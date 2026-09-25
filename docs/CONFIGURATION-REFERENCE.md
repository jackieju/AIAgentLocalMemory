# Configuration Reference

> **All configurable options** for the `ai-agent-local-memory` plugin.
>
> Config file: `neural-context.json`
> Lookup order (first one found wins):
> 1. `<project>/.opencode/neural-context.json`
> 2. `<project>/neural-context.json`
> 3. `~/.config/opencode/neural-context.json` (global — most common)
>
> Every field is **optional**. The plugin runs fine with no config file at all (using the defaults listed below).
>
> 🇨🇳 中文版：[CONFIGURATION-REFERENCE_CN.md](./CONFIGURATION-REFERENCE_CN.md)

---

## Table of Contents

- [1. Basics & context budget](#1-basics--context-budget)
- [2. Memory recall strategy](#2-memory-recall-strategy)
- [3. LLM / Embedding](#3-llm--embedding)
- [4. Local LLM three modes (growing agent)](#4-local-llm-three-modes-observer--student--primary)
- [5. LoRA training (optional)](#5-lora-training-optional)
- [6. Dreamer (daily memory consolidation)](#6-dreamer-daily-memory-consolidation)
- [7. Idle reading](#7-idle-reading)
- [8. Multi-machine sync](#8-multi-machine-sync)
- [9. Coexistence with other context managers](#9-coexistence-with-other-context-managers)
- [Full config example](#full-config-example)

---

## 1. Basics & context budget

| Field | Type | Default | Meaning |
|---|---|---|---|
| `injectSystemPrompt` | `boolean` | `true` | Whether to inject the plugin's system-prompt usage guide (tool usage, recall hints) |
| `contextWindowTokens` | `number` | auto-resolved by model | **Force** the context-window token count. If omitted, resolved from the last-used model (Opus/Sonnet=200K, GPT-5.x/6=400K, Kimi=256K, DeepSeek=128K, fallback 128K) |
| `budgetRatio` | `number` | (reserved) | Legacy reserved field; compression budget is currently controlled by the internal constant `TARGET_USAGE_PCT=0.55` |
| `protectedTags` | `number` | `20` | Protected-tag count: the most recent N messages are exempt from caveman compression and tool-output truncation |
| `systemToolsReservePct` | `number` | `0.18` | Fraction of the window reserved for the system prompt + tool definitions, preventing overflow once the conversation fills the budget |

> **Other compression thresholds** (EXECUTE_THRESHOLD=65%, EMERGENCY_DROP_PCT=85%,
> HISTORIAN_CHUNK_PCT=25%, etc.) are internal tuning constants and are not exposed via config.
> The full list is in the appendix of [`CONTEXT-COMPRESSION-PIPELINE.md`](./CONTEXT-COMPRESSION-PIPELINE.md).

---

## 2. Memory recall strategy

| Field | Type | Default | Meaning |
|---|---|---|---|
| `recallStrategy` | `"plugin"` \| `"llm"` | `"plugin"` | Which method to use for cross-session memory recall |

- **`"plugin"`** (default): in-house engine — FTS5 full-text search + embedding semantic search + spreading-activation associative recall. **Spends no extra LLM tokens.**
- **`"llm"`** (Claude Code style): FTS builds a candidate shortlist → an LLM picks the ≤5 most relevant from it. Recall quality is closer to human judgment, but every recall costs one LLM call.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `readExtractBackend` | `"server"` \| `"local"` | `"server"` | Which backend `neural_read` (reading/curation) uses for extraction. `server` = main LLM (interruptible sub-session); `local` = the local LLM configured under `localLlm` (Ollama etc.) |

---

## 3. LLM / Embedding

Used for **memory extraction, historian summarization, and building embedding semantic edges**. The `llm` here is a lightweight model used internally by the plugin (distinct from OpenCode's main conversation model).

### `llm` (memory extraction / historian summarization)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `llm.provider` | `"openai"` \| `"ollama"` \| `"custom"` | — | Provider type |
| `llm.baseUrl` | `string` | `http://localhost:6655/openai/v1` | API endpoint |
| `llm.apiKey` | `string` | `$OPENAI_API_KEY` | API key |
| `llm.model` | `string` | — | Model name |

### `embedding` (semantic vectors for embedding edges + semantic recall)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `embedding.provider` | `"openai"` \| `"ollama"` \| `"custom"` | — | Provider type |
| `embedding.baseUrl` | `string` | falls back to `llm.baseUrl` or `http://localhost:6655/openai/v1` | API endpoint |
| `embedding.apiKey` | `string` | falls back to `llm.apiKey` or `$OPENAI_API_KEY` | API key |
| `embedding.model` | `string` | — | e.g. `text-embedding-3-small` |

> The plugin runs without embedding configured — cross-session recall just degrades to pure FTS (may miss when vocabulary doesn't overlap).

---

## 4. Local LLM three modes (Observer / Student / Primary)

This is the core switch for the "growing agent": it lets a small local model (e.g. Ollama's Qwen3) participate in different roles, gradually learning the main model's capabilities.

**Omit the entire `localLlm` block → the local LLM is fully disabled and the plugin runs as a plain memory/compression tool.**

| Field | Type | Default | Meaning |
|---|---|---|---|
| `localLlm.provider` | `"ollama"` \| `"openai"` \| `"custom"` | — | Local LLM provider |
| `localLlm.endpoint` | `string` | — | Endpoint, e.g. `http://localhost:11434` |
| `localLlm.model` | `string` | — | e.g. `qwen3:14b` |
| `localLlm.apiKey` | `string` | — | API key (usually not needed for Ollama) |
| `localLlm.mode` | `"observer"` \| `"student"` \| `"primary"` | **required** (if `localLlm` is present) | The local model's role |

### The three modes

| mode | What the local model does | Training data |
|---|---|---|
| **`observer`** | Watches only: when the main model (or `neural_ask_server`) answers, the local model also generates an answer; the two are compared for divergence and stored as a training pair. **Does not affect the main conversation.** | Accumulates a lot (default triggerCount=100) |
| **`student`** | Injects instructions into the system prompt: when the local model's confidence is below threshold / after repeated user corrections, it proactively calls `neural_ask_server` to consult the main model and learn. | Medium (default triggerCount=50) |
| **`primary`** | The local model is the primary; it only escalates to the main model when the user explicitly says "ask the big model". | Medium |

### `localLlm.confidence`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `confidence.userThreshold` | `number` | `0.5` | Below this confidence (student mode), proactively escalate |
| `confidence.autoEscalateAfter` | `number` | `3` | After N user corrections, automatically lower confidence and lean toward consulting |

### `localLlm.training` (training-data collection)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `training.triggerCount` | `number` | observer=`100`, others=`50` | How many training pairs to accumulate before triggering one LoRA training run |
| `training.cotStrategy` | `"thinking-tag"` \| `"post-rewrite"` \| `"none"` | **`"none"`** | Whether to capture chain-of-thought (CoT) for training data |

**`cotStrategy` details** (default `none` = off; turn on only if you want it):
- **`none`** (default): don't capture CoT, only store Q&A pairs. **Reasoning training is optional and off by default.**
- **`thinking-tag`**: force the model to emit reasoning inside `<thinking>` tags and capture that CoT.
- **`post-rewrite`**: after answering, ask the model to write out its reasoning process.

---

## 5. LoRA training (optional)

LoRA training is **not a config field** — it's an independent flow triggered by `localLlm.training.triggerCount`:

- Once training data reaches `triggerCount` entries, the plugin calls `packages/lora-pipeline/auto-train.sh` to train automatically.
- Manual export: call the `neural_export_training` tool (outputs MLX LoRA JSONL to `~/.local/share/ai-agent-local-memory/lora-training/`).
- Manual training: `cd packages/lora-pipeline && ./train.sh`.
- **Whether to do reasoning training**: controlled by `cotStrategy` (default `none` = don't).
- **How often**: controlled by `triggerCount` (once per N training pairs accumulated).

> LoRA training runs entirely locally (MLX); no data is uploaded. Training material comes from `experience` nodes + `pairs.jsonl`.

---

## 6. Dreamer (daily memory consolidation)

Dreamer has **no config fields**; its behavior is fixed:

- **Trigger**: a fire-and-forget check at the end of every `messages.transform` (aligned with Claude Code's stopHooks approach), not a timer.
- **Cooldown**: a cooldown-lock mechanism — **runs at most once per day** (24h cooldown, lock file `.dream-lock`).
- **What it does**: extracts long-term `fact` / `value` / `culture` nodes from `episodes/*.json`; prunes stale memory; marks consumed episodes.
- **Timeout**: at most 5 minutes per run (`DREAM_TIMEOUT_MS`).

> `value` / `culture` are the "growing agent" character layer; they get injected into the system prompt to influence agent behavior.
> You can curate them proactively via `neural_read` + `neural_adopt` (the "parent picks the books" path).

---

## 7. Idle reading

When a session goes idle, the agent may proactively ask the user "what book / material would you like me to read?" (fed into `neural_read`).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `idleReadingPrompt.enabled` | `boolean` | `true` | Whether to enable proactive reading requests. Set `false` to fully opt out |
| `idleReadingPrompt.minIntervalMs` | `number` | `3600000` (1 hour) | Minimum gap between two reading requests in the same session |
| `idleReadingPrompt.maxPerDay` | `number` | `3` | Max reading requests per session per day |

**Turn off at runtime** (no config change needed):
- Reply "don't ask again today" → silent for 24 hours
- Reply "permanently disable reading" → fully off

> If the last book wasn't finished (`neural_read` was interrupted), idle will **resume that book** instead of asking for a new one.

---

## 8. Multi-machine sync

| Field | Type | Default | Meaning |
|---|---|---|---|
| `syncRepo` | `string` | — | Git remote repo URL. If set, sync is auto-initialized on first launch |

Sync mechanism (append-only operation log + Git merge):
- Memory-graph writes are appended to `operations.jsonl` (without embeddings, to avoid repo bloat).
- Auto push every hour (only when there are changes) + pull + replay.
- Manual: the `neural_sync` tool (`init` / `status` / `push` / `pull` / `export` / `import`).
- **Team sharing**: everyone configures the same `syncRepo` → all memory is merged and shared (including value/culture).
- **One-way merge**: `neural_sync(action="import", repoUrl=...)` merges someone else's memory store into yours without changing your own sync config.

---

## 9. Coexistence with other context managers

| Field | Type | Default | Meaning |
|---|---|---|---|
| `coexistWithOtherContextManager` | `boolean` | auto-detect | Whether to coexist with another context manager such as magic-context |

- Omit → auto-detect whether magic-context is installed in the project.
- Detected / set to `true` → **coexistence mode**: the plugin's `messages.transform` is **disabled** (doesn't take over compression, avoiding two transforms fighting), keeping only the memory features (recall/remember, etc.).
- Set to `false` → force-take-over compression (even if another manager is detected).

---

## Full config example

```json
{
  "injectSystemPrompt": true,
  "contextWindowTokens": 200000,
  "protectedTags": 20,
  "systemToolsReservePct": 0.18,

  "recallStrategy": "plugin",
  "readExtractBackend": "server",

  "llm": {
    "provider": "openai",
    "baseUrl": "http://localhost:6655/openai/v1",
    "apiKey": "sk-...",
    "model": "gpt-5-mini"
  },
  "embedding": {
    "provider": "openai",
    "baseUrl": "http://localhost:6655/openai/v1",
    "model": "text-embedding-3-small"
  },

  "localLlm": {
    "provider": "ollama",
    "endpoint": "http://localhost:11434",
    "model": "qwen3:14b",
    "mode": "observer",
    "confidence": { "userThreshold": 0.5, "autoEscalateAfter": 3 },
    "training": { "triggerCount": 100, "cotStrategy": "none" }
  },

  "idleReadingPrompt": {
    "enabled": true,
    "minIntervalMs": 3600000,
    "maxPerDay": 3
  },

  "syncRepo": "git@github.com:youruser/your-memory-store.git",
  "coexistWithOtherContextManager": false
}
```

> **Minimal config**: nothing is required to run. The example above shows every option — use only what you need.
> The most common starter config is just the `llm` + `embedding` blocks (so memory extraction and semantic recall work).
