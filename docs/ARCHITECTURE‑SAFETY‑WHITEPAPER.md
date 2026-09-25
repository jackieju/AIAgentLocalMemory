# AI‑Agent‑Local‑Memory — Architecture & Safety Whitepaper
Author: Jacky Gigi

⚠️ This document describes internal design, invariants, safety boundaries and risk model.
This is not user manual.

---

## Core Project Statement

AI‑Agent‑Local‑Memory is a complete local‑first, source‑traceable, drift‑resilient, auditable agent memory & context‑orchestration runtime.
It does NOT patch or rewrite LLM weights.
All memory, reasoning support and safety scaffolding lives outside the model, as inspectable application‑layer logic.
This is “scaffolding intelligence”, not native AGI.

---

## The Five Logical Layers

### Layer 1 — Trusted Base Layer (Always Enabled, Production‑Safe Baseline)
This is the immutable foundation; no speculative LLM writes are allowed here.

- **Append‑Only RawLog**
Every user message, model output, complete thinking‑chain, tool call, system event is appended with a globally unique source‑id.
Records can never be overwritten, edited or deleted.

- **Traceable Context Compressor**
Compression builds lightweight views for the context window.
It never deletes or modifies RawLog entries.
Every compressed fragment holds a source‑id, and can be expanded back to full original text.

- **Cross‑Session persistent memory manager**
Separates: long‑term global storage / active session working set / temporary context view.
When a session closes, hot working‑state is archived, raw history remains intact.
New sessions retrieve relevant history by multi‑weight matching — not by dumping the whole log.

> Invariant: Layer 1 data is the only system‑defined “source of truth”.

### Layer 2 — Dreamer Background Pre‑Computation (Optional, Acceleration Only)

Inspired by Magic‑Context, but transformed from request‑time processing into idle‑time asynchronous pre‑computation.
When host GPU / CPU load is low:
- Scan original RawLog
- discover possible event chains, entity links, timing relationships
- generate pre‑ranked suggestions and compact hypothetical views

Hard safety invariants for Dreamer:
- Dreamer can only read RawLog; it **cannot use previous Dreamer‑output as primary input** (anti‑recursive‑drift)
- All outputs tagged `hypothetical_view` or `suggested_insight`
- Never written into RawLog as ground‑truth records
- Enforced cool‑down interval to prevent over‑processing & resource‑spam
- Pre‑computed caches can be invalidated and rebuilt at any time

Dreamer is a performance accelerator & pattern‑finder — it is NOT a truth‑discovery engine.

### Layer 3 — Observer Full‑Trace Recorder (Always Enabled)

Observer runs as a purely side‑channel logger, zero interference with agent execution.
It captures:
- user input
- full raw model thinking‑chain
- final response
- all tool‑call arguments + tool return payload
- the exact context snapshot that the model saw at that moment
- memory retrieval list with individual retrieval scores
- final decision reasoning

Value:
- 100% deterministic replay of past agent runs
- debug memory‑ranking & compression behaviour
- back‑test alternative memory algorithms against real historical traces
- produce reasoning‑rich datasets for SFT / DPO / ORPO fine‑tuning

Important caveat:
Traces are *what happened*, not automatically “what should have happened”.
A trace may contain flawed reasoning or mistaken actions; traces must be quality‑filtered before training.

### Layer 4 — Teaching‑Mode Teacher‑Student Self‑Distillation (Experimental · Default OFF)

Workflow:
1. A smaller local “student” model attempts to solve the task first
2. If consistency sampling / tool checks / confidence metrics indicate failure → escalate to powerful “teacher” LLM
3. Observer saves the full trial: student attempt + teacher’s complete correct reasoning
4. Off‑line pipelines may filter high‑quality samples to distill the student model

Built‑in risk mitigations:
- Do NOT rely only on model self‑reported “uncertainty”; combine multiple objective signals
- Bad / failed trajectories are tagged and excluded from training pools
- Guards against the student learning to lazily “call teacher for everything”
- Entire feature is marked experimental and opt‑in

### Layer 5 — Commonsense Foundation Normative Reasoning (Experimental · Default OFF)

Instead of hard‑coded rule‑lists or weight‑locked RLHF alignment, this module gives the agent read‑only access to a library of timeless plain commonsense & basic moral intuitions.
During high‑impact decisions the agent may retrieve these source texts and perform deliberative reasoning.
Full specification: see `COMMONSENSE‑FOUNDATION‑SPEC.md`

---

## System‑Wide Risk Declarations

1. **This system cannot fully eliminate LLM hallucination**
Even with perfect source‑logging, the model may mis‑interpret valid source records.

2. **Similarity ≠ causality or relevance**
Hybrid retrieval improves recall, but cannot guarantee it always fetches the causally correct events.

3. **Derived data must never become new ground‑truth**
Summaries, associations, dreamer insights, interpretations are hints only.
RawLog is the only trusted anchor.

4. **Full trace does not equal perfect training data**
Models often write plausible‑sounding “post‑hoc rationalization” in their thinking block, not their real reasoning path.
Unfiltered trace‑fed fine‑tuning risks cementing errors.

5. **Experimental features are not production‑grade**
Dreamer, Teaching‑Mode, Commonsense reasoning are powerful but contain unresolved edge‑case risks.
They are switched off by default.

6. **No “magic safety switch” exists**
Commonsense deliberation improves explainability of judgements, but it cannot replace lightweight deterministic bottom‑line safety filters.

---

## Official Default Feature Switch Policy

✅ **Enabled by default (trusted baseline):**
- Append‑only RawLog storage
- Traceable context compression
- Cross‑session memory manager
- Observer full trace recorder

⚠️ **Disabled by default (experimental, user must explicitly opt‑in):**
- Dreamer background pre‑computation
- Teaching‑Mode teacher‑student distillation
- Commonsense Foundation deliberative reasoning

---

## Architectural golden rule

> You can build smart suggestions on top of evidence.
> But you must never let suggestions become the evidence.