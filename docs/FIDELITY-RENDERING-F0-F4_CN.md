# 保真度分层上下文渲染（F0–F4）

> 状态：**历史 / 备用引擎**。该设计实现在
> `packages/core/src/context-renderer.ts`（`ContextRenderer` 类），是 **`nvp-server`**
> 宿主使用的压缩引擎（通过 `renderContext` RPC）。
> 目前 OpenCode 适配器改用的是 *magic-context 风格的 compartment* 引擎
> （`runCompartmentTransform`）。本文档把 F0–F4 引擎写下来存档，避免它只存在于代码里。

## 1. 它做什么

不同于"最近尾部保留原文、更旧的全部摘要"的做法，F0–F4 渲染器把**每一轮**对话独立看待，
把它渲染成**五个保真度档位之一**，档位由这一轮跟当前话题的*相关度*决定
（用记忆图上的扩散激活衡量），并受 token 预算约束。

五个档位（`interfaces.ts` 里的 `FidelityLevel`）：

| 档位 | 名称       | 渲染出的内容                                    |
|------|-----------|------------------------------------------------|
| `f0` | full      | 逐字原文                                        |
| `f1` | paragraph | 段落级摘要（若无摘要则取前 ~800 字符）          |
| `f2` | gist      | 一句话要点（或前 ~120 字符）                    |
| `f3` | title     | 标题 / `[role] 前 ~40 字符…`                    |
| `f4` | suppressed| 省略 —— `§tag§ [elided]`                        |

每条渲染消息保留 `§tag§` 前缀，使其仍可寻址（供 `neural_pin` / `neural_reduce` /
`neural_expand` 使用）。

## 2. 核心思想：看相关度，不是看年龄

与按年龄压缩的关键区别：一个**旧**的对话轮，一旦它的话题重新变得相关，会**重新激活到高保真度**；
而一个**新但不相关**的轮次可以被渲染成较低保真度。年龄只是喂给激活分的*若干信号之一*，
不是唯一的轴。

## 3. 流程（每次 `render()` 调用）

`context-renderer.ts:69` 的 `render(sessionId, currentActivationSeeds)`：

1. **加载 episodes**（`loadEpisodes`，第 166 行）—— 取出该 session 所有 `type:"episode"`
   节点，按 `turnIndex` 排序（缺失则回退 `createdAt`）。每个 episode 节点带 `EpisodicData`，
   其中有 `fidelity` 载荷（`f0` 恒有；`f1`/`f2`/`f3` 可选）。

2. **计算预算**（`computeBudget`，第 220 行）：
   `contextWindowTokens * budgetRatio − systemPromptTokens − reserveTokens`。
   默认值：`budgetRatio=0.6`、`systemPromptTokens=2000`、`reserveTokens=4000`。

3. **用工作记忆增补种子**（`augmentSeedsWithWorkingMemory`，第 190 行）—— 把最多
   `WORKING_MEMORY_SAMPLE=20` 个最近触碰过的节点 id 作为弱种子加入
   （`WORKING_MEMORY_SEED_BOOST=0.1`），让当前焦点影响激活。

4. **扩散激活**（`graph.spreadingActivation`，第 88 行）—— 参数 `maxHops=3`、
   `hopDecay=0.5`、`threshold=0.08`。为每个节点产出一个相关度分。

5. **每个 episode 的有效激活分**（第 102–118 行）—— 对每个 episode，取以下三者的最大值：
   - `baseAct` —— 它的扩散激活分（未被激活则为 `0`）；
   - `recencyBonus = i / episodes.length` —— 线性近因（最新 ≈ 1.0）；
   - `wmFloor = 0.2`（`WORKING_MEMORY_FLOOR`），若节点在工作记忆中。

   然后套用覆盖规则：
   - **suppressed**（且非最后一轮）→ `act = −1`（`SUPPRESSED_ACTIVATION`）；
   - **pinned**、或落在强制全文的近期窗口内、或就是最后一轮 → `act = +∞`（恒 `f0`）。

   `recencyBonus` 正是这个引擎里**时间权重**已经存在的地方。

6. **二分搜索阈值**（`binarySearchThresholds`，第 240 行）—— 找到最小的 scale `s`，
   使*模拟*渲染出的 token 数刚好塞进预算。阈值由 `s` 按固定比例派生
   （`scaleToThresholds`，第 263 行）：`full=s, para=s/2, gist=s/4, title=s/10`。
   `s` 越大，越少节点能过各档阈值、总 token 单调下降，所以取最小的能塞下的 `s` 来
   **最大化预算利用率**。32 次迭代，epsilon `0.001`。

7. **挑档 + 迟滞**（第 126–150 行）：
   - `pickFidelity(act, thresholds)`（第 289 行）：`act ≥ full → f0`、`≥ para → f1`、
     `≥ gist → f2`、`≥ title → f3`，否则 `f4`。
   - **迟滞**（`applyHysteresis`，第 305 行，默认边际 `0.2`）：节点一旦有了某档位，
     只有当激活越过相关阈值超过这个边际时才切档。这让渲染前缀在多轮间**保持稳定**
     （避免某节点每轮 f1↔f0 抖动、把 prompt 缓存打爆）。对 `+∞`/`−1`（强制）节点跳过。

8. **渲染内容**（`renderContent`，第 329 行）—— 按所选档位输出 `§tag§ <text>`，
   当某摘要档没有预生成时，回退到截断的 `f0`。

9. **system 注入**（`buildSystemInjection`，第 358 行）—— 一个 `<neural-memory>` 块，
   含 ready 的 session facts + 激活度最高的 concepts/assertions，外加工具使用指南
   （`neural_reduce`/`neural_pin`/`neural_recall`/`neural_note`）。

## 4. 常量（全在 `context-renderer.ts` 第 15–30 行）

```
CHARS_PER_TOKEN        = 4      F1_FALLBACK_CHARS      = 800
F2_FALLBACK_CHARS      = 120    F3_FALLBACK_CHARS      = 40
RECENT_AVG_SAMPLE      = 10     TOP_CONCEPTS           = 5
TOP_ACTIVATION_SCAN    = 50     ACTIVATION_MAX_HOPS    = 3
ACTIVATION_HOP_DECAY   = 0.5    ACTIVATION_THRESHOLD   = 0.08
WORKING_MEMORY_FLOOR   = 0.2    WORKING_MEMORY_SAMPLE  = 20
WORKING_MEMORY_SEED_BOOST = 0.1 BINARY_SEARCH_ITERATIONS = 32
BINARY_SEARCH_EPSILON  = 0.001  SUPPRESSED_ACTIVATION  = -1
```

## 5. 近期全文窗口

`recentFullTextTurns`（配置）或 `calcRecentFullText`（第 203 行）强制最近 N 轮为 `f0`。
N 随最近 10 轮的平均轮次大小自适应：`平均 <200 tokens → 5`、`<500 → 4`、否则 `3`。
轮次越长 ⇒ 强制全文的越少，以保护预算。

## 6. 与 compartment 引擎的关系

| | F0–F4 渲染器（`ContextRenderer`） | Compartment 引擎（`runCompartmentTransform`） |
|---|---|---|
| 单元 | 每条**消息** | 每个 **compartment**（一段被摘要的消息*区间*） |
| 保真度轴 | 每条消息 5 档 | tail = 原文；更旧 = p1/p2/p3 摘要 |
| 相关度 | 扩散激活 → 阈值 | 近因窗口 + 后台 historian |
| 宿主 | `nvp-server`（`renderContext` RPC） | OpenCode 适配器（`messages.transform`） |
| 时间权重 | `recencyBonus = i/len`（内建） | 近因 tail 边界 |

**给计划中的"方案 D"（compartment 上的时间+语义混合）的复用提示：**
这里的*激活→档位映射*（`pickFidelity` + `binarySearchThresholds` + `applyHysteresis`）
在思路上可复用，但它耦合于*每条消息*的 episode。要*按 compartment*应用，需要多一步：
把某 compartment 覆盖的那些 episode 节点（`startOrd..endOrd`）的激活分**聚合**成该
compartment 的一个分，再喂进同一套阈值/迟滞逻辑。episode 原文已在图里，所以
**不需要把摘要加进图**——新增的只有"episode 激活分 → compartment 分"这个聚合。
