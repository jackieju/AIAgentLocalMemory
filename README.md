# AIAgentLocalMemory

Neural-network-inspired memory engine for AI agents. Uses Hebbian learning, spreading activation, and a working memory queue instead of traditional database queries.

**Transform any AI agent into a growing, personal intelligence.** This plugin gives AI agents their own local brain — memory that persists, context that scales, and a local LLM that learns and improves through daily use. Like giving your AI a private mind that gets smarter over time. Dont' waste any token any chat any dollar in your daily talk with LLM, which can make your local LLM smarter everyday.

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

Add to `opencode.json` or `opencode.jsonc`:
```json
{
  "plugin": ["ai-agent-local-memory"]
}
```

Restart OpenCode.

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
  "coexistWithMagicContext": false,
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
| `coexistWithMagicContext` | auto-detected | Force coexistence mode on/off |
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
| AIAgentLocalMemory fully takes over | `neural-context.json`: `{"coexistWithMagicContext": false}` + remove magic-context from project opencode.json |
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
      "triggerCount": 100                   // LoRA training triggers after this many training pairs
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
