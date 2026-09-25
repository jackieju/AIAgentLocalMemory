# 配置参考（Configuration Reference）

> `ai-agent-local-memory` 插件的**所有可配置选项**。
>
> 配置文件：`neural-context.json`
> 查找顺序（第一个存在的生效）：
> 1. `<项目目录>/.opencode/neural-context.json`
> 2. `<项目目录>/neural-context.json`
> 3. `~/.config/opencode/neural-context.json`（全局，最常用）
>
> 所有字段都是**可选**的。不写配置文件也能跑（走下面列出的默认值）。
>
> 🌐 English: [CONFIGURATION-REFERENCE.md](./CONFIGURATION-REFERENCE.md)

---

## 目录

- [1. 基础与上下文预算](#1-基础与上下文预算)
- [2. 记忆检索策略](#2-记忆检索策略)
- [3. LLM / Embedding（记忆抽取与摘要）](#3-llm--embedding)
- [4. 本地 LLM 三模式（成长型 agent）](#4-本地-llm-三模式observer--student--primary)
- [5. LoRA 训练（可选）](#5-lora-训练可选)
- [6. Dreamer（每日记忆巩固）](#6-dreamer每日记忆巩固)
- [7. 主动求书（idle reading）](#7-主动求书idle-reading)
- [8. 多机同步](#8-多机同步)
- [9. 与其他 Context 管理器共存](#9-与其他-context-管理器共存)
- [完整配置示例](#完整配置示例)

---

## 1. 基础与上下文预算

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `injectSystemPrompt` | `boolean` | `true` | 是否注入插件的 system prompt 使用指南（工具用法、记忆检索提示） |
| `contextWindowTokens` | `number` | 按模型自动解析 | **强制指定**上下文窗口 token 数。不填则按最后使用的模型自动判断（Opus/Sonnet=200K，GPT-5.x/6=400K，Kimi=256K，DeepSeek=128K，兜底 128K） |
| `budgetRatio` | `number` | （保留字段） | 历史保留字段，当前压缩预算由内部常量 `TARGET_USAGE_PCT=0.55` 控制 |
| `protectedTags` | `number` | `20` | 保护标签数量：最近 N 条消息豁免 caveman 压缩与工具输出截断 |
| `systemToolsReservePct` | `number` | `0.18` | 给 system prompt + 工具定义预留的窗口比例。防止对话吃满预算后 system+tools 溢出 |

> **压缩相关的其余阈值**（EXECUTE_THRESHOLD=65%、EMERGENCY_DROP_PCT=85%、
> HISTORIAN_CHUNK_PCT=25% 等）是内部调优常量，不通过配置暴露。
> 完整清单见 [`CONTEXT-COMPRESSION-PIPELINE_CN.md`](./CONTEXT-COMPRESSION-PIPELINE_CN.md) 附录。

---

## 2. 记忆检索策略

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `recallStrategy` | `"plugin"` \| `"llm"` | `"plugin"` | 跨 session 记忆检索用哪种方式 |

- **`"plugin"`**（默认）：插件自研引擎检索 —— FTS5 全文搜索 + embedding 语义搜索 + 扩散激活（spreading activation）联想召回。**不额外花大模型 token**。
- **`"llm"`**（Claude Code 风格）：FTS 先取候选清单 → 交给 LLM 从清单里挑出最相关的 ≤5 条。检索质量更贴近人类判断，但每次 recall 要消耗一次 LLM 调用。

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `readExtractBackend` | `"server"` \| `"local"` | `"server"` | `neural_read`（读书/策展）抽取用哪个后端。`server`＝主大模型（可打断子 session）；`local`＝本地 LLM（`localLlm` 配置的 ollama 等） |

---

## 3. LLM / Embedding

用于**记忆抽取、historian 摘要、embedding 建语义边**。这里的 `llm` 是插件内部用的轻量模型（区别于 OpenCode 主对话模型）。

### `llm`（记忆抽取 / historian 摘要）

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `llm.provider` | `"openai"` \| `"ollama"` \| `"custom"` | — | 提供商类型 |
| `llm.baseUrl` | `string` | `http://localhost:6655/openai/v1` | API 端点 |
| `llm.apiKey` | `string` | `$OPENAI_API_KEY` | 密钥 |
| `llm.model` | `string` | — | 模型名 |

### `embedding`（语义向量，用于 embedding 联想边 + 语义检索）

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `embedding.provider` | `"openai"` \| `"ollama"` \| `"custom"` | — | 提供商类型 |
| `embedding.baseUrl` | `string` | 回退到 `llm.baseUrl` 或 `http://localhost:6655/openai/v1` | API 端点 |
| `embedding.apiKey` | `string` | 回退到 `llm.apiKey` 或 `$OPENAI_API_KEY` | 密钥 |
| `embedding.model` | `string` | — | 如 `text-embedding-3-small` |

> 不配 embedding 也能跑，只是跨 session 检索退化为纯 FTS（词汇不重叠时可能召回不到）。

---

## 4. 本地 LLM 三模式（Observer / Student / Primary）

这是「成长型 agent」的核心开关：让本地小模型（如 ollama 的 Qwen3）以不同角色参与，逐步学习主模型的能力。

**`localLlm` 整块不配 → 完全关闭本地 LLM，插件按普通记忆/压缩工具运行。**

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `localLlm.provider` | `"ollama"` \| `"openai"` \| `"custom"` | — | 本地 LLM 提供商 |
| `localLlm.endpoint` | `string` | — | 端点，如 `http://localhost:11434` |
| `localLlm.model` | `string` | — | 如 `qwen3:14b` |
| `localLlm.apiKey` | `string` | — | 密钥（ollama 通常不需要） |
| `localLlm.mode` | `"observer"` \| `"student"` \| `"primary"` | **必填**（配了 localLlm 就得有） | 本地模型的角色 |

### 三种 mode 的区别

| mode | 本地模型做什么 | 训练数据 |
|---|---|---|
| **`observer`**（观察者） | 只旁观：主模型（或 `neural_ask_server`）回答时，本地模型也生成一份答案，两份对比算 divergence，存为训练对。**不影响主对话**。 | 大量积累（默认 triggerCount=100） |
| **`student`**（学生） | 在 system prompt 注入指令：本地模型置信度低于阈值 / 被用户纠正多次时，主动调 `neural_ask_server` 向主模型求助并学习。 | 中量（默认 triggerCount=50） |
| **`primary`**（主力） | 本地模型当主力，仅在用户明确说「问大模型」时才 escalate 到主模型。 | 中量 |

### `localLlm.confidence`（置信度控制）

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `confidence.userThreshold` | `number` | `0.5` | 置信度低于此值时（student 模式）主动 escalate |
| `confidence.autoEscalateAfter` | `number` | `3` | 被用户纠正 N 次后自动降低置信度、倾向求助 |

### `localLlm.training`（训练数据采集）

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `training.triggerCount` | `number` | observer=`100`，其他=`50` | 积累多少训练对后触发一次 LoRA 训练 |
| `training.cotStrategy` | `"thinking-tag"` \| `"post-rewrite"` \| `"none"` | **`"none"`** | 是否为训练数据采集思维链（CoT） |

**`cotStrategy` 详解**（默认 `none`＝关闭，想开才开）：
- **`none`**（默认）：不采集 CoT，只存问答对。**推理训练是可选的，默认不做。**
- **`thinking-tag`**：强制模型用 `<thinking>` 标签输出推理，采集其中的 CoT。
- **`post-rewrite`**：回答后再让模型补写一段推理过程。

---

## 5. LoRA 训练（可选）

LoRA 训练**不是配置字段**，而是由 `localLlm.training.triggerCount` 触发的独立流程：

- 训练数据积累到 `triggerCount` 条后，插件调用 `packages/lora-pipeline/auto-train.sh` 自动训练。
- 手动导出训练数据：调用 `neural_export_training` 工具（输出 MLX LoRA JSONL 格式到 `~/.local/share/ai-agent-local-memory/lora-training/`）。
- 手动训练：`cd packages/lora-pipeline && ./train.sh`。
- **要不要做推理训练**：由 `cotStrategy` 控制（默认 `none`＝不做）。
- **多久做一次**：由 `triggerCount` 控制（每积累 N 条训练对做一次）。

> LoRA 训练全程在本地（MLX），不上传数据。训练素材来自 `experience` 节点 + `pairs.jsonl`。

---

## 6. Dreamer（每日记忆巩固）

Dreamer **无配置字段**，行为固定：

- **触发**：每次 `messages.transform` 结束后 fire-and-forget 检查一次（对齐 Claude Code 的 stopHooks 思路），不是定时器。
- **冷却**：cooldown-lock 机制，**每天最多跑一次**（24h 冷却，锁文件 `.dream-lock`）。
- **做什么**：从 `episodes/*.json` 抽取长期 `fact` / `value`（价值观）/ `culture`（文化模式）节点；剪枝过期记忆；标记已消费的 episode。
- **超时**：单次最长 5 分钟（`DREAM_TIMEOUT_MS`）。

> value / culture 是「成长型 agent」的性格层，会注入到 system prompt 影响 agent 行为。
> 通过 `neural_read` + `neural_adopt` 可主动策展（「家长选书」路径）。

---

## 7. 主动求书（idle reading）

session 空闲时，agent 可能主动开口问用户「想让我读什么书 / 学什么材料」（喂给 `neural_read`）。

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `idleReadingPrompt.enabled` | `boolean` | `true` | 是否开启主动求书。设 `false` 完全关闭 |
| `idleReadingPrompt.minIntervalMs` | `number` | `3600000`（1 小时） | 同一 session 两次求书的最小间隔 |
| `idleReadingPrompt.maxPerDay` | `number` | `3` | 每个 session 每天最多求书次数 |

**运行时关闭**（无需改配置）：
- 回复「今天别再问」→ 静默 24 小时
- 回复「永久关闭读书」→ 彻底关闭

> 若上一本书没读完（`neural_read` 被打断），idle 时会**续读那本书**而不是问新书。

---

## 8. 多机同步

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `syncRepo` | `string` | — | Git 远程仓库 URL。配了则首次启动自动初始化同步 |

同步机制（append-only 操作日志 + Git 合并）：
- 记忆图的写操作追加到 `operations.jsonl`（不含 embedding，避免仓库膨胀）。
- 每小时自动 push（仅当有变化）+ pull + replay。
- 手动：`neural_sync` 工具（`init` / `status` / `push` / `pull` / `export` / `import`）。
- **团队共享**：多人配同一 `syncRepo` → 记忆全部合并共享（含 value/culture）。
- **单向合并**：`neural_sync(action="import", repoUrl=...)` 把别人的记忆库合并进来，不改自己的同步配置。

---

## 9. 与其他 Context 管理器共存

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `coexistWithOtherContextManager` | `boolean` | 自动检测 | 是否与 magic-context 等其他 Context 管理器共存 |

- 不填 → 自动检测项目里是否装了 magic-context。
- 检测到 / 设为 `true` → **共存模式**：插件的 `messages.transform` **禁用**（不接管压缩，避免两套 transform 打架），只保留记忆功能（recall/remember 等）。
- 设为 `false` → 强制接管压缩（即使检测到其他管理器）。

---

## 完整配置示例

```json
{
  "injectSystemPrompt": true,
  "contextWindowTokens": 200000,
  "protectedTags": 20,
  "systemToolsReservePct": 0.18,

  "recallStrategy": "plugin",
  "readExtractBackend": "server",

  "llm": {
    "provider": "openai",
    "baseUrl": "http://localhost:6655/openai/v1",
    "apiKey": "sk-...",
    "model": "gpt-5-mini"
  },
  "embedding": {
    "provider": "openai",
    "baseUrl": "http://localhost:6655/openai/v1",
    "model": "text-embedding-3-small"
  },

  "localLlm": {
    "provider": "ollama",
    "endpoint": "http://localhost:11434",
    "model": "qwen3:14b",
    "mode": "observer",
    "confidence": { "userThreshold": 0.5, "autoEscalateAfter": 3 },
    "training": { "triggerCount": 100, "cotStrategy": "none" }
  },

  "idleReadingPrompt": {
    "enabled": true,
    "minIntervalMs": 3600000,
    "maxPerDay": 3
  },

  "syncRepo": "git@github.com:youruser/your-memory-store.git",
  "coexistWithOtherContextManager": false
}
```

> **最小配置**：什么都不写也能跑。上面示例展示了全部选项，实际按需取用即可。
> 最常见的起步配置只需 `llm` + `embedding` 两块（让记忆抽取和语义检索能工作）。
