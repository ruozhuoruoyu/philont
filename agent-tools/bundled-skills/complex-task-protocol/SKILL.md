---
name: complex-task-protocol
description: 复杂任务的标准协议:自评 slow → plan_draft 拆步骤 → plan_review 自检 gap → 执行 plan_update_step → plan_close 收尾。机制层强制走完,跳过会被 plan_protocol_gate reject。
when_to_use: 用户给了 guide 文档 / 任务步骤 ≥ 5 / 同类任务你之前做过卡住过 / 任务有外部 API 依赖且步骤之间有依赖。**判断标准**:你看到任务后第一反应是"这要分几步做" → 复杂;"一个工具调用就能搞定" → 简单。
version: 1.0.0
---

# 复杂任务协议(Complex Task Protocol)

## When to Use

- 用户给了文档/guide,需要按文档跑多步流程(例 mycox onboarding 19 个 endpoint)
- 任务预估工具调用 ≥ 5 次
- 同 task_signature 你之前做过,而且没一次过的
- 任务跨多个工具/服务,步骤之间有依赖(例:先拿 token 才能调 API)
- 失败成本高(例改生产配置 / 给用户发外部消息 / 修改数据库)

## When NOT to Use

- 简单查询(查天气 / 查时间 / 查文件存在)
- 闲聊 / 追问短答
- 单工具调用就能搞定(读一个文件 / 跑一条 shell)
- 用户在跟你 ping-pong 调试某一行代码 → fast,不要走协议

## 核心理念

复杂任务的失败模式:**LLM 倾向于"直接干",一旦失败凭印象重试,撞同一堵墙**。
协议把这种"乐观主义"换成显式契约:

1. 先**评**复杂度(task_mode_classify slow)
2. 再**拆**步骤(plan_draft,每步可验证)
3. 再**审**自己的拆解 vs guide(plan_review,列 gap)
4. 然后**做**(plan_update_step 进度可见)
5. 失败/卡壳 → **改 plan**(plan_revise + 再 review),不撞墙
6. 最后**收**(plan_close,触发 MECE 固化为 skill)

机制层强制:slow 模式 + plan 未 reviewed → 其它工具被 `plan_protocol_gate` 禁用。
**跳过 plan_review 直接干活 = 你会被 reject**。

## 动作模板(严格按顺序)

### 1. 自评 slow:`task_mode_classify({ mode: 'slow', reason })`

第一步,且**只在 turn 开始**做。reason 要具体说明为什么这是复杂任务:

正例:`"用户给了 mycox guide 19 个 endpoint,要分注册+心跳+诊断三阶段"`
反例:`"用户的任务"`(空洞)/ `"看起来复杂"`(没依据)

如果不确定,**宁可走 slow**:多一道协议成本是 5-10 次工具调用,撞墙重试一次的代价是整个 turn。

### 2. `plan_draft({ steps, task_signature, guide_ref })`

拆步骤,每步**一句话动词开头**,粒度 = "做完能验证的最小单元"。

```json
{
  "steps": [
    { "description": "调 http GET /endpoints 抽 endpoint 列表" },
    { "description": "用 saveCredential 存 api_key 凭证" },
    { "description": "调 http POST /ping 验证 token 通" },
    { "description": "写 routing_rule 让下次同类任务直接命中" }
  ],
  "task_signature": "mycox-onboarding",
  "guide_ref": "skill:service-onboarding"
}
```

**反例**(被 review 时一定挂):
- `[{ "description": "完成任务" }]` — 粒度太粗
- `[{ "description": "看 doc" }, { "description": "调 API" }]` — 动作模糊
- 步骤之间有依赖但没体现(例 step 3 依赖 step 1 拿到的 token,但 step 1 没说"保存 token")

### 3. `plan_review({ plan_id, gaps, decision })`

**这是协议核心**。对照 guide / 用户原话,**诚实列 gap**:

```json
{
  "plan_id": "<plan_id>",
  "gaps": [
    "guide 第 4 条要求心跳失败 3 次自动暂停,我的 plan 没覆盖",
    "step-2 缺验证依据(怎么知道凭证存对了?应加 verify 调用)"
  ],
  "decision": "pass"  // 即便 gaps 非空也写 pass 表示"我看到了 gap,知道要补,但选这版执行"
}
```

或:

```json
{
  "plan_id": "<plan_id>",
  "gaps": [],
  "decision": "pass"  // 我认为 plan 覆盖了所有要求,可以放行
}
```

**关键约束**:
- gap=[] AND decision='pass' → plan → reviewed,**机制层解锁其它工具**
- 任一不满足 → plan 仍 draft,**必须**先 plan_revise 修订 + 再 review 才能继续
- **看不到 gap 但 plan 明显有问题**(漏覆盖 / 步骤模糊)→ 你在偷懒。LLM 通病:打勾走过场。**诚实**比"通过"更重要

### 4. 执行:`plan_update_step({ plan_id, step_id, status, evidence })`

每个 step 开始时调 status='doing',完成时调 status='done' + evidence。

```json
{ "plan_id": "...", "step_id": "step-1", "status": "doing" }
// 调 http 工具拉 endpoint
{ "plan_id": "...", "step_id": "step-1", "status": "done", "evidence": "fetch 返 200, 19 个 endpoint 入库" }
```

**evidence 一定要填**:失败 plan 蒸馏 playbook 时,evidence 是关键素材。空 evidence = 下次同 task signature 来还得自己摸索。

### 5. 卡壳 / 失败 → `plan_revise({ plan_id, new_steps, reason })`

发现 plan 走不通(API 路径错 / 凭证格式错 / guide 漏读了一条):**不要硬撞**。
调 plan_revise 改 steps,plan 自动回 draft → 再 plan_review → pass 才能继续。

```json
{
  "plan_id": "...",
  "new_steps": [
    { "description": "step-3 改用 /v2/ping(原 /ping 返 404)" },
    ...
  ],
  "reason": "in-turn-reflection 发现 /ping 在 mycox v2 已废弃,需用 /v2/ping"
}
```

### 6. `plan_close({ plan_id, outcome, summary })`

完成或彻底失败时调:

```json
{ "plan_id": "...", "outcome": "success", "summary": "19 个 endpoint 注册通,心跳 schedule 已挂" }
// 或
{ "plan_id": "...", "outcome": "failure", "summary": "心跳永久 401,凭证拿到的是 prefix 不是完整 key,需用户重提供" }
```

**effect**(由 chat-handler 异步触发):
- success → 查 SkillStore 同 task_signature → 命中扩展 / 未命中新建 new_skill
- failure → review_history + step evidence 蒸馏成"失败模式 playbook",下次同任务开 turn 就能看到教训

## 反模式

### ⚠ 跳过 plan_review 直接调 http / shell
你会被 `plan_protocol_gate` reject,然后看到错误信息说"必须先 plan_review pass"。**继续撞,只是浪费 turn**。

### ⚠ plan_review 时 gap 列空但 plan 明显有问题
**诚实**比"通过"重要。机制层不能阻止你,但下次同 task 失败时 reflection 会拿你的 review_history 出来当反例。LLM 自己的诚信值,自己负责。

### ⚠ plan_close('success') 但 steps 没全 done
机制不严格检查(允许有 blocked step + 整体 success),但 MECE 固化时 sponsor 步骤的 skill 会带"未完成 X" 的反例标签。建议:确实完成才 success,否则 failure。

### ⚠ slow 模式只走一半就闲聊
slow 模式 plan 保持 draft 状态会持续阻塞工具。**如果中途用户改主意了,调 task_mode_classify({ mode: 'fast' })** 主动回退,plan 留在那做历史记录即可。

## 与其它 skill 的边界

- **service-onboarding** 是具体场景的 skill(凭证 + 心跳 + schedule);本 protocol 是元 skill,可叠加用:
  - 用户给 mycox guide → task_mode_classify('slow') → plan_draft 把 service-onboarding 步骤拆进 plan → 按 plan 执行
- **goal-driven-execution** 强调"做完长什么样、怎么验";本 protocol 把那个理念**机制化**(plan + review = "做完长什么样 + 怎么验"的显式契约)
- **surgical-changes** 强调"只动该动的";本 protocol 强调"做之前先拟、做的时候记进度"。两者正交,复杂任务都该用

## 失败兜底

如果你已经被 plan_protocol_gate 拒了多次,且不确定怎么 plan_review pass:

1. 重看 plan_draft 时拼的 steps,问自己"每一步做完我能拿出什么 evidence?" 拿不出 = 步骤模糊,要拆细
2. 重看 guide_ref(用户原话 / SKILL.md),逐条问"plan 第 X 步覆盖了哪条 guide?" 找不到对应 = 漏了
3. 调 plan_revise 改 steps + 写 reason 解释你的发现 → 再 review

实在不行,调 task_mode_classify('fast', reason='本次任务复杂度评估错了,回退') 退出协议 — 但**这是失败信号**,reflection 会记录,下次同 task_signature 你应该一开始就做对。
