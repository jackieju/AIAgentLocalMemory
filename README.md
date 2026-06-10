# AIAgentLocalMemory

Neural-network-inspired memory engine for AI agents. Uses Hebbian learning, spreading activation, and a working memory queue instead of traditional database queries.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Adapter Layer (per-host)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ OpenCode │  │ OpenClaw │  │  CLI/API │      │
│  │ Adapter  │  │ Adapter  │  │ (future) │      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘      │
├───────┼──────────────┼──────────────┼────────────┤
│  ┌─────────────────────────────────────────┐    │
│  │         Core Engine                      │    │
│  │  • Graph (nodes + synapses)             │    │
│  │  • Spreading Activation                 │    │
│  │  • Hebbian Learning / Decay             │    │
│  │  • Working Memory Queue                 │    │
│  │  • Context Renderer (f0-f4 fidelity)    │    │
│  │  • Session Abstraction                  │    │
│  └────────────────────┬────────────────────┘    │
├───────────────────────┼──────────────────────────┤
│  ┌─────────────────────────────────────────┐    │
│  │         Storage Layer (pluggable)        │    │
│  │  • SQLite + FTS5 (default)              │    │
│  │  • Cross-runtime: bun:sqlite / node:sqlite │  │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
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

### Context Rendering (f0-f4 Fidelity)
Every conversation message is stored as an episode node. When assembling context:
1. Run spreading activation from current topic seeds
2. Assign activation scores to each episode
3. Binary search for threshold that fits within token budget
4. Render each episode at appropriate fidelity level:
   - **f0** — Full text (high activation / recent / pinned)
   - **f1** — Paragraph summary (~200 tokens)
   - **f2** — One-line gist (~30 tokens)
   - **f3** — Title only (~8 tokens)
   - **f4** — Elided placeholder (~5 tokens)
5. Hysteresis band (±20%) prevents fidelity flickering between turns

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
| `neural_import_history` | Import past OpenCode sessions into the neural graph |
| `neural_backup` | Backup the entire memory graph to a timestamped directory |
| `neural_status` | View engine stats and working memory |

### OpenCode Configuration

Create `neural-context.json` in your project root or `.opencode/` directory:

```json
{
  "injectSystemPrompt": true,
  "contextWindowTokens": 128000,
  "budgetRatio": 0.6,
  "coexistWithMagicContext": false
}
```

| Option | Default | Description |
|---|---|---|
| `injectSystemPrompt` | `true` | Inject relevant memories into the system prompt each turn |
| `contextWindowTokens` | `128000` | Context window size in tokens for budget calculation |
| `budgetRatio` | `0.6` | Fraction of context window allocated to history |
| `coexistWithMagicContext` | auto-detected | Force coexistence mode on/off |

### Standalone Mode (replaces magic-context)

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

### Coexistence Mode (alongside magic-context)

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

## Backup

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
