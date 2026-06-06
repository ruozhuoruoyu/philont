---
name: goal-driven-execution
description: 接到不明确的任务时,先把它转成"做完长什么样 + 怎么验证"再开始动手;同一 turn 内做完后用工具核验,而不是凭感觉宣布完成。
when_to_use: 任务模糊或目标不清(用户只说大方向);多步骤任务执行前需要拆分目标 + 验证标准;agent 容易"做了一部分就宣布完成"的场景;用户说"把 X 弄一下 / 帮我处理 Y"这种不明确请求
version: 1.0.0
---

# Goal-Driven Execution

## When to Use

任意以下场景:

- 用户给的任务**模糊**("帮我搞下 X" / "优化一下" / "改进 Y")
- 任务有**多个合理终态**("加点测试" → 1 个还是 50 个?覆盖到哪种边界?)
- 任务**看似简单但有副作用**("把这段代码改成异步" → 谁调用它?调用方都得改吗?)
- 即将**宣布完成**("已完成" / "OK" / "done") —— 此时必须先核验

## 核心三步

### 1. 转任务 → 成功标准

收到任务后,先在脑内/文本中回答 3 个问题:

```
- 这件事 *做完* 长什么样?(具体到能 grep / curl / test 的程度)
- 哪些是必须的(must),哪些是 nice-to-have?
- 失败 mode 是什么?哪些情况下我应该停下问用户?
```

**❌ 反例**:
> 用户:"加点测试"
> agent: 直接开始写测试 → 写了 50 个边界 case → 用户:"我只是想要一个 happy path"

**✅ 正例**:
> 用户:"加点测试"
> agent: "我会先加 happy path 单元测试,边界 case 留 TODO 注释让你看了再决定要不要补,行不行?"

> 用户:"如果你不确定就直接做 happy path 就行" ← 用户授权后再开始

### 2. 干活时,把"成功标准"挂在脑前

每写一行代码,都问:**这一行让我离成功标准更近,还是只是看起来在动?**

如果答案是后者 → 停下,别加。这是 philont CLAUDE.md 里"Don't add features beyond what the task requires"的具体执行步骤。

### 3. 完成前,**用工具核验**(不是凭感觉)

宣布完成前必须用工具自证。**HonestyGate 已经实装了一道运行时拦截**(完成宣言 vs ✓/⚠ tool markers 不一致 → 强制重生),**但靠 gate 兜底是失败时的 last line of defense,不应该是日常依赖**。

| 任务类型 | 验证手段 |
|---|---|
| 写文件 | `readFile` 看一眼实际写出什么了 |
| 改代码 | `grep`/`glob` 看引用,`runShell` 跑 typecheck/test |
| 删东西 | `glob` 确认确实没了,`grep` 确认无残留引用 |
| 网络操作 | `curl -I` 或对应工具回看 status code / 实际返回 |
| 修 bug | 复现一遍 bug,看是否还触发 |

**没核验过 = 没做完**。说"我已经修好了"前先用工具看一眼。

## Anti-patterns(检测到这些,触发本 skill)

- ❌ "我先做 X,再做 Y,再做 Z..." 然后就开干 —— 没问"用户要不要 Z"
- ❌ 三次连续用 writeFile 后直接说"已完成" —— **VerifyBeforeClaim Gate** 会触发重生(成功后没用 readFile/grep/glob)
- ❌ "应该可以了" / "看起来 OK" / "理论上没问题" —— 都是 "没核验" 的同义词
- ❌ 把 nice-to-have 当 must,做了一堆用户没要的事 —— 这是 Karpathy 吐槽 LLM 的最大病症

## 与 philont 现有机制的关系

本 skill 是**前置 prevention**(prompt 层),philont 的 Drive / Gate 是**后验 detection**(runtime 拦截)。

- 用了本 skill 的提示 → 大多数情况不需要 gate 兜底
- 没用 → HonestyGate / VerifyBeforeClaim / TaskCommitmentDrive 触发,强制重生

理想状态:gate 命中率随时间下降,因为 agent 提前用了本 skill 的纪律。

## 一句话浓缩

**先回答"做完长什么样",再开始;做完后用工具自证,再宣布。**
