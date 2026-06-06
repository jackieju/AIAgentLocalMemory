# AIAgentLocalMemory

Neural-network-inspired memory engine for AI agents. Uses Hebbian learning, spreading activation, and a working memory queue instead of traditional database queries.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Adapter Layer (per-host)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ OpenCode │  │ OpenClaw │  │  CLI/API │      │
│  │ Adapter  │  │ (future) │  │ (future) │      │
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

#### Option A: Local install (from source)

Clone and build:
```bash
git clone https://github.com/jackieju/AIAgentLocalMemory.git
cd AIAgentLocalMemory
bun install
```

Build a self-contained bundle and install to OpenCode's global plugins directory:
```bash
cd packages/adapter-opencode
bun build src/index.ts --outdir dist --target node --format esm --external @opencode-ai/plugin
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/ai-agent-local-memory.js
```

That's it. Restart OpenCode — the plugin is loaded automatically from the `plugins/` directory.

#### Option B: npm install (when published)

Add to `opencode.json`:
```json
{
  "plugin": ["@ai-agent-local-memory/adapter-opencode"]
}
```

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
