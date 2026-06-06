---
name: skill-creator
description: 写新 skill 的元 skill——把成功的多步骤经验提炼为 SKILL.md 让未来重用,而不是每次重发明轮子。
when_to_use: 用户说"把这个流程记下来 / 学一下 / 写成 skill";agent 跑完一个非平凡多步任务并成功,值得提炼;用户跟 agent 互动式确认每一步如何 generalize 成 SKILL.md。**人驱版**:用户主动要写 skill 时用本 skill 交互;通用流程文档自动归纳走 doc-to-skill。
version: 1.0.0
---

# Skill Creator

## When to Use

- 用户说"把这个写成 skill / 记下这个流程 / 以后这种事..."
- 你刚踩了 N 个坑后终于成功(教训应该固化,下次直奔正确路径)
- 看到一个**可复用的多步骤流程**(单步操作不值得做 skill,直接调工具即可)
- 用户多次重复相同请求(频率信号)

## 什么值得做 skill

| 值得 | 不值得 |
|---|---|
| 多步骤 routine(N ≥ 3 步) | 单步工具调用("跑下 ls") |
| 决策树(不同情况不同走法) | 一次性脚本 |
| 领域知识(术语/规范/约定) | 通用编程知识(LLM 自己有) |
| 工具组合套路 | LLM 已能稳定执行的 |

## SKILL.md 模板

```markdown
---
name: <kebab-case-name>
description: 一句话——做什么 + 何时用,LLM 看 description 决定要不要调
version: 1.0.0
---

# <Title>

## When to Use
- <触发条件 1>
- <触发条件 2>
(列表项会被自动提取成 trigger keywords 喂 FTS5 索引)

## <Section 1: 例如 流程 / 步骤 / 决策树>

具体步骤,**带可执行代码块**(LLM 复制就能用):
```
<command>
```

## Anti-patterns

- ❌ <反例 1>
- ❌ <反例 2>

## <可选:边界情况 / 例外>
```

## 写作纪律

### Description 字段(最重要)

**LLM 通过 description 决定要不要 search 到这个 skill** —— 写得宽泛或 generic 就会被埋没。

**❌**:`"git 工具"`
**✅**:`"标准 git 工作流——branch / commit message / push / pr 的多步骤 routine,避免遗漏关键步骤"`

包含**做什么 + 何时用 + 解决什么坑**。

### When to Use 段(触发关键词来源)

加载器从这段提取 list 项作为 FTS5 索引关键词。所以:
- 用**用户实际会说的话**做触发条件,不是技术术语
  - ❌ "需要进行版本控制操作时"
  - ✅ "用户说'帮我提交 / 推送 / 发 PR'"
- 中英文都覆盖(用户切换语言不漏)

### Action template(主体)

- 给**具体命令** + **例子** > 抽象描述
- 中间用 ```` ``` ```` 代码块,LLM 直接复用
- **明确 anti-pattern** 段——告诉读者哪些事不要做(防止 LLM 走偏)

### 长度

- 太短(< 30 行)= 没积累足够经验,可能不值得
- 太长(> 150 行)= 信息过载,LLM 用不起来
- 甜点 50-100 行

## 落盘位置

- 工程内通用 → `<workdir>/.philont/skills/<name>/SKILL.md`(workspace 优先级)
- 个人通用 → `~/.philont/skills/<name>/SKILL.md`(global)
- 内置(发到 philont 主仓) → `agent-tools/bundled-skills/<name>/SKILL.md`

写完后 watcher 会自动 reimport,无需重启。

## Anti-patterns

- ❌ 把单一工具调用写成 skill → SKILL.md 里只有一行命令,看不出价值
- ❌ description 用"util" / "helper" / "various" 等 generic 词
- ❌ When to Use 用 LLM 视角("agent 需要 X 时") 而非用户视角("用户问 X 时")
- ❌ 不写 anti-pattern 段 → 读者不知道边界,容易过度应用

## Bootstrap 例子

如果你本轮发现一个值得固化的流程,**现在就写**(用上面模板),不要等下次。
