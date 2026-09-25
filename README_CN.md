# AIAgentLocalMemory

> 🌐 English README: [README.md](./README.md)

<!--Neural-network-inspired memory engine for AI agents. Uses Hebbian learning, spreading activation, and a working memory queue instead of traditional database queries.

**Transform any AI agent into a growing, personal intelligence.** This plugin gives AI agents their own local brain — memory that persists, context that scales, and a local LLM that learns and improves through daily use. Like giving your AI a private mind that gets smarter over time. Dont' waste any token any chat any dollar in your daily talk with LLM, which can make your local LLM smarter everyday.
-->

**AI-Agent-Local-Memory** 是一个把以下能力整合进单一本地设备栈的项目：

- **可审计、抗漂移的记忆** —— 每一条事实都可追溯到它的来源
- **智能上下文调度** —— 在恰当的时刻给出恰当的记忆
- **后台预推理** —— 智能体在空闲时提前思考
- **完整的推理轨迹可观测性** —— 没有任何事情发生在黑箱里
- **本地师生自蒸馏** —— 智能体在你的机器上自我学习、自我改进
- **内置常识与伦理对齐** —— 安全是地基，而非事后补丁

<!-- Traditional memory stores drift, can't be audited, can't be trained on, can't be explained, ship with no safety layer, and can't evolve on their own. **AI-Agent-Local-Memory fixes the whole chain.**-->

面向 **本地优先、隐私、可解释、可自我演化的智能体** 的下一代记忆架构。

## 功能特性

### 智能体上下文与企业记忆管理

- **无限上下文管理** —— 冗长的历史会被后台 historian（后台摘要器）透明地压缩成 `<compartment>` 摘要，而最近的对话尾部保持完整保真，因此对话不会撞上 token 上限墙。
- **神经记忆** —— 一个联想图（节点 + 带权突触、Hebbian 学习、扩散激活、工作记忆）按语义和联想来召回，而非关键词匹配。
- **跨项目共享记忆** —— 一张全局记忆图在这台机器的每一个项目、每一个会话之间复用。
- **跨机器记忆同步** —— 记忆图通过一份 Git 支撑的仅追加操作日志在多台机器间复制（无冲突，`neural_sync` push / pull / status）。
- **跨设备会话同步** —— 完整的原始 OpenCode 会话（消息、工具调用、推理过程）可通过 `neural_session_import` 在第二台机器上重放，于是你换台电脑就能从上次停下的地方继续写。
- **可公开、可发布的记忆** —— 你可以把自己的记忆发布到任何地方（比如 github），或者获取别人的公开记忆并与自己智能体的记忆合并；别人也可以获取你的智能体记忆并与他自己的合并。
- **多语言与语义搜索** —— SQLite FTS5 配合 `Intl.Segmenter` 支持中日韩分词，并可选地通过任意兼容 OpenAI 或 Ollama 的端点做基于 embedding（嵌入向量）的语义召回。
- **自动会话持久化** —— 每一段对话都会镜像成一份可读的 Markdown 抄本，底层的 `opencode.db` 每天以 gzip 备份到 iCloud。
- **实时 TUI 侧边栏** —— 记忆图统计、同步状态、上下文压缩比、以及 LoRA 训练进度都直接呈现在 OpenCode 侧边栏里。
- **与第三方上下文管理器（magic-context）共存** —— 自动检测 `@cortexkit/opencode-magic-context` 并停用会冲突的钩子，同时保持 neural 工具可用。


### 成长中的智能体
- **成长中的本地智能体** —— 一个可选的本地 LLM（默认通过 Ollama 运行 Qwen3 14B），以三种模式运行 —— 观察者（Observer，静默地向服务器 LLM 学习）、学生（Student，不确定时自动升级求助）、或主力（Primary，完全自主）—— 并配有一条 LoRA 微调流水线，它在经过分歧过滤的问答对上训练，并在出现回退时自动回滚。
- **按需升级求助** —— `neural_ask_server` 让本地智能体用一个结构化的 `[Reasoning] + [Answer]` 提示词去咨询服务器 LLM，并把每一条响应存成一个可复用的 experience 节点。
- **人类常识** 人类的常识与道德才是真正的安全保障。智能体会周期性地请求阅读像《论语》这样的经典书籍，以理解何为人性与道德。


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

## 架构

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

### 知识路由 —— 你学到的东西最终去了哪里？

你通过 OpenCode 借助本插件进行的每一段对话，都会被拆成两条流：

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

**每一次你向某个 LLM 学习时，你的本地 LLM 也在学到更多。** 项目事实流入记忆图，于是未来的对话能靠联想召回它们。通用的推理与解决问题的模式流入训练对，于是在足够多的 LoRA 循环之后，本地模型就能独立处理它熟悉的问题形态 —— 无需任何云端 API。

## 企业用例：共享的成长型智能

对于在复杂项目上协作的大团队，本插件会创造一种在所有团队成员之间共同成长的 **集体智能**：

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

## 各个包（Packages）

| 包 | 描述 |
|---|---|
| `@ai-agent-local-memory/core` | 与宿主无关的引擎：图、Hebbian 学习、扩散激活、工作记忆、上下文渲染器 |
| `@ai-agent-local-memory/storage-sqlite` | SQLite + FTS5 存储（跨运行时：Bun 与 Node.js） |
| `@ai-agent-local-memory/adapter-opencode` | OpenCode 插件适配器（完整上下文管理） |
| `@ai-agent-local-memory/adapter-openclaw` | OpenClaw 插件适配器（ContextEngine + 记忆插槽） |

## 数据模型

**节点（神经元）：** 带类型的记忆单元：
- `concept`（概念）—— 从对话中提取的关键实体
- `assertion`（断言）—— 由多个概念组成的复合论断
- `definition`（定义）—— 定义式描述
- `filler`（填充）—— 低优先级上下文
- `episode`（情节）—— 完整对话引用
- `meta`（元）—— 枢纽节点（合并后的摘要）
- `fact`（事实）—— 跨会话持久保留的持久笔记/事实
- `experience`（经验）—— 从咨询服务器 LLM 中学到的解决方案

**突触（边）：** 带类型的加权连接：
- `entity`（实体）—— 共享的命名实体
- `temporal`（时间）—— 在同一时间窗内共现
- `lexical`（词汇）—— 词语重叠（Jaccard 0.2–0.55）
- `semantic`（语义）—— embedding 相似度
- `causal`（因果）—— 因果关系
- `compositional`（组合）—— 组合（概念 → 断言）

## 工作原理

### Hebbian 学习
边在共激活时增强：`Δw = η × (1 - w)`（渐近，永远不超过 1）。边随时间衰减：`w = w × exp(-λ × Δt)`。弱的、旧的、极少使用的边会被剪枝。

### 检索（混合打分）
1. 全文搜索（FTS5，OR 模式）→ 按 BM25 排名
2. 对最近访问过的节点做工作记忆加权
3. 从顶部种子做扩散激活 → 发现相关联的记忆
4. 混合分 = `FTS_weight × fts_score + activation_weight × spread_score`
5. 结果按相关性降序排序

### 上下文管理（Historian + Compartments）
长对话会被自动压缩，以留在上下文窗口之内：

1. **最近的消息**（最后 20 条）保持完整保真
2. **historian**（后台 LLM）把更早的消息压缩成 **compartment（压缩摘要块）** —— 三个层级的摘要：
   - **p1** —— 段落摘要（约 150 tokens）：目标、决策、涉及的文件
   - **p2** —— 一句话（约 25 tokens）：发生过的最重要的事
   - **p3** —— 标题（约 8 tokens）：像 git 提交的标题一样
3. **预算适配**：compartment 会以能塞进上下文窗口 15% 之内的最高保真度渲染
4. **触发**：每 6 轮，或当上下文超过 80% 预算时，historian 就压缩最旧的、尚未 compartment 化的那段窗口

**展开 compartment**：当你看到被压缩的历史时，说"展开那一段"或"给我看原文"—— LLM 就会调用 `neural_expand(start=N, end=M)` 来取回完整的原始文本。

**结果**：无限会话支持 —— 上下文永不溢出，旧对话以摘要形式保留，原始文本随时可按需取回。

### 查看原始对话历史

当对话被压缩成 compartment 后，你随时可以取回原文：

**只需自然地询问：**
- "展开前面那段摘要"
- "让我看看之前讨论 X 的原文"
- "show me the full text of that compressed section"
- "expand the earlier conversation about Y"

LLM 看到的 compartment 带有序号标记（`<compartment start="5" end="10">`），并会自动调用 `neural_expand(start=5, end=10)` 从 OpenCode 的数据库取回原始消息。

**直接使用工具：**
- `neural_expand(start=5, end=10)` —— 按序号范围展开一个 compartment
- `neural_expand(tags="3-5")` —— 按标签编号展开
- `neural_session_read(sessionId="ses_xxx")` —— 读取任意会话的消息

### 工作记忆
LRU-频率混合队列（默认 1000 项）。分数 = `frequency × exp(-0.01 × hours_since_access)`。满了时逐出分数最低的项。

---

## OpenCode 插件

### 安装

#### 方案 A：npm（推荐）

本插件以 [`ai-agent-local-memory`](https://www.npmjs.com/package/ai-agent-local-memory) 之名发布在 npm 上。OpenCode 在启动时会自动安装 npm 插件 —— 无需手动 `npm install`。

> **注意：** npm 发布版可能落后于最新开发进度。如果你想要最新的修复和特性，请从 GitHub 源码安装（下面的方案 B）。

添加到你的 OpenCode 配置（`~/.config/opencode/opencode.jsonc` 或项目级 `opencode.json`）：

```json
{
  "plugin": ["ai-agent-local-memory"]
}
```

重启 OpenCode。首次启动时，它会自动从 npm 拉取该插件。

要使用特定版本（可选）：
```json
{
  "plugin": ["ai-agent-local-memory@0.2.0"]
}
```

#### 方案 B：从源码安装

```bash
git clone https://github.com/jackieju/AIAgentLocalMemory.git
cd AIAgentLocalMemory
bun install
bun build packages/adapter-opencode/src/index.ts --outdir dist --target bun --external @opencode-ai/plugin
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/ai-agent-local-memory.js
```

重启 OpenCode。

### OpenCode 工具

| 工具 | 描述 |
|---|---|
| `neural_remember` | 存储一个记忆节点（concept、assertion、definition 等） |
| `neural_recall` | 通过图遍历 + 扩散激活按 **联想** 查找记忆 |
| `neural_forget` | 按 ID 删除一个记忆节点 |
| `neural_note` | 保存持久的事实/笔记（会话/项目/全局范围） |
| `neural_reduce` | 丢弃被打标签的内容（从渲染中抑制） |
| `neural_pin` | 钉住内容，使其始终以完整保真度显示 |
| `neural_expand` | 把被压缩/省略的内容展开回完整文本 |
| `neural_ask_server` | 就本地智能体无法解决的问题咨询服务器 LLM |
| `neural_import_history` | 把过去的 OpenCode 会话导入神经图 |
| `neural_session_import` | 重放从另一台机器导出的 OpenCode 会话（见 [跨设备会话同步](#cross-device-session-sync)） |
| `neural_backup` | 把整张记忆图备份到一个带时间戳的目录 |
| `neural_sync` | 通过 Git 在多台机器间同步记忆（init/push/pull/status） |
| `neural_status` | 查看引擎统计与工作记忆 |

### OpenCode 配置

在你的项目根目录或 `.opencode/` 目录下创建 `neural-context.json`：

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

| 选项 | 默认值 | 描述 |
|---|---|---|
| `injectSystemPrompt` | `true` | 每一轮把相关记忆注入系统提示词 |
| `contextWindowTokens` | `128000` | 用于预算计算的上下文窗口大小（以 token 计） |
| `budgetRatio` | `0.6` | 分配给历史的上下文窗口占比 |
| `coexistWithOtherContextManager` | 自动检测 | 强制开启/关闭共存模式 |
| `syncRepo` | — | 多机同步的 Git 远端 URL（启动时自动初始化） |
| `llm.provider` | — | LLM 提供方：`"openai"`、`"ollama"` 或 `"custom"` |
| `llm.baseUrl` | `https://api.openai.com/v1` | API 端点（用于自定义提供方） |
| `llm.apiKey` | `$OPENAI_API_KEY` | API 密钥（或通过环境变量设置） |
| `llm.model` | `gpt-4o-mini` | 模型名 |
| `embedding.provider` | — | Embedding 提供方：`"openai"`、`"ollama"` 或 `"custom"` |
| `embedding.baseUrl` | `https://api.openai.com/v1` | API 端点（用于自定义提供方） |
| `embedding.apiKey` | `$OPENAI_API_KEY` | API 密钥（或通过环境变量设置） |
| `embedding.model` | `text-embedding-3-small` | 模型名 |

### LLM 与 Embedding 增强

当配置了提供方后，引擎会自动增强记忆质量：

| 模块 | 触发条件 | 效果 |
|---|---|---|
| **LLMExtractor** | 配置了 `llm` | 在摄入时做高质量的概念/断言提取（相较于正则） |
| **EmbeddingLinker** | 配置了 `embedding` | 通过余弦相似度建立语义边（相较于仅词汇重叠） |
| **EdgeWeightPredictor** | 始终启用 | 多特征打分改进边权重 |
| **LightweightLinker** | 始终启用 | 基线的正则实体 + 词汇边（无需任何外部服务） |

在未配置提供方的情况下，系统仍可仅用 LightweightLinker 工作。

#### 提供方示例

**OpenAI：**
```json
{ "llm": { "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o-mini" } }
```

**Ollama（本地）：**
```json
{ "llm": { "provider": "ollama", "model": "llama3.2" },
  "embedding": { "provider": "ollama", "model": "nomic-embed-text" } }
```

**自定义的兼容 OpenAI 端点：**
```json
{ "llm": { "provider": "custom", "baseUrl": "http://localhost:8080/v1", "model": "my-model" } }
```

### 独立模式（例如替代 magic-context）

在独立模式下，本插件完全管理上下文窗口：
- 对话历史压缩（基于激活的保真度渲染）
- 跨会话记忆（带 Hebbian 学习的神经图）
- 会话事实与笔记
- 完整的上下文窗口预算管理

在 `opencode.json` 中替代 magic-context：
```json
{
  "plugin": ["ai-agent-local-memory"],
  "compaction": { "auto": false, "prune": false }
}
```

### 共存模式（例如与 magic-context 并存）

当在你的 `opencode.json` 中检测到 magic-context 时，插件会自动进入共存模式：

- `messages.transform` 被 **停用**（由 magic-context 负责上下文压缩）
- 记忆内容注入被 **停用**（避免双重注入）
- 工具使用指南 **仍会注入**（这样智能体知道 neural_* 工具的存在）
- 所有 `neural_*` 工具对联想记忆而言 **仍完全可用**

在此模式下，magic-context 负责"上下文窗口管理"，而 AIAgentLocalMemory 提供"联想记忆"。

### 逐项目控制

| 场景 | 做法 |
|---|---|
| 与 magic-context 并存（默认） | 无需配置 —— 自动检测 |
| AIAgentLocalMemory 完全接管 | `neural-context.json`：`{"coexistWithOtherContextManager": false}` + 从项目的 opencode.json 中移除 magic-context |
| 对本项目禁用 AIAgentLocalMemory | 使用一个不加载该插件的项目级 `opencode.json` |

### 成长中的本地智能体 —— 三种学习模式

本插件实现了一套 **成长型本地智能** 系统：一个本地 LLM 通过观察、引导式学习、或按需咨询，逐步向一个强大的服务器 LLM（Claude/GPT）学习。随着时间推移，本地智能体变得越来越能自给自足。

#### 配置

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

#### 各种模式

| 模式 | 主力模型 | 本地 LLM 角色 | 学习方法 |
|---|---|---|---|
| **observer**（观察者） | 服务器 LLM（OpenCode 配置） | 静默观察者 | 存储每一个 {问题, 回复} 对以供学习 |
| **student**（学生） | 本地 LLM（OpenCode provider = ollama） | 带安全网地主动作答 | 置信度低时通过 `neural_ask_server` 自动升级求助 |
| **primary**（主力） | 本地 LLM（OpenCode provider = ollama） | 完全自主 | 仅当用户明确说"问大模型"时才升级求助 |
| *(未配置)* | 服务器 LLM（OpenCode 配置） | 不适用 | 插件正常工作，不做本地学习 |

#### 观察者模式（Observer Mode）

本地 LLM 静默地观察服务器 LLM（Claude）如何处理每一个请求：

```
User asks question → Claude answers → Plugin stores {question, answer} as training pair
                                     → After 100 pairs: triggers LoRA fine-tuning automatically
```

- 训练数据存储在 `~/.local/share/ai-agent-local-memory/training-pairs/pairs.jsonl`
- 对响应质量无影响 —— 一切由服务器 LLM 处理
- 理想的起点：在切换到学生/主力模式之前先积累数据

##### 推理捕获（cotStrategy，opt-in 选择性开启）

单纯的 `{Q, A}` 对只教会本地模型模仿答案的风格，而非推理。**默认情况下插件不会强制任何推理捕获** —— 每一段对话都完全保持服务器 LLM 自然响应的样子，你永远不用为此多付 token，也不用等待重写。如果你也想让训练数据里包含推理，可以选择性地开启思维链捕获：

| 策略 | 行为 | 用户可见性 | 成本 |
|---|---|---|---|
| **`none`**（默认） | 不捕获推理。原样存储 `{Q, A}`。 | 不向响应添加任何内容 | 零 |
| **`thinking-tag`** | 服务器 LLM 在最终答案之前，把推理包在 `<thinking>...</thinking>` 标签里。两部分都作为训练输出被存储。 | 大多数 TUI 主题会将其隐藏，但确实会拉长响应长度 | 无额外 API 调用 |
| **`post-rewrite`** | 原始对话正常运行。会话空闲后，一个后台子会话请求服务器 LLM 把回复重写为 `[Reasoning] + [Answer]` 并存储重写结果。 | 用户看到的仍是原样回复 | 每个问答对多一次 API 调用（后台） |

通过 `localLlm.training.cotStrategy` 配置。**默认：`none`** —— 推理捕获完全是可选的。由你决定哪些对话被蒸馏出推理、以及何时进行。

#### 学生模式（Student Mode）

本地 LLM 是主要应答者（OpenCode provider = ollama），并带自动升级求助：

```
User asks question → Local LLM assesses confidence
  → High confidence + has relevant experience: answers independently
  → Low confidence / unfamiliar topic: calls neural_ask_server → learns from response
  → User corrects 3+ times: auto-suggests escalation for subsequent questions
```

- 置信度阈值可配置（`confidence.userThreshold`，默认 0.5）
- 不满意检测：追踪"不对"、"错了"、"wrong"、"重做"等信号
- 每一次成功的升级求助都存成训练对 → 周期性 LoRA 微调

#### 主力模式（Primary Mode）

本地 LLM 完全自主 —— 仅在用户明确请求时才升级求助：

```
User asks question → Local LLM answers independently (always)
User says "问大模型" → calls neural_ask_server → learns from response
```

- 最大自主性、最少服务器 LLM 用量
- 在完成了大量 LoRA 训练之后是理想选择

#### LoRA 微调流水线

当积累了足够的数据后，训练会自动发生：

```bash
# Manual training (packages/lora-pipeline/)
./train.sh                    # MLX LoRA training (Qwen3 8B, rank 8, 200 iters)
./benchmark.sh                # Compare base vs fine-tuned
./rollback.sh                 # Revert if degraded

# Or trigger from OpenCode:
# Use neural_export_training tool to export data manually
```

**自动训练**：插件监控训练对数量。当达到阈值（observer 为 100，student/primary 为 50）时，训练会以 `nice -n 19`（低 CPU 优先级）在后台被触发。

**侧边栏状态**：TUI 侧边栏显示训练状态：
```
◆ LoRA Training
Last: 3h ago ✓              ← last training time + result
Runs: 5  Improved: 3/5     ← total runs + success count
```

#### 远程本地 LLM

本地 LLM 可以运行在你网络中的另一台机器上：

```json
{
  "localLlm": {
    "provider": "ollama",
    "endpoint": "http://192.168.1.100:11434",
    "model": "qwen3:32b"
  }
}
```

在远程机器上：`OLLAMA_HOST=0.0.0.0 ollama serve`

#### 子智能体学习

每次 OpenCode 进入空闲状态时，插件不仅从 **主** 对话中收获训练对，还从本轮中派生的 **每一个子会话** 中收获 —— Oracle 咨询、Explore/Librarian 搜索、Metis/Momus 评审、以及任何 Sisyphus-Junior 委派。来自子会话的每一个 `(user prompt, assistant reply)` 对都会被写入 `pairs.jsonl`，并带上一条把它标记为子智能体风格响应的指令（"逐步推理，引用证据"）。这样一来，本地 LLM 不仅学到主智能体如何回答你，还学到每个专家角色如何思考。子会话的发现通过 `SELECT id FROM session WHERE parent_id = ?` 递归完成（只读），并为安全起见在每次空闲事件中上限设为 50 个子会话。

#### 重放历史会话

如果你已经有几百个过去的 OpenCode 会话，并且想现在就从中挖掘训练数据（而不是等未来的对话去积累），可运行重放编排器：

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

该脚本有 **两种安全模式**，二者都保证对你的本地文件系统零修改：

**模式 1 —— Shortcircuit（默认，最高推理保真度）：**

- 使用位于 `~/.local/bin/opencode-fork` 的一个 opencode 分叉二进制，来自 [jackieju/opencode 分支 replay-shortcircuit](https://github.com/jackieju/opencode/tree/replay-shortcircuit)，它给 `tool.execute.before` 插件钩子添加了一个可选的 `shortcircuit` 字段。当插件设置它时，opencode 会跳过真正的工具执行，并把那个值作为 tool_result 返回。
- 运行 **完整的 Sisyphus 智能体** —— 相同的系统提示词、相同的许可工具、相同的子智能体分派（Oracle、Explore、Librarian、Metis、Momus、Sisyphus-Junior）。每一步推理都与原始对话完全相同。
- 插件的 `tool.execute.before` 钩子由环境变量 `NEURAL_REPLAY_ORIG_SESSION_ID` 激活，它在原始会话的 `opencode.db` 中查询一个匹配当前工具名 + 参数的已完成工具调用，并通过 shortcircuit 返回那条历史结果。每一次 Read、Grep、Edit、Write、Bash、WebFetch 等都从历史中供给 —— **真正的工具从不被执行。**
- 一个把该钩子变更上游合入 opencode 的 PR：[anomalyco/opencode#35613](https://github.com/anomalyco/opencode/pull/35613)。在它合入之前，请使用分叉版。

**模式 2 —— 只读智能体（后备方案，如果缺少分叉版）：**

- 使用原版 opencode 加 `--agent oracle`（或另一个 opencode 定义的只读智能体：`plan`、`explore`、`librarian`、`metis`、`momus`、`multimodal-looker`）。
- opencode 的运行时会强制执行该智能体的工具白名单 —— Edit / Write / Bash 写入会被硬拒绝，因此没有任何东西被修改。
- 推理保真度较低，因为该智能体的人设和可用工具与原始的 Sisyphus 运行不同。

当分叉二进制存在时，编排器会自动选择模式 1；当你传入 `--agent` 时回退到模式 2；否则拒绝运行。

**构建分叉版：**

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

构建耗时约 2 分钟；末尾的冒烟测试会打印 `Smoke test passed: 0.0.0-replay-shortcircuit-<timestamp>`。

**重放如何工作（两种模式都一样）：**

1. 从你本地的 `opencode.db` 读出用户消息序列（只读，WAL 安全）。
2. 对每一个历史会话，在 `/tmp/replay-<sessionId>/` 下的一个临时目录里派生一个全新的无头 opencode 对话。
3. 通过 `opencode run --print` 一次一条地喂入用户消息（第一条用全新会话，后续用 `--continue`）。
4. 在模式 1 中，每一次工具调用都通过 shortcircuit 从历史供给；在模式 2 中，写工具被智能体的白名单硬拒绝。
5. 每一条被重放的助手回复 + 每一次子智能体调用都经过插件的 `session.idle` 收集器，于是最终落入 `pairs.jsonl`（主 + 子智能体风格）。
6. 当积累了足够的对之后，LoRA 自动训练会自行触发。

**成本警告：** 重放会像一次实时对话一样消耗真实的 LLM API token。先用 `--limit 5` 来评估成本，再运行完整历史。如果你用的是 Anthropic Pro/Max 订阅，这实际上是免费的（只受速率限制）。

**重放是一次性的：它从历史中产出一次性的训练数据回填。从那以后，`session.idle` 的子智能体收获会让训练集持续增量增长。**

**已知限制：** `opencode run --print` 是一次性的无头调用，它可能不总是触发我们的收集器所依赖的 `session.idle` 事件。重放期间端到端的训练对收获正在积极集成中 —— 安全机制（不做本地修改）已被验证，但无头重放期间 pairs.jsonl 的增长在我们接入一个替代触发器之前可能会滞后。实时交互式会话仍照常收集训练对。

#### 进阶路径

```
1. Start with observer mode (accumulate 100+ training pairs)
2. Run LoRA fine-tuning on accumulated data
3. Switch to student mode (local LLM with safety net)
4. As local model improves, reduce escalation frequency
5. Switch to primary mode (fully autonomous local agent)
```

---

## OpenClaw 插件

### 安装

#### 方案 A：从源码安装（开发时推荐）

```bash
git clone https://github.com/jackieju/AIAgentLocalMemory.git
cd AIAgentLocalMemory
bun install
rm -rf packages/adapter-openclaw/node_modules
bun build packages/adapter-openclaw/src/index.ts --outdir packages/adapter-openclaw/dist --target node --external "openclaw" --external "bun:sqlite" --external "node:sqlite"
openclaw plugins install --force packages/adapter-openclaw
openclaw gateway restart
```

代码变更后更新：
```bash
bun build packages/adapter-openclaw/src/index.ts --outdir packages/adapter-openclaw/dist --target node --external "openclaw" --external "bun:sqlite" --external "node:sqlite"
cp packages/adapter-openclaw/dist/index.js ~/.openclaw/extensions/neural-context/dist/index.js
openclaw gateway restart
```

#### 方案 B：npm（发布后）

```bash
openclaw plugins install @ai-agent-local-memory/adapter-openclaw
openclaw gateway restart
```

### OpenClaw 配置

添加到 `~/.openclaw/openclaw.json`：

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

| 选项 | 默认值 | 描述 |
|---|---|---|
| `storageDir` | `~/.local/share/ai-agent-local-memory-openclaw` | 自定义存储目录 |
| `autoRecall` | `true` | 在每次 AI 作答前通过扩散激活注入相关记忆 |
| `autoCapture` | `true` | 每一轮之后存储对话并构建联想边 |
| `maxRecallResults` | `10` | 每轮注入上下文的最大记忆数 |
| `debug` | `false` | 启用详细调试日志 |

### OpenClaw 上下文引擎（Context Engine）

本插件注册为一个完整的 **ContextEngine**（`ownsCompaction: true`），提供：

- **assemble()** —— 在 token 预算内做基于激活的保真度渲染（f0-f4）
- **compact()** —— 委托给 OpenClaw 内置的压缩作为后备
- **ingest() / afterTurn()** —— 把消息作为 episode 节点存储，并自动创建边
- **bootstrap()** —— 在会话开始时初始化存储

这意味着对话历史被智能地管理 —— 旧消息基于相关性（而非仅按年龄）被压缩，并在其话题再次相关时重新激活到完整保真度。

### OpenClaw 工具

| 工具 | 描述 |
|---|---|
| `neural_recall` | 通过图遍历 + 扩散激活按 **联想** 查找记忆 |
| `neural_remember` | 存储信息并自动建立联想连接 |
| `neural_forget` | 按 ID 删除一个记忆节点 |
| `neural_note` | 保存跨会话持久保留的持久事实/笔记 |
| `neural_status` | 查看引擎统计与工作记忆 |

---

## 存储

### 默认路径

| 适配器 | 默认存储路径 |
|---|---|
| OpenCode | `~/.local/share/ai-agent-local-memory/` |
| OpenClaw | `~/.local/share/ai-agent-local-memory-openclaw/` |

存储内容：
```
├── graph.db          ← all nodes, edges, FTS index (single SQLite file)
├── graph.db-wal      ← WAL journal (may not exist when idle)
├── graph.db-shm      ← shared memory (may not exist when idle)
├── episodes/         ← raw session JSON files (original conversation text)
├── transcripts/      ← auto-synced chat transcripts (one file per session)
└── backups/          ← created by neural_backup tool
```

### 自定义存储路径

**OpenCode** —— `neural-context.json` 或环境变量：
```json
{ "storageDir": "/path/to/custom/storage" }
```
```bash
export AI_AGENT_LOCAL_MEMORY_DIR=/path/to/custom/storage
```

**OpenClaw** —— `~/.openclaw/openclaw.json` 中的插件配置：
```json
{ "plugins": { "entries": { "neural-context": { "config": { "storageDir": "/path/to/custom/storage" } } } } }
```

### 在多个宿主之间共享记忆

把两个适配器都指向同一目录，以共享单一的一张记忆图：

```json
// OpenCode neural-context.json
{ "storageDir": "~/.local/share/ai-agent-shared-memory" }

// OpenClaw plugin config
{ "storageDir": "~/.local/share/ai-agent-shared-memory" }
```

SQLite WAL 模式安全地处理并发读。并发写很罕见，并通过 busy timeout 重试。

## 分布式同步（多机器）

使用 Git 在多台机器间同步记忆。采用仅追加的操作日志 —— 不可能产生冲突。

### 工作原理

```
Machine A writes → appends to operations.jsonl → git push
Machine B: git pull → replay new operations → local graph updated
```

每台机器追加自己的操作。Git 合并总是干净的（仅追加，无重叠行）。UUID 节点 ID 防止跨机器碰撞。

### 设置

**机器 1（首次）：**
```
neural_sync(action="init", repoUrl="git@github.com:yourname/memory-sync.git")
```

**机器 2（加入现有）：**
```
neural_sync(action="init", repoUrl="git@github.com:yourname/memory-sync.git")
neural_sync(action="pull")
```

### 日常使用

```
neural_sync(action="push")     → commit + push local operations
neural_sync(action="pull")     → pull + replay remote operations
neural_sync(action="status")   → check sync state
```

### 同步过程中的写入

如果在同步期间创建了新记忆，它们会被安全地追加到操作日志，并纳入下一次 push。不可能发生数据丢失。

### 架构

```
graph.db (local runtime database — fast reads/writes)
    ↑ replay
operations.jsonl (append-only log — synced via Git)
```

操作日志是同步的唯一真相来源。`graph.db` 是一个物化视图，随时可从日志重建。

## 备份

### 会话抄本（Session Transcripts）

每次 OpenCode 完成响应（会话进入空闲状态）时，完整的聊天历史会被自动写入：

```
~/.local/share/ai-agent-local-memory/transcripts/<sessionId>.md
```

该文件与会话保持同步 —— 每个空闲事件都会检查是否有新内容并更新文件。格式：

```markdown
[user] How do I fix the auth bug?

---

[assistant] Looking at the auth module...

---

[tool] { result of tool call }

---
```

这给了你每一段对话的持久、可读副本，即使会话从 OpenCode 中被删除也能留存。

### 跨设备会话同步

换到一台新机器，继续同一个 OpenCode 会话 —— 包括完整的消息历史、工具调用和推理过程 —— 就像你从未离开过。

**工作原理（设计）：**

- **仅追加导出**：在每个 `session.idle` 事件上，插件读取 OpenCode 本地的 `opencode.db`（SQLite，WAL 模式，**只读句柄**，不与 OpenCode 自身的写入产生写竞争），并把任何新消息/部分追加到 `~/.local/share/ai-agent-local-memory/sync/opencode-sessions/<sessionId>.jsonl`。
- **逐会话游标**：`.exporter-state.json` 记住每个会话最后导出的 `message_id`，因此后续导出是增量的 —— 一次空闲事件只写入增量。
- **首次上限**：本机上一个全新会话每次空闲事件最多导出 500 条消息，以避免一次大的阻塞写入；其余的在之后的空闲事件中补上。
- **Git 支撑的同步**：`opencode-sessions/` 目录位于同一个 [分布式同步](#distributed-sync-multi-machine) 仓库（`syncRepo`）内。已有的后台同步定时器会把它们连同神经图一起提交并推送 —— 没有额外的网络往返。
- **结构化重放**：每一行 JSONL 是 `{"msg": <message row>, "parts": [<part row>, ...]}` —— 是 OpenCode schema 的无损快照，而非文本抄本。重放会重建 OpenCode 会渲染的完全相同的对话。
- **会话元数据**：一次性的 `<sessionId>.session.json` 捕获标题、目录、模型和 token 统计，以便导入的会话正确出现在 OpenCode 的会话列表里。

**设计上非阻塞：**

- **从不阻塞事件循环**：只有异步 I/O，从不 `execSync`。
- **从不阻塞 `messages.transform`**：导出在 `session.idle` 事件上运行，此时助手早已回复完毕。
- **从不写入 `opencode.db`**：只读句柄，因此与 OpenCode 的 SQLite 锁竞争不可能发生。
- **搭上同步定时器的便车**：没有单独的 git 进程，没有额外的网络噪声。

**使用 —— 导出（自动，无需操作）：**

每当 OpenCode 进入空闲，活动会话的新消息会被追加到 JSONL，并在下一个同步节拍推送到同步仓库。

**使用 —— 在新机器上导入：**

1. 在新机器上配置 `syncRepo`，使其神经记忆从同一个 git 仓库拉取（见 [设置](#setup)）。
2. 等待同步定时器拉取（或运行 `neural_sync` action=`pull`）—— 这会把 `opencode-sessions/` 目录带到新机器上。
3. 在 OpenCode 内部运行该工具：

   ```
   neural_session_import(sessionId="ses_...")
   ```

   可选：`overwrite=true` 以重新插入消息，即使某些在本地已存在（默认是安全的幂等重放 —— 重复项通过 `INSERT OR IGNORE` 被跳过）。
4. **重启 OpenCode** 让它重新读取 `opencode.db` —— 导入的会话现在出现在会话列表里，并可用 `opencode --session <sessionId>` 重新打开。

**同步仓库中的存储布局：**

```
<syncRepo>/opencode-sessions/
├── ses_abc123.jsonl           append-only messages + parts
├── ses_abc123.session.json    one-time session metadata
├── ses_xyz789.jsonl
├── ses_xyz789.session.json
└── .exporter-state.json       per-session cursor (last exported message_id)
```

**功能描述：**

你保留了 OpenCode 原生的单机会话体验。在幕后，每一个空闲时刻都把增量差异写入一份 git 同步的 JSONL，因此任何拉取同一仓库的第二台机器（macOS / Linux / Windows）都能调用一个工具，从你上次停下的地方精确接续 —— 相同的消息、相同的工具历史、相同的推理轨迹。

### 通过工具（在 OpenCode 中）

```
neural_backup()                           → ~/.local/share/ai-agent-local-memory/backups/<timestamp>/
neural_backup(destination="/path/to/dir") → custom path
```

### 手动

```bash
cp -r ~/.local/share/ai-agent-local-memory/ ~/backup/ai-agent-local-memory-$(date +%Y%m%d)/
```

## 开发

```bash
bun install
bun build packages/adapter-opencode/src/index.ts --outdir packages/adapter-opencode/dist --target bun --external @opencode-ai/plugin
bun build packages/adapter-openclaw/src/index.ts --outdir packages/adapter-openclaw/dist --target node --external "openclaw" --external "bun:sqlite" --external "node:sqlite"
```

### 跨运行时兼容性

存储层使用一个 sqlite-shim，它会自动选择：
- 在 Bun 下运行时（OpenCode）用 `bun:sqlite`
- 在 Node.js 下运行时（OpenClaw）用 `node:sqlite`（DatabaseSync）

在任一运行时上都无需外部原生依赖。

## 开发会话

原始设计会话（OpenCode）：
```bash
opencode --session ses_166d0e7b9ffeBpCjAtqVkPPkP4
```

## 文档

进一步阅读见 [`docs/`](./docs)：

- [配置参考](./docs/CONFIGURATION-REFERENCE_CN.md) ([English](./docs/CONFIGURATION-REFERENCE.md)) — 每一个可配置选项，含默认值与完整示例。
- [Context 压缩流程](./docs/CONTEXT-COMPRESSION-PIPELINE_CN.md) ([English](./docs/CONTEXT-COMPRESSION-PIPELINE.md)) — 从用户按键到组装 LLM payload 的完整流程。
- [Commonsense Foundation Spec](./docs/COMMONSENSE%E2%80%91FOUNDATION%E2%80%91SPEC.md) — 智能体如何将常识与伦理培育成它的安全层。
- [Architecture & Safety Whitepaper](./docs/ARCHITECTURE%E2%80%91SAFETY%E2%80%91WHITEPAPER.md) — 系统架构与安全模型。
- [Working with a Local LLM](./docs/case-of-working-with-local-llm.md) — 对观察者 / 学生 / 主力这三种本地 LLM 模式的逐步讲解。

## 许可证

Copyright (C) 2026 Jackie Ju

本程序是自由软件：你可以在自由软件基金会发布的 GNU Affero 通用公共许可证（GNU Affero General Public License）条款下重新分发它和/或修改它，采用该许可证的第 3 版，或（由你选择）任何更新的版本。

本程序的分发是希望它有用，但不附带任何担保；甚至不含对适销性或特定用途适用性的默示担保。详见 GNU Affero 通用公共许可证。

你应当已随本程序收到一份 GNU Affero 通用公共许可证的副本。如果没有，请见 <https://www.gnu.org/licenses/>。

> 说明：以上许可证内容为中文译文，仅供参考；具有法律效力的权威许可证文本以英文原文（GNU Affero General Public License v3）为准。
