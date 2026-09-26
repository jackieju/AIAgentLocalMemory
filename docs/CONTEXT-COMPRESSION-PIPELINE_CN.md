# Context 压缩流程详解（Context Compression Pipeline）

> 本文档描述 `ai-agent-local-memory` 插件在 OpenCode 中管理上下文的**完整流程**：
> 从用户按下回车输入一条消息开始，到最终发给大模型的 payload 被组装出来为止，
> 每一个阶段的动作、触发条件与设计意图。
>
> 核心文件：`packages/adapter-opencode/src/index.ts`
> 关键 hook：`experimental.chat.messages.transform`
>
> 🌐 English: [CONTEXT-COMPRESSION-PIPELINE.md](./CONTEXT-COMPRESSION-PIPELINE.md)

---

## 摘要：摘要机制与历史保留策略是怎么做的

最常被问到的两个问题，先在最前面回答清楚：

### 摘要在哪些地方做？用什么模型？

系统里所有"摘要"任务都用**同一个 LLM**（`historianLlm`）。它实际连的是哪个模型：

1. 若在 `neural-context.json` 里配了 `llm` 字段（例如 `provider: ollama, model: qwen3:14b`）→ **走你的本地模型**（参考配置下是本地 Ollama 的 Qwen3:14B）。
2. 否则回退到 `http://localhost:6655/openai/v1` 的 `claude-sonnet-4-6`，再 fallback 到 `gpt-4.1-mini`、`gpt-5-mini`。

有 4 处调用它：**Historian 压缩**（把一段旧对话 + 工具输出折叠成一个 `<compartment>` 摘要块）、**Dreamer**（每天一次，从对话里抽取事实/价值观/文化特征存进记忆图）、**本地 LLM 判断**（observer/student 模式）、**neural_read**（从 URL/文本抽取 value/culture 候选）。

**关键：Context 压缩的绝大部分工作不用任何模型。** microCompact（截断超大工具输出）、caveman 压缩（去填充词）、tail 预算裁剪、孤儿清除，全是纯字符串/预算计算，**零 LLM**。只有"把整段旧对话折叠成一句摘要"（compartment）这一步才调模型。

### 历史是不是"全塞到放不下为止"？—— 不是。

历史**不是**塞满 100% 直到爆掉，而是**主动压缩 + 预算裁剪**，分三层控制：

1. **compartment 折叠（`tailStart`）**——最后一个 compartment 的 `endMessageId` 之前的历史，*早已被 Historian 摘要成折叠块*，不再逐条塞入，只塞那一句摘要。
2. **tail 预算裁剪**——对 `tailStart` 之后的"尾部原文对话"，设一个 token 预算 `tailBudgetTokens`：基准 = `contextLimit × 0.55`（`TARGET_USAGE_PCT`），减去约 18% 给 system prompt + 工具 schema 预留，再乘熔断因子。循环**从最新消息往回累加，超预算就 break**，丢掉最旧的 tail 消息。
3. **两道硬底**——`HARD_TAIL_CAP = 500` 条上限；**最新一条永远保留**（即便它自己就超预算也 force-include，它内部的超大工具输出改由 microCompact 截断）。

所以准确的说法是：**旧历史摘要成折叠块；尾部只保留最近的、能塞进 55% 窗口预算的原文对话；超出的丢弃；最新一条无论如何保留。** 目标利用率是窗口的 **55%**，不是 100%。

### compartment + tail 超预算时，砍谁 —— compartment 还是 tail？

**砍的是 tail 里最旧的原文，最新的绝不砍。** 但机制要讲精确：

- compartment 和 tail **不抢同一个预算**。`tailBudgetTokens` **只管 tail**（原文对话）。compartment 摘要是在这个预算之外注入的。
- 预算裁剪**只作用在 tail 上**，从**最旧**的 tail 消息开始往后砍（`for i = length-1 → floor`，超预算 break）。最新一条先 force-include 保住。
- compartment 覆盖范围**只增不减**（`tailStart` 是地板）。随对话变长，Historian 不断把新变旧的历史折叠进 compartment，把 `tailStart` 往后推。所以**不存在"砍 compartment"这个动作**——compartment 是已经压缩好的成果，只会累积；真正在超预算时被裁掉的是"还没被折叠的、较旧的 tail 原文"，而它们同时正被 Historian 折叠进 compartment。
- 被丢掉的旧 tail 不是"删了就没了"：它们要么已经、要么很快被折叠进 compartment 摘要，要么进 `<earlier-topics>` 汇总（>20 条被跳过时，每条被跳过的 user 消息取前 80 字塞进一个清单）。

> **已知边界情况**：compartment 摘要目前是无条件全部注入的（不受 `tailBudgetTokens` 限制）。实践中每个都很小（几百 token），几十个也远在限制内。若摘要累积过多，这可能成为压力点——是将来给 compartment 摘要也加预算上限的候选改进。

---

## 0. 总览：两条独立的路径

插件在一次用户交互中，实际上跑两条**互相独立**的路径：

| 路径 | 何时触发 | 做什么 | 是否阻塞回显 |
|---|---|---|---|
| **回显路径**（hot path） | 用户按回车的瞬间 | 落盘保命 + 压缩组装发给 LLM 的 payload | **是**，必须极快 |
| **记忆路径**（idle path） | session 空闲时 | 写记忆图、historian 压缩、linking、dreamer | 否，全异步 |

**红线**：回显路径（`chat.message` + `messages.transform`）绝不做任何耗时 IO（DB 全量扫描、网络请求）。
所有耗时工作都推到 `session.idle` 事件后执行。这是从多次「切到插件后卡死数分钟」事故中定死的铁律。

---

## 1. 用户按回车 → `chat.message` hook（最早触点）

```
用户输入 "hello" + 回车
   │
   ▼
chat.message hook 触发（早于回显、早于 transform）
   │
   ├─ 同步把 user 消息原文追加落盘到 pending-messages/<sid>.log
   │  （保命：万一后续 transform 卡死，消息也不会丢）
   │
   └─ bump globalThis.__neuralMainBusyAt = Date.now()
      （标记「主 session 正忙」，供可打断的后台 neural_read 让出）
```

**为什么先落盘**：早期版本 transform 一卡死，用户刚输入的消息连数据库都没进，永久丢失。
`chat.message` 是 OpenCode 中能最早、且独立于 transform 拿到用户原文的点。

---

## 2. `messages.transform` 入口 → 幂等守卫

```
messages.transform(output)
   │
   ├─ originalMessagesSnapshot = output.messages.slice()   ← 原始快照，出错时回滚
   │
   ├─ 幂等 guard：if (messages[RENDERED_SENTINEL]) return   ← 关键！
   │     OpenCode 每轮会用同一个 messages 数组【调用两次】transform。
   │     第一次已 splice/压缩后打上 RENDERED_SENTINEL 标记；
   │     第二次直接返回，避免对已压缩结果再压一遍（否则会坍缩到只剩 1 条）。
   │
   └─ 若 magic-context 共存 → 直接透传（不接管压缩，避免两套 transform 打架）
```

---

## 3. 定位真实 session + 计算使用率

```
   ├─ 从 output.messages 里提取真实 OpenCode session ID（ses_xxx）
   │     不能用目录 hash —— 那样查 compartments/usage 会串到别的 session。
   │
   ├─ lastModelKey = 最后一条 assistant 消息用的模型
   │     用于按模型解析上下文窗口（Opus=200K, GPT-5.x=400K, Kimi=256K...）
   │
   ├─ contextLimit = pluginConfig.contextWindowTokens ?? resolveContextWindow(lastModelKey)
   │
   └─ realUsage = getContextUsage(openCodeSessionId)
      usagePct = 最近一条已结算 assistant 消息的真实 token 占用百分比
      （查 opencode.db 的 cache.read + cache.write + input + output）
```

---

## 4. Scheduler：三态调度（execute / defer / skip）

决定这一轮**要不要触发 historian 生成新的压缩摘要（compartment）**：

```
   usagePct ≥ EXECUTE_THRESHOLD(65%)  且 非 mid-turn → execute（后台异步压缩）
   usagePct ≥ 63% 或 mid-turn                        → defer （下轮再说）
   否则                                               → skip  （不压缩）
```

- **execute**：后台 IIFE 起 historian 子 session，把最旧的一批消息压成 compartment（见 §12）。**不阻塞** transform 返回。
- historian 一次压缩的量 = `contextLimit × HISTORIAN_CHUNK_PCT(25%)`（对齐 magic-context）。

---

## 5. 读取已有 compartments → 算 tail 边界

```
   compartments = compartmentStore.getForSession(openCodeSessionId)
   │     compartment = 一段已被 historian 压成摘要的旧消息（存 SQLite）
   │
   ├─ tailStart = 最后一个 compartment 的 endMessageId 在数组里的下标 + 1
   │     （tail = 尚未被压缩、需要原样/近似保留的最近消息段）
   │
   └─ maxCompartOrd = 最后一个 compartment 覆盖到的 ordinal
```

**tail = 从 tailStart 到末尾的消息**。压缩的核心就是「compartments（摘要）+ tail（近似原文）」拼起来发给 LLM。

---

## 6. L1 microCompact —— 巨型工具输出截断（在预算扫描之前）

```
   扫描最近 500 条消息：
   for 每条消息的每个 part:
      if part.state.output.length > MICROCOMPACT_TRIGGER_CHARS(50000):
         截断到前 2000 字符 + 可回溯 stub
```

**可回溯 stub 文案**（`buildToolStub`）：
```
…[tool output compacted — kept first 2000 of 87000 chars]
[retrieve verbatim: grep the tool block name="bash" args={"command":"…"} in
 ~/.local/share/ai-agent-local-memory/transcripts/<sid>.md; if absent, re-run bash with the same args]
```

**为什么必须在预算扫描之前**：microCompact 直接改 `messages[]`（对象引用共享），
让后面的 token 预算扫描（§8）测到的是「截断后」的尺寸。
若顺序颠倒，巨型 payload 会以原尺寸顶爆预算 → 「Input too long」。

**注意**：这里**不再豁免最近 N 条**（旧版有 `KEEP_RECENT=3`，已移除）——
所有超过 5 万字符的工具输出一律截断，不管新旧。任务3的「最新一条不删」保的是消息整条不被删空，不是不截断内部的工具 payload。

---

## 7. protectLine —— 保护线（四护栏加固）

保护最近 ~2 个「有意义的用户 turn」不被压缩掉，解决「用户答 C 指向上一轮 A/B/C」的跨轮引用问题。

**四护栏**（源于 build #277 爆炸事故，见 `docs/` 事故记录）：
```
(a) span cap    —— 回看不超过 MAX_PROTECT_SPAN(80) 条消息
(b) floor       —— startIdx 永不低于 floor（HARD_TAIL_CAP=500 兜底）
(c) token ceiling — 保护拉回不能把 tail 撑过 budget × 1.3
(d) pressure gate — 仅当 usagePct < 70% 才启用保护，高压时放弃保护保命
```

护栏 (a)+(b) 折进扫描下界 `protectFloor = max(floor, length - 80)`，
使 protectLine **物理上不可能**落到极小下标（那正是 #277 撑爆预算的根因）。

---

## 8. L2 budget scan —— token 预算扫描（tail 定界）

```
   tailBudgetTokens = max(
       contextLimit × 0.1,                                    ← 硬下限
       (contextLimit × TARGET_USAGE_PCT(0.55) - systemToolsReserve) × breakerFactor
   )

   从末尾往前累加：
   for i = length-1 downto floor:
       tailTokens += msgTokensMemo(messages[i])   ← 用真实 tokenizer 精确计数（记忆化）
       if tailTokens > tailBudgetTokens: break
       startIdx = i
```

- **systemToolsReserve** = `contextLimit × 0.18`：给 system prompt + 工具定义预留，
  否则对话吃满 55% 后，system+tools 一叠加就溢出。
- **breakerFactor**（熔断器）：historian 连续失败时，每次失败把 tail 预算减半（降到 1/4 floor），
  保证即使压缩失败，请求也能降到限额以下，不会反复 413。

**N=1 保证**（任务3）：若最新单条消息已超预算，budget loop 首轮 break 会把 startIdx 停在 `length`，
掉进 slice(-1)。这里强制把最新一条纳入 tail —— 最新消息永不丢。

---

## 9. protect 拉回

```
   if (allowProtect && protectLine < startIdx):
       startIdx = max(protectFloor, protectLine)   ← 把 tail 起点拉到保护线，但受 (b)(c) 双重钳制
```

至此 **tail = messages.slice(startIdx)** 定界完成，后续都在 tail 上做减量，不再改变边界。

---

## 10. tool 指纹去重

```
   给每条 tool 消息算指纹 = toolName + input前300字符
   同指纹出现多次 → 除最后一次外，其余（且落在保护区之外的）标记为 drop
   （渲染时替换成空 —— 重复的工具调用只留最新一次）
```

---

## 11. 结构噪声清理 + caveman 压缩 + tier 截断

按顺序对 tail 做逐级减量：

```
① 结构噪声清理：meta / step-start / step-finish part → 清空
      （豁免最新一条 —— 任务3）

② caveman 文本压缩（仅非保护区，按位置分级）：
      前 20% → ultra（最狠）    20-40% → full    40-60% → lite
      去填充词/冠词、缩写等自然语言压缩

③ tier 截断（工具输出，按工具价值分档）：
      T1 (read/todowrite/task/glob…只读探查) → 截到 4000（留多）
      T2 (edit/write/grep/bash…)            → 截到 2000
      T3 (未知/其他)                         → 截到 800（截最狠）
      每处截断都带可回溯 stub（去 MD grep 工具名+参数）

④ 保护区工具输出截断：> 16000 字符 → 截到 16000 + 可回溯 stub
      （保护区文本原样不动，只截工具输出，防单条巨型工具结果撑爆）
```

---

## 12. Emergency drop —— 应急丢弃（贴 magic-context，仅高压触发）

```
   if usagePct ≥ EMERGENCY_DROP_PCT(85%):
      扫描非保护区的工具输出，按 tier 分组
      每个 tier 保留最近 TIER_RECENCY_RESERVE(20%)（recency reserve）
      其余按 T3 → T2 → T1 顺序【整条 sentinel 替换】（＝丢弃，非截断）
      （同样留可回溯 stub，LLM 想看去 MD 取回）
```

与 §11 的 tier 截断区别：
- **§11 截断**：一直做，把大工具输出砍到几 K，保留头部。
- **§12 丢弃**：只在真高压（≥85%）时做，把整个工具输出换成一句 stub。先丢低价值+旧的。

---

## 13. 渲染循环 → 拼装最终消息数组

```
   for 每条 tail 消息:
      tagCounter++                              ← 给每条打 §N§ 标签
      if 被 drop / 被去重 且未 pin → 渲染成空
      注入时间间隔标记（+5m / +2h / +3d …）
      注入 compartments（在 tail 之前，作为已压缩历史摘要）
      注入 <project-memory> / <facts> / value/culture 性格层
      pin 的消息豁免所有压缩
```

---

## 14. orphan tool_result 清扫 + 写回

```
   ① 收集 tail 里所有存活的 tool_use callID
   ② 删掉配对 tool_use 已被裁掉的孤儿 tool_result（否则 Anthropic 400）
   ③ 规范尾部边界（不能以 assistant 或纯 tool_result 结尾，否则 prefill 报错）
   ④ messages.splice(0, messages.length, ...rendered)   ← 原地替换（proxy 对象要求 splice）
   ⑤ 打上 RENDERED_SENTINEL 幂等标记
```

**至此，发给大模型的 payload 组装完成，transform 返回，回显出现。**

---

## 15. 记忆路径（idle，全异步，不阻塞回显）

session 空闲时消费 pendingIdleWork 队列：

```
session.idle 事件
   │
   ├─ historian 压缩：把最旧一批消息压成 compartment（子 session，用 historian agent）
   │
   ├─ lightweight linking：把 user/assistant 文本存入记忆图 + 建联想边（FTS+Jaccard）
   │
   ├─ transcript 归档：把整个 session 逐字镜像到 transcripts/<sid>.md（含工具输出原文）
   │     ← 这就是 §6/§11/§12 stub 里让 LLM grep 的那个文件
   │
   ├─ Dreamer（每天最多一次，cooldown-lock）：从 episodes 抽取长期 fact / value / culture
   │
   └─ gap backfill：补录 transform 期间可能漏掉的消息到记忆图
```

---

## 附：关键阈值一览（写死常量，非配置项）

| 常量 | 值 | 含义 |
|---|---|---|
| `EXECUTE_THRESHOLD` | 65% | scheduler 触发 historian 压缩的使用率 |
| `TARGET_USAGE_PCT` | 0.55 | tail 目标占上下文窗口比例 |
| `FORCE_COMPARTMENT_PCT` | 80% | 强制压缩阈值 |
| `EMERGENCY_DROP_PCT` | 85% | 应急丢弃工具输出阈值 |
| `ABORT_PCT` | 95% | 放弃阈值 |
| `HISTORIAN_CHUNK_PCT` | 0.25 | historian 一次压缩量占窗口比例 |
| `MICROCOMPACT_TRIGGER_CHARS` | 50000 | 巨型工具输出截断触发字符数 |
| `TIER_RECENCY_RESERVE` | 0.2 | emergency drop 每 tier 保留最近比例 |
| `MAX_PROTECT_SPAN` | 80 | 保护线最大回看消息数 |
| `HARD_TAIL_CAP` | 500 | tail 硬上限（性能兜底） |
| `SYSTEM_TOOLS_RESERVE_PCT` | 0.18 | 给 system+tools 预留比例 |

这些是内部调优常量，不通过配置文件暴露。可配置的选项见 [`CONFIGURATION-REFERENCE_CN.md`](./CONFIGURATION-REFERENCE_CN.md)。
