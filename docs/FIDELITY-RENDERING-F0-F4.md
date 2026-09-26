# Fidelity-Tiered Context Rendering (F0–F4)

> Status: **historical / alternate engine**. This design is implemented in
> `packages/core/src/context-renderer.ts` (the `ContextRenderer` class) and is the
> compression engine used by the **`nvp-server`** host (via the `renderContext` RPC).
> The OpenCode adapter today uses the *magic-context-style compartment* engine
> (`runCompartmentTransform`) instead. This document describes the F0–F4 engine so it
> is written down somewhere rather than living only in the code.

## 1. What it does

Instead of the "keep a recent tail verbatim, summarize everything older" approach, the
F0–F4 renderer treats **every** conversation turn independently and renders it at one of
**five fidelity levels**, chosen by how *relevant* that turn is to the current topic
(measured by spreading activation over the memory graph), subject to a token budget.

The five levels (`FidelityLevel` in `interfaces.ts`):

| Level | Name        | What is rendered                                             |
|-------|-------------|--------------------------------------------------------------|
| `f0`  | full        | Verbatim original text                                       |
| `f1`  | paragraph   | Paragraph-length summary (or first ~800 chars if no summary) |
| `f2`  | gist        | One-sentence gist (or first ~120 chars)                      |
| `f3`  | title       | Title / `[role] first ~40 chars…`                            |
| `f4`  | suppressed  | Elided — `§tag§ [elided]`                                    |

Each rendered message keeps its `§tag§` prefix so it stays addressable (e.g. for
`neural_pin` / `neural_reduce` / `neural_expand`).

## 2. The core idea: relevance, not age

The key difference from age-based compression: an **old** turn whose topic becomes
relevant again will **re-activate to a high fidelity**, while a **recent-but-irrelevant**
turn can be rendered at a lower fidelity. Age is only *one* of several signals feeding
the activation score, not the sole axis.

## 3. Pipeline (per `render()` call)

`render(sessionId, currentActivationSeeds)` in `context-renderer.ts:69`:

1. **Load episodes** (`loadEpisodes`, line 166) — pull all `type:"episode"` nodes for the
   session, sorted by `turnIndex` (falls back to `createdAt`). Each episode node carries
   `EpisodicData` with a `fidelity` payload (`f0` always present; `f1`/`f2`/`f3` optional).

2. **Compute budget** (`computeBudget`, line 220):
   `contextWindowTokens * budgetRatio − systemPromptTokens − reserveTokens`.
   Defaults: `budgetRatio=0.6`, `systemPromptTokens=2000`, `reserveTokens=4000`.

3. **Augment seeds with working memory** (`augmentSeedsWithWorkingMemory`, line 190) —
   add up to `WORKING_MEMORY_SAMPLE=20` recently-touched node ids as weak seeds
   (`WORKING_MEMORY_SEED_BOOST=0.1`) so the current focus biases activation.

4. **Spreading activation** (`graph.spreadingActivation`, line 88) — with
   `maxHops=3`, `hopDecay=0.5`, `threshold=0.08`. Produces a relevance score per node.

5. **Effective activation per episode** (line 102–118) — for each episode, take the max of:
   - `baseAct` — its spreading-activation score (`0` if not activated),
   - `recencyBonus = i / episodes.length` — linear recency (newest ≈ 1.0),
   - `wmFloor = 0.2` if the node is in working memory (`WORKING_MEMORY_FLOOR`).

   Then apply overrides:
   - **suppressed** (and not the last turn) → `act = −1` (`SUPPRESSED_ACTIVATION`),
   - **pinned**, or within the forced-full recent window, or the very last turn →
     `act = +∞` (always `f0`).

   `recencyBonus` is exactly where **time weight** already lives in this engine.

6. **Binary-search the thresholds** (`binarySearchThresholds`, line 240) — find the
   smallest scale `s` whose *simulated* rendered token count fits the budget. Thresholds
   are derived from `s` with fixed ratios (`scaleToThresholds`, line 263):
   `full=s, para=s/2, gist=s/4, title=s/10`. As `s` rises, fewer nodes clear each
   threshold and total tokens fall monotonically, so we take the smallest fitting `s` to
   **maximize budget utilization**. 32 iterations, epsilon `0.001`.

7. **Pick fidelity + hysteresis** (line 126–150):
   - `pickFidelity(act, thresholds)` (line 289): `act ≥ full → f0`, `≥ para → f1`,
     `≥ gist → f2`, `≥ title → f3`, else `f4`.
   - **Hysteresis** (`applyHysteresis`, line 305, default margin `0.2`): once a node has a
     fidelity, only switch levels when activation crosses the relevant threshold by more
     than the margin. This keeps the rendered prefix **stable** across turns (avoids a
     node flickering f1↔f0 every message, which would bust prompt caching). Skipped for
     `+∞`/`−1` (forced) nodes.

8. **Render content** (`renderContent`, line 329) — emit `§tag§ <text>` at the chosen
   level, falling back to truncated `f0` when a summary tier isn't precomputed.

9. **System injection** (`buildSystemInjection`, line 358) — a `<neural-memory>` block
   with ready session facts + top activated concepts/assertions, plus the tool usage
   guide (`neural_reduce`/`neural_pin`/`neural_recall`/`neural_note`).

## 4. Constants (all in `context-renderer.ts`, lines 15–30)

```
CHARS_PER_TOKEN        = 4      F1_FALLBACK_CHARS      = 800
F2_FALLBACK_CHARS      = 120    F3_FALLBACK_CHARS      = 40
RECENT_AVG_SAMPLE      = 10     TOP_CONCEPTS           = 5
TOP_ACTIVATION_SCAN    = 50     ACTIVATION_MAX_HOPS    = 3
ACTIVATION_HOP_DECAY   = 0.5    ACTIVATION_THRESHOLD   = 0.08
WORKING_MEMORY_FLOOR   = 0.2    WORKING_MEMORY_SAMPLE  = 20
WORKING_MEMORY_SEED_BOOST = 0.1 BINARY_SEARCH_ITERATIONS = 32
BINARY_SEARCH_EPSILON  = 0.001  SUPPRESSED_ACTIVATION  = -1
```

## 5. Recent-full-text window

`recentFullTextTurns` (config) or `calcRecentFullText` (line 203) forces the most recent
N turns to `f0`. N adapts to average turn size over the last 10 turns: `<200 avg tokens →
5`, `<500 → 4`, else `3`. Longer turns ⇒ fewer forced-full to protect the budget.

## 6. Relationship to the compartment engine

| | F0–F4 renderer (`ContextRenderer`) | Compartment engine (`runCompartmentTransform`) |
|---|---|---|
| Unit | Per **message** | Per **compartment** (a summarized *span* of messages) |
| Fidelity axis | 5 levels per message | tail = verbatim; older = p1/p2/p3 summary |
| Relevance | spreading activation → threshold | recency window + background historian |
| Host | `nvp-server` (`renderContext` RPC) | OpenCode adapter (`messages.transform`) |
| Time weight | `recencyBonus = i/len` (built in) | recency tail boundary |

**Reuse note for the planned "Strategy D" (time+semantic hybrid over compartments):**
the *activation→tier mapping* here (`pickFidelity` + `binarySearchThresholds` +
`applyHysteresis`) is reusable in spirit, but it is coupled to *per-message* episodes.
Applying it *per-compartment* needs an extra step: aggregate the activation scores of the
episode nodes a compartment covers (`startOrd..endOrd`) into one score for that
compartment, then feed that into the same threshold/hysteresis logic. The episode
originals are already in the graph, so **no summary needs to be added to the graph** — only
the "episode activation → compartment score" aggregation is new.
