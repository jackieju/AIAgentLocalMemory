# AIAgentLocalMemory

Neural-network-inspired memory engine for AI agents. Uses Hebbian learning, spreading activation, and a working memory queue instead of traditional database queries.

**Transform any AI agent into a growing, personal intelligence.** This plugin gives AI agents their own local brain — memory that persists, context that scales, and a local LLM that learns and improves through daily use. Like giving your AI a private mind that gets smarter over time. Dont' waste any token any chat any dollar in your daily talk with LLM, which can make your local LLM smarter everyday.

## Features

**Memory & recall**

- **Neural memory graph** — nodes (episodes / concepts / facts / experiences) connected by weighted synapses; recall by spreading activation instead of keyword match.
- **Hebbian learning** — every recall strengthens co-activated edges; unused edges decay. Frequently associated memories become easier to reach.
- **Working memory** — bounded queue of currently active nodes (recency + activation) that biases retrieval toward the current train of thought.
- **Hybrid scoring** — FTS5 keyword hits, embedding cosine similarity, and graph activation are combined into one ranked list per recall.
- **CJK-aware search** — SQLite FTS5 uses `Intl.Segmenter` for Chinese / Japanese / Korean word segmentation, no external tokenizer required.
- **Optional embeddings** — plug any OpenAI-compatible or Ollama embedding endpoint (`nomic-embed-text`, `text-embedding-3-small`, etc.) to add semantic recall alongside FTS.
- **Cross-session recall** — search across every past OpenCode session on this machine, not just the currently open one.

**Context management (OpenCode `messages.transform`)**

- **Compartments** — long history is compressed into `<compartment>` summaries by a background historian sub-session, keeping the recent tail full-fidelity.
- **Budget-driven rendering** — token budget aware, fidelity tiers (`f0`–`f4`) per message, with automatic tail selection and structural noise stripping.
- **Neural tools** — `neural_expand`, `neural_reduce`, `neural_pin`, `neural_note` for LLM-driven context grooming inside the conversation.
- **Coexistence mode** — auto-detects `@cortexkit/opencode-magic-context` and disables conflicting hooks; tools stay available.

**Growing local agent (three modes)**

- **Observer mode** — Claude / GPT stays the main model; the local LLM silently learns from every reply. Distillation data is captured either via `<thinking>` prompt injection or an idle-time post-rewrite sub-session.
- **Student mode** — the local LLM becomes the main model with automatic escalation to the server LLM when its confidence is low or the user is dissatisfied 3+ times.
- **Primary mode** — the local LLM is fully autonomous; only escalates on an explicit user command.
- **`neural_ask_server`** — one tool call to consult the server LLM with structured `[Reasoning] + [Answer]` output. Each Q&A becomes an experience node.
- **LoRA fine-tune pipeline** — auto-triggered when enough data has accumulated (`packages/lora-pipeline/auto-train.sh`, MLX-based, Qwen3 14B default). Rollback if the new adapter regresses on the benchmark.
- **Divergence-based training filter** — only samples where local answer and server answer disagreed significantly (`divergence ≥ 0.3` by default) are kept — no wasted training on already-known material.

**Storage & sync**

- **Single global graph** at `~/.local/share/ai-agent-local-memory/graph.db` — knowledge accumulated in one project is available in every project.
- **Append-only operation log** — every mutation is a line in `operations.jsonl`; `graph.db` is a materialized view. Conflict-free git merges.
- **Distributed sync via Git** — `neural_sync` init / push / pull / status; background timer auto-pushes on dirty state.
- **Embedding cache never syncs** — vectors are stripped before append to `operations.jsonl`; each machine regenerates its own local embeddings on pull.

**Session persistence**

- **Session transcripts** — every session's full chat history is mirrored to `transcripts/<sessionId>.md` on every `session.idle` event, human-readable and always up to date.
- **Cross-device session sync** — new. Every `session.idle` also appends the incremental raw messages + parts of the active session to `opencode-sessions/<sessionId>.jsonl` in the sync repo. Read-only handle on `opencode.db`, per-session cursor, first-time cap at 500 msg/tick. On a new machine, `neural_session_import(sessionId=...)` replays the JSONL back into that machine's `opencode.db` so you can `opencode --session <id>` and continue writing where you left off.
- **Daily backup** — `opencode.db` is gzip-copied once per 24h to iCloud Drive (`opencode-backup/opencode.db.gz`) alongside the neural configs.

**TUI sidebar**

- Live memory graph stats (nodes / edges / working memory / node type breakdown).
- Sync status (ops count, last push, repo).
- Compartment compression ratio (`before% / after%`).
- LoRA training state (last run time, improved / degraded, total runs, improvement count, in-progress indicator).
- Session ID and build number.

**Tooling**

- Full tool set: `neural_remember`, `neural_recall`, `neural_forget`, `neural_note`, `neural_reduce`, `neural_pin`, `neural_expand`, `neural_ask_server`, `neural_import_history`, `neural_session_import`, `neural_backup`, `neural_sync`, `neural_status`, `neural_export_training`.
- Two switching scripts (`~/use-ai-agent-local-memory.sh`, `~/use-magic-context.sh`) — one command flips both `opencode.jsonc` and `tui.json`, autoconfigures OpenCode's `small_model` to the local LLM in observer / student / primary mode, preserves your custom theme.

**Non-blocking guarantees**

- Never runs `execSync` on the event loop.
- Never touches the network inside `messages.transform`.
- `opencode.db` is only ever opened read-only from within the plugin — no lock contention with OpenCode's main writer.
- All git operations run on a low-priority background timer, async, timeouts bounded.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ☁️  Server LLM (Claude, GPT, etc.)                                        │
│   ┌─────────────────────────────────────┐                                   │
│   │  Shared brain. Powerful but:        │                                   │
│   │  • No personal memory               │                                   │
│   │  • No individual growth             │                                   │
│   │  • Treats everyone the same         │                                   │
│   │  • Every request costs money        │                                   │
│   └─────────────────────────────────────┘                                   │
│                         ▲ consult when stuck                                │
│                         │                                                   │
│   🧠  Your Local Agent (Local LLM + This Plugin)                            │
│   ┌─────────────────────────────────────┐                                   │
│   │  Your own brain. Grows with you:    │                                   │
│   │  • Remembers YOUR projects          │                                   │
│   │  • Learns YOUR patterns             │                                   │
│   │  • Gets faster over time            │                                   │
│   │  • Runs free, locally               │                                   │
│   │  • Asks the "shared brain" only     │                                   │
│   │    when truly stuck                 │                                   │
│   └─────────────────────────────────────┘                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Adapter Layer (per-host)                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                        │
│  │ OpenCode │  │ OpenClaw │  │  CLI/API │                        │
│  │ Adapter  │  │ Adapter  │  │ (future) │                        │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                        │
├───────┼──────────────┼──────────────┼─────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐   │
│  │         Core Engine                                         │   │
│  │  • Neural Graph (nodes + synapses + Hebbian learning)      │   │
│  │  • Spreading Activation + Working Memory                   │   │
│  │  • Context Manager (historian + compartments)              │   │
│  │  • Experience Store (learned solutions)                    │   │
│  │  • Training Data Collector (distillation pairs)            │   │
│  └──────────────────────┬─────────────────────────────────────┘   │
├─────────────────────────┼─────────────────────────────────────────┤
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐   │
│  │         Local LLM Layer (optional, ollama / remote)         │   │
│     • Observer: silently learns from server LLM               │   │
│  │  • Student: answers with auto-escalation safety net         │   │
│     • Primary: fully autonomous, escalates on demand          │   │
│  │  • LoRA Fine-tuning Pipeline (auto-triggered)               │   │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┬─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘   │
├─────────────────────────┼─────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐   │
│  │         Storage Layer                                       │   │
│  │  • SQLite + FTS5 (Intl.Segmenter for CJK)                 │   │
│  │  • Operation Log (append-only, git-syncable)               │   │
│  │  • Cross-device sync via Git                               │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

## Enterprise Use Case: Shared Growing Intelligence

For large teams working on complex projects, the plugin creates a **collective intelligence** that grows across all team members:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   🏢  Large Project (hundreds of developers, years of history)               │
│                                                                             │
│   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│   │Developer│ │Developer│ │Architect│ │ Support │ │   QA    │            │
│   │  Alice  │ │   Bob   │ │  Carol  │ │  David  │ │   Eve   │            │
│   └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘            │
│        │           │           │           │           │                   │
│        └───────────┴───────────┴───────────┴───────────┘                   │
│                                │                                            │
│                    ┌───────────▼───────────┐                                │
│                    │   Shared Memory Graph  │                                │
│                    │   (Git-synced SQLite)  │                                │
│                    │                        │                                │
│                    │  • Alice debugged the  │                                │
│                    │    auth module → stored │                                │
│                    │  • Bob optimized the   │                                │
│                    │    query → stored       │                                │
│                    │  • Carol's architecture│                                │
│                    │    decisions → stored   │                                │
│                    │  • David's customer    │                                │
│                    │    patterns → stored    │                                │
│                    └───────────┬───────────┘                                │
│                                │                                            │
│                    ┌───────────▼───────────┐                                │
│                    │  Shared Local LLM      │                                │
│                    │  (team ollama server)  │                                │
│                    │                        │                                │
│                    │  Learns from EVERYONE: │                                │
│                    │  • Debugging patterns  │                                │
│                    │  • Code conventions    │                                │
│                    │  • Domain knowledge    │                                │
│                    │  • Customer issues     │                                │
│                    └───────────────────────┘                                │
│                                                                             │
│   Month 1:  Everyone asks server LLM constantly (high cost)                 │
│   Month 3:  Local LLM handles routine questions (cost ↓ 40%)               │
│   Month 6:  Local LLM knows the project deeply (cost ↓ 70%)                │
│   Month 12: New hires get instant access to all accumulated knowledge       │
│                                                                             │
│   Key benefits:                                                             │
│   • Eve asks "why does payment fail for JP users?" → local LLM recalls     │
│     David's support experience + Alice's debugging notes + Bob's fix        │
│   • New developer joins → immediately has access to team's entire           │
│     problem-solving history without reading thousands of documents           │
│   • No knowledge lost when someone leaves — their experience lives on       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---|---|
| `@ai-agent-local-memory/core` | Host-agnostic engine: graph, Hebbian learning, spreading activation, working memory, context renderer |
| `@ai-agent-local-memory/storage-sqlite` | SQLite + FTS5 storage (cross-runtime: Bun and Node.js) |
| `@ai-agent-local-memory/adapter-opencode` | OpenCode plugin adapter (full context management) |
| `@ai-agent-local-memory/adapter-openclaw` | OpenClaw plugin adapter (ContextEngine + memory slot) |

## Data Model

**Nodes (Neurons):** Memory units with types:
- `concept` — Key entity extracted from conversation
- `assertion` — Composite claim from multiple concepts
- `definition` — Definition-style description
- `filler` — Low-priority context
- `episode` — Full conversation reference
- `meta` — Hub node (consolidated summary)
- `fact` — Durable note/fact that persists across sessions
- `experience` — Learned solution from server LLM consultation

**Synapses (Edges):** Weighted connections with types:
- `entity` — Shared named entity
- `temporal` — Co-occurrence in time window
- `lexical` — Word overlap (Jaccard 0.2–0.55)
- `semantic` — Embedding similarity
- `causal` — Causal relationship
- `compositional` — Composition (concepts → assertion)

## How It Works

### Hebbian Learning
Edges strengthen on co-activation: `Δw = η × (1 - w)` (asymptotic, never exceeds 1). Edges decay over time: `w = w × exp(-λ × Δt)`. Weak, old, rarely-used edges get pruned.

### Retrieval (Hybrid Scoring)
1. Full-text search (FTS5, OR mode) → ranked by BM25
2. Working memory boost for recently accessed nodes
3. Spreading activation from top seeds → discover associated memories
4. Hybrid score = `FTS_weight × fts_score + activation_weight × spread_score`
5. Results sorted by descending relevance

### Context Management (Historian + Compartments)
Long conversations are automatically compressed to stay within the context window:

1. **Recent messages** (last 20) are kept at full fidelity
2. **Historian** (background LLM) compresses older messages into **compartments** — summaries at 3 levels:
   - **p1** — Paragraph summary (~150 tokens): goals, decisions, files touched
   - **p2** — One sentence (~25 tokens): the most important thing that happened
   - **p3** — Title (~8 tokens): like a git commit subject
3. **Budget fitting**: Compartments render at the highest fidelity that fits within 15% of context window
4. **Trigger**: Every 6 turns or when context exceeds 80% budget, historian compresses the oldest uncompartmentalized window

**Expanding compartments**: When you see compressed history, say "expand that section" or "show me the original" — the LLM will call `neural_expand(start=N, end=M)` to retrieve the full original text.

**Result**: Infinite session support — context never overflows, old conversations are preserved as summaries, and original text is always retrievable on demand.

### Viewing Original Conversation History

When conversations are compressed into compartments, you can always retrieve the original text:

**Just ask naturally:**
- "展开前面那段摘要"
- "让我看看之前讨论 X 的原文"
- "show me the full text of that compressed section"
- "expand the earlier conversation about Y"

The LLM sees compartments with ordinal markers (`<compartment start="5" end="10">`) and automatically calls `neural_expand(start=5, end=10)` to fetch the original messages from OpenCode's database.

**Direct tool usage:**
- `neural_expand(start=5, end=10)` — expand a compartment by ordinal range
- `neural_expand(tags="3-5")` — expand by tag number
- `neural_session_read(sessionId="ses_xxx")` — read messages from any session

### Working Memory
LRU-frequency hybrid queue (default 1000 items). Score = `frequency × exp(-0.01 × hours_since_access)`. Lowest-score items evicted when full.

---

## OpenCode Plugin

### Install

#### Option A: npm (recommended)

The plugin is published on npm as [`ai-agent-local-memory`](https://www.npmjs.com/package/ai-agent-local-memory). OpenCode auto-installs npm plugins on startup — no manual `npm install` needed.

Add to your OpenCode config (`~/.config/opencode/opencode.jsonc` or project-level `opencode.json`):

```json
{
  "plugin": ["ai-agent-local-memory"]
}
```

Restart OpenCode. On first launch, it will fetch the plugin from npm automatically.

To use a specific version (optional):
```json
{
  "plugin": ["ai-agent-local-memory@0.2.0"]
}
```

#### Option B: From source

```bash
git clone https://github.com/jackieju/AIAgentLocalMemory.git
cd AIAgentLocalMemory
bun install
bun build packages/adapter-opencode/src/index.ts --outdir dist --target bun --external @opencode-ai/plugin
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/ai-agent-local-memory.js
```

Restart OpenCode.

### OpenCode Tools

| Tool | Description |
|---|---|
| `neural_remember` | Store a memory node (concept, assertion, definition, etc.) |
| `neural_recall` | Find memories by ASSOCIATION via graph traversal + spreading activation |
| `neural_forget` | Remove a memory node by ID |
| `neural_note` | Save durable facts/notes (session/project/global scope) |
| `neural_reduce` | Drop tagged content (suppress from rendering) |
| `neural_pin` | Pin content to always show at full fidelity |
| `neural_expand` | Expand compressed/elided content back to full text |
| `neural_ask_server` | Consult the server LLM for problems the local agent can't solve |
| `neural_import_history` | Import past OpenCode sessions into the neural graph |
| `neural_session_import` | Replay an OpenCode session exported from another machine (see [Cross-Device Session Sync](#cross-device-session-sync)) |
| `neural_backup` | Backup the entire memory graph to a timestamped directory |
| `neural_sync` | Synchronize memory across machines via Git (init/push/pull/status) |
| `neural_status` | View engine stats and working memory |

### OpenCode Configuration

Create `neural-context.json` in your project root or `.opencode/` directory:

```json
{
  "injectSystemPrompt": true,
  "contextWindowTokens": 128000,
  "budgetRatio": 0.6,
  "coexistWithOtherContextManager": false,
  "syncRepo": "git@github.com:yourname/memory-sync.git",
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small"
  }
}
```

| Option | Default | Description |
|---|---|---|
| `injectSystemPrompt` | `true` | Inject relevant memories into the system prompt each turn |
| `contextWindowTokens` | `128000` | Context window size in tokens for budget calculation |
| `budgetRatio` | `0.6` | Fraction of context window allocated to history |
| `coexistWithOtherContextManager` | auto-detected | Force coexistence mode on/off |
| `syncRepo` | — | Git remote URL for multi-machine sync (auto-initializes on startup) |
| `llm.provider` | — | LLM provider: `"openai"`, `"ollama"`, or `"custom"` |
| `llm.baseUrl` | `https://api.openai.com/v1` | API endpoint (for custom providers) |
| `llm.apiKey` | `$OPENAI_API_KEY` | API key (or set via env var) |
| `llm.model` | `gpt-4o-mini` | Model name |
| `embedding.provider` | — | Embedding provider: `"openai"`, `"ollama"`, or `"custom"` |
| `embedding.baseUrl` | `https://api.openai.com/v1` | API endpoint (for custom providers) |
| `embedding.apiKey` | `$OPENAI_API_KEY` | API key (or set via env var) |
| `embedding.model` | `text-embedding-3-small` | Model name |

### LLM & Embedding Enhancement

When providers are configured, the engine automatically enhances memory quality:

| Module | Trigger | Effect |
|---|---|---|
| **LLMExtractor** | `llm` configured | High-quality concept/assertion extraction on ingest (vs regex) |
| **EmbeddingLinker** | `embedding` configured | Semantic edges via cosine similarity (vs lexical overlap only) |
| **EdgeWeightPredictor** | Always active | Multi-feature scoring improves edge weights |
| **LightweightLinker** | Always active | Baseline regex entity + lexical edges (no external service needed) |

Without providers configured, the system still works using LightweightLinker only.

#### Provider Examples

**OpenAI:**
```json
{ "llm": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o-mini" } }
```

**Ollama (local):**
```json
{ "llm": { "provider": "ollama", "model": "llama3.2" },
  "embedding": { "provider": "ollama", "model": "nomic-embed-text" } }
```

**Custom OpenAI-compatible endpoint:**
```json
{ "llm": { "provider": "custom", "baseUrl": "http://localhost:8080/v1", "model": "my-model" } }
```

### Standalone Mode (e.g. replaces magic-context)

In standalone mode, this plugin fully manages the context window:
- Conversation history compression (activation-based fidelity rendering)
- Cross-session memory (neural graph with Hebbian learning)
- Session facts and notes
- Full context window budget management

Replace magic-context in `opencode.json`:
```json
{
  "plugin": ["ai-agent-local-memory"],
  "compaction": { "auto": false, "prune": false }
}
```

### Coexistence Mode (e.g. alongside magic-context)

When magic-context is detected in your `opencode.json`, the plugin automatically enters coexistence mode:

- `messages.transform` is **disabled** (magic-context handles context compression)
- Memory content injection is **disabled** (avoids double injection)
- Tool usage guide is **still injected** (so the agent knows neural_* tools exist)
- All `neural_*` tools remain **fully functional** for associative memory

In this mode, magic-context handles "context window management" while AIAgentLocalMemory provides "associative memory".

### Per-project Control

| Scenario | How |
|---|---|
| Use alongside magic-context (default) | No config needed — auto-detected |
| AIAgentLocalMemory fully takes over | `neural-context.json`: `{"coexistWithOtherContextManager": false}` + remove magic-context from project opencode.json |
| Disable AIAgentLocalMemory for this project | Use a project-level `opencode.json` that doesn't load the plugin |

### Growing Local Agent — Three Learning Modes

The plugin implements a **growing local intelligence** system: a local LLM progressively learns from a powerful server LLM (Claude/GPT) through observation, guided learning, or on-demand consultation. Over time, the local agent becomes increasingly self-sufficient.

#### Configuration

```json
// ~/.config/opencode/neural-context.json
{
  "localLlm": {
    "provider": "ollama",
    "endpoint": "http://localhost:11434",   // or remote: "http://192.168.1.100:11434"
    "model": "qwen3:8b",
    "mode": "observer",                     // "observer" | "student" | "primary"
    "confidence": {
      "userThreshold": 0.5,                 // student mode: confidence below this triggers escalation
      "autoEscalateAfter": 3                // student mode: auto-escalate after N user corrections
    },
    "training": {
      "triggerCount": 100,                   // LoRA training triggers after this many training pairs
      "cotStrategy": "thinking-tag"          // How to capture reasoning in observer mode
    }
  }
}
```

#### Modes

| Mode | Main Model | Local LLM Role | Learning Method |
|---|---|---|---|
| **observer** | Server LLM (OpenCode config) | Silent observer | Stores every {question, reply} pair for distillation |
| **student** | Local LLM (OpenCode provider = ollama) | Active with safety net | Auto-escalates via `neural_ask_server` when confidence is low |
| **primary** | Local LLM (OpenCode provider = ollama) | Fully autonomous | Only escalates when user explicitly says "问大模型" |
| *(not configured)* | Server LLM (OpenCode config) | N/A | Plugin works normally without local learning |

#### Observer Mode

The local LLM silently watches how the server LLM (Claude) handles every request:

```
User asks question → Claude answers → Plugin stores {question, answer} as training pair
                                     → After 100 pairs: triggers LoRA fine-tuning automatically
```

- Training data stored in `~/.local/share/ai-agent-local-memory/training-pairs/pairs.jsonl`
- No impact on response quality — server LLM handles everything
- Ideal starting point: accumulate data before switching to student/primary mode

##### Reasoning capture (cotStrategy)

Plain `{Q, A}` pairs teach the local model to imitate answer style but not reasoning. To distill reasoning too, you can capture chain-of-thought:

| Strategy | Behavior | User visibility | Cost |
|---|---|---|---|
| **`thinking-tag`** (default) | Server LLM wraps reasoning in `<thinking>...</thinking>` tags before the final answer. Both are stored as training output. | Hidden by OpenCode UI | No extra API calls |
| **`post-rewrite`** | Original conversation runs normally. After session idle, a sub-session asks the server LLM to rewrite the reply as `[Reasoning] + [Answer]` and stores the rewrite. | User sees original reply as-is | One extra API call per Q&A pair (background) |
| **`none`** | No reasoning capture. Store `{Q, A}` as-is. | — | Zero |

Configure via `localLlm.training.cotStrategy`. Default: `thinking-tag`.

#### Student Mode

The local LLM is the main responder (OpenCode provider = ollama), with automatic escalation:

```
User asks question → Local LLM assesses confidence
  → High confidence + has relevant experience: answers independently
  → Low confidence / unfamiliar topic: calls neural_ask_server → learns from response
  → User corrects 3+ times: auto-suggests escalation for subsequent questions
```

- Confidence threshold configurable (`confidence.userThreshold`, default 0.5)
- Dissatisfaction detection: tracks "不对", "错了", "wrong", "重做" signals
- Every successful escalation stored as training pair → periodic LoRA fine-tuning

#### Primary Mode

The local LLM is fully autonomous — only escalates on explicit user request:

```
User asks question → Local LLM answers independently (always)
User says "问大模型" → calls neural_ask_server → learns from response
```

- Maximum autonomy, minimum server LLM usage
- Ideal after significant LoRA training has been completed

#### LoRA Fine-Tuning Pipeline

Training happens automatically when enough data accumulates:

```bash
# Manual training (packages/lora-pipeline/)
./train.sh                    # MLX LoRA training (Qwen3 8B, rank 8, 200 iters)
./benchmark.sh                # Compare base vs fine-tuned
./rollback.sh                 # Revert if degraded

# Or trigger from OpenCode:
# Use neural_export_training tool to export data manually
```

**Auto-training**: Plugin monitors training pair count. When threshold is reached (100 for observer, 50 for student/primary), training is triggered in background with `nice -n 19` (low CPU priority).

**Sidebar status**: TUI sidebar shows training status:
```
◆ LoRA Training
Last: 3h ago ✓              ← last training time + result
Runs: 5  Improved: 3/5     ← total runs + success count
```

#### Remote Local LLM

The local LLM can run on another machine in your network:

```json
{
  "localLlm": {
    "provider": "ollama",
    "endpoint": "http://192.168.1.100:11434",
    "model": "qwen3:32b"
  }
}
```

On the remote machine: `OLLAMA_HOST=0.0.0.0 ollama serve`

#### Progression Path

```
1. Start with observer mode (accumulate 100+ training pairs)
2. Run LoRA fine-tuning on accumulated data
3. Switch to student mode (local LLM with safety net)
4. As local model improves, reduce escalation frequency
5. Switch to primary mode (fully autonomous local agent)
```

---

## OpenClaw Plugin

### Install

#### Option A: From source (recommended for development)

```bash
git clone https://github.com/jackieju/AIAgentLocalMemory.git
cd AIAgentLocalMemory
bun install
rm -rf packages/adapter-openclaw/node_modules
bun build packages/adapter-openclaw/src/index.ts --outdir packages/adapter-openclaw/dist --target node --external "openclaw" --external "bun:sqlite" --external "node:sqlite"
openclaw plugins install --force packages/adapter-openclaw
openclaw gateway restart
```

To update after code changes:
```bash
bun build packages/adapter-openclaw/src/index.ts --outdir packages/adapter-openclaw/dist --target node --external "openclaw" --external "bun:sqlite" --external "node:sqlite"
cp packages/adapter-openclaw/dist/index.js ~/.openclaw/extensions/neural-context/dist/index.js
openclaw gateway restart
```

#### Option B: npm (when published)

```bash
openclaw plugins install @ai-agent-local-memory/adapter-openclaw
openclaw gateway restart
```

### OpenClaw Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "neural-context": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        },
        "config": {
          "autoRecall": true,
          "autoCapture": true,
          "maxRecallResults": 10
        }
      }
    },
    "slots": {
      "memory": "neural-context",
      "contextEngine": "neural-context"
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `storageDir` | `~/.local/share/ai-agent-local-memory-openclaw` | Custom storage directory |
| `autoRecall` | `true` | Inject relevant memories before every AI turn via spreading activation |
| `autoCapture` | `true` | Store conversations and build associative edges after every turn |
| `maxRecallResults` | `10` | Maximum memories injected into context per turn |
| `debug` | `false` | Enable verbose debug logs |

### OpenClaw Context Engine

The plugin registers as a full **ContextEngine** (`ownsCompaction: true`), providing:

- **assemble()** — Activation-based fidelity rendering (f0-f4) within token budget
- **compact()** — Delegates to OpenClaw's built-in compaction as fallback
- **ingest() / afterTurn()** — Stores messages as episode nodes with automatic edge creation
- **bootstrap()** — Initializes storage on session start

This means conversation history is managed intelligently — old messages are compressed based on relevance (not just age), and re-activate to full fidelity when their topic becomes relevant again.

### OpenClaw Tools

| Tool | Description |
|---|---|
| `neural_recall` | Find memories by ASSOCIATION via graph traversal + spreading activation |
| `neural_remember` | Store information with automatic associative linking |
| `neural_forget` | Remove a memory node by ID |
| `neural_note` | Save durable facts/notes that persist across sessions |
| `neural_status` | View engine stats and working memory |

---

## Storage

### Default Paths

| Adapter | Default Storage Path |
|---|---|
| OpenCode | `~/.local/share/ai-agent-local-memory/` |
| OpenClaw | `~/.local/share/ai-agent-local-memory-openclaw/` |

Storage contents:
```
├── graph.db          ← all nodes, edges, FTS index (single SQLite file)
├── graph.db-wal      ← WAL journal (may not exist when idle)
├── graph.db-shm      ← shared memory (may not exist when idle)
├── episodes/         ← raw session JSON files (original conversation text)
├── transcripts/      ← auto-synced chat transcripts (one file per session)
└── backups/          ← created by neural_backup tool
```

### Custom Storage Path

**OpenCode** — `neural-context.json` or env var:
```json
{ "storageDir": "/path/to/custom/storage" }
```
```bash
export AI_AGENT_LOCAL_MEMORY_DIR=/path/to/custom/storage
```

**OpenClaw** — plugin config in `~/.openclaw/openclaw.json`:
```json
{ "plugins": { "entries": { "neural-context": { "config": { "storageDir": "/path/to/custom/storage" } } } } }
```

### Sharing Memory Between Hosts

Point both adapters to the same directory to share a single memory graph:

```json
// OpenCode neural-context.json
{ "storageDir": "~/.local/share/ai-agent-shared-memory" }

// OpenClaw plugin config
{ "storageDir": "~/.local/share/ai-agent-shared-memory" }
```

SQLite WAL mode handles concurrent reads safely. Concurrent writes are rare and retried via busy timeout.

## Distributed Sync (Multi-Machine)

Synchronize memory across multiple machines using Git. Uses an append-only operation log — no conflicts possible.

### How it works

```
Machine A writes → appends to operations.jsonl → git push
Machine B: git pull → replay new operations → local graph updated
```

Each machine appends its own operations. Git merges are always clean (append-only, no overlapping lines). UUID node IDs prevent collisions across machines.

### Setup

**Machine 1 (first time):**
```
neural_sync(action="init", repoUrl="git@github.com:yourname/memory-sync.git")
```

**Machine 2 (join existing):**
```
neural_sync(action="init", repoUrl="git@github.com:yourname/memory-sync.git")
neural_sync(action="pull")
```

### Daily Use

```
neural_sync(action="push")     → commit + push local operations
neural_sync(action="pull")     → pull + replay remote operations
neural_sync(action="status")   → check sync state
```

### Writes During Sync

If new memories are created while syncing, they are safely appended to the operation log and included in the next push. No data loss is possible.

### Architecture

```
graph.db (local runtime database — fast reads/writes)
    ↑ replay
operations.jsonl (append-only log — synced via Git)
```

The operation log is the source of truth for sync. `graph.db` is a materialized view that can be rebuilt from the log at any time.

## Backup

### Session Transcripts

Every time OpenCode finishes responding (session enters idle state), the full chat history is automatically written to:

```
~/.local/share/ai-agent-local-memory/transcripts/<sessionId>.md
```

The file stays in sync with the session — each idle event checks for new content and updates the file. Format:

```markdown
[user] How do I fix the auth bug?

---

[assistant] Looking at the auth module...

---

[tool] { result of tool call }

---
```

This gives you a persistent, readable copy of every conversation that survives even if the session is deleted from OpenCode.

### Cross-Device Session Sync

Move to a new machine and continue the same OpenCode session — including the full message history, tool calls, and reasoning — as if you never left.

**How it works (design):**

- **Append-only export**: On every `session.idle` event, the plugin reads OpenCode's local `opencode.db` (SQLite, WAL mode, **read-only handle**, no write contention with OpenCode's own writes) and appends any new messages/parts to `~/.local/share/ai-agent-local-memory/sync/opencode-sessions/<sessionId>.jsonl`.
- **Per-session cursor**: `.exporter-state.json` remembers the last exported `message_id` per session, so subsequent exports are incremental — one idle event only writes the delta.
- **First-time cap**: A brand-new session on this machine exports at most 500 messages per idle event to avoid a large blocking write; the rest is picked up on later idle events.
- **Git-backed sync**: The `opencode-sessions/` directory lives inside the same [Distributed Sync](#distributed-sync-multi-machine) repo (`syncRepo`). The existing background sync timer commits and pushes them along with the neural graph — no extra network round-trip.
- **Structured replay**: Each JSONL line is `{"msg": <message row>, "parts": [<part row>, ...]}` — a lossless snapshot of the OpenCode schema, not a text transcript. Replay recreates the exact same conversation OpenCode would render.
- **Session metadata**: A one-time `<sessionId>.session.json` captures title, directory, model, and token stats so the imported session appears correctly in OpenCode's session list.

**Non-blocking by design:**

- **Never blocks the event loop**: only async I/O, never `execSync`.
- **Never blocks `messages.transform`**: exports run on the `session.idle` event, after the assistant has already replied.
- **Never writes to `opencode.db`**: read-only handle, so SQLite lock contention with OpenCode is impossible.
- **Piggy-backs on the sync timer**: no separate git process, no extra network chatter.

**Usage — export (automatic, no action required):**

Whenever OpenCode goes idle, new messages of the active session are appended to the JSONL and, on the next sync tick, pushed to the sync repo.

**Usage — import on a new machine:**

1. Configure `syncRepo` on the new machine so its neural memory pulls from the same git repo (see [Setup](#setup)).
2. Wait for the sync timer to pull (or run `neural_sync` action=`pull`) — this brings the `opencode-sessions/` directory to the new machine.
3. From inside OpenCode, run the tool:

   ```
   neural_session_import(sessionId="ses_...")
   ```

   Optional: `overwrite=true` to re-insert messages even if some already exist locally (default is safe idempotent replay — duplicates are skipped via `INSERT OR IGNORE`).
4. **Restart OpenCode** so it re-reads `opencode.db` — the imported session now appears in the session list and can be reopened with `opencode --session <sessionId>`.

**Storage layout in the sync repo:**

```
<syncRepo>/opencode-sessions/
├── ses_abc123.jsonl           append-only messages + parts
├── ses_abc123.session.json    one-time session metadata
├── ses_xyz789.jsonl
├── ses_xyz789.session.json
└── .exporter-state.json       per-session cursor (last exported message_id)
```

**Feature description:**

You keep OpenCode's native single-machine session UX. Behind the scenes, every idle moment writes the incremental diff to a git-synced JSONL, so any second machine (macOS / Linux / Windows) that pulls the same repo can call one tool and pick up exactly where you left off — same messages, same tool history, same reasoning traces.

### Via Tool (in OpenCode)

```
neural_backup()                           → ~/.local/share/ai-agent-local-memory/backups/<timestamp>/
neural_backup(destination="/path/to/dir") → custom path
```

### Manual

```bash
cp -r ~/.local/share/ai-agent-local-memory/ ~/backup/ai-agent-local-memory-$(date +%Y%m%d)/
```

## Development

```bash
bun install
bun build packages/adapter-opencode/src/index.ts --outdir packages/adapter-opencode/dist --target bun --external @opencode-ai/plugin
bun build packages/adapter-openclaw/src/index.ts --outdir packages/adapter-openclaw/dist --target node --external "openclaw" --external "bun:sqlite" --external "node:sqlite"
```

### Cross-Runtime Compatibility

The storage layer uses a sqlite-shim that automatically selects:
- `bun:sqlite` when running under Bun (OpenCode)
- `node:sqlite` (DatabaseSync) when running under Node.js (OpenClaw)

No external native dependencies required on either runtime.

## Development Session

Original design session (OpenCode):
```bash
opencode --session ses_166d0e7b9ffeBpCjAtqVkPPkP4
```

## License

MIT
