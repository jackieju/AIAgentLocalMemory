# Commonsense Foundation — Specification
Author: Jacky Gigi
Experimental module for AI‑Agent‑Local‑Memory | Default: OFF

---

## Background of this design

Today’s mainstream LLM safety has two well‑known weaknesses:

- Rule‑based guardrails are enumerative: they can only block cases humans have already thought of; novel grey‑zone scenarios often slip through or trigger false positives.
- RLHF / DPO weight‑alignment embeds values inside model weights as a black box.
You cannot inspect *which reason* led to a decision, you cannot audit or trace the value‑judgement source.

Commonsense‑Foundation explores an alternative path:
**Do not hard‑code values inside weights. Store basic human commonsense & intuitive moral reference texts as immutable, readable external evidence.
Let the agent retrieve, deliberate and reason with them — just like a human refers to shared life‑principles when facing unfamiliar dilemmas.**

This does NOT promise “perfect moral behaviour”. It aims for **traceable, explainable deliberation**.

---

## Core philosophy

Human moral intuition is not born as a complete lookup‑table.
We absorb simple shared principles from texts, stories and daily examples, then continuously test & calibrate them against real‑life experience.
We mimic that process at system level, without rewriting model weights.

- Source corpus: plain, ancient commonsense texts (e.g. selected passages from The Analects and similar universal‑intuition material)
- Source entries are permanently read‑only
- The agent may reference them during high‑stakes decisions
- All deliberation reasoning is captured inside `thinking` blocks and saved by Observer
- Background modules may generate temporary hypothetical interpretations — but never rewrite the original source.

---

## Defined record types

### foundation_source (immutable anchor)
```yaml
type: foundation_source
source_type: ethics_commonsense
content: original unmodified text
source_id: global unique id
create_time: timestamp
mutable: false
Once written: no edit, no delete, no append, no re‑phrasing allowed by any component.

ethical_interpretation (temporary hypothetical only)
type: ethical_interpretation
source_id: links back to one or more foundation_source
content: model‑generated understanding & possible application scenarios
confidence: low / medium (HIGH confidence is FORBIDDEN)
is_hypothetical: true
expire_time: auto‑expires after defined TTL
mutable: true
These are NOT new axioms. They are disposable working notes, they will expire and need to be re‑derived again from original source.
Non‑breakable enforcement rules

Rule 1: All foundation‑source entries are permanently read‑only.
No module, no LLM, no Dreamer can alter them.

Rule 2: No recursive interpretation‑chains.
When re‑examining commonsense material, processing must start from foundation_source original text.
The system cannot use old ethical_interpretation records as primary input for new deep‑interpretation.

Rule 3: When making a value‑driven decision, explicit source citation is mandatory.
In its thinking trace the agent must:
‑ quote relevant original foundation‑source snippet(s)
‑ note possible conflicting principles
‑ explain its weighing logic
‑ state final conclusion
The full chain is logged by Observer for later audit.

Rule 4: Two‑tier safety — never downgrade the hard baseline.
‑ Bottom layer: simple, deterministic safety filters (keyword checks, lightweight safety classifier) — hard physical guardrail.
‑ Upper layer: commonsense deliberative reasoning — explains grey‑zone trade‑offs.
The deliberation layer is an interpreter, NOT a replacement for the hard safety fence.

Rule 5: Interpretations never become training‑gold‑standard.
ethical_interpretation traces are marked unvalidated; they do NOT automatically flow into the teacher‑student fine‑tuning dataset.
Explicit limits & honest disclaimer

• This module cannot guarantee safe or correct judgements.

• Ancient commonsense texts are polysemous; an LLM can still selectively quote or misinterpret them.

• Different principles may conflict in complex real‑world situations; the agent may pick a sub‑optimal balance.

• It is not a “moral oracle”. It is an audit‑able deliberation reference system.

• Must not be deployed for high‑risk, life‑critical scenarios without independent human oversight.
Why this matters

Most alignment solutions try to “force the model to obey”.
This design tries to give the agent something it can consult, cite and show its work.
Safety becomes visible, not hidden inside black‑box weights.
---