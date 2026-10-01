# 编写适配器 —— 基于 `core` 为任意 agent 构建

> `@ai-agent-local-memory/core` 是一个**宿主无关**的记忆 + 上下文压缩引擎。
> 它从不 import SQLite、从不直接调用 LLM、对 OpenCode 一无所知。
> **适配器（adapter）**就是把 `core` 接到具体 agent 宿主上的那层薄胶水。
> 本文以我们自己的 `adapter-opencode` 为真实范本，精确说明**接一个新宿主你必须实现什么**。
>
> core 包：`packages/core` —— 参考适配器：`packages/adapter-opencode/src/index.ts`
>
> 🇬🇧 English: [WRITING-ADAPTERS.md](./WRITING-ADAPTERS.md)

---

## `core` 给你什么，你提供什么

`core` 出大脑，宿主出双手。分工如下：

| `core` 提供（直接 import 用） | 你（适配器）必须提供 |
|---|---|
| `NeuralContextEngine` —— 记忆引擎 | 一个 `StorageProvider`（持久化） |
| `Historian` —— 对话压缩器 | 一个 `LLMProvider` / `EmbeddingProvider`（或复用我们的） |
| `runCompartmentTransform` —— 压缩入口 | 一个 `TransformDeps` 捆绑包（宿主胶水） |
| `OperationLog`、`LoggedStorageProvider` —— 同步日志 | 宿主钩子（你的 agent 如何调进胶水层） |
| 现成的 provider（`OpenAICompatibleLLM`、`OllamaLLM` 等） | 配置加载（形状由你定） |

适配器的全部工作就是：**实现三个契约、接几个宿主钩子、传一份配置。**

---

## 安装与引入

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
  // 类型:
  type StorageProvider,
  type LLMProvider,
  type EmbeddingProvider,
  type TransformDeps,
  type EngineConfig,
} from "@ai-agent-local-memory/core";
```

`core` 唯一的 public 入口是 `packages/core/src/index.ts`（一个 barrel 导出），你需要的东西全在那里。
想要开箱即用的 SQLite `StorageProvider`，见 `@ai-agent-local-memory/storage-sqlite`。

---

## 契约 1 —— `StorageProvider`（持久化）

`core` 从不碰数据库，持久化层由你注入。完整方法面（`packages/core/src/interfaces.ts`）：

```ts
export interface StorageProvider {
  // 生命周期
  open(projectId: string): Promise<void>;
  close(): Promise<void>;
  // 节点
  getNode(id: string): Promise<MemoryNode | null>;
  putNode(node: MemoryNode): Promise<void>;
  updateNode(id: string, updates: Partial<Omit<MemoryNode, "id">>): Promise<void>;
  deleteNode(id: string): Promise<void>;
  getNodesByIds(ids: string[]): Promise<MemoryNode[]>;
  queryNodes(filter: NodeFilter): Promise<MemoryNode[]>;
  // 边
  getEdges(nodeId: string, direction?: "in" | "out" | "both"): Promise<Synapse[]>;
  putEdge(edge: Synapse): Promise<void>;
  updateEdge(src, dst, type, updates): Promise<void>;
  deleteEdge(src, dst, type): Promise<void>;
  getEdgesBatch(nodeIds: string[], direction?): Promise<Synapse[]>;
  // 全文检索
  search(query: string, limit?: number): Promise<MemoryNode[]>;
  searchWithScores?(query: string, limit?: number): Promise<Array<{ node: MemoryNode; score: number }>>;
  // 批量
  getAllNodes(): Promise<MemoryNode[]>;
  getAllEdges(): Promise<Synapse[]>;
  getNodeCount(): Promise<number>;
}
```

`searchWithScores` 可选（存在时混合排序会用它）。最省事的路：直接复用
`@ai-agent-local-memory/storage-sqlite` 里的 `SqliteStorageProvider`，整个契约都不用自己写。

---

## 契约 2 —— `LLMProvider` / `EmbeddingProvider`

`core` 从不 import 任何 LLM SDK。要么复用内置 provider（`OpenAICompatibleLLM`、`OllamaLLM` 等），
要么实现这两个极小的接口：

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

`Historian`（压缩器）接收一个 `LLMProvider`：

```ts
export interface HistorianConfig {
  llm: LLMProvider;
  fallbackModels?: string[];  // 默认 []
  minWindow?: number;         // 默认 6
  maxWindow?: number;         // 默认 12
}
```

---

## 契约 3 —— `TransformDeps`（宿主胶水）

这是适配器工作的核心。`runCompartmentTransform(input, output, deps)` 是宿主每轮调用的压缩入口；
`deps: TransformDeps` 就是宿主把 `core` 自己不可能知道的东西统统递进去的方式。以下逐字摘自
`packages/core/src/context-compressor.ts`（源码里字段类型是 `any`，此处如实复现——真正重要的是注释）：

```ts
export interface TransformDeps {
  // 宿主原生用量查询。宿主测不出就返回 0% → core 回退到自己计数。
  getContextUsage: (sid: string) => { percentage: number; inputTokens: number };
  // 宿主有真实用量来源吗？false/缺省 → core 自己计数。
  hasNativeUsage?: boolean;

  // 上一条 assistant 回合是否停在工具调用中途？true/false 为权威;
  // undefined = 判断不了 → core 用消息数组启发式。
  getIsMidTurn?: (sid: string) => boolean | undefined;

  // 最新 user 消息 id，用来校准保护线；undefined = 宿主解析不出。
  getLastUserMessageId?: (sid: string) => string | undefined;

  // ★ 413 断路器：上一轮是否撑爆了模型上下文？
  //   中立契约 —— core 不学习任何宿主专属的错误名。
  //   { overflowed:true, tokensUsed?, tokensLimit?, observedOnTurnId? } = 宿主看到了溢出
  //   { overflowed:false } = 唯一的复位信号，仅在权威的成功时才发
  //   undefined           = 宿主测不出（必须返回 undefined，绝不能返回 false ——
  //                         false 会错误地复位断路器）
  getPreviousOverflow?: (sid: string) =>
    { overflowed: boolean; tokensUsed?: number; tokensLimit?: number; observedOnTurnId?: string } | undefined;

  storage: any;           // 带 searchWithScores 的 StorageProvider
  rawStorage: any;        // 底层 sqlite provider（适配器用 getDb()）
  compartmentStore: any;  // compartment（摘要）存储

  historian: any;         // Historian 实例
  pendingIdleWork: any;

  countClaudeTokens: (text: string) => number;  // 复用 core 导出的函数
  msgTokensMemo: any; msgTokenCache: any;
  setActiveTokenizerModel: any; resolveContextWindow: any;  // 复用 core 导出
  buildToolStub: any; resolveToolTier: any; toEpochMs: any;  // 复用 core 导出
  pinnedTags: any; droppedTags: any;

  pluginConfig: any;      // 你的配置（原样透传；见下）
  sessionId: any; localLlmMode: any; autoEscalateAfter: any;

  client?: any;           // OpenCode 专属句柄；其他宿主可省略
  dataBase?: any; directory?: any;

  state: any;             // 可变状态袋（适配器用 getter/setter 对实现）

  log?: (e: { file: string; text: string; append?: boolean }) => void;  // 诊断输出
}
```

**`getContextUsage` 是唯一必需的回调。** 其余所有 `get*` 都可选——省略它 `core` 就用启发式回退。

**唯一一个必须做对的坑：`getPreviousOverflow` 的三态。** `{overflowed:false}` 是*复位*信号，
只能在宿主*权威*地观察到该回合成功时才发。测不出就返回 `undefined`——返回 `false` 会错误复位
413 断路器，使它的止损目的失效。

---

## 配置

两份互相独立的配置——别混：

**`EngineConfig`**（传给 `engine.init()`，在 `core` 里定义）。默认值来自 `engine.ts`：

| 字段 | 类型 | 默认 |
|---|---|---|
| `storage` | StorageProvider | 必填 |
| `llm` / `embedding` | provider? | — |
| `learningRate` | number? | 0.1 |
| `decayRate` | number? | 0.005 |
| `pruneThreshold` | number? | 0.01 |
| `maxHops` | number? | 3 |
| `activationThreshold` | number? | 0.08 |
| `workingMemorySize` | number? | 1000 |
| `projectId` | string? | "default" |
| `episodesDir` | string? | — |

**`PluginConfig`** 是*适配器自己*的形状（从你宿主的配置文件读）。它被原样透传进
`deps.pluginConfig`——`core` 只把 `llm`/`embedding` 两块翻译成 provider 对象，其余字段怎么解释全由你定。
我们 OpenCode 适配器支持的完整字段见[配置参考](./CONFIGURATION-REFERENCE_CN.md)。

---

## 宿主钩子 —— 你的 agent 必须调用什么

我们的 OpenCode 适配器接了六个钩子。不同宿主暴露的钩子名不同，但**职责**是通用的。
摘自 `packages/adapter-opencode/src/index.ts`：

| 职责 | OpenCode 钩子 | 做什么 |
|---|---|---|
| **压缩**（主入口） | `experimental.chat.messages.transform` | 在消息数组进模型前改写它 → 委托给 `runCompartmentTransform`。 |
| **记忆注入** | `experimental.chat.system.transform` | 把 project-memory / user-character / learned-experience / session-history 块前置到 system prompt。 |
| **捕获 user 消息** | `chat.message` | 用户按回车时同步记下这行。绝不碰 LLM/DB/网络（保持当前回合不被阻塞）。 |
| **工具短路 / 训练** | `tool.execute.before` / `.after` | 仅 replay 模式：从历史短路工具调用，或采样训练数据。 |
| **延迟工作 + 归档** | `event`（`session.idle`） | session 空闲时跑延迟压缩/建边，并写出 transcript MD。 |

如果你的宿主只需要记忆（像我们的 `adapter-openclaw`，完全不做压缩），你要实现的就少得多——
只要一个回合前的 recall 钩子和一个回合后的 capture 钩子。

---

## 最小接线骨架

从真实的 `adapter-opencode` 精简而来（宿主钩子名会随你的 agent 不同而不同）：

```ts
// 宿主入口：接收工作目录 + 宿主 client，返回钩子对象
async function MyAdapter({ directory, client }) {
  const pluginConfig = loadConfig(directory);            // 你的配置形状

  // --- core 引擎组装 ---
  const rawStorage = new SqliteStorageProvider();        // 宿主侧持久化
  const opLog      = new OperationLog(syncDir);
  const storage    = new LoggedStorageProvider(rawStorage, opLog);
  const engine     = new NeuralContextEngine();

  // 按配置选 provider（或复用 core 的）
  const llm       = pluginConfig.llm ? new OpenAICompatibleLLM({ ...pluginConfig.llm }) : undefined;
  const embedding = pluginConfig.embedding ? new OpenAICompatibleEmbedding({ ...pluginConfig.embedding }) : undefined;

  await engine.init({ storage, projectId: "global", episodesDir, llm, embedding });

  const compartmentStore = new CompartmentStore(rawStorage.getDb());
  const historian        = new Historian({ llm, fallbackModels: ["gpt-4.1-mini", "gpt-5-mini"] });

  // --- 宿主胶水：针对你的宿主实现 TransformDeps 的各回调 ---
  function getContextUsage(sid) { /* 查宿主用量，或返回 {percentage:0, inputTokens:0} */ ... }
  function getPreviousOverflow(sid) { /* 查宿主上一轮；见上面的三态规则 */ ... }
  // ... getIsMidTurn、getLastUserMessageId、getSessionMessageList ...

  const deps = {
    getContextUsage, hasNativeUsage: true, getIsMidTurn, getLastUserMessageId, getPreviousOverflow,
    compartmentStore, historian, pendingIdleWork, pluginConfig,
    rawStorage, storage, countClaudeTokens, buildToolStub, resolveToolTier,
    setActiveTokenizerModel, resolveContextWindow, toEpochMs,
    client, directory,
    state: { /* 跨调用可变状态的 getter/setter 对 */ },
    log: (e) => { /* 写诊断 */ },
  };

  // --- 接钩子 ---
  return {
    "chat.messages.transform": (input, output) => runCompartmentTransform(input, output, deps),
    "chat.system.transform":   async (_in, out) => { /* 把记忆块注入 out.system */ },
    "chat.message":            async (_in, out) => { /* 同步记下 user 消息 */ },
    "event":                   async (ev) => { /* 空闲时：延迟压缩 + 归档 */ },
    // ... 需要 replay/训练再接 tool.execute.before/after ...
  };
}

export default { id: "my-agent-memory", server: MyAdapter };
```

整体形状就这些。两个现成适配器展示了跨度：
- **`adapter-opencode`** —— 完整压缩 + 记忆 + 同步（全部六个钩子）。
- **`adapter-openclaw`** —— 仅记忆（recall/remember），无压缩、无 413 断路器。

照你宿主的需要挑一个研究、把胶水抄过去即可。
