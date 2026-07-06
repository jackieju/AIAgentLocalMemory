# AIAgentLocalMemory

Neural-network-inspired memory engine for AI agents. Uses Hebbian learning, spreading activation, and a working memory queue instead of traditional database queries.

**Transform any AI agent into a growing, personal intelligence.** This plugin gives AI agents their own local brain — memory that persists, context that scales, and a local LLM that learns and improves through daily use. Like giving your AI a private mind that gets smarter over time. Dont' waste any token any chat any dollar in your daily talk with LLM, which can make your local LLM smarter everyday.

## Features

- **Unlimited context management** — long history is transparently compressed into `<compartment>` summaries by a background historian while the recent tail stays full-fidelity, so conversations don't hit a token wall.
- **Neural memory** — an associative graph (nodes + weighted synapses, Hebbian learning, spreading activation, working memory) recalls by meaning and association instead of keyword match.
- **Cross-project shared memory** — one global memory graph is reused across every project and every session on the machine.
- **Cross-machine memory sync** — the memory graph replicates between machines through a Git-backed append-only operation log (conflict-free, `neural_sync` push / pull / status).
- **Cross-device session sync** — the full raw OpenCode session (messages, tool calls, reasoning) can be replayed on a second machine via `neural_session_import`, so you switch computers and keep writing where you left off.
- **Multilingual & semantic search** — SQLite FTS5 with `Intl.Segmenter` for CJK, plus optional embedding-based semantic recall through any OpenAI-compatible or Ollama endpoint.
- **Growing local agent** — an optional local LLM (Qwen3 14B via Ollama by default) that runs in three modes — Observer (silently learns from the server LLM), Student (auto-escalates when unsure), or Primary (fully autonomous) — with a LoRA fine-tune pipeline that trains on divergence-filtered Q&A pairs and rolls back on regression.
- **Escalation on demand** — `neural_ask_server` lets the local agent consult the server LLM with a structured `[Reasoning] + [Answer]` prompt and stores every response as a reusable experience node.
- **Automatic session persistence** — every conversation is mirrored to a readable Markdown transcript, and the underlying `opencode.db` is gzip-backed up daily to iCloud.
- **Live TUI sidebar** — memory graph stats, sync state, context compression ratio, and LoRA training progress are visible directly inside the OpenCode sidebar.
- **Magic-context coexistence** — auto-detects `@cortexkit/opencode-magic-context` and disables conflicting hooks while keeping the neural tools available.

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
│  │  • Training Data Collector (learning pairs)                │   │
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

### Knowledge routing — where does what you learn end up?

Every conversation you have through OpenCode with this plugin is split into two streams:

```
                    ┌──────────────────────────────┐
                    │   You (user)  ↔  Agent + LLM │
                    │        (a conversation)      │
                    └──────────────┬───────────────┘
                                   │
                     ┌─────────────┴─────────────┐
                     │                           │
                     ▼                           ▼
     ┌─────────────────────────┐   ┌─────────────────────────────┐
     │  Project-specific facts │   │  General reasoning & skills │
     │                         │   │        (optional)           │
     │  ─────────────────────  │   │  ─────────────────────────  │
     │  • file paths           │   │  • how to debug a           │
     │  • bug root causes      │   │    race condition           │
     │  • config values        │   │  • when to consult Oracle   │
     │  • naming conventions   │   │  • how to structure a       │
     │  • decisions made       │   │    good commit message      │
     │  • what breaks what     │   │  • language-agnostic        │
     │                         │   │    problem-solving patterns │
     └────────────┬────────────┘   └───────────────┬─────────────┘
                  │                                │
                  ▼                                ▼
     ┌─────────────────────────┐   ┌─────────────────────────────┐
     │  Global Memory Graph    │   │  Local LLM (fine-tuned)     │
     │  (SQLite + FTS +        │   │  (Qwen3 14B + LoRA)         │
     │   embeddings + git)     │   │                             │
     │                         │   │  Trained from Q&A pairs     │
     │  Recalled by            │   │  captured in Observer /     │
     │  neural_recall,         │   │  Student mode. Each         │
     │  spreading activation.  │   │  auto-triggered LoRA run    │
     │                         │   │  makes it a little more     │
     │  Shared across every    │   │  capable, permanently.      │
     │  project on this        │   │                             │
     │  machine and every      │   │                             │
     │  machine you sync to.   │   │                             │
     └─────────────────────────┘   └─────────────────────────────┘
```

**Every time you learn from an LLM, your local LLM is learning more.** Project facts flow into the memory graph so future conversations recall them by association. General reasoning and problem-solving patterns flow into training pairs so, after enough LoRA cycles, the local model can handle familiar shapes of problems on its own — no cloud API required.

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
      "cotStrategy": "none"                  // Reasoning capture: "none" (default, opt-in) | "thinking-tag" | "post-rewrite"
    }
  }
}
```

#### Modes

| Mode | Main Model | Local LLM Role | Learning Method |
|---|---|---|---|
| **observer** | Server LLM (OpenCode config) | Silent observer | Stores every {question, reply} pair for learning |
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

##### Reasoning capture (cotStrategy, opt-in)

Plain `{Q, A}` pairs teach the local model to imitate answer style but not reasoning. **By default the plugin does NOT force any reasoning capture** — every conversation stays exactly as the server LLM naturally responds and you never pay a token surcharge or wait for a rewrite. If you want reasoning in the training data too, you can opt in to chain-of-thought capture:

| Strategy | Behavior | User visibility | Cost |
|---|---|---|---|
| **`none`** (default) | No reasoning capture. Store `{Q, A}` as-is. | Nothing added to responses | Zero |
| **`thinking-tag`** | Server LLM wraps reasoning in `<thinking>...</thinking>` tags before the final answer. Both are stored as training output. | Hidden by most TUI themes, but does inflate response length | No extra API calls |
| **`post-rewrite`** | Original conversation runs normally. After session idle, a background sub-session asks the server LLM to rewrite the reply as `[Reasoning] + [Answer]` and stores the rewrite. | User sees the original reply as-is | One extra API call per Q&A pair (background) |

Configure via `localLlm.training.cotStrategy`. **Default: `none`** — reasoning capture is entirely optional. You decide which conversations get reasoning distilled and when.

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

#### Sub-agent learning

Every time OpenCode goes idle, the plugin harvests training pairs not only from the **main** conversation but from **every sub-session** that was spawned during the turn — Oracle consultations, Explore/Librarian searches, Metis/Momus reviews, and any Sisyphus-Junior delegations. Each `(user prompt, assistant reply)` pair from a sub-session is written to `pairs.jsonl` with an instruction that flags it as a sub-agent style response ("reason step by step, cite evidence"). This way, the local LLM learns not just how the primary agent answers you, but how each specialist role thinks. Sub-session discovery is done via `SELECT id FROM session WHERE parent_id = ?` recursively (read-only) and capped at 50 sub-sessions per idle event for safety.

#### Replaying historical sessions

If you already have hundreds of past OpenCode sessions and want to mine them for training data right now (not wait for future conversations to accumulate), run the replay orchestrator:

```bash
# Replay every historical session (default: shortcircuit mode via forked opencode)
packages/lora-pipeline/replay-history.sh

# Replay 10 most recent sessions
packages/lora-pipeline/replay-history.sh --limit 10

# Replay only sessions from a given date onward
packages/lora-pipeline/replay-history.sh --since 2026-06-01

# Require at least 5 messages per session
packages/lora-pipeline/replay-history.sh --min-messages 5

# Fallback: use stock opencode with a read-only agent
packages/lora-pipeline/replay-history.sh --agent oracle
```

The script has **two safety modes** that both guarantee zero modifications to your local filesystem:

**Mode 1 — Shortcircuit (default, highest reasoning fidelity):**

- Uses a forked opencode binary at `~/.local/bin/opencode-fork` from [jackieju/opencode branch replay-shortcircuit](https://github.com/jackieju/opencode/tree/replay-shortcircuit), which adds an optional `shortcircuit` field to the `tool.execute.before` plugin hook. When a plugin sets it, opencode skips the real tool execution and returns that value as the tool_result.
- Runs the **complete Sisyphus agent** — same system prompt, same permitted tools, same sub-agent dispatch (Oracle, Explore, Librarian, Metis, Momus, Sisyphus-Junior). Every reasoning step is identical to the original conversation.
- The plugin's `tool.execute.before` hook, activated by env var `NEURAL_REPLAY_ORIG_SESSION_ID`, queries the original session's `opencode.db` for a completed tool call matching the current tool name + args, and returns the historical result via shortcircuit. Every Read, Grep, Edit, Write, Bash, WebFetch, etc. is served from history — **the real tool is never executed.**
- A PR upstreaming the hook change to opencode: [anomalyco/opencode#35613](https://github.com/anomalyco/opencode/pull/35613). Until it lands, use the fork.

**Mode 2 — Read-only agent (fallback, if fork is missing):**

- Uses stock opencode with `--agent oracle` (or another opencode-defined read-only agent: `plan`, `explore`, `librarian`, `metis`, `momus`, `multimodal-looker`).
- Opencode's runtime enforces the agent's tool whitelist — Edit / Write / Bash-write are hard-rejected, so nothing gets modified.
- Reasoning fidelity is lower because the agent's persona and available tools differ from the original Sisyphus run.

The orchestrator picks Mode 1 automatically when the fork binary exists; falls back to Mode 2 when you pass `--agent`; otherwise refuses to run.

**Building the fork:**

```bash
# One-time setup
git clone git@github.com:jackieju/opencode.git ~/Desktop/ju/projects/opencode
cd ~/Desktop/ju/projects/opencode
git checkout replay-shortcircuit
bun install
cd packages/opencode
bun run build --single --skip-embed-web-ui

# Symlink so replay-history.sh finds it
ln -sf ~/Desktop/ju/projects/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode ~/.local/bin/opencode-fork
```

The build takes ~2 minutes; the smoke test at the end prints `Smoke test passed: 0.0.0-replay-shortcircuit-<timestamp>`.

**How replay works (both modes):**

1. Reads user message sequences out of your local `opencode.db` (read-only, WAL-safe).
2. For each historical session, spawns a fresh headless opencode conversation in a scratch directory under `/tmp/replay-<sessionId>/`.
3. Feeds the user messages through `opencode run --print` one at a time (first with a fresh session, subsequent with `--continue`).
4. In Mode 1, every tool call is served from history via shortcircuit; in Mode 2, write tools are hard-rejected by the agent's whitelist.
5. Every replayed assistant reply + every sub-agent call goes through the plugin's `session.idle` collector so it ends up in `pairs.jsonl` (main + sub-agent style).
6. When enough pairs accumulate, LoRA auto-train fires on its own.

**Cost warning:** replaying consumes real LLM API tokens exactly like a live conversation. Start with `--limit 5` to gauge cost before running the full history. If you're on an Anthropic Pro/Max subscription this is effectively free (rate-limited only).

**Replay is one-shot: it produces a one-time backfill of training data from history. From that point on, `session.idle` sub-agent harvesting keeps the training set growing incrementally.**

**Known limitation:** `opencode run --print` is a headless one-shot invocation that may not always fire the `session.idle` event our collector relies on. End-to-end training-pair harvest during replay is under active integration — the safety mechanism (no local modifications) has been verified, but pairs.jsonl growth during a headless replay may lag until we wire an alternate trigger. Live interactive sessions continue to collect pairs normally.

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
