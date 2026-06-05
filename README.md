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

Add to `opencode.json`:

```json
{
  "plugin": ["@ai-agent-local-memory/adapter-opencode"]
}
```

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
  "injectSystemPrompt": true
}
```

| Option | Default | Description |
|---|---|---|
| `injectSystemPrompt` | `true` | Inject relevant memories into the system prompt each turn |

## Using alongside magic-context

This plugin can coexist with magic-context. They use separate storage, separate tool names, and separate data models. The only overlap is the `experimental.chat.system.transform` hook — both plugins inject context into the system prompt.

If you use both simultaneously and want to avoid double context injection (which wastes context window budget), disable this plugin's injection:

```json
{
  "injectSystemPrompt": false
}
```

With injection disabled, the `neural_recall` tool still works — the agent can explicitly query the neural memory when needed, rather than having it auto-injected every turn.

## Development

```bash
bun install
bun run --filter='*' build
bun run --filter='*' test
```

## License

MIT
