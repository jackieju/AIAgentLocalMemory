# 压缩策略（A / B / D）

本文档总结可选的上下文压缩策略。一个策略是对**两件事**的顶层选择：(1) 最近消息的
**tail 边界**如何计算；(2) tail 之外的旧消息如何**渲染成 compartment 摘要**。策略选定
*之后*每轮的内部管线机制，见 `CONTEXT-COMPRESSION-PIPELINE_CN.md`。

一共三个真实策略 —— **A、B、D**。（`C` 已被并入 `B`，现在作为向后兼容别名映射到它。）

通过 `neural-context.json` 选择：

```jsonc
{
  "compressionStrategy": "B",   // "A" | "B" | "D"（"C" = B 的别名；默认 "B"）
  "summaries": true,            // 仅 B/D：false → 回退到 80 字符列表
  "halfLifeRank": 5,            // 仅 D：时间衰减半衰期（按 compartment 排名计）
  "semanticWeight": 0.5,        // 仅 D：embedding 与 FTS 的融合权重（设计阶段）
  "ftsRelevanceRanking": false  // 仅 B/D：false（默认）= 纯时序排序（magic-context 风格，
                                // 无时序倒置）。true = 按相关度重排 compartment
                                // （见下方"时序倒置风险"）。
}
```

---

## 一览表

| | Tail 边界 | Compartment 渲染 | 相关度加权? | 时间加权? | 老会话上的行为 |
|---|---|---|---|---|---|
| **A** | recency 窗口：`min(20条, 24h)`，只收窄 | 80 字符 user 标题列表 | 否 | 仅 tail（24h 窗口） | 与新会话相同 |
| **B**（默认） | magic-context 动态 tail（按 token 预算） | 80 字符 user 标题列表 | 否 | 否 | 与新会话相同 |
| **C** | 同 B | 按**语义相关度**挑 p1/p2/p3 档 | 是 | 否 | 仍是 p1/p2/p3 档，但无语义排序* |
| **D** | 同 A（`min(20条, 24h)`） | 按**相关度 × 时间衰减**挑 p1/p2/p3 档 | 是 | 是（影响 compartment 打分） | 仍是 p1/p2/p3 档，但无语义排序* |

**排列顺序说明：** 所有策略最终都按**时序**（老→新）输出 compartment。表格里的"时间
加权"*仅*指时间是否影响档位*选择*（D 会降低较老 compartment 的分数，使其更可能掉到
p3 或被丢弃），不指输出顺序。B 在档位选择上没有时间加权；A/D 的"时间"体现为 24h 的
tail 窗口（A）或衰减（D）。

\* 在 ord-stamping 上线之前创建的会话上，B/D 的 compartment 全部得 0 分（没有坐标可
join）。它们**仍渲染为 p1/p2/p3 分档**——只是没有相关度/时间排序：贪心过程只是按时序
把预算填满。所以老会话仍得到 p1/p2/p3 摘要，只是缺了智能挑选。详见下文。

---

## 两个维度

每个策略都是一个 **tail 策略** 与一个 **compartment 渲染器** 的组合。

### 维度 1 — Tail 策略（`resolveTailPolicy`）
- **B 式（B）：** tail 纯粹由 token 预算界定
  （`contextLimit × TARGET_USAGE_PCT`，再经断路器因子和 system/tools 预留调整）。
  在预算内尽量多保留最近消息。这是对齐 magic-context 的行为。
- **A 式（A、D）：** 同样的预算界定，然后**额外**用 recency 窗口收窄 —— 一条消息只有
  在**最近 20 条 且 最近 24 小时**（交集）内才留在 tail。这是*只收窄*：它只能缩小
  tail、绝不会越过预算把 tail 放大。它的存在是为了防止超长会话里 tail 悄悄膨胀。

### 维度 2 — Compartment 渲染器（`renderCompartments*`）
比 tail 更旧的消息会被摘要成 `<earlier-topics>` 消息。
- **80 字符列表（A）：** 取*被跳过的 user 消息*，每条截到 80 字符，拼成一个标题
  列表。渲染时不使用 LLM 摘要。便宜、有损、与话题无关。
- **p1/p2/p3 分档（B、D）：** 使用 historian 存在每个 compartment 上的三档摘要
  （p1 = 一段 ≤150 token，p2 = 一句 ≤25 token，p3 = 标题 ≤8 token），按相关度为每个
  compartment 挑一档。B 按 FTS 关键词相关度排序；D 把 FTS 与 embedding 语义相关度融合
  （见下文）。

> **安全不变量（所有渲染器）：** compartment 输出永远是纯文本 `role=user` 消息，
> **不含 `tool_result`**。若某个 `tool_result` 配对的 `tool_use` 已被丢弃，会触发
> Anthropic pre-stream 400（"消息凭空消失" bug）。下游 orphan-sweep 按 id 配对，不按位置。

---

## B / D：档位选择如何工作

B 和 D 共用一个引擎（`renderCompartmentsCD`）。每轮：

1. **Query** = 最近 1–3 条*有意义*的 user 消息拼接（每条截到 500 字符）。用 1–3 轮
   （而非只用最后一条）能稳定话题信号、减少档位抖动。
2. **一次**有界 FTS 查询：`searchWithScores(query, 50)`。这是热路径上*唯一*的图读取
   —— 没有 `getAllNodes`、不加载全部 embedding（那条路径导致过 build #57 的 OOM，此处禁用）。
3. **按 compartment 聚合**：每个 compartment 的分数 = 命中 episode 中，`ord` 落在
   `[startOrd, endOrd]` 区间内且 session 匹配的那些节点的**最大**分。用 `max`（而非
   `sum`）避免长 compartment 偏置 —— 一个强相关 episode 不应输给一堆弱相关的。
4. **仅 D — 语义融合：** 在 FTS 分数之外，D 还计算 query 与每个 compartment 的缓存
   embedding 之间的余弦相似度，并把两者（加权）融合。这正是让 D 能捞回一个*语义相关*
   但零关键词重叠的话题的原因。B 跳过此步（只用 FTS）。*（设计阶段 —— 接线方案见下文
   "D：语义融合"。）*
5. **仅 D — 时间衰减：** 把（融合后的）分数乘以 `exp(-ln2 × ageRank / halfLifeRank)`，
   其中 `ageRank` 是 compartment 的 recency 排名（0 = 最新），`halfLifeRank` 默认 5。所以
   在相关度相等时，老 5 个排名的 compartment 价值减半 —— 但一个高度相关的老 compartment
   仍能压过一个不相关的新 compartment。
6. **贪心分档**，受 `historyBudgetTokens` 约束
   （`contextLimit × HISTORY_BUDGET_PCT`，默认 0.15）：按分数降序，先给 p1（完整）直到
   预算会溢出，再 p2，再 p3。token 成本用所选档位的**真实** `countClaudeTokens`，不是
   名义上限。保底规则保证分数最高的 `min(3, 总数)` 个 compartment 至少保留 p3；分数最低
   的溢出部分被完全丢弃。

**B = 去掉第 4、5 步的 D。** B 纯按当前 FTS 相关度排序；D 额外加 embedding 语义融合和
recency 偏好。

### `summaries: false`
关闭 B/D 的分档渲染：渲染器回退到 80 字符列表（同 A）。生成**不**受影响 —— p1/p2/p3 是
compartment 的本体，跳过它们的生成会导致无内容可压缩，也会破坏 A。

---

## 为什么 B/D 的相关度排序"只对新会话生效"

B/D 靠一个共享的 **`ord`** 坐标把 episode join 到 compartment（即 compartment 的
`startOrd`/`endOrd` 也在用的那个会话级密集序号）。这个坐标在 episode 节点**创建时**盖上
（`safePutNode` 解析 `messageId → ord`）。

现有图（撰写时约 41,862 个 episode 节点）**没有**这个坐标，且**无法回填**：
- 老节点上的 `messageId`：**0 个** —— 没有东西能解析出 `ord`。
- `turnIndex` 只有约 20.6% 的节点有，且它**非单调**（是批内局部值、不是会话级全局序号
  —— 例如一整个 session 的节点全读作 `1`），因此无法映射到 `ord`。硬猜会盖上**错误**
  坐标，这比没有更糟（不相关的老 compartment 会被抬成 p1）。

因此回填被有意**放弃**。对于 ord-stamping 上线*之前*创建的会话，每个 compartment 都得
0 分 → 打平 → 贪心过程按时序把 token 预算填满。关键是这仍然渲染为 **p1/p2/p3 分档**
（质量高于 A 的 80 字符列表）。丢失的只是*智能挑选*：没有分数，B 无法偏好当前相关的
compartment、D 无法偏好较新的/语义相关的，两者都只是按时序把档位塞满预算。对于*之后*
创建的会话，B/D 完全精确。新会话的占比会随时间增长。

真正回退到 A 的 80 字符列表只发生在两种情况：`summaries: false`，或某个 compartment
根本没有 p1/p2/p3（无内容可渲染）。

---

## 我该用哪个？

- **B（默认）：** p1/p2/p3 分档，按 FTS 关键词相关度排序，tail 对齐 magic-context。最佳
  通用选择 —— 与你当下工作有关键词重叠的旧话题得到完整 p1 摘要；不相关的缩成标题或丢弃。
- **A：** 最便宜。80 字符标题列表 + tail 的硬性 recency 上限。如果超长会话让你的 tail
  膨胀、你想要一个牢固的 recency 上限、又不需要相关度排序，选它。
- **D：** 像 B 但增加 **embedding 语义融合**（捞回*意义*相关而非仅关键词相关的话题）
  外加 recency 偏好。这是唯一让神经/语义层真正影响压缩的策略。适合*新的*长期会话——
  既在意"当下相关什么"又在意"最近发生什么"——且你配置了 embedding provider。

---

## 时序倒置风险（相关度排序）—— 务必阅读

当 B 或 D 按**相关度**排序 compartment（B 用 FTS 关键词，D 用 FTS+embedding）时，如果
一个**较老**的 compartment 分数更高，它可能被排到一个**较新**的 compartment 前面。这
带来一个真实隐患：

> 假设会话早期你得出结论 **"X"**（错的），后来又修正为 **"其实 X 错了，应该是 Y"**。
> 如果这两条都老到被压进了**不同的** compartment，相关度排序可能把较早的（现已错误的）
> "X" compartment 给了更高档位（完整 p1），而后来的修正被压成标题甚至丢弃。大模型于是
> 看到的是详细的错误结论、看不到修正——**它可能把已被推翻的结论当成当前的正确结论。**

这是相关度排序的根本取舍：它优化的是*话题相关度*，可能破坏*因果/时间*顺序。

**本项目如何缓解（三层）：**

1. **`ftsRelevanceRanking: false` 是默认值。** 开箱即用时，B 和 D 都**纯按时序**排列
   compartment（和 magic-context / Claude Code 一样）：最新的 compartment 拿最高档位，
   所以后来的修正**永远不会**把预算输给较早的错误结论。无时序倒置。只有你显式设置
   `ftsRelevanceRanking: true` 才会承担这个风险。
2. **Recency tie-break（同分决胜）。** 即使打开相关度，当两个 compartment 分数相同时，
   **较晚的**赢（`按分数降序、再按 idx 降序`），所以修正不会输给同分的较老陈述。
3. **时序化 historian 摘要。** historian 的 prompt（学 Claude Code）被要求按时间顺序
   分析对话，当后面的消息修正/推翻前面的内容时，以**最新**状态为准并注明早先的已被
   取代。这在**单个 compartment 内部**有效——但注意它对**跨不同 compartment** 的情况
   **无效**（那是第 1 层负责的）。

**结论：**
- 如果"修正场景下的正确性"比"话题召回"更重要，保持 `ftsRelevanceRanking: false`（默认）。
  这是安全选择。
- 只有当你想把相关的老话题顶上来、并接受上述时序倒置风险时，才设 `ftsRelevanceRanking:
  true`。**D 继承同样的风险**（它的 embedding 融合只在相关度排序打开时才运行）。

---

## 验证 B/D

B/D 只在**新**会话、且轮次足够多以生成 compartment 时才产生可见差异：

```jsonc
{ "compressionStrategy": "D", "halfLifeRank": 5 }
```

重启，开一个新 session，跨几个不同话题聊到 compartment 形成，然后回到早先的某个话题 ——
相关的较旧 compartment 应展开（p1），不相关的保持标题（p3）或被丢弃。

---

## 深入：两个摘要引擎（F0–F4 vs P1/P2/P3）

`packages/core` 里有**两个完全不同、各自独立写就**的压缩引擎。这是整个代码库里最容易
被混淆的一点，所以值得说精确。它们**不是**彼此的变体，**也不是** magic-context 的变体。

### 引擎 1 —— F0–F4 精度渲染（`context-renderer.ts`，`ContextRenderer`）

**血统：我们自研。** 建立在我们的神经记忆图谱之上。这是插件**最早**的压缩
（commit `5299079`，P1 阶段）。它跟 magic-context 毫无关系。

**粒度：逐消息。** 每一条消息（episode）独立地被赋予五个精度档位之一并按该档渲染：

| 档位 | 名称 | 大小（相对全文 `s`） | 含义 |
|---|---|---|---|
| **f0** | full | `s` | 逐字，整条消息 |
| **f1** | para | `s / 2` | 一段长度的浓缩 |
| **f2** | gist | `s / 4` | 要点 |
| **f3** | title | `s / 10` | 一行标题 |
| **f4** | omit | `0` | 完全丢弃 |

**一条消息的档位如何决定 —— 靠相关度，不是靠新旧：**
1. `graph.spreadingActivation(seeds, …)` 从当前的 activation seeds（你此刻在聊什么）
   出发，在神经图谱上扩散。每条 episode 得到一个 **activation 分数** —— 它跟当下的
   相关程度。
2. `binarySearchThresholds(...)` 二分搜索一组分数阈值，使所有渲染后消息的*总和*刚好
   塞进 token 预算。高 activation 的消息落在 `full` 阈值以上（f0）；相关度递减的依次
   掉到 f1 → f2 → f3 → f4。
3. `recentFullTextTurns`（3–5，按消息长度动态定）强制最近几轮为 **f0**，不管其
   activation —— 最近的上下文你永远看到逐字原文。
4. `applyHysteresis`（默认 0.2）抑制抖动：一条消息不会在 f1 和 f2 之间来回跳，除非它的
   activation 越过一个死区带。

**关键特性：**
- 渲染时**不调 LLM**。f0–f4 的载荷是预先算好、存在 episode 上的浓缩；渲染只是*挑*一个
   档位。每轮很便宜。
- 细粒度：一条高相关的老消息可以保持 f0，而它同期的邻居掉到 f3 —— 这是 compartment
   做不到的（compartment 把一整块消息一起摘要）。
- 相关度来自图谱 activation，所以需要一个填充良好、连接良好的图谱才能发挥。图谱稀疏时
   activation 信号很弱。

### 引擎 2 —— P1/P2/P3 compartment 摘要（`historian.ts` + `compartments.ts`）

**血统：对齐 magic-context。** 这是 magic-context 风格的做法：一个 LLM "historian" 把
一*块*老消息摘要成三档，存成一个覆盖 ordinal 区间 `[startOrd, endOrd]` 的 "compartment"。

| 档位 | 形态 | 预算 | 内容 |
|---|---|---|---|
| **p1** | 一段 | ≤150 token | 用户目标、已做决策、碰过的文件/符号、遇到的错误、当前状态（过去时） |
| **p2** | 一句 | ≤25 token | 发生的最重要的一件事 |
| **p3** | 一个标题 | ≤8 token | 像 git commit subject |

**工作方式：**
1. 当 tail 之外积累了足够多老消息，historian 拿到这块消息，按 `HISTORIAN_PROMPT` 提示
   吐出**严格 JSON** `{p1,p2,p3}`。
2. 结果作为一个 compartment 持久化，用 `startOrd`/`endOrd` 标记它替换了哪些消息。
3. 渲染时策略为每个 compartment 挑*一*档（A 总是改用 80 字符列表；B/D 按相关度挑
   p1/p2/p3 —— 见前文）。

**关键特性：**
- *生成*时需要调 LLM（在后台子 session 里做，不在热路径上）。一旦生成，渲染就免费。
- 粗粒度：每*块*消息一组摘要，不是每条消息。无法在压缩邻居的同时保留某条消息的原文。
- 独立于神经图谱 —— 即使图谱稀疏/为空也能工作，因为 LLM 直接读原始 transcript 块。

### 并排对比

| | F0–F4（引擎 1） | P1/P2/P3（引擎 2） |
|---|---|---|
| 血统 | 我们的神经图谱设计 | 对齐 magic-context |
| 粒度 | 逐**消息** | 逐**块**（compartment） |
| 相关度信号 | 图谱扩散激活 | 生成时无；B/D 在渲染时加相关度（B：FTS；D：FTS+embedding） |
| 需要 LLM? | 否（载荷预先算好） | 是（historian 生成各档） |
| 需要好图谱? | 是 | 否 |
| 档位数 | 5（f0–f4） | 3（p1/p2/p3） |
| 最近原文保证 | `recentFullTextTurns` → f0 | tail（不压缩） |
| 抗抖动 | 迟滞死区带 | 无需（compartment 一旦写入就稳定） |

两者没有绝对的优劣。F0–F4 更细、且无需 LLM，但依赖丰富的图谱；P1/P2/P3 更粗、要花 LLM
调用，但在任何数据上都稳健，且给出干净、人类可读的摘要。

---

## 历史：解耦*之前*我们用的是什么压缩

"哪个引擎才是真正在跑的"这个困惑，来自真实的反复变动。以下是 git 核实过的时间线：

| 时间 | Commit | transform 的状态 |
|---|---|---|
| 2026-06-06 | `5299079`（P1） | **只有 F0–F4。** 史上第一个 `messages.transform`：扩散激活 + 二分搜索精度 + `recentFullTextTurns`。那时还没有 compartment。 |
| 约 2026-06-13 | `61287af`（perf） | 为提速把 `renderer.render()` 从热路径移除。F0–F4 停止被调用。 |
| 2026-06-14 | `ba95466`（b63） | **切到 P1/P2/P3。** Historian + compartment 系统集成进 transform。compartment 从这里开始成为真正在跑的机制。 |
| 2026-08-14 | `b334078`（Build #265） | 小清理：把已经死掉的 `ContextRenderer`（F0–F4）import 从 adapter 移除，并把 `neural_reduce/pin/expand` 改成只操作压缩系统。这**不是**那次大解耦 —— transform 逻辑当时仍内联在插件里。 |
| 2026-09-26 | `0237cde`（Build #290） | **那次真正的解耦。** 把整套 ~1000 行的 compartment/transform 引擎 + 7 个共享 helper 从插件里抽进 `packages/core`（`context-compressor.ts`、`transform-helpers.ts`），藏在 `runCompartmentTransform(input, output, deps)` 之后，配一个显式的 `TransformDeps` 接口。adapter 从 **4327 → 3264 行**；同时加了 nvp-server 作为第二个宿主（零 `@opencode` 依赖）证明可复用。 |
| `0237cde` 之后 | — | **加入 A/B/D**（最初 A/B/C/D，后来 B+C 合并）。这些方案是*在*已解耦的 core 引擎*之上*做的 —— 这就是它们生来就 host-agnostic 的原因。 |

**所以对"解耦之前插件长什么样"的直接回答：** 在 `0237cde`（Build #290，9 月 26 日）
之前，OpenCode 插件是一个 **~4327 行的胖插件**，把整条 context 压缩流水线**全部内联在
自己身上** —— token 预算、tail 边界、compartment 渲染、microCompact、tokenizer、tool
分档，全揉在 `adapter-opencode/src/index.ts` 里，跟 OpenCode 的 hook 和消息格式缠死。
别的 agent 根本无法复用。（*记忆* core 从第一个 commit `f667833` 起就一直住在
`packages/core` 里；焊死在插件上的是*压缩*那一半，而这正是 `0237cde` 解开的。）解耦之后
插件变成一个薄适配器（~3264 行，主要是 OpenCode 特有的 I/O），只是去调
`runCompartmentTransform`。

关于引擎：到解耦那一刻（9 月 26 日），真正在跑的引擎已经是 **P1/P2/P3 compartment** 了。
F0–F4 早在 6 月 14 日（`ba95466`）就被换下，它的死 import 在 8 月 14 日（`b334078`）被
移除。9-26 的解耦**并没有**改变*哪个*引擎在跑 —— 它只是把 P1/P2/P3 的机器挪进共享 core。
F0–F4 本身从未被删除；它住在 `packages/core`（`context-renderer.ts`），今天由 nvp-server
宿主使用，只是没接进 OpenCode 的 transform。

---

## 相关文档
- `CONTEXT-COMPRESSION-PIPELINE_CN.md` —— 每轮 transform 的 15 阶段机制。
- `FIDELITY-RENDERING-F0-F4_CN.md` —— 较旧的 per-message f0–f4 精度渲染器
  （由独立的 nvp-server 渲染路径使用，与这些策略不同）。
- `CONFIGURATION-REFERENCE_CN.md` —— 全部配置字段。
