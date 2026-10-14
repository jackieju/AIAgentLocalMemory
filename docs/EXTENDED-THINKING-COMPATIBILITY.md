# Extended Thinking, Reasoning Parts, and Context Compression Compatibility

This document records how `ai-agent-local-memory` interacts with provider-side
"thinking" / "reasoning" features such as Anthropic Extended Thinking, Gemini thought
signatures, OpenAI reasoning items, and plain-text `<think>` models such as DeepSeek R1
or Qwen.

## The important distinction

There are two different things often called "thinking":

| Mechanism | What it is | Owned by | Stored as |
|---|---|---|---|
| Provider-side extended thinking | The model spends extra output tokens on a hidden or semi-visible reasoning block before final answer generation | Model provider / host runtime | OpenCode-normalized `reasoning` / `thinking` parts, provider metadata, sometimes signatures |
| Plugin CoT capture | A training-data feature where the plugin asks the model to emit plain `<thinking>...</thinking>` text for distillation | `ai-agent-local-memory` | JSONL training examples, only when `cotStrategy` is enabled |

Seeing `Thought · 22.6s` in the UI means provider-side extended thinking happened. It does
**not** mean the plugin captured a plain-text chain of thought for local-model training.
The plugin's CoT capture is controlled separately by `localLlm.training.cotStrategy`, which
currently defaults to `none`.

## Why extended thinking can break under compression

Some providers do not treat thinking blocks as ordinary text. Anthropic Extended Thinking is
the most important example:

- thinking blocks carry a signed/encrypted integrity payload;
- replaying a signed thinking block requires the preceding conversation prefix to remain
  consistent with the prefix that existed when the block was produced;
- if a context compressor rewrites earlier turns, injects prefixes, changes timestamps, or
  partially removes reasoning parts, the provider can reject or drop the block.

The observed failure mode in a very large session was:

```text
assistant message has reasoning/signature metadata
assistant message has no final text part
finish=stop, no API error
UI shows thinking / spinner behavior but no final answer
```

The practical cause was not "the model cannot answer". The model could still reason
internally. The failure was in the transport/replay boundary for provider-side thinking
blocks after historical context had been rewritten by compression.

## Current compressor behavior

Implementation file:

```text
packages/core/src/context-compressor.ts
```

### 1. Recent tail is protected by position

The compressor protects the newest messages by position, not by provider name. In the core
transform this is represented by `isProtected` and a protected tag floor derived from
`PROTECTED_TAGS_COUNT`.

The important property is:

```text
recent protected tail => reasoning/thinking parts are not cleaned or truncated
```

This is provider-agnostic. It does not care whether the model is Anthropic, OpenAI,
Gemini, DeepSeek, or Qwen.

### 2. Old reasoning/thinking is removed from context

Outside the protected tail, old reasoning parts are removed:

```ts
part.type !== "reasoning" && part.type !== "thinking"
```

This is intentional. Old reasoning is high-token, fragile context and usually harmful to
feed back indefinitely. It is not treated as long-term memory.

For models that emit inline thinking text, the compressor also strips inline tags from old
text:

```text
<thinking>...</thinking>
<think>...</think>
```

This covers DeepSeek/Qwen-style plain-text reasoning.

### 3. No signature-aware provider branch exists

The compressor does **not** parse, preserve, strip, or validate Anthropic signatures
explicitly. There is no provider-specific block such as:

```ts
if (provider === "anthropic") { ... }
```

Signatures survive only when the whole part survives. The real safety mechanism is
positional protected-tail passthrough.

### 4. Remaining risk: prefix injection still mutates text parts

The compressor also injects bookkeeping markers into text parts, including:

- `§N§` tag prefixes;
- elapsed-time comments such as `<!-- +Xm -->`.

Those markers are useful for `neural_expand`, `neural_reduce`, and chronological context.
However, they mutate the textual prefix around reasoning blocks. For providers with strict
prefix-bound reasoning validation, this can matter.

The current protection is therefore best described as:

```text
provider-agnostic enough for common normalized reasoning parts,
but not fully signature-aware for every provider that binds reasoning to exact prefixes.
```

## Provider compatibility matrix

| Provider/model family | Thinking style | Expected risk with compression |
|---|---|---|
| Anthropic Claude Extended Thinking | Signed thinking blocks with prefix binding | High risk if protected turns are rewritten; this is the bug class already observed |
| Google Gemini thought signatures | Signature-like thought replay constraints | Similar risk class; must be tested before claiming full support |
| OpenAI o-series / GPT-5 reasoning | Server-managed or encrypted reasoning items | Risk exists, but failure mode may differ from Anthropic's blank-final-output symptom |
| DeepSeek R1 | Plain `<think>` text | Low signature risk; old inline thinking can be stripped like normal text |
| Qwen thinking mode | Mostly plain text / explicit thinking mode | Low signature risk; behaves closer to DeepSeek than Anthropic |

## Practical rules

### For live context compression

1. Keep recent turns as intact as possible.
2. Do not rewrite recent signed reasoning blocks.
3. Drop or summarize old reasoning instead of feeding it forever.
4. Treat provider-side reasoning as fragile runtime state, not as stable long-term memory.

### For local-model distillation

Provider-side extended thinking is not the same thing as plugin CoT capture.

If training data is desired, enable the plugin's explicit plain-text capture path:

```json
{
  "localLlm": {
    "training": {
      "cotStrategy": "thinking-tag"
    }
  }
}
```

This asks the model to emit a separate plain-text `<thinking>...</thinking>` block that can
be stored in JSONL. It is independent of provider-side Extended Thinking.

Do not assume `Thought · Ns` UI events are automatically usable as distillation data.
Provider-side thinking may be hidden, signed, encrypted, empty in text form, or subject to
provider replay constraints.

## Open follow-up

For complete cross-provider safety, the compressor should consider one stricter invariant:

```text
If a message is inside the protected tail, do not inject § tags or elapsed-time comments
into that message's text parts either.
```

That would make the protected tail closer to a true byte-preserving passthrough and reduce
risk for any provider that binds reasoning blocks to exact context prefixes.
