# Writing an Adapter — Build on `core` for Any Agent

> `@ai-agent-local-memory/core` is a **host-agnostic** memory + context-compression engine.
> It never imports SQLite, never calls an LLM directly, and knows nothing about OpenCode.
> An **adapter** is the thin glue layer that wires `core` into a concrete agent host.
> This document shows exactly **what you must implement** to bring the engine to a new host,
> using our own `adapter-opencode` as the real reference.
>
> Core package: `packages/core` — Reference adapter: `packages/adapter-opencode/src/index.ts`
>
> 🇨🇳 中文版：[WRITING-ADAPTERS_CN.md](./WRITING-ADAPTERS_CN.md)

---

## What `core` gives you, what you provide

`core` ships the brains; the host provides the hands. The split:

| `core` provides (import and use) | You (the adapter) must provide |
|---|---|
| `NeuralContextEngine` — memory engine | A `StorageProvider` (persistence) |
| `Historian` — conversation compressor | An `LLMProvider` / `EmbeddingProvider` (or reuse ours) |
| `runCompartmentTransform` — compression entry point | A `TransformDeps` bundle (host glue) |
| `OperationLog`, `LoggedStorageProvider` — sync log | Host hooks (how your agent calls into the glue) |
| Ready-made providers (`OpenAICompatibleLLM`, `OllamaLLM`, …) | Config loading (shape is yours) |

The whole job of an adapter is: **implement three contracts, wire a few host hooks, pass a config.**

---

## Install & import

```ts
import {
  NeuralContextEngine,
  Historian,
  runCompartmentTransform,
  OperationLog,
  LoggedStorageProvider,
  OpenAICompatibleLLM,
  OpenAICompatibleEmbedding,
  OllamaLLM,
  OllamaEmbedding,
  FallbackEmbedding,
  countClaudeTokens,
  buildToolStub,
  resolveToolTier,
  setActiveTokenizerModel,
  resolveContextWindow,
  toEpochMs,
  // types:
  type StorageProvider,
  type LLMProvider,
  type EmbeddingProvider,
  type TransformDeps,
  type EngineConfig,
} from "@ai-agent-local-memory/core";
```

`core`'s only public entry is `packages/core/src/index.ts` (a barrel export). Everything you need
is there. For a batteries-included SQLite `StorageProvider`, see `@ai-agent-local-memory/storage-sqlite`.

---

## Contract 1 — `StorageProvider` (persistence)

`core` never touches a database. You inject the persistence layer. Full method surface
(`packages/core/src/interfaces.ts`):

```ts
export interface StorageProvider {
  // lifecycle
  open(projectId: string): Promise<void>;
  close(): Promise<void>;
  // nodes
  getNode(id: string): Promise<MemoryNode | null>;
  putNode(node: MemoryNode): Promise<void>;
  updateNode(id: string, updates: Partial<Omit<MemoryNode, "id">>): Promise<void>;
  deleteNode(id: string): Promise<void>;
  getNodesByIds(ids: string[]): Promise<MemoryNode[]>;
  queryNodes(filter: NodeFilter): Promise<MemoryNode[]>;
  // edges
  getEdges(nodeId: string, direction?: "in" | "out" | "both"): Promise<Synapse[]>;
  putEdge(edge: Synapse): Promise<void>;
  updateEdge(src, dst, type, updates): Promise<void>;
  deleteEdge(src, dst, type): Promise<void>;
  getEdgesBatch(nodeIds: string[], direction?): Promise<Synapse[]>;
  // full-text search
  search(query: string, limit?: number): Promise<MemoryNode[]>;
  searchWithScores?(query: string, limit?: number): Promise<Array<{ node: MemoryNode; score: number }>>;
  // bulk
  getAllNodes(): Promise<MemoryNode[]>;
  getAllEdges(): Promise<Synapse[]>;
  getNodeCount(): Promise<number>;
}
```

`searchWithScores` is optional (hybrid ranking uses it when present). Easiest path: just reuse
`SqliteStorageProvider` from `@ai-agent-local-memory/storage-sqlite` and skip this entirely.

---

## Contract 2 — `LLMProvider` / `EmbeddingProvider`

`core` never imports an LLM SDK. Either reuse a built-in provider (`OpenAICompatibleLLM`,
`OllamaLLM`, …) or implement these two tiny interfaces:

```ts
export interface LLMProvider {
  complete(prompt: string, options?: { model?: string; maxTokens?: number }): Promise<string>;
  extractConcepts(text: string): Promise<ConceptExtraction>;
}
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}
```

`Historian` (the compressor) takes an `LLMProvider`:

```ts
export interface HistorianConfig {
  llm: LLMProvider;
  fallbackModels?: string[];  // default []
  minWindow?: number;         // default 6
  maxWindow?: number;         // default 12
}
```

---

## Contract 3 — `TransformDeps` (the host glue)

This is the heart of adapter work. `runCompartmentTransform(input, output, deps)` is the
compression entry point your host calls on every turn; `deps: TransformDeps` is how the host
hands `core` everything it can't know on its own. Verbatim from
`packages/core/src/context-compressor.ts` (fields are typed `any` in the source — reproduced
faithfully; the comments are what matter):

```ts
export interface TransformDeps {
  // Host-native usage query. Return 0% if the host can't measure → core falls back to self-count.
  getContextUsage: (sid: string) => { percentage: number; inputTokens: number };
  // Does the host have a real usage source? false/omitted → core self-counts.
  hasNativeUsage?: boolean;

  // Is the previous assistant turn stopped mid tool-call? true/false authoritative;
  // undefined = can't tell → core uses a message-array heuristic.
  getIsMidTurn?: (sid: string) => boolean | undefined;

  // Latest user message id, used to calibrate the protect line; undefined = host can't resolve.
  getLastUserMessageId?: (sid: string) => string | undefined;

  // ★ 413 circuit breaker: did the previous turn overflow the model's context?
  //   Neutral contract — core learns NO host-specific error names.
  //   { overflowed:true, tokensUsed?, tokensLimit?, observedOnTurnId? } = host saw an overflow
  //   { overflowed:false } = the ONLY reset signal, emit ONLY on an authoritative success
  //   undefined           = host can't measure (MUST return undefined, never false —
  //                         false falsely resets the breaker)
  getPreviousOverflow?: (sid: string) =>
    { overflowed: boolean; tokensUsed?: number; tokensLimit?: number; observedOnTurnId?: string } | undefined;

  storage: any;           // StorageProvider with searchWithScores
  rawStorage: any;        // underlying sqlite provider (adapter uses getDb())
  compartmentStore: any;  // compartment (summary) store

  historian: any;         // Historian instance
  pendingIdleWork: any;

  countClaudeTokens: (text: string) => number;  // reuse core's exported fn
  msgTokensMemo: any; msgTokenCache: any;
  setActiveTokenizerModel: any; resolveContextWindow: any;  // reuse core exports
  buildToolStub: any; resolveToolTier: any; toEpochMs: any;  // reuse core exports
  pinnedTags: any; droppedTags: any;

  pluginConfig: any;      // your config (passed through; see below)
  sessionId: any; localLlmMode: any; autoEscalateAfter: any;

  client?: any;           // OpenCode-specific handle; omit for other hosts
  dataBase?: any; directory?: any;

  state: any;             // mutable state bag (adapter implements as getter/setter pairs)

  log?: (e: { file: string; text: string; append?: boolean }) => void;  // diagnostic sinks
}
```

**`getContextUsage` is the only required callback.** Every other `get*` is optional — omit it
and `core` uses a heuristic fallback.

**The one gotcha to get right: `getPreviousOverflow`'s three states.** `{overflowed:false}` is a
*reset* signal and must be emitted only when the host *authoritatively* observed the turn
succeed. If you can't measure, return `undefined` — returning `false` will falsely reset the 413
breaker and defeat its loss-stopping purpose.

---

## Config

Two separate configs — don't confuse them:

**`EngineConfig`** (passed to `engine.init()`, defined in `core`). Defaults from `engine.ts`:

| Field | Type | Default |
|---|---|---|
| `storage` | StorageProvider | required |
| `llm` / `embedding` | provider? | — |
| `learningRate` | number? | 0.1 |
| `decayRate` | number? | 0.005 |
| `pruneThreshold` | number? | 0.01 |
| `maxHops` | number? | 3 |
| `activationThreshold` | number? | 0.08 |
| `workingMemorySize` | number? | 1000 |
| `projectId` | string? | "default" |
| `episodesDir` | string? | — |

**`PluginConfig`** is the *adapter's own* shape (read from your host's config file). It is passed
through untouched into `deps.pluginConfig` — `core` only translates the `llm`/`embedding` blocks
into provider objects; everything else is yours to interpret. See
[Configuration Reference](./CONFIGURATION-REFERENCE.md) for the full field list our OpenCode
adapter supports.

---

## Host hooks — what your agent must call

Our OpenCode adapter wires six hooks. A different host exposes different hook names, but the
*responsibilities* carry over. From `packages/adapter-opencode/src/index.ts`:

| Responsibility | OpenCode hook | What it does |
|---|---|---|
| **Compression** (the main one) | `experimental.chat.messages.transform` | Rewrites the message array before it hits the model → delegates to `runCompartmentTransform`. |
| **Memory injection** | `experimental.chat.system.transform` | Prepends project-memory / user-character / learned-experience / session-history blocks to the system prompt. |
| **Capture user message** | `chat.message` | On Enter, synchronously logs the user line. Never touches LLM/DB/network (keeps the main turn unblocked). |
| **Tool short-circuit / training** | `tool.execute.before` / `.after` | Replay-mode only: short-circuit tool calls from history, or sample training data. |
| **Deferred work + archive** | `event` (`session.idle`) | Runs deferred compression/linking and writes the transcript MD when the session goes idle. |

If your host only needs memory (like our `adapter-openclaw`, which skips compression entirely),
you implement far less — just a before-turn recall hook and an after-turn capture hook.

---

## Minimal wiring skeleton

Boiled down from the real `adapter-opencode` (host hook names will differ for your agent):

```ts
// host entry: receives working directory + host client, returns hook object
async function MyAdapter({ directory, client }) {
  const pluginConfig = loadConfig(directory);            // your config shape

  // --- core engine assembly ---
  const rawStorage = new SqliteStorageProvider();        // host-side persistence
  const opLog      = new OperationLog(syncDir);
  const storage    = new LoggedStorageProvider(rawStorage, opLog);
  const engine     = new NeuralContextEngine();

  // pick providers from config (or reuse core's)
  const llm       = pluginConfig.llm ? new OpenAICompatibleLLM({ ...pluginConfig.llm }) : undefined;
  const embedding = pluginConfig.embedding ? new OpenAICompatibleEmbedding({ ...pluginConfig.embedding }) : undefined;

  await engine.init({ storage, projectId: "global", episodesDir, llm, embedding });

  const compartmentStore = new CompartmentStore(rawStorage.getDb());
  const historian        = new Historian({ llm, fallbackModels: ["gpt-4.1-mini", "gpt-5-mini"] });

  // --- host glue: implement the TransformDeps callbacks against YOUR host ---
  function getContextUsage(sid) { /* query host usage, or return {percentage:0, inputTokens:0} */ ... }
  function getPreviousOverflow(sid) { /* inspect host's last turn; see three-state rule above */ ... }
  // ... getIsMidTurn, getLastUserMessageId, getSessionMessageList ...

  const deps = {
    getContextUsage, hasNativeUsage: true, getIsMidTurn, getLastUserMessageId, getPreviousOverflow,
    compartmentStore, historian, pendingIdleWork, pluginConfig,
    rawStorage, storage, countClaudeTokens, buildToolStub, resolveToolTier,
    setActiveTokenizerModel, resolveContextWindow, toEpochMs,
    client, directory,
    state: { /* getter/setter pairs for cross-call mutable state */ },
    log: (e) => { /* write diagnostics */ },
  };

  // --- wire the hooks ---
  return {
    "chat.messages.transform": (input, output) => runCompartmentTransform(input, output, deps),
    "chat.system.transform":   async (_in, out) => { /* inject memory blocks into out.system */ },
    "chat.message":            async (_in, out) => { /* synchronously log user message */ },
    "event":                   async (ev) => { /* on idle: deferred compress + archive */ },
    // ... tool.execute.before/after if you need replay/training ...
  };
}

export default { id: "my-agent-memory", server: MyAdapter };
```

That's the whole shape. Two existing adapters prove the range:
- **`adapter-opencode`** — full compression + memory + sync (all six hooks).
- **`adapter-openclaw`** — memory only (recall/remember), no compression, no 413 breaker.

Study whichever matches your host's needs and copy the glue.
