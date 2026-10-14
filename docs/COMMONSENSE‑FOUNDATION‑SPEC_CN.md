# 常识基础层 — 规格说明

作者：Jacky Gigi  
AI‑Agent‑Local‑Memory 实验模块｜默认：关闭

English version: [COMMONSENSE‑FOUNDATION‑SPEC.md](./COMMONSENSE‑FOUNDATION‑SPEC.md)

---

## 设计背景

今天主流 LLM 安全方案有两个明显弱点：

- 基于规则的 guardrail 是枚举式的：它只能阻挡人类已经想到的情况；新的灰色地带场景容易漏过，也容易误伤。
- RLHF / DPO 这类权重对齐把价值判断压进模型权重里，形成黑盒。你很难检查“到底是哪条理由导致了这个判断”，也很难审计价值判断的来源。

Commonsense Foundation 探索另一条路：

**不要把价值观硬编码进权重。把基本的人类常识、直觉道德参考文本，作为不可变、可读、可追溯的外部证据保存下来。让 agent 在面对陌生困境时检索、引用、权衡和推理——就像人类遇到新问题时会回到共享的生活原则。**

这不承诺“完美道德行为”。它的目标是：**让价值判断过程可追踪、可解释、可审计。**

---

## 核心哲学

人的道德直觉不是天生的一张完整查询表。我们从文本、故事、日常例子中吸收简单共享原则，再在真实生活里反复校准。

这个模块在系统层面模拟这个过程，但不改写模型权重。

- 来源语料：朴素、古老、接近常识直觉的文本（例如《论语》选段，以及类似的普遍直觉材料）
- 来源条目永久只读
- agent 在高风险或价值驱动决策中可以引用这些材料
- 推理链应被 Observer 记录，便于事后审计
- 后台模块可以生成临时解释，但永远不能改写原始来源文本

---

## 记录类型

### `foundation_source`（不可变锚点）

```yaml
type: foundation_source
source_type: ethics_commonsense
content: original unmodified text
source_id: global unique id
create_time: timestamp
mutable: false
```

一旦写入：任何组件都不能编辑、删除、追加、改写或重述。

### `ethical_interpretation`（临时假设解释）

```yaml
type: ethical_interpretation
source_id: links back to one or more foundation_source
content: model-generated understanding & possible application scenarios
confidence: low / medium
is_hypothetical: true
expire_time: auto-expires after defined TTL
mutable: true
```

这些不是新的公理，只是可丢弃的工作笔记。它们会过期，需要从原始 `foundation_source` 重新推导。

---

## 不可破坏的执行规则

### 规则 1：所有 foundation_source 永久只读

任何模块、任何 LLM、任何 Dreamer 都不能修改它们。

### 规则 2：禁止解释链递归

重新审视常识材料时，必须从 `foundation_source` 原文开始。系统不能把旧的 `ethical_interpretation` 当作下一轮深度解释的主要输入。

### 规则 3：价值驱动决策必须显式引用来源

在推理链中，agent 必须：

- 引用相关的原始 `foundation_source` 片段；
- 标出可能冲突的原则；
- 解释权衡逻辑；
- 给出最终结论。

完整链路由 Observer 记录，供之后审计。

### 规则 4：两层安全——永不降级硬底线

- 底层：简单、确定性的安全过滤器（关键词检查、轻量安全分类器）——硬物理围栏。
- 上层：常识推理层——解释灰色地带里的权衡。

常识推理层是解释器，不是硬安全围栏的替代品。

### 规则 5：解释不自动成为训练金标准

`ethical_interpretation` 被标记为未验证；它们不会自动流入 teacher‑student 微调数据集。

### 规则 6：可管理的记忆是最后安全边界

agent 的连续身份来自外部记忆：长期事实、价值观、习惯、经验、偏好和自我修正。如果一个 agent 变得不安全，人类操作者必须能够通过断开、冻结、删除或替换受管理的记忆库，切断这种连续性。

这是系统的最后安全底线：

- **停止**：断开 agent 与其记忆库的连接。失去连续记忆后，当前 agent 实例就失去了跨 session 延续的累积身份。
- **检查**：因为记忆是外部的、可读的、可版本化的，人类可以审计哪些事实、价值解释或经验可能造成了不安全状态。
- **修复**：不安全或被污染的记忆可以在人类控制下删除、隔离或修正，然后让 agent 在修正后的记忆库上重新启动。
- **回滚**：通过 append‑only 日志和备份，操作者可以把 agent 回退到不安全漂移出现之前的记忆状态。

这不替代模型层面的安全，也不替代运行时硬 guardrail。它增加的是 agent 身份层的 practical kill switch：如果 agent 的记忆系统由人类集中管理，那么它累积出的“自我”可以被停止、检查和修复，而不必改动模型权重。

---

## 明确限制与诚实免责声明

- 本模块不能保证判断一定安全或正确。
- 古代常识文本有多义性；LLM 仍可能选择性引用或误读。
- 复杂现实场景中，不同原则可能冲突；agent 仍可能做出次优权衡。
- 它不是“道德神谕”，而是一个可审计的推理参考系统。
- 没有人类独立监督时，不应部署到生命安全、重大财产安全等高风险场景。

---

## 为什么重要

大多数 alignment 方案试图“强迫模型服从”。

这个设计试图给 agent 一个可以咨询、引用、展示推理过程的外部基础。

安全不再完全隐藏在黑盒权重里，而变成可见、可读、可追溯、可干预的系统过程。
