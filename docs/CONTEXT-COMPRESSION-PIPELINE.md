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
