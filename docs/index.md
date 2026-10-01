# AI‑Agent‑Local‑Memory

> Author: Jackie Juju
> Local‑first, traceable, drift‑resilient, self‑iterable agent memory runtime — not just another vector‑store wrapper.

⚠️ **This is NOT AGI.**
This is a scaffolding‑style external‑memory system for LLMs.
It does not modify model weights, and it has no native world‑model, no intrinsic goals, no consciousness.

[![status](https://img.shields.io/badge/status‑experimental‑orange)]()
[![local‑first](https://img.shields.io/badge/local‑first‑✅‑green)]()
[![traceable](https://img.shields.io/badge/full‑trace‑auditable‑blue)]()

---

## What is this?

Most open‑source agent‑memory projects only solve one piece of the puzzle:
some rearrange context windows, some store facts, some implement vector retrieval — leaving you to build fragile glue code between components.

**AI‑Agent‑Local‑Memory** provides a complete closed‑loop stack:

> Append‑Only Raw Log → Multi‑layered Indexing & Retrieval → Traceable Context Compression
> → Background pre‑computation (Dreamer) → Non‑intrusive full‑trace observation (Observer)
> → Optional teacher‑student self‑distillation (Teaching‑Mode)
> → Optional commonsense‑grounded normative reasoning (Commonsense Foundation)

Everything can run self‑hosted; no mandatory closed‑cloud API required.

---

## Core non‑negotiable design principles

1. **Append‑only RawLog is the single source of truth**
Raw events are never overwritten, deleted or edited.
All summaries, views, insights and interpretations are derived data, and must carry valid `source‑id` pointing back to original records.

2. **Compression is not destruction**
Compression generates temporary presentation‑views only.
It never replaces or erases source evidence.
Any compressed snippet can be expanded back to full original text.

3. **Derived outputs are hypothetical, not ground truth**
LLM‑produced summaries, associations or inferences are marked `hypothetical`.
They may act as hints or suggestions, but must never become authoritative facts.

4. **Built‑in guard against recursive drift**
Pre‑computed derived views cannot be used as primary input for another round of deep re‑abstraction.
This prevents gradual “memory creep” caused by repeatedly summarizing summaries.

5. **Observation must be side‑effect‑free**
The Observer trace logger never modifies main execution flow. It only records.

6. **Safe baseline is always enabled; powerful advanced features are opt‑in**
High‑potential, high‑uncertainty experimental modules are OFF by default.
You explicitly turn them on when you understand their trade‑offs.

---

## Architecture overview

This system is organized in five logical layers:

- **Layer 1 — Trusted Base Layer (always on)**
  Append‑only RawLog + traceable context compressor + cross‑session persistent memory.
  Deterministic storage, no speculative LLM mutation.

- **Layer 2 — Dreamer background pre‑computation (opt‑in)**
  When system load is low, Dreamer scans the original RawLog and builds pre‑computed views & event‑chain associations.
  It speeds‑up runtime response, but all outputs are hypothetical cache — never truth.

- **Layer 3 — Observer full‑trace recorder (always on)**
  Passively captures complete execution: user input, full thinking‑chain, tool I/O, context snapshot, retrieval log, final decision.
  Traces can be used for debugging, backtesting memory strategies, or filtered for SFT / DPO / ORPO fine‑tuning.

- **Layer 4 — Teaching‑Mode teacher‑student distillation (opt‑in, experimental)**
  Local “student” model attempts tasks first; falls back to a stronger “teacher” model on failure / low confidence.
  Complete trajectories are logged by Observer for offline distillation. Not enabled by default.

- **Layer 5 — Commonsense Foundation normative reasoning (opt‑in, experimental)**
  Provides reference to immutable commonsense & basic moral‑intuition sources.
  Helps the agent reason through ambiguous grey‑zone situations — without replacing hard safety guards.

> See full specification: `ARCHITECTURE‑SAFETY‑WHITEPAPER.md`

---

## What makes it different from similar projects

- **Magic‑Context**: excellent context re‑arranger, but no persistent long‑term event log, no tracing, no self‑improvement loop.
- **Good‑Memory**: solid evidence‑based fact store, but leaves context assembly & trace recording for you to implement.
- **Mem0 / MemGPT**: convenient, but often allows summaries to silently replace original evidence, hard to fully audit.

AI‑Agent‑Local‑Memory aims to close those gaps by keeping source‑evidence intact, reference‑integrity enforced, and the whole stack auditable.

---

## Important limitations & disclaimers

- It cannot eliminate LLM hallucination entirely.
- Traceable does not mean infallible; “having a source” does not guarantee correct interpretation.
- Experimental modules carry known risks of drift, over‑confidence or learned bad habits.
- **Do NOT use for high‑stakes safety‑critical workflows without independent validation.**

---

## Quick start (high‑level preview)

> Detailed installation & API docs will follow as the project matures.
1. Initialize RawLog storage

2. Enable Observer trace capture (on by default)

3. Run with base memory & context compressor

4. (Optional) Turn on Dreamer for background pre‑compute

5. (Optional) Turn on Teaching‑Mode for local distillation

6. (Optional) Load Commonsense Foundation corpus
---

## License & note

This is an independent open‑source work by Jacky Gigi.
It is a practical engineering exploration of traceable, local‑first agent memory, not a “solution to AGI alignment”.
Use at your own discretion.