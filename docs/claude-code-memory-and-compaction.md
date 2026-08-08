# Claude Code 记忆架构 + Context 管理：研究与借鉴改动

本文档记录：基于 **Claude Code 2.1.88 泄露源码**（`~/Downloads/claude-code-main.zip`，`restored/src/`，2026-03-31 泄露、后被 unpublish）的研究结论，以及从中提炼、落地到本插件 `ai-agent-local-memory` 的实际改动。

---

## 0. 可信度分级（先声明）

研究素材有两类，可信度不同：

- ✅ **真实源码核实**：`memdir/memdir.ts`(507行)、`findRelevantMemories.ts`、常量
  `MAX_ENTRYPOINT_LINES=200` / `MAX_ENTRYPOINT_BYTES=25000`、`SessionMemory runForkedAgent`、
  `services/compact/` 五级压缩 —— 路径与常量在泄露源码中全部命中。
- ⚠️ **谨慎对待（二手解读）**：GitHub 上 `Henry1027666` 的 "七层记忆架构" 分析文档含脑补路径/常量，
  只作设计思路参考，不可当源码事实引用。

---

## 1. 「grep 替代 RAG」——机制在 OpenCode 核心，不在插件

Claude Code 故意**不使用 RAG / embedding / 向量库**，改用 grep。这套机制在 OpenCode 里
**架构上和插件无关**——OpenCode 二进制自己就实现了：

| Claude Code | OpenCode 对应物 | 位置 |
|---|---|---|
| Grep(ripgrep) | `grep` 工具 | 核心 `tool/grep.ts` |
| Glob | `glob` 工具 | 核心 `tool/glob.ts` |
| Read | `read` 工具 | 核心 `tool/read.ts` |
| Explore 子 agent | `task` 工具 | 核心 `tool/task.ts` |
| RAG/embedding/向量 | **不存在**（全仓 0 处） | — |

### 三段式分工（最关键的启示）

```
代码检索      → grep（精确, 无索引）           ← OpenCode 核心已做
对话记忆检索  → LLM 语义挑选（不是 embedding） ← Claude Code 用 Sonnet 挑 ≤5 条
上下文压缩    → 子 agent 后台提取              ← 插件在做
```

---

## 2. Claude Code 三层记忆（Self-healing memory）

- **第一层 `MEMORY.md`**：目录/指针，≤200 行 / 25KB，每行 ≤150 字符；只存指针不存内容。
  超限用双保险截断（行数 + 字节，切在换行处），并追加 Warning 告知索引未加载完整。
- **第二层 话题文件**：编码偏好、项目约定、踩过的坑。新对话用 Sonnet 小模型挑 ≤5 个相关文件加载。
  **Punchline**：正在使用的工具**不加载其使用文档**（都在用了说明会用），但**一定加载它的已知坑点**。
- **第三层 历史对话**：存成特定格式的文件，需要时用 grep 搜关键词。

**铁律：记忆不记代码。** 代码会变、记忆不会自动更新（"函数 X 在第 30 行"重构后即成误导）。
只记人的偏好/判断；代码事实实时 grep。→ 从根源消灭"缓存与数据库不一致"。

---

## 3. Claude Code 五级上下文压缩管线（漏斗式）

1. **剪裁**：旧 tool 调用结果只保留结构、不保留内容。
2. **微压缩 (microCompact)**：把体积大的 tool 结果**卸载到缓存**（不是直接丢弃）。
3. **上下文折叠**：对中间对话折叠摘要，只保留关键信息。
4. **自动压缩 (autoCompact)**：上下文占用超阈值时触发全量摘要压缩。
5. **应急压缩**：API 返回 `413 (prompt too long)` 时触发。
   **断路器**：连续失败 3 次自动停（源码中有会话连续失败 3000+ 次仍重试的极端案例）。

---

## 4. 落地到本插件的改动（9 项任务，纯插件实现，无 fork 依赖）

源码：`packages/adapter-opencode/src/index.ts`。已 commit `3f3dcc6` 推送到
`jackieju/AIAgentLocalMemory` main。build #247/#248 修复了随后的崩溃。

### 记忆安全 & 召回

- **Task 1 — `safePutNode` 中央白名单**：3 条 ingestion 路径全部经它，`tool_output` 永远进不了图。
  对齐 Claude Code「不记可推导内容」铁律。
- **Task 2 — `recallStrategy` 配置 (`plugin` | `llm`)**：`llm` 模式照抄 Claude Code——
  FTS 建编号候选清单 → `historianLlm` 挑 ≤5 个相关 ID → 失败回退 top FTS。`neural_recall` 按此分支。
  （运行时默认 `recallStrategy ?? "plugin"`。）

### 压缩层（对应五级压缩）

- **L1 microCompact**：大 tool 输出（`MICROCOMPACT_TRIGGER_CHARS = 50000` 触发 → 2KB stub），
  覆盖 positional truncation 跳过的保护区，保留最近 3 个原文。
- **L2 `systemToolsReservePct`（默认 `0.18`）**：从 tail 预算里预留 system + tool schema 空间
  （按 1.51x / 1.57x 计费校准），直接根治长期的 "Input too long mid-turn"。
- **L4 断路器**：`breakerFactor = Math.max(0.25, Math.pow(0.5, historianFailureCount))`，
  失败时收缩 tail 预算，成功后重置。

### 已存在、无需新增（验证确认）

- **Task 4a** 分级触发阶梯：defer@63 / execute@65 / force@80 / abort@95。
- **Task 4c** 摘要复用：historian 从 `lastEndOrd+1` 开始，不重复摘要已覆盖消息。

### 修复的崩溃

- **Task 4d**：把 L1 microCompact 移到 L2 预算扫描**之前**（否则 200KB 大输出按 50K token 计费
  导致误驱逐本可放下的消息）。
- **build #248**：`originalMessagesSnapshot` / `RENDERED_SENTINEL` 声明在 `try` 块内、
  `catch` 后引用越界导致 `ReferenceError`，hoist 到 `try` 之前修复。

---

## 5. 尚未做 / 有架构约束

- **L2 精确版 + L4 精确版（需看到真实 413）** 需要 fork opencode 加 `chat.request.transform` hook，
  因为 `messages.transform` 跑在请求组装**之前**，看不到 system prompt / tools / 413 错误。
- fork PR **#35613**（`jackieju/opencode`，branch `replay-shortcircuit`）被 bot 自动关闭未合并，
  所以当前插件里是**纯插件近似版**（预留 headroom + 失败计数水位线），fork 精确版留作可选增强。

---

## 6. 部署验证（截至本文档写入时）

在部署 bundle（npm `ai-agent-local-memory@0.3.0`，
`~/.cache/opencode/packages/ai-agent-local-memory/node_modules/ai-agent-local-memory/index.js`）中
逐项 grep 确认 9 项特性均为真实代码（非注释）：

| 特性 | 校验符号 | 命中 |
|---|---|---|
| Task 1 | `safePutNode` | ✅ 4 |
| Task 2 | `recallStrategy` / `llmRecall` | ✅ 3 / 2 |
| L1 | `MICROCOMPACT_TRIGGER_CHARS = 50000` | ✅ 4 |
| L2 | `systemToolsReservePct ?? 0.18` | ✅ 3 |
| L4 | `breakerFactor = Math.max(0.25, Math.pow(0.5, …))` | ✅ 2 |
| L4 | `historianFailureCount` | ✅ 7 |
| 崩溃修复 | `originalMessagesSnapshot` / `RENDERED_SENTINEL` | ✅ 2 / 3 |

部署 bundle 报告 `SERVER_BUILD = "250"`（对应 commit `ed9ea5e` 及之后的本地重建）。
