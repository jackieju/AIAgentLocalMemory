# Compression Strategies (A / B / D)

This document summarizes the selectable context-compression strategies. A
strategy is a *top-level choice* of **two things**: (1) how the recent-message
**tail boundary** is computed, and (2) how the older messages beyond the tail are
**rendered into compartment summaries**. For the per-turn internal mechanics that
run *after* a strategy is chosen, see `CONTEXT-COMPRESSION-PIPELINE.md`.

There are three real strategies — **A, B, D**. (`C` was merged into `B` and now
maps to it as a backward-compat alias.)

Select one via `neural-context.json`:

```jsonc
{
  "compressionStrategy": "B",   // "A" | "B" | "D"  ("C" = alias of B; default "B")
  "summaries": true,            // B/D only: false → fall back to the 80-char list
  "halfLifeRank": 5,            // D only: time-decay half-life in compartment ranks
  "semanticWeight": 0.5,        // D only: embedding-vs-FTS fusion weight (design phase)
  "ftsRelevanceRanking": false  // B/D only: false (DEFAULT) = pure chronological ordering
                                // (magic-context style, no time inversion). true = relevance
                                // re-ranks compartments (see "Time-inversion risk" below).
}
```

---

## At a glance

| | Tail boundary | Compartment rendering | Relevance-weighted? | Time-weighted? | Behavior on old sessions |
|---|---|---|---|---|---|
| **A** | recency window: `min(20 msgs, 24h)`, narrow-only | 80-char user-title list | No | Tail only (24h window) | Same as new |
| **B** (default) | magic-context dynamic tail (token-budget driven) | p1/p2/p3 tiers by **lexical (FTS) relevance** | Yes (FTS keyword) | No | p1/p2/p3 tiers, but no relevance ordering* |
| **D** | same as A (`min(20 msgs, 24h)`) | p1/p2/p3 tiers by **semantic (embedding+FTS) relevance × time-decay** | Yes (embedding + FTS) | Yes (compartment scoring) | p1/p2/p3 tiers, but no relevance ordering* |

> **C is now an alias of B.** B and C were merged: their only difference used to be
> the compartment renderer (B = 80-char list, C = p1/p2/p3 tiers). Since the 80-char
> list was a degraded leftover (p1/p2/p3 were being generated but thrown away at
> render time), B absorbed C's p1/p2/p3 tier rendering. `strategy:"C"` still works —
> it maps to B — but there are now three real strategies: **A, B, D**.

> **D is the only strategy where the neural/semantic layer actually matters.** B
> ranks compartments by FTS keyword overlap (bm25); D fuses that with **embedding
> semantic similarity** so a topic from days ago that is semantically related to
> what you're doing now (even with zero keyword overlap) gets pulled back. The
> embedding fusion is being wired in (design phase); until it lands, D behaves like
> B + time-decay. See "D: semantic fusion" below.

**Ordering note:** all strategies emit compartments in **chronological order**
(oldest→newest). "Time-weighted" in the table means *only* whether time affects
tier *selection* (D lowers older compartments' scores so they're likelier to drop
to p3/out); it does not refer to output order. B has no time weighting on tier
selection; A/D express "time" as the 24h tail window (A) or the decay (D).

\* On sessions created before ord-stamping shipped, B/D compartments all score 0
(no coordinate to join). They still render as **p1/p2/p3 tiers** — with no
relevance/time ordering: the greedy pass just fills the budget in chronological
order. So old sessions still get p1/p2/p3 summaries, just without the smart
selection. See below.

---

## The two axes

Every strategy is a pairing of a **tail policy** and a **compartment renderer**.

### Axis 1 — Tail policy (`resolveTailPolicy`)
- **B-style (B):** the tail is delimited purely by a token budget
  (`contextLimit × TARGET_USAGE_PCT`, adjusted by the breaker factor and the
  system/tools reserve). It keeps as many recent messages as fit. This is the
  magic-context-aligned behavior.
- **A-style (A, D):** the same budget delimitation, then **additionally** clamped
  by a recency window — a message is only kept in the tail if it is within the
  last **20 messages AND the last 24 hours** (intersection). This is *narrow-only*:
  it can shrink the tail but never widen it beyond the budget. It exists so the
  tail cannot silently balloon on very long sessions.

### Axis 2 — Compartment renderer (`renderCompartments*`)
The messages older than the tail are summarized into `<earlier-topics>` message(s).
- **80-char list (A):** takes the *skipped user messages*, slices each to 80
  chars, and joins them into one title list. No LLM summaries are used at render
  time. Cheap, lossy, topic-agnostic.
- **p1/p2/p3 tiers (B, D):** uses the historian's three summary tiers stored on
  each compartment (p1 = one paragraph ≤150 tok, p2 = one sentence ≤25 tok,
  p3 = a title ≤8 tok) and picks a tier per compartment by relevance. B ranks by
  FTS keyword relevance; D fuses FTS with embedding semantic relevance (see below).

> **Safety invariant (all renderers):** compartment output is always pure-text
> `role=user` messages with **no `tool_result`**. A `tool_result` whose matching
> `tool_use` was dropped triggers an Anthropic pre-stream 400 ("message vanishes"
> bug). The downstream orphan-sweep pairs by id, not position.

---

## B / D: how tier selection works

Both B and D share one engine (`renderCompartmentsCD`). Per turn:

1. **Query** = the last 1–3 *meaningful* user messages, concatenated (each capped
   to 500 chars). Using 1–3 turns (not just the last one) stabilizes the topic
   signal and reduces tier flicker.
2. **One** bounded FTS query: `searchWithScores(query, 50)`. This is the *only*
   graph read on the hot path — no `getAllNodes`, no full embedding load (that path
   caused the build #57 OOM and is forbidden here).
3. **Aggregate** per compartment: each compartment's score = the **max** score
   among hit episodes whose stamped `ord` falls in `[startOrd, endOrd]` and whose
   session matches. `max` (not `sum`) avoids long-compartment bias — one strongly
   relevant episode shouldn't lose to many weak ones.
4. **D only — semantic fusion:** in addition to the FTS score, D computes the
   embedding cosine similarity between the query and each compartment's cached
   embedding, and fuses the two (weighted). This is what lets D pull back a topic
   that is *semantically* related but shares no keywords. B skips this step (FTS
   only). *(Design phase — see "D: semantic fusion" below for the wiring plan.)*
5. **D only — time-decay:** multiply the (fused) score by
   `exp(-ln2 × ageRank / halfLifeRank)`, where `ageRank` is the compartment's
   recency rank (0 = newest) and `halfLifeRank` defaults to 5. So a compartment
   5 ranks older is worth half as much at equal relevance — but a highly relevant
   old compartment can still beat a recent irrelevant one.
6. **Greedy tier assignment** under `historyBudgetTokens`
   (`contextLimit × HISTORY_BUDGET_PCT`, default 0.15): sort by score desc; assign
   p1 (full) until the budget would overflow, then p2, then p3. Token cost is the
   **real** `countClaudeTokens` of the chosen tier, not a nominal cap. A floor
   guarantees the top `min(3, count)` compartments keep at least p3; the
   lowest-scoring overflow is dropped entirely.

**B = D without steps 4 and 5.** B ranks purely by current FTS relevance; D adds
embedding semantic fusion and a recency bias.

### `summaries: false`
Turns off tier rendering for B/D: the renderer falls back to the 80-char list
(same as A). Generation is **not** affected — p1/p2/p3 are the compartment's body;
skipping their generation would leave nothing to compress and break A too.

---

## Why B/D relevance ordering is "new-session-only"

B/D join episodes to compartments by a shared **`ord`** coordinate (the dense
session sequence number that compartments' `startOrd`/`endOrd` also use). That
coordinate is stamped onto an episode node **at creation time** (`safePutNode`
resolves `messageId → ord`).

The existing graph (≈41,862 episode nodes at time of writing) has **no** such
coordinate and **cannot be backfilled**:
- `messageId` on old nodes: **0** — nothing to resolve `ord` from.
- `turnIndex` present on only ~20.6%, and it is **non-monotonic** (batch-local, not
  a session-global sequence — e.g. a whole session's nodes all read `1`), so it
  cannot be mapped to `ord`. Guessing would stamp **wrong** coordinates, which is
  worse than none (irrelevant old compartments would be promoted to p1).

Therefore backfill is deliberately **not** done. For sessions created *before* the
ord-stamping shipped, every compartment scores 0 → ties → the greedy pass fills the
token budget in chronological order. Crucially this still renders **p1/p2/p3 tiers**
(higher quality than A's 80-char list). What's lost is only the *smart selection*:
without scores, B can't prefer the currently-relevant compartment and D can't prefer
the recent/semantically-related one; both just pack tiers chronologically until the
budget is spent. For sessions created *after*, B/D are fully precise. New sessions'
share grows over time.

Genuine fallback to A's 80-char list happens only when `summaries: false`, or when
a compartment has no p1/p2/p3 at all (nothing to render).

---

## Which should I use?

- **B (default):** p1/p2/p3 tiers ranked by FTS keyword relevance, magic-context-aligned
  tail. Best general choice — old topics that share keywords with what you're doing
  now get full p1 summaries; unrelated ones shrink to a title or drop.
- **A:** cheapest. 80-char title list + hard recency cap on the tail. Use if long
  sessions make your tail balloon and you want a firm recency ceiling and don't
  need relevance ranking.
- **D:** like B but adds **embedding semantic fusion** (pulls back topics related
  in *meaning*, not just keywords) plus a recency bias. The only strategy where the
  neural/semantic layer actually affects compression. Best for *new* long-lived
  sessions where both "what's relevant now" and "what's recent" matter, and you have
  an embedding provider configured.

---

## Time-inversion risk (relevance ranking) — READ THIS

When B or D rank compartments by **relevance** (FTS keywords for B, FTS+embedding for
D), they can pull an **older** compartment ahead of a **newer** one if the older one
scores higher. That creates a real hazard:

> Suppose early in a session you concluded **"X"** (wrong), and later corrected it to
> **"actually X was wrong, it's Y"**. If both are old enough to be compressed into
> *separate* compartments, relevance ranking may give the earlier (now-wrong) "X"
> compartment a richer tier (full p1) while the later correction shrinks to a title or
> drops. The model then sees the detailed wrong conclusion and misses the correction —
> **it can treat the overturned conclusion as current truth.**

This is the fundamental trade-off of relevance ordering: it optimizes for *topical
relevance*, which can break *causal/temporal* order.

**How this project mitigates it (three layers):**

1. **`ftsRelevanceRanking: false` is the DEFAULT.** Out of the box, B and D order
   compartments **purely chronologically** (like magic-context / Claude Code): the
   newest compartment gets the richest tier, so a later correction can **never** lose
   budget to an earlier now-wrong conclusion. No time inversion. You only take on the
   risk if you explicitly set `ftsRelevanceRanking: true`.
2. **Recency tie-break.** Even with relevance ON, when two compartments score equal the
   **later** one wins (`sort by score desc, then idx desc`), so a correction never loses
   to an equally-scored older statement.
3. **Time-ordered historian summaries.** The historian prompt (Claude-Code-style) is
   instructed to analyze the conversation in time order and, when a later message
   corrects/supersedes an earlier one, reflect the **latest** state as truth and note
   the earlier was superseded. This helps **within** a single compartment — but note it
   does **not** help across *separate* compartments (that's what layer 1 is for).

**Bottom line:**
- Leave `ftsRelevanceRanking: false` (default) if correctness under corrections matters
  more than topical recall. This is the safe choice.
- Set `ftsRelevanceRanking: true` only if you want relevant old topics pulled forward and
  accept the time-inversion risk above. **D inherits the same risk** (its embedding fusion
  only runs when relevance ranking is on).

---

## Verifying B/D

B/D only produce visible differences on **new** sessions with enough turns to
generate compartments:

```jsonc
{ "compressionStrategy": "D", "halfLifeRank": 5 }
```

Restart, open a new session, converse across several distinct topics until
compartments form, then return to an earlier topic — relevant older compartments
should expand (p1) while unrelated ones stay as titles (p3) or drop.

---

## Deep dive: the two summary engines (F0–F4 vs P1/P2/P3)

There are **two completely different, independently-authored** compression engines
in `packages/core`. This is the single most-confused point in the codebase, so it
is worth being precise. They are NOT variants of each other and NOT variants of
magic-context.

### Engine 1 — F0–F4 fidelity rendering (`context-renderer.ts`, `ContextRenderer`)

**Origin: our own.** Built on our neural memory graph. This was the *first*
compression the plugin ever had (commit `5299079`, P1). It has nothing to do with
magic-context.

**Granularity: per-message.** Every single message (episode) is independently
assigned one of five fidelity levels and rendered at that level:

| Level | Name | Size (relative to full text `s`) | Meaning |
|---|---|---|---|
| **f0** | full | `s` | verbatim, the whole message |
| **f1** | para | `s / 2` | a paragraph-length condensation |
| **f2** | gist | `s / 4` | a gist |
| **f3** | title | `s / 10` | a one-line title |
| **f4** | omit | `0` | dropped entirely |

**How a message's level is chosen — relevance, not recency:**
1. `graph.spreadingActivation(seeds, …)` runs over the neural graph from the current
   activation seeds (what you're talking about now). Each episode gets an
   **activation score** — how relevant it is to the present moment.
2. `binarySearchThresholds(...)` binary-searches a set of score cutoffs so that the
   *sum* of all rendered messages fits the token budget. High-activation messages
   land above the `full` cutoff (f0); progressively less relevant ones fall to
   f1 → f2 → f3 → f4.
3. `recentFullTextTurns` (3–5, chosen dynamically by message length) force the most
   recent turns to **f0** regardless of activation — you always see recent context
   verbatim.
4. `applyHysteresis` (default 0.2) damps flicker: a message won't bounce between,
   say, f1 and f2 turn-to-turn unless its activation moves past a dead-band.

**Key properties:**
- No LLM call at render time. The f0–f4 payloads are pre-computed condensations
  stored on the episode; rendering just *picks* a level. Cheap per turn.
- Fine-grained: a single highly-relevant old message can stay f0 while its
  neighbors in the same era drop to f3 — something compartments cannot do (they
  summarize a whole chunk together).
- Relevance comes from graph activation, so it needs a populated, well-linked
  graph to shine. On a sparse graph the activation signal is weak.

### Engine 2 — P1/P2/P3 compartment summaries (`historian.ts` + `compartments.ts`)

**Origin: aligned with magic-context.** This is the magic-context-style approach:
an LLM "historian" summarizes a *chunk* of old messages into three tiers, stored as
a "compartment" covering an ordinal range `[startOrd, endOrd]`.

| Tier | Shape | Budget | Content |
|---|---|---|---|
| **p1** | one paragraph | ≤150 tokens | user goals, decisions made, files/symbols touched, errors hit, current state (past tense) |
| **p2** | one sentence | ≤25 tokens | the single most important thing that happened |
| **p3** | a title | ≤8 tokens | like a git commit subject |

**How it works:**
1. When enough old messages accumulate beyond the tail, the historian is handed that
   chunk and prompted (`HISTORIAN_PROMPT`) to emit **strict JSON** `{p1,p2,p3}`.
2. The result is persisted as one compartment with `startOrd`/`endOrd` marking which
   messages it replaces.
3. At render time a strategy picks *one* tier per compartment (A always uses the
   80-char list instead; B/D pick p1/p2/p3 by relevance — see above).

**Key properties:**
- Requires an LLM call to *generate* (done in a background sub-session, off the hot
  path). Once generated, rendering is free.
- Coarse-grained: one summary set per *chunk* of messages, not per message. Cannot
  keep one message verbatim while compressing its neighbors.
- Independent of the neural graph — works even on a sparse/empty graph, because the
  LLM reads the raw transcript chunk directly.

### Side-by-side

| | F0–F4 (Engine 1) | P1/P2/P3 (Engine 2) |
|---|---|---|
| Origin | our neural-graph design | magic-context-aligned |
| Granularity | per **message** | per **chunk** (compartment) |
| Relevance signal | graph spreading-activation | none at generation; B/D add relevance at render (B: FTS; D: FTS+embedding) |
| Needs LLM? | no (payloads pre-computed) | yes (historian generates tiers) |
| Needs a good graph? | yes | no |
| Levels | 5 (f0–f4) | 3 (p1/p2/p3) |
| Recent-verbatim guarantee | `recentFullTextTurns` → f0 | the tail (uncompressed) |
| Anti-flicker | hysteresis dead-band | n/a (compartments are stable once written) |

Neither is strictly better. F0–F4 is finer and LLM-free but leans on a rich graph;
P1/P2/P3 is coarser and costs LLM calls but is robust on any data and gives clean
human-readable summaries.

---

## History: what compression we used *before* decoupling

The confusion about "which engine is the real one" comes from real churn. Here is
the git-verified timeline:

| When | Commit | State of the transform |
|---|---|---|
| 2026-06-06 | `5299079` (P1) | **F0–F4 only.** The first-ever `messages.transform`: spreading-activation + binary-search fidelity + `recentFullTextTurns`. No compartments existed yet. |
| ~2026-06-13 | `61287af` (perf) | `renderer.render()` removed from the hot path for speed. F0–F4 stops being called. |
| 2026-06-14 | `ba95466` (b63) | **Switched to P1/P2/P3.** Historian + compartment system integrated into the transform. This is where compartments became the live mechanism. |
| 2026-08-14 | `b334078` (Build #265) | Minor cleanup: the already-dead `ContextRenderer` (F0–F4) import was removed from the adapter and `neural_reduce/pin/expand` were rewired to touch only the compaction system. This is NOT the big decoupling — the transform logic still lived inline in the plugin. |
| 2026-09-26 | `0237cde` (Build #290) | **THE decoupling.** The whole ~1000-line compartment/transform engine + 7 shared helpers were extracted from the plugin into `packages/core` (`context-compressor.ts`, `transform-helpers.ts`) behind `runCompartmentTransform(input, output, deps)` with an explicit `TransformDeps` interface. The adapter shrank from **4327 → 3264 lines**; nvp-server was added as a second host (zero `@opencode` deps) to prove reuse. |
| after `0237cde` | — | **A/B/D added** (originally A/B/C/D; B+C later merged). The strategies were built *on top of* the now-decoupled core engine — which is why they are host-agnostic from birth. |

**So the direct answer to "what did the plugin look like before decoupling":**
before `0237cde` (Build #290, Sep 26) the OpenCode plugin was a **~4327-line fat
plugin** with the entire context-compression pipeline **inlined inside it** — token
budgeting, tail boundary, compartment rendering, microCompact, tokenizer, tool
tiering, all welded into `adapter-opencode/src/index.ts` and entangled with
OpenCode's hooks and message shape. No other agent could reuse it. (The *memory*
core had always lived in `packages/core` since the very first commit `f667833`; it
was the *compression* half that was welded to the plugin, and that is exactly what
`0237cde` unwelded.) After decoupling the plugin is a thin adapter (~3264 lines,
mostly OpenCode-specific I/O) that just calls `runCompartmentTransform`.

Regarding the engines: by decoupling time (Sep 26) the live engine was already
**P1/P2/P3 compartments**. F0–F4 had been swapped out on Jun 14 (`ba95466`) and its
dead import removed on Aug 14 (`b334078`). The Sep-26 decoupling did **not** change
*which* engine ran — it moved the P1/P2/P3 machinery into shared core. F0–F4 itself
was never deleted; it lives in `packages/core` (`context-renderer.ts`) and is used
today by the nvp-server host, just not wired into the OpenCode transform.

---

## Related docs
- `CONTEXT-COMPRESSION-PIPELINE.md` — the 15-stage per-turn transform mechanics.
- `FIDELITY-RENDERING-F0-F4.md` — the older per-message f0–f4 fidelity renderer
  (used by the standalone nvp-server render path, distinct from these strategies).
- `CONFIGURATION-REFERENCE.md` — all config fields.
