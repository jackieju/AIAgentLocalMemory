# Context Compression Pipeline

> This document describes the **complete flow** by which the `ai-agent-local-memory` plugin
> manages context inside OpenCode: from the moment the user presses Enter to send a message,
> all the way to the assembled payload sent to the LLM — every stage's action, trigger, and design intent.
>
> Core file: `packages/adapter-opencode/src/index.ts`
> Key hook: `experimental.chat.messages.transform`
>
> 🇨🇳 中文版：[CONTEXT-COMPRESSION-PIPELINE_CN.md](./CONTEXT-COMPRESSION-PIPELINE_CN.md)

---

## Summary: how summarization and history retention actually work

Two questions people ask most often, answered up front:

### Where is "summarization" done, and by which model?

Every summarization task in the system uses **one shared LLM** (`historianLlm`). Which model that resolves to:

1. If you set the `llm` field in `neural-context.json` (e.g. `provider: ollama, model: qwen3:14b`) → **your local model** (Ollama Qwen3:14B in the reference setup).
2. Otherwise it falls back to `http://localhost:6655/openai/v1` with `claude-sonnet-4-6`, then `gpt-4.1-mini`, then `gpt-5-mini`.

Four places call it: **Historian compression** (folding an old stretch of conversation + tool outputs into one `<compartment>` summary block), **Dreamer** (once-daily fact/value/culture extraction into the memory graph), **local-LLM judging** (observer/student modes), and **neural_read** (curating value/culture candidates from a URL/text).

**Crucially, most of context compression uses no model at all.** microCompact (truncating oversized tool outputs), caveman compression (stripping filler words), tail budgeting, and orphan sweeps are all pure string/budget math — **zero LLM**. Only the step that folds an old conversation stretch into a one-line summary (a compartment) calls the model.

### Is history "stuffed until it no longer fits"? — No.

History is **not** packed to 100% until it overflows. It is actively compressed and budget-trimmed in three layers:

1. **Compartment folding (`tailStart`)** — history before the last compartment's `endMessageId` has *already been summarized* into fold blocks by the Historian. It is not re-fed message by message; only the one-line summary goes in.
2. **Tail budget trimming** — for the raw conversation *after* `tailStart`, a token budget `tailBudgetTokens` is set: base = `contextLimit × 0.55` (`TARGET_USAGE_PCT`), minus ~18% reserved for system prompt + tool schemas, times a circuit-breaker factor. The loop **accumulates from the newest message backwards and breaks once the budget is exceeded**, dropping the oldest tail messages.
3. **Two hard floors** — `HARD_TAIL_CAP = 500` messages max, and the **newest message is always kept** (force-included even if it alone exceeds the budget; its oversized tool outputs are truncated by microCompact instead).

So the accurate description is: **old history is folded into summaries; the tail keeps the most recent raw conversation that fits inside the 55% window budget; the excess is dropped; the newest message is kept no matter what.** Target utilization is **55%** of the window, not 100%.

### When compartment + tail exceed budget, what gets cut — compartment or tail?

**The tail's oldest raw messages get cut. The newest is never cut.** But note the mechanism precisely:

- Compartments and the tail do **not** compete for the same budget. `tailBudgetTokens` governs **only the tail** (raw conversation). Compartment summaries are injected outside this budget.
- Budget trimming acts **only on the tail**, cutting from the **oldest** tail messages forward (`for i = length-1 → floor`, break on overflow). The newest message is force-included first.
- Compartment coverage **only grows, never shrinks** (`tailStart` is a floor). As the conversation lengthens, the Historian keeps folding newly-old history into compartments, pushing `tailStart` forward. So there is no "cut a compartment" action — **compartments are finished compression output that only accumulates**; what actually gets trimmed under budget pressure is the *not-yet-folded, older tail raw text*, which is simultaneously being folded into compartments by the Historian.
- Messages dropped from the tail are not simply lost: they are (or soon will be) folded into a compartment summary, or listed in an `<earlier-topics>` digest (when >20 messages are skipped, each skipped user message contributes its first 80 chars to a list).

> **Known edge case**: compartment summaries are currently injected unconditionally (not bounded by `tailBudgetTokens`). In practice each is small (a few hundred tokens), so dozens of them stay well within limits. If summaries ever accumulate excessively this could become a pressure point — a candidate for a future per-compartment-summary budget cap.

---

## 0. Overview: two independent paths

In a single user interaction the plugin actually runs two **independent** paths:

| Path | When it fires | What it does | Blocks echo? |
|---|---|---|---|
| **Echo path** (hot path) | The instant the user presses Enter | Crash-proof persistence + compresses & assembles the LLM payload | **Yes**, must be extremely fast |
| **Memory path** (idle path) | When the session goes idle | Writes the memory graph, historian compression, linking, dreamer | No, fully async |

**Red line**: the echo path (`chat.message` + `messages.transform`) must never do any slow IO (full DB scans, network requests).
All slow work is pushed to after the `session.idle` event. This is an iron rule cemented by repeated "hang for minutes after switching to the plugin" incidents.

---

## 1. User presses Enter → `chat.message` hook (earliest touchpoint)

```
User types "hello" + Enter
   │
   ▼
chat.message hook fires (before echo, before transform)
   │
   ├─ Synchronously append the raw user message to pending-messages/<sid>.log
   │  (crash-proof: even if a later transform hangs, the message is not lost)
   │
   └─ bump globalThis.__neuralMainBusyAt = Date.now()
      (marks "main session is busy" so an interruptible background neural_read yields)
```

**Why persist first**: in early versions, if transform hung, the message the user just typed
never even reached the database and was lost forever.
`chat.message` is the earliest point in OpenCode where you can grab the raw user text, independent of transform.

---

## 2. `messages.transform` entry → idempotency guard

```
messages.transform(output)
   │
   ├─ originalMessagesSnapshot = output.messages.slice()   ← original snapshot, roll back on error
   │
   ├─ idempotency guard: if (messages[RENDERED_SENTINEL]) return   ← critical!
   │     OpenCode calls transform TWICE per turn with the SAME messages array.
   │     The first pass splices/compresses and stamps RENDERED_SENTINEL;
   │     the second pass returns immediately, avoiding re-compressing an already
   │     compressed result (otherwise it collapses to just 1 message).
   │
   └─ if magic-context coexists → pass through directly (don't take over compression,
      avoiding two transforms fighting)
```

---

## 3. Locate the real session + compute usage

```
   ├─ Extract the real OpenCode session ID (ses_xxx) from output.messages
   │     Must NOT use the directory hash — that would cross compartments/usage into another session.
   │
   ├─ lastModelKey = the model used by the last assistant message
   │     Used to resolve the context window by model (Opus=200K, GPT-5.x=400K, Kimi=256K...)
   │
   ├─ contextLimit = pluginConfig.contextWindowTokens ?? resolveContextWindow(lastModelKey)
   │
   └─ realUsage = getContextUsage(openCodeSessionId)
      usagePct = real token-usage percentage from the most recent settled assistant message
      (queries cache.read + cache.write + input + output from opencode.db)
```

---

## 4. Scheduler: three-state scheduling (execute / defer / skip)

Decides whether this turn should **trigger the historian to produce a new compressed summary (compartment)**:

```
   usagePct ≥ EXECUTE_THRESHOLD(65%)  and not mid-turn → execute (async compress in background)
   usagePct ≥ 63% or mid-turn                          → defer  (wait for next turn)
   otherwise                                            → skip   (no compression)
```

- **execute**: a background IIFE spins up a historian sub-session to compress the oldest batch of messages into a compartment (see §12). **Does not block** transform's return.
- The amount the historian compresses at once = `contextLimit × HISTORIAN_CHUNK_PCT(25%)` (aligned with magic-context).

---

## 5. Read existing compartments → compute tail boundary

```
   compartments = compartmentStore.getForSession(openCodeSessionId)
   │     compartment = a span of old messages already compressed into a summary by the historian (stored in SQLite)
   │
   ├─ tailStart = index of the last compartment's endMessageId in the array + 1
   │     (tail = the recent message span not yet compressed, kept verbatim/near-verbatim)
   │
   └─ maxCompartOrd = the ordinal the last compartment covers up to
```

**tail = messages from tailStart to the end**. The core of compression is stitching together
"compartments (summaries) + tail (near-verbatim)" and sending it to the LLM.

---

## 6. L1 microCompact — giant tool-output truncation (before the budget scan)

```
   Scan the most recent 500 messages:
   for each part of each message:
      if part.state.output.length > MICROCOMPACT_TRIGGER_CHARS(50000):
         truncate to the first 2000 chars + a retrievable stub
```

**Retrievable stub text** (`buildToolStub`):
```
…[tool output compacted — kept first 2000 of 87000 chars]
[retrieve verbatim: grep the tool block name="bash" args={"command":"…"} in
 ~/.local/share/ai-agent-local-memory/transcripts/<sid>.md; if absent, re-run bash with the same args]
```

**Why it must run before the budget scan**: microCompact mutates `messages[]` directly (shared object refs),
so the later token budget scan (§8) measures the **post-truncation** size.
If the order were reversed, a giant payload would blow the budget at its original size → "Input too long".

**Note**: it **no longer exempts the most recent N** (the old `KEEP_RECENT=3` has been removed) —
all tool outputs over 50k chars are truncated regardless of age. Task 3's "never delete the newest message"
protects the message from being emptied entirely, not from having its internal tool payload truncated.

---

## 7. protectLine — the protect line (four-guardrail hardening)

Protects the most recent ~2 "meaningful user turns" from being compressed away, solving the
cross-turn reference problem ("user answers C, referring to A/B/C from the previous turn").

**Four guardrails** (born from the build #277 blowup incident, see the incident notes in `docs/`):
```
(a) span cap    — look back no more than MAX_PROTECT_SPAN(80) messages
(b) floor       — startIdx never drops below floor (HARD_TAIL_CAP=500 backstop)
(c) token ceiling — the protect pull-back can't push the tail past budget × 1.3
(d) pressure gate — enable protection only when usagePct < 70%; under high pressure abandon it to survive
```

Guardrails (a)+(b) are folded into the scan lower bound `protectFloor = max(floor, length - 80)`,
making it **physically impossible** for protectLine to land at a tiny index (which was exactly the root cause of #277 blowing the budget).

---

## 8. L2 budget scan — token budget scan (tail delimitation)

```
   tailBudgetTokens = max(
       contextLimit × 0.1,                                    ← hard lower bound
       (contextLimit × TARGET_USAGE_PCT(0.55) - systemToolsReserve) × breakerFactor
   )

   Accumulate from the end backward:
   for i = length-1 downto floor:
       tailTokens += msgTokensMemo(messages[i])   ← precise count via the real tokenizer (memoized)
       if tailTokens > tailBudgetTokens: break
       startIdx = i
```

- **systemToolsReserve** = `contextLimit × 0.18`: reserved for the system prompt + tool definitions,
  otherwise once the conversation fills 55%, system+tools stacked on top overflow.
- **breakerFactor** (circuit breaker): when the historian fails repeatedly, each failure halves the tail budget
  (down to a 1/4 floor), so even if compression fails, the request drops below the limit and doesn't 413 over and over.

**N=1 guarantee** (Task 3): if the newest single message already exceeds budget, the budget loop's first-pass break
leaves startIdx at `length`, falling into slice(-1). Here we force the newest message into the tail — the newest message is never lost.

---

## 9. Protect pull-back

```
   if (allowProtect && protectLine < startIdx):
       startIdx = max(protectFloor, protectLine)   ← pull the tail start to the protect line, but doubly clamped by (b)(c)
```

At this point **tail = messages.slice(startIdx)** is delimited; everything afterward only reduces within the tail and never changes the boundary.

---

## 10. Tool fingerprint deduplication

```
   Compute a fingerprint for each tool message = toolName + first 300 chars of input
   Same fingerprint appears multiple times → all but the last (and only those outside the protected region) are marked drop
   (rendered as empty — duplicate tool calls keep only the latest)
```

---

## 11. Structural-noise cleanup + caveman compression + tier truncation

Reduce the tail in order:

```
① Structural-noise cleanup: meta / step-start / step-finish parts → cleared
      (the newest message is exempt — Task 3)

② Caveman text compression (non-protected region only, graded by position):
      first 20% → ultra (hardest)    20-40% → full    40-60% → lite
      natural-language compression: strip filler/articles, abbreviate, etc.

③ Tier truncation (tool outputs, tiered by tool value):
      T1 (read/todowrite/task/glob… read-only probes) → cut to 4000 (keep more)
      T2 (edit/write/grep/bash…)                       → cut to 2000
      T3 (unknown/other)                                → cut to 800 (cut hardest)
      each truncation carries a retrievable stub (grep the MD by tool name + args)

④ Protected-tail tool-output truncation: > 16000 chars → cut to 16000 + retrievable stub
      (protected-region text is untouched, only tool outputs are cut, to prevent a single giant tool result from blowing up)
```

---

## 12. Emergency drop — (aligned with magic-context, high-pressure only)

```
   if usagePct ≥ EMERGENCY_DROP_PCT(85%):
      Scan tool outputs in the non-protected region, group by tier
      Each tier keeps its most recent TIER_RECENCY_RESERVE(20%) (recency reserve)
      The rest are [replaced entirely by a sentinel] in T3 → T2 → T1 order (= dropped, not truncated)
      (still leaves a retrievable stub so the LLM can fetch it from the MD)
```

Difference from §11's tier truncation:
- **§11 truncation**: always runs, cuts large tool outputs down to a few K, keeps the head.
- **§12 drop**: runs only under real pressure (≥85%), replaces the whole tool output with a one-line stub. Drops low-value + old ones first.

---

## 13. Render loop → assemble the final message array

```
   for each tail message:
      tagCounter++                              ← tag each with a §N§ label
      if dropped / deduped and not pinned → render as empty
      inject time-gap markers (+5m / +2h / +3d …)
      inject compartments (before the tail, as compressed history summaries)
      inject <project-memory> / <facts> / value/culture character layer
      pinned messages are exempt from all compression
```

---

## 14. Orphan tool_result sweep + write-back

```
   ① Collect all live tool_use callIDs in the tail
   ② Delete orphan tool_results whose paired tool_use was trimmed (otherwise Anthropic 400)
   ③ Normalize the trailing boundary (can't end with assistant or a bare tool_result, else prefill error)
   ④ messages.splice(0, messages.length, ...rendered)   ← in-place replace (the proxy object requires splice)
   ⑤ Stamp the RENDERED_SENTINEL idempotency marker
```

**At this point, the payload for the LLM is assembled, transform returns, and the echo appears.**

---

## 15. Memory path (idle, fully async, does not block echo)

When the session goes idle, it drains the pendingIdleWork queue:

```
session.idle event
   │
   ├─ historian compression: compress the oldest batch into a compartment (sub-session, using the historian agent)
   │
   ├─ lightweight linking: store user/assistant text into the memory graph + build associative edges (FTS+Jaccard)
   │
   ├─ transcript archiving: mirror the whole session verbatim to transcripts/<sid>.md (including raw tool output)
   │     ← this is the file the stubs in §6/§11/§12 tell the LLM to grep
   │
   ├─ Dreamer (at most once per day, cooldown-lock): extract long-term fact / value / culture from episodes
   │
   └─ gap backfill: backfill messages the transform may have missed into the memory graph
```

---

## Worked example: one message through the whole pipeline

This walks a **single user turn** through the pipeline end to end, showing the `messages[]` state
after each stage. To keep it readable the numbers are scaled down (a 20-message session, a small
budget); the *behaviour* matches the code exactly. Legend:

```
  [U] user text      [A] assistant text     [T] tool call + output
  §N§ = render tag    ▓ = compartment (summary)    ░ = dropped/emptied
  ✂ = truncated       ⭑ = protected (last ~2 user turns)
```

### Setup — what the host hands us

The user just typed **"用 C 方案"** (answering an earlier A/B/C question). OpenCode calls
`messages.transform` with the full live array. Say the session already has **1 compartment**
covering the oldest 8 messages, so the DB looks like:

```
 opencode.db (host)          compartments table (ours)
 ─────────────────           ──────────────────────────
 msg #0..#19 (20 msgs)       ▓ cmp-1: startOrd=0 endOrd=7
   each with tokens.*          endMessageId = id(msg#7)
                               p1/p2/p3 summary of msgs #0–7
```

The incoming array (indices = ordinals here for simplicity):

```
 idx: 0   1   2   3   4   5   6   7 │ 8   9   10  11  12  13  14  15  16  17  18  19
      U   A   T   A   U   A   T   A │ U   A   T   A   U   A   T   A   U   A   U   A(?)
      └──────── covered by cmp-1 ───┘ └──────── not yet compressed ─────────────┘ ▲
                                                                        msg#18 = "用 C 方案" (just typed)
      (msg #2/#6/#10/#14 are big tool outputs; #10 is a 60KB bash dump)
```

### Stage 2 — idempotency guard

First pass on this array → the `RENDERED_SENTINEL` Symbol is absent → **proceed**.
(If OpenCode re-invokes transform on the *same* array object this turn, the Symbol is now set → instant no-op, no double-compression.)

### Stage 6–8 — usage & scheduler

```
 getContextUsage(sid) → last finished assistant tokens = 138k / 200k  → usagePct = 69%
 isMidTurn? last DB assistant $.finish = "stop" (not "tool-calls")     → false
 scheduler: usagePct 69 ≥ 65 and not mid-turn                          → "execute"
```

### Stage 9–10 — compartments & tail boundary

```
 compartments = [cmp-1]         (endMessageId = id(msg#7))
 tailStart = indexOf(id msg#7) + 1 = 8      ← located by message-id, NOT a stored index

 ┌─ compartment region ─┐┌──────────── tail (verbatim-ish) ────────────┐
 ▓▓▓▓▓▓▓▓ (cmp-1 = #0–7)  #8 #9 #10 #11 #12 #13 #14 #15 #16 #17 #18 #19
```

### Stage 12 — microCompact (L1): stub the 60KB tool output

msg **#10**'s `state.output` is 60 000 chars > `MICROCOMPACT_TRIGGER_CHARS (50000)` → keep first
2 000 chars + a retrievable stub. Nothing else changes yet.

```
 before: #10 [T bash] state.output = "<60000 chars>"
 after : #10 [T bash] state.output = "<2000 chars>…[tool output compacted — kept first 2000 of 60000 chars]
                                       [retrieve verbatim: grep the tool block name=\"bash\" args={…} in
                                        ~/.local/share/ai-agent-local-memory/transcripts/<sid>.md]"
```

This mutates the shared object ref, so the next stage measures the **shrunken** size.

### Stage 13 — protectLine: anchor the last ~2 user turns

Scan backward for `hasMeaningfulUserText`, stop at the 2nd one:

```
 …#16[U] …#17[A] …#18[U="用 C 方案"] …#19[A]
        2nd meaningful user ↑           1st meaningful user ↑ (=#18)
 protectLine = 16       (guardrails: span≤80 ✓, ≥floor ✓, usagePct 69 < 70 ✓ so protection is ON)
```

`#16..#19` become the ⭑protected region — they will not be compressed away, so the model still
sees the A/B/C question (#16/#17) that "用 C 方案" refers to.

### Stage 14 — budget scan (L2): where does the tail start?

`tailBudgetTokens = max(20k, (110k − 36k)×1.0) = 74k`. Accumulate from the end backward until it
overflows; suppose it fits from **#12** onward:

```
 scan: #19+#18+#17+…+#12 = 71k ≤ 74k, add #11 → 79k > 74k → break
 startIdx = 12
 protect pull-back: protectLine(16) is NOT < startIdx(12) → no change
 tail = messages.slice(12) = #12 … #19
```

State now:

```
 ▓ cmp-1 (#0–7)   [#8 #9 #10✂ #11]  ← dropped by budget scan (before startIdx)
                   └── these fall out of the window; their gist is safe in cmp-1 only if compressed;
                       #8–#11 are NOT in cmp-1, so the historian (Stage 17) will later compress them.
 tail →            #12 #13 #14 #15 │ #16 #17 #18 #19
                   └─ compressible ─┘ └── ⭑protected ──┘
```

### Stage 16 — reduce *within* the tail (boundary is now fixed)

```
 tail:  #12[U] #13[A] #14[T] #15[A] │ #16[U] #17[A] #18[U] #19[A]
                                      └────── protected: untouched ──────┘

 16b structural noise:  step-start/step-finish parts in #12–#18 → emptied (last msg #19 exempt)
 16c caveman (oldest hardest, only the non-protected front ~part):
        #12 text → "ultra"  #13 → "full"  #14 n/a(tool)  (protected #16–19 skipped)
 16d tool truncation:  #14[T grep] tier T2 → state.output capped at 2000 + stub
 16e protected tool cap: (none >16k here)
```

### Stage 12/emergency — only if usagePct ≥ 85%

Here usagePct is 69% (< 85) → **emergency drop does not run**. (If it were ≥85%, T3→T2→T1 tool
outputs outside the recent-20% would be replaced wholesale by one-line stubs.)

### Stage 13/render — assemble the outgoing array

```
 OUTPUT sent to the LLM (top → bottom):

   <compartment ▓>  p1/p2/p3 summary of msgs #0–7      ← from cmp-1
   §12§ [U] "ultra-compressed #12"
   §13§ [A] "full-compressed #13"
   §14§ [T grep] "<2000-char output>✂ …[retrieve verbatim: …]"
   §15§ [A] "…"
   §16§ ⭑[U] "……方案 A / B / C ……"        ← verbatim (protected)
   §17§ ⭑[A] "……你选哪个？……"              ← verbatim (protected)
   §18§ ⭑[U] "用 C 方案"                     ← the newest user msg, never dropped
   §19§ ⭑[A] …
   + injected: <project-memory>, <facts>, value/culture character layer, time-gap markers
```

### Stage 14/sweep — orphans + write-back

```
 ① live tool_use callIDs in tail = {#14}
 ② any tool_result whose tool_use was trimmed (e.g. #10's pair fell out) → deleted (else Anthropic 400)
 ③ trailing boundary ok (ends on assistant #19; if it ended on a bare tool_result it'd be normalized)
 ④ messages.splice(0, messages.length, ...rendered)   ← in-place replace
 ⑤ stamp RENDERED_SENTINEL
 → transform returns, echo of "用 C 方案" appears.
```

### Later, on idle (Stage 15) — async, does not block the echo

```
 session.idle:
   ├─ historian: compress the now-old #8–#11 batch → new ▓ cmp-2 (endMessageId = id #11)
   │     next turn, tailStart jumps to 12 automatically
   ├─ transcript: mirror the WHOLE session verbatim (incl. the 60KB #10 output) → transcripts/<sid>.md
   │     ← this is what every ✂ stub tells the model to grep
   ├─ lightweight linking: store #18/#19 text as graph nodes + FTS/Jaccard edges
   └─ dreamer (≤1×/day): mine facts/values from episodes
```

**Net effect this turn:** a 20-message array (with a 60KB blob) that would have blown the window was
sent as `1 compartment summary + 8 tail messages` (4 of them verbatim-protected), staying under the
74k tail budget — while the newest "用 C 方案" and the A/B/C it references were both preserved, and
nothing was truly lost (the full text lives in the compartment summary, the graph, and the transcript MD).

---

## Appendix: key thresholds (hard-coded constants, not config)

| Constant | Value | Meaning |
|---|---|---|
| `EXECUTE_THRESHOLD` | 65% | Usage at which the scheduler triggers historian compression |
| `TARGET_USAGE_PCT` | 0.55 | Target fraction of the context window the tail occupies |
| `FORCE_COMPARTMENT_PCT` | 80% | Force-compression threshold |
| `EMERGENCY_DROP_PCT` | 85% | Threshold for emergency tool-output drop |
| `ABORT_PCT` | 95% | Give-up threshold |
| `HISTORIAN_CHUNK_PCT` | 0.25 | Fraction of the window the historian compresses per run |
| `MICROCOMPACT_TRIGGER_CHARS` | 50000 | Char count that triggers giant tool-output truncation |
| `TIER_RECENCY_RESERVE` | 0.2 | Fraction each tier keeps recent during emergency drop |
| `MAX_PROTECT_SPAN` | 80 | Max messages the protect line looks back |
| `HARD_TAIL_CAP` | 500 | Tail hard cap (performance backstop) |
| `SYSTEM_TOOLS_RESERVE_PCT` | 0.18 | Fraction reserved for system+tools |

These are internal tuning constants, not exposed via the config file. For configurable options see [`CONFIGURATION-REFERENCE.md`](./CONFIGURATION-REFERENCE.md).
