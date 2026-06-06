---
name: doc-to-skill
description: 通用 meta-skill — 给一份流程文档(SOP / runbook / API guide / 任意 markdown 操作指南)URL,把文档归纳成可复用的 philont skill 持久化到 SkillStore,后续同类请求自动命中。从"读文档照做"升级为"读完一次以后我自己会"。
when_to_use: 用户给流程文档 URL 让 agent 学会按此操作("学下这个 SOP / 把这份 runbook 学下来 / follow https://.../guide.md 以后照做");用户给一份 markdown 流程文档,但**没说**心跳/凭证/周期(否则用 service-onboarding);agent 自己研究时发现一份很详细的 step-by-step 操作指南值得固化
version: 1.0.0
---

# Doc → Skill 通用归纳器

philont 的核心理念之一是**"读完一次以后我自己会"**。这个 skill 把"agent 读一份流程文档"
变成"agent 学会一类任务"——任意 SOP / runbook / 操作手册输入,philont skill 输出。

## When to Use

- 用户说"读 https://... 这份文档,以后照做" / "学下这个 SOP" / "把这个 runbook 变成你的技能"
- 用户给一份 markdown / HTML 流程文档,但**没说**心跳 / 凭证 / 周期(否则用 `service-onboarding`)
- agent 自己研究时发现一份很详细的 step-by-step 操作指南,值得固化为可复用 skill

## When NOT to Use(边界)

| 场景 | 用什么 | 理由 |
|---|---|---|
| API 服务 + 凭证 + 周期心跳("注册 X service,key=xx,每 30min") | **`service-onboarding`** | 那是特化版,有 step 5 强制 schedule_reminder |
| 用户跟我对话提炼经验("把刚才这个流程记下来") | **`skill-creator`**(交互式) | 用户主动驱动写 skill,需要 Q/A 互动 |
| 公共 registry 找现成 skill("ClawHub 上有没有 X") | **`clawhub`** / **`github-skills`** | 不归纳新 skill,是装现成的 |
| 用户问"这文档讲什么"(一次性查询) | 直接 `webFetch` 答,**不要**建 skill | 一次性需求不需要持久化 |
| 文档是纯参考资料(API reference / 词典 / spec)无操作流程 | **`store_note`** 兜底 | 没"动作序列"建出来的 skill 是空壳 |

## 核心理念

skill-creator 教**人写**(交互式),service-onboarding 太特化(强制心跳),clawhub 拉现成。
本 skill 覆盖**最朴素**的"我读了一份说明书,我会了"——纯文档输入,通用流程输出,
无凭证、无心跳、无外部 service 假设。

跟 reflection 自学的差异:
- reflection 路径是**经验驱动**(agent 跑过一次任务后总结)
- 本 skill 是**文档驱动**(agent 读完一份文档就归纳,不需要先跑一次)
- 二者都通往 `installSkill`,正常 maturity 状态机生效

## 步骤(严格 6 步)

### 1. Fetch + 验证文档可读性

```
http({ method: "GET", url: "<doc-url>" })
```

**用 `http` 不用 `webFetch`**(同 service-onboarding 教训:webFetch 的 aux LLM 蒸馏可能
把含 "agent 应当 X" 的指令文档误判为 prompt injection 拒绝处理)。

验证:
- HTTP status 200 → 继续
- 4xx/5xx / 超时 → abort,告诉用户 URL 无法访问,**不**建 skill
- body 长度 < 500 字 → **拒绝建 skill**(见 Anti-patterns),fallback 到 `store_note` 保留文档摘要
- body 是渲染过 HTML 太大乱码 → 退回 `webFetch({ extractor: 'raw' })` 一次

### 2. 解析文档结构

LLM 直接读 raw markdown / HTML,**自己**判断:

- 有几级标题层级
- 是否含 numbered / bulleted **操作步骤序列**(关键判据)
- 是否含"failure handling / troubleshooting / 注意事项"段
- 是否含"anti-pattern / 不要做 / 错误示范"段
- 是否含"何时用 / when to use"段(明确触发场景)

**判据**:必须至少识别出 **3 个明确"动作步骤"**(动词开头:"运行 / 调用 / 检查 / 提交...")。
否则 → 这是参考资料不是流程,跳到失败分支(见失败处理表)。

### 3. 抽 skill 元信息 + name 冲突预检查

LLM 输出结构化候选(内部推理,不打印给用户):

```json
{
  "name": "<kebab-case,基于文档主题,例 'deploy-runbook' / 'incident-response' / 'data-etl-pipeline'>",
  "description": "<一句话:做什么 + 何时用,LLM 看 description 决策>",
  "when_to_use": "<narrative 文本:user 在什么场景应该用这个 skill,跟 description 互补>",
  "trigger_keywords": ["关键词1", "关键词2", ...],
  "steps": [{ "title", "action", "code_or_command?" }],
  "failure_table": [{ "symptom", "remedy" }],
  "anti_patterns": ["..."],
  "source_url": "<原文档 URL>",
  "source_hash": "<sha256(url).slice(0,12)>"
}
```

**name 冲突预检查**(关键步):

```
search_skills({ query: "<候选 name>" })
```

若已存在同名 skill → 跳到失败处理表"name 冲突"分支,**不强覆盖**。

### 4. 合成 SKILL.md 文本

按 philont 标准 frontmatter + 章节模板组装:

```markdown
---
name: <抽出的 name>
description: <抽出的 description>
when_to_use: <抽出的 when_to_use>
version: 1.0.0
source: self:doc-to-skill:<source_hash>
maturity: draft
---

# <Title 来自文档主标题>

## When to Use
- <bullet 1>
- <bullet 2>

## 流程

### 步骤 1: <title>
<action 描述>
\`\`\`
<code if any>
\`\`\`
...

## 失败处理
| 现象 | 应对 |
|---|---|
...

## Anti-patterns
- ❌ ...

## 来源
本 skill 由 doc-to-skill 从 <source_url> 自动归纳生成。原文档为权威源,本 skill 是
agent 的内化版本,可能简化或漏抄。如发现行为偏差,回原文档校对。
```

### 5. installSkill 持久化

```
installSkill({
  name: "<name>",
  source: "self:doc-to-skill:<source_hash>",
  content: "<上面合成的 SKILL.md 全文>"
})
```

`installSkill` 同步刷新 SkillStore(见 philont P0 修复)。`maturity` 默认 `draft`
(状态机自动认),不是 stable —— **从未跑过的 skill 不应该被强信任**。

### 6. 验证 + 通告

```
search_skills({ query: "<刚抽出的某个 trigger keyword>" })
```

返回结果含新 skill → 索引正常。回复用户:

```
✅ 已学:<skill-name>(maturity=draft)
- 来源:<doc-url>
- 共 N 步,K 个 anti-pattern
- 下次你说 "<示例触发词>" 时会自动调用

如要修改 / 重学 / 卸载,告诉我。
```

## 失败处理表

| 现象 | 应对 |
|---|---|
| `http` GET 4xx / 5xx | abort,告诉用户 URL 不可达,**不**建 skill |
| body < 500 字 | 信息不足建 skill 风险大;fallback `store_note({title:'doc:<url>', body:<原文>})`,告诉用户"文档太薄,我记成 note 了不建 skill" |
| 解析不出 3+ 操作步骤(纯参考资料) | **不**建 skill;`store_note` 保留摘要,告诉用户"这文档是参考资料没流程,我记成笔记了" |
| 同名 skill 已存在 | **不强覆盖**。给用户 3 选项:(a) 另起名(默认追加 `-v2`)(b) `uninstallSkill` 旧的再装新的(c) merge(让 LLM 把新文档当 update 喂给 skill-creator 流程)。等用户选 |
| `installSkill` 写入失败 | 重试 1 次;再失败 abort,告诉用户磁盘 / 权限问题 |
| 生成的 SKILL.md 自检不过(缺 description / when_to_use 为空) | 回 step 3 重抽一次;两次失败 abort 并 store_note 兜底 |

## Anti-patterns

- ❌ **从 < 500 字薄文档建 skill** —— 信息不足,生出的 skill 都是空壳,污染 SkillStore 索引,
  reflection 升档机制还会被噪声拖慢
- ❌ **从纯 API reference / 词典 / 数据表建 skill** —— 没"动作序列",建出来 description 空泛,
  trigger 烂,LLM 永远命中不到
- ❌ **强行覆盖同名 skill** —— 会丢用户 / reflection 自生的本地经验。必须 ask 用户决策路线
- ❌ **maturity 直接写 stable** —— 没跑过就被强信任,真出错 reflection 状态机要踩好几次降档
  才修正,损失大。**默认必须 draft**
- ❌ **用 webFetch 拉文档** —— aux LLM 蒸馏可能拒读"agent 操作指令"文档(见 service-onboarding
  实战教训)。**用 http GET 拿原始 markdown**
- ❌ **doc-to-skill 调 doc-to-skill 递归** —— 文档里链接到另一份文档时,**不**自动深挖。
  一次只学一份;追文档链让用户显式发起
- ❌ 给 skill 起非常 generic 的名字(`deploy` / `api` / `helper`)—— 跟 skill-creator 写作纪律
  一致,trigger 烂等于没建

## 跟其他 meta-skill 协同

| skill | 关系 |
|---|---|
| `service-onboarding` | 上位特化:同样读文档,但**额外**要求凭证 + 心跳 + auth verify。doc-to-skill 是它的"无服务"超集 |
| `skill-creator` | 互补:skill-creator 教**人写格式**(交互式);doc-to-skill 是 agent 自驱版,内部其实复用 skill-creator 的 SKILL.md 模板 |
| `clawhub` / `github-skills` | 互补:它们拉公共仓现成 skill;doc-to-skill 从私有 / 内部 / 任意 URL 文档**派生**新 skill |
| reflection 收口 emit `new_skill` | 互补:reflection 是经验驱动(跑成功后归纳);doc-to-skill 是文档驱动(读完归纳)。两条路都通往 `installSkill` |

## 质量控制(跟 skill_maturity.ts 状态机协同)

- **默认 `maturity='draft'`**,跟 schema v11 状态机兼容:reflection 跟踪 use_count,
  1 次成功 → confirmed,5 次 → stable,3 次连续失败 → deprecated
- **source 标 `self:doc-to-skill:<hash>`**,跟 reflection 自生的 `self:reflect-<id>` /
  clawhub 的 `clawhub:<slug>@<ver>` 区分,审计可追溯
- doc-to-skill 学出的 draft skill **不**走层 1 自动 routing rule 路径(routing_bundled.ts
  内 source 检测 'self:*' 跳过)。等 reflection 验证成功 ≥ 1 次升到 confirmed 后,
  reflection 自己写一条 routing rule
- 失败 ≥ 3 次 → 自动 deprecated(同既有 skill 状态机)

## Bootstrap 例子

| URL | 期望路径 |
|---|---|
| `https://kubernetes.io/docs/tasks/debug/debug-cluster/` (numbered 步骤 + troubleshooting) | 正例:6 步通跑,装出 `k8s-cluster-debug` draft skill |
| `https://github.com/<org>/<repo>/blob/main/RUNBOOK.md` | 正例:典型 ops runbook |
| `https://docs.python.org/3/library/json.html`(纯 API reference) | 反例 step 2:无操作序列 → store_note 兜底 |
| 任意 < 500 字 README | 反例 step 1:body 太短 → store_note |
| 用户连续 2 次给同一份文档 | 失败表:name 冲突分支,问用户选项 |
| 用户给某 service guide.md + key + 30min(走错路由) | 应被 `service-onboarding` routing rule 优先命中(关键词"凭证 / 心跳"),doc-to-skill 不命中 |
