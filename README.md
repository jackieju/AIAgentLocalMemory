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
│  │  • Session Abstraction                  │    │
│  └────────────────────┬────────────────────┘    │
├───────────────────────┼──────────────────────────┤
│  ┌─────────────────────────────────────────┐    │
│  │         Storage Layer (pluggable)        │    │
│  │  • SQLite + FTS5 (default)              │    │
│  │  • Custom StorageProvider               │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---|---|
| `@ai-agent-local-memory/core` | Host-agnostic engine: graph, Hebbian learning, spreading activation, working memory |
| `@ai-agent-local-memory/storage-sqlite` | SQLite + FTS5 storage implementation |
| `@ai-agent-local-memory/adapter-opencode` | OpenCode plugin adapter |
| `@ai-agent-local-memory/adapter-openclaw` | OpenClaw plugin adapter |

## Data Model

**Nodes (Neurons):** Memory units with types:
- `concept` — Key entity extracted from conversation
- `assertion` — Composite claim from multiple concepts
- `definition` — Definition-style description
- `filler` — Low-priority context
- `episode` — Full conversation reference
- `meta` — Hub node (consolidated summary)

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

### Retrieval (Dual-Path)
1. Check working memory queue (recently/frequently accessed nodes)
2. If found → use as seeds for spreading activation
3. If not → full-text search (FTS5) → top results become seeds
4. Spreading activation propagates through graph edges with hop decay

### Working Memory
LRU-frequency hybrid queue (default 1000 items). Score = `frequency × exp(-0.01 × hours_since_access)`. Lowest-score items evicted when full.

## Usage with OpenCode

### Install

#### Option A: npm (recommended)

Add to `opencode.json` or `opencode.jsonc`:
```json
{
  "plugin": ["ai-agent-local-memory"]
}
```

Restart OpenCode — it will automatically download and load the plugin.

#### Option B: From source

Clone and build:
```bash
git clone https://github.com/jackieju/AIAgentLocalMemory.git
cd AIAgentLocalMemory
bun install
bun build packages/adapter-opencode/src/index.ts --outdir dist --target bun --external @opencode-ai/plugin
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/ai-agent-local-memory.js
```

Restart OpenCode — the plugin is loaded automatically from the `plugins/` directory.

### Per-project control

The plugin is installed globally but you can control behavior per-project:

| Scenario | How |
|---|---|
| **All projects**: use alongside magic-context (default) | No config needed — auto-detected |
| **This project**: AIAgentLocalMemory fully takes over | Create `neural-context.json` in project root with `{"coexistWithMagicContext": false}` and remove magic-context from project-level opencode.json |
| **This project**: disable AIAgentLocalMemory | Add a project-level `opencode.json` that doesn't load the plugin |

### Tools Provided

| Tool | Description |
|---|---|
| `neural_remember` | Store a memory node (concept, assertion, definition, etc.) |
| `neural_recall` | Query memories via spreading activation |
| `neural_forget` | Remove a memory node by ID |
| `neural_status` | View engine stats and working memory |

### Configuration

Create `neural-context.json` in your project root or `.opencode/` directory:

```json
{
  "injectSystemPrompt": true,
  "contextWindowTokens": 128000,
  "budgetRatio": 0.6
}
```

| Option | Default | Description |
|---|---|---|
| `injectSystemPrompt` | `true` | Inject relevant memories into the system prompt each turn |
| `contextWindowTokens` | `128000` | Context window size in tokens for budget calculation |
| `budgetRatio` | `0.6` | Fraction of context window allocated to history |
| `coexistWithMagicContext` | auto-detected | Force coexistence mode on/off |

### Tools Provided

| Tool | Description |
|---|---|
| `neural_remember` | Store a memory node (concept, assertion, definition, etc.) |
| `neural_recall` | Find memories by ASSOCIATION via graph traversal + spreading activation |
| `neural_forget` | Remove a memory node by ID |
| `neural_note` | Save durable facts/notes (session/project/global scope) |
| `neural_reduce` | Drop tagged content (suppress from rendering) |
| `neural_pin` | Pin content to always show at full fidelity |
| `neural_expand` | Expand compressed/elided content back to full text |
| `neural_backup` | Backup the entire memory graph to a timestamped directory |
| `neural_status` | View engine stats and working memory |

## Using alongside magic-context

**Automatic coexistence detection**: When this plugin detects magic-context in your `opencode.json`, it automatically enters coexistence mode:

- `messages.transform` is **disabled** (magic-context handles context compression)
- Memory content injection is **disabled** (avoids double injection)
- Tool usage guide is **still injected** (so the agent knows neural_* tools exist)
- All `neural_*` tools remain **fully functional** for associative memory

In this mode, magic-context handles the "context window management" while AIAgentLocalMemory provides "associative memory" — a complementary relationship.

### When to use standalone (without magic-context)

Replace magic-context entirely in `opencode.json`:
```json
{
  "plugin": ["@ai-agent-local-memory/adapter-opencode"],
  "compaction": { "auto": false, "prune": false }
}
```

In standalone mode, this plugin handles:
- Conversation history compression (activation-based fidelity rendering)
- Cross-session memory (neural graph with Hebbian learning)
- Session facts and notes
- Full context window management

## OpenClaw Installation

```bash
openclaw plugins install @ai-agent-local-memory/adapter-openclaw
openclaw gateway restart
```

Configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "neural-context"
    },
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
    }
  }
}
```

### OpenClaw Configuration Options

| Option | Default | Description |
|---|---|---|
| `storageDir` | `~/.local/share/ai-agent-local-memory` | Custom storage directory |
| `autoRecall` | `true` | Inject relevant memories before every AI turn via spreading activation |
| `autoCapture` | `true` | Store conversations and build associative edges after every turn |
| `maxRecallResults` | `10` | Maximum memories injected into context per turn |
| `debug` | `false` | Enable verbose debug logs |

### OpenClaw Tools Provided

| Tool | Description |
|---|---|
| `neural_recall` | Find memories by ASSOCIATION via graph traversal + spreading activation |
| `neural_remember` | Store information with automatic associative linking |
| `neural_forget` | Remove a memory node by ID |
| `neural_note` | Save durable facts/notes that persist across sessions |
| `neural_status` | View engine stats and working memory |

## Shared Memory Across Hosts

If you install AIAgentLocalMemory in both OpenCode and OpenClaw, they share the same memory graph by default:

```
~/.local/share/ai-agent-local-memory/
├── graph.db       ← shared by both adapters
└── episodes/      ← shared
```

Memories stored via OpenClaw are immediately available in OpenCode and vice versa. Both adapters use `projectId: "global"` and the same default storage path.

SQLite WAL mode handles concurrent reads. Concurrent writes are rare (only on `agent_end`) and are retried automatically via SQLite's busy timeout.

To use separate memory stores, set a custom `storageDir` in one adapter's config.

## Backup

### Via tool (in OpenCode)

Call `neural_backup` during a session:
```
neural_backup()                           → backs up to ~/.local/share/ai-agent-local-memory/backups/<timestamp>/
neural_backup(destination="/path/to/dir") → backs up to custom directory
```

### Manual backup

```bash
cp -r ~/.local/share/ai-agent-local-memory/ ~/backup/ai-agent-local-memory-$(date +%Y%m%d)/
```

Data directory contents:
```
~/.local/share/ai-agent-local-memory/
├── graph.db          ← all nodes, edges, FTS index (single SQLite file)
├── graph.db-wal      ← WAL journal (may not exist when idle)
├── graph.db-shm      ← shared memory (may not exist when idle)
├── episodes/         ← raw session JSON files
└── backups/          ← created by neural_backup tool
```

For a consistent backup, ensure no active write operations are in progress. SQLite WAL mode guarantees that copying `graph.db` + `graph.db-wal` together is always consistent.

## Development

```bash
bun install
bun run --filter='*' build
bun run --filter='*' test
```

## Development Session

The original design session for this project is in OpenCode. To resume:

```bash
opencode --session ses_166d0e7b9ffeBpCjAtqVkPPkP4
```

Note: This session was started in `/Users/I027910/Projects/HanziZombieDefense` directory.

## License

MIT
