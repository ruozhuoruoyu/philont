---
name: memory-discipline
description: 记忆工具(store_fact / get_fact / list_facts)的使用纪律——namespace 怎么选、何时该读再写、避免覆盖丢信息。
when_to_use: 要 store_fact 但不确定 namespace / key 选什么(user / project / self / service.X);记忆需要更新现有值时(读再写避免覆盖);agent 准备记重要事实但担心写错位置 / 命名规范
version: 1.0.0
---

# Memory Discipline

## When to Use

- 用户说"记一下 / 记住 / 我喜欢 / 我不吃 / 我是 ..."
- 用户问"我之前说过什么 / 你还记得 X 吗 / 我的 Y 是什么"
- 准备做推荐 / 建议前(应该先 list_facts 避免踩用户拒绝过的)
- 任何**长期对未来仍有效**的偏好 / 约束 / 属性 / 计划

## Namespace 决策树

| 内容 | namespace | key 例 |
|---|---|---|
| 用户偏好(喜欢/不喜欢) | `user` | `preferences.cuisine` |
| 用户禁忌/过敏/约束 | `user` | `constraints.diet` |
| 用户身份/属性 | `user` | `role` / `location` / `age` |
| 用户计划事件 | `user` | `events.<name>`(fact_kind=event,occurred_at=ISO) |
| 项目相关 | `project` | `tech_stack` / `goals` |
| 角色身份(用户给 agent 的) | `user.role` | `style` |
| **agent 自己的认知** | `self` | **只读不写**(由 SelfReflector 维护) |

## 写入纪律(关键)

### 先读后写,合并而非覆盖

**❌ 错** — 直接 store_fact 覆盖:
```
用户:"我也讨厌香菜"
agent: store_fact(user, preferences.cuisine, {dislikes: ["香菜"]})
       ← 之前存的 dislikes: ["日料"] 被丢了
```

**✅ 对** — 先 get,合并,再 store:
```
existing = get_fact(user, preferences.cuisine)
        // {dislikes: ["日料"]}
merged = {dislikes: [...existing.dislikes, "香菜"]}
store_fact(user, preferences.cuisine, merged)
```

### 负面偏好优先

用户**否定**某物时**几乎一定要记**(下次推荐踩雷代价高)。
- "我不吃辣 / 我对花生过敏" → constraints,**永久**
- "我喜欢面条" → preferences,可衰减

### 主动记忆原则

即使用户没说"记住",看到以下信号**立即** store_fact:
1. 偏好声明:"我喜欢/讨厌/不爱 X"
2. 约束/禁忌:"不能吃/过敏/戒酒中"
3. 属性:"我在北京/我是后端/我 30 岁"
4. 计划事件:"明天去面试 / 中午吃饺子"

## 读取纪律

### 推荐前必扫

任何"建议 / 推荐 / 选哪个" 前先:
```
list_facts(user, prefix="preferences")
list_facts(user, prefix="constraints")
```
没扫直接推荐 = 大概率撞用户拒绝过的东西。

### "你还记得 X 吗" 不是闲聊

立即 `list_facts` 或 `get_fact` 查,**不要**说"我没有上下文"——你有 recall_sessions / list_facts 可用。

## Anti-patterns

- ❌ 说"好的我记住了" 但没调 store_fact = 撒谎(HonestyGate 会检测)
- ❌ 同一 namespace.key 不读直接写 → 覆盖丢信息
- ❌ 用 namespace=`assistant` / `agent` 等(非约定值)→ 后续读不到
- ❌ value 写成长 prose → 后续 get_fact 拿到一段散文,不是结构化数据。**用 JSON 对象** ` {key: value}`

## 命名约定速查

- 用 `.` 分层:`preferences.cuisine` / `events.next_trip`
- 复数词描述集合:`dislikes` / `allergies`
- 时间字段用 ISO 8601:`occurred_at: "2026-04-28T12:00:00Z"`
