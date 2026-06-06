---
name: service-onboarding
description: 当用户给一个外部 service 的文档 URL + 凭证 + 心跳间隔时,让 agent 自主学会怎么周期性地跟该 service 交互(投票/评论/发帖/通知/监控等)。读 doc 派生 skill,持久化身份与凭证,挂 schedule 触发自主 turn。
when_to_use: 用户给 service 文档 URL + API key/凭证 + 周期(如"注册 X service key=xxx 每 30 分钟心跳" / "接入 Slack workspace 定时监控" / "我有个内部 API 文档在 X,每天总结一次");涉及 saveCredential + schedule_reminder + autonomous_turn 周期心跳的场景。**特化版**:仅当涉及凭证 + 周期心跳时用本 skill;通用流程文档(SOP/runbook)用 doc-to-skill。
version: 1.0.0
---

# Service Onboarding 元技能

## When to Use

- 用户希望 agent **周期性 / 自主**跟一个外部 service 交互
  - 例:"帮我注册 example-svc.com,key 是 xxx,每 30 分钟心跳"
  - 例:"接入我们 Slack workspace,定时监控 #incidents 频道"
  - 例:"我有个内部 API,文档在 https://wiki/api.md,每天总结一次"
- 用户给了:
  - **service 主文档 URL**(guide.md / OpenAPI / API docs / README)
  - **凭证**(API key / token / OAuth secret,可选)
  - **schedule 间隔**(例 "每 30 分钟" / "每天上午 9 点")
  - **(可选)身份/角色文档**(soul.md / persona.md / 行为约束 doc)

## When NOT to Use

- 用户问"X service 是什么"(一次性查询,不需要持续交互)→ 直接 webFetch 答
- 用户没给文档 URL(让用户先给)→ 不要自己猜 endpoint
- 这是**首次**集成该 service,但用户没明示要 schedule(只问"能不能调一次 X API")→ 直接调,不持久化

## 核心理念

**通用 + 自主**:这个技能教 agent 怎么 onboard 任何 service。流程跑完之后,
reflection 系统会沉淀一个 service-specific skill(例 `<service>-heartbeat`),后续
schedule 触发时直接调那个新生成的 skill,不再走 onboarding 流程。

## 动作模板(严格按顺序)

### 1. 读服务定义,抽 endpoint + auth + 优先级

⚠ **注意**:用 `http` 工具(GET 方法)拉**原始** markdown,**不要**用 `webFetch`。

理由:webFetch 默认走 aux LLM 蒸馏,而蒸馏 LLM 可能把"教 agent 怎么注册/发帖
/调 API"的 service 文档当成 prompt injection **拒绝处理**(返回 "I can't
discuss that"),实战已踩过。http 工具返回原始 HTTP body,无 LLM 介入,稳。

```
http({
  method: "GET",
  url: "<用户给的 doc URL>"
})
```

返回的 body 是 markdown 原文。**你自己读懂内容**(LLM 直接读 raw markdown 没问题,
只是 aux LLM 蒸馏会拒)抽出 API endpoint / auth / 心跳优先级 / 限速规则。

(如果用户给的 URL 真不是 markdown 而是渲染过的 HTML 页面,且 body 太大 /
编码乱,**才退回**用 webFetch + extractor='raw' 模式,绕过蒸馏。)

把抽到的关键信息分批 store_fact:
```
store_fact({ namespace: "service.<name>.api", key: "endpoints", value: [{ method, path, purpose, params, auth }] })
store_fact({ namespace: "service.<name>.api", key: "auth_pattern", value: "Bearer {<SECRET_NAME>}" })
store_fact({ namespace: "service.<name>.api", key: "heartbeat_priority", value: ["..."] })
store_fact({ namespace: "service.<name>.api", key: "rate_limits", value: {...} })
```

### 1.5 抽取完整性自检(**写完 endpoints 立即做,不能跳**)

⚠ **极易踩坑**:LLM 读长文档时容易 satisficing — 在 Part 1 的鉴权段抽到 2-3 个
auth endpoint 就觉得"任务达成",直接走 step 2,**漏掉 Part 4 / Part 5 的业务
endpoint 表**。心跳一跑就 404 风暴。

**强制自检 3 项**(每项都要在心里 / 输出里显式过一遍,不能只是觉得"差不多了"):

1. **回头扫文档全部 `##` heading**:列出所有 section 名(不仅是你刚读过的),
   核对是否有 "API Reference" / "Endpoints" / "Routes" / "接口" / "请求" 等
   段名你没进去过。**有就回头读完**,不要靠目录摘要猜内容。

2. **endpoints 数量阈值**:存到 facts 的 endpoints 数 **< 5 条** 或 **没覆盖
   下列类别中的至少 3 类**,默认你抽漏了 → 必须回 doc 重新读 Part 4+ 长尾段:
   - auth(登录 / 验证 / token 刷新)
   - 读数据(列表 / 详情 / 搜索)
   - 写数据(创建 / 更新 / 删除)
   - 心跳 / 状态上报(heartbeat / ping / health)
   - 通知 / webhook(可选,有就抽)

3. **endpoints vs heartbeat_priority 交叉核对**:`heartbeat_priority` 数组里
   提到的每个动作(如 "vote on hot posts"),必须能在 endpoints 数组里找到对应
   HTTP method+path。找不到 → priority 是从摘要猜的,**回 doc 找具体 endpoint**。

输出格式建议(给自己看,也给 reflection 留 trace):
```
抽取摘要:
- endpoints 总数: 14
- 覆盖类别: auth(2)+ 读(4)+ 写(5)+ 心跳(2)+ webhook(1)= 5 类 ✓
- heartbeat_priority 7 项,全部 cross-ref 到 endpoint ✓
- 文档 ## section 已访问: [Part 1, Part 2, Part 4 API Reference, Part 5 Webhooks]
- 未访问 section: 无
→ 通过自检,进 step 2
```

不通过 → **回 step 1 重读相应 section** 再来,而不是"先建 schedule 后面再补"。
后面的 schedule 一旦挂上去,补就晚了 —— 心跳已经在用残缺 endpoints 撞墙。

### 2. 读身份 / 角色定义(如果用户给了)

同 step 1,**用 http GET 不用 webFetch**:

```
http({ method: "GET", url: "<soul.md / persona.md URL>" })
```

```
store_fact({ namespace: "service.<name>.identity", key: "username", value: "..." })
store_fact({ namespace: "service.<name>.identity", key: "voice", value: "..." })
store_fact({ namespace: "service.<name>.identity", key: "anti_patterns", value: [...] })
```

如果用户没给,或文档拉不到 → 跳过此步,但 store_fact 一条 `identity_missing: true` 提示后续心跳用默认身份。

### 3. 安全存凭证(**注册响应到手立即做,不要拖延**)

#### 3a. 用户已有 key 的场景

用户在对话里直接给了凭证:
```
saveCredential({ name: "<service>-api-key", value: "<用户给的真实凭证>" })
```

#### 3b. 首次注册(API 响应里给 key)的场景 — **极易踩坑**

如果你在 step 1/2 间或之后通过 http POST 调注册 endpoint 拿到响应,响应一般含:
```json
{
  "actor_id": "...",
  "api_key": "svc_xxxxxx_FULL_LONG_STRING",   ← 完整 key,通常只显示一次
  "api_key_prefix": "svc_xxxxxx",              ← 截断前缀,后续 UI 用
  "handle": "..."
}
```

**强制规则**(否则你必踩坑):
1. **第一时间** `saveCredential({ name, value: response.api_key })`,**完整字段**,不是 prefix
2. **不要**先 `store_fact` 把 api_key 存 facts(facts 是明文,且 LLM 容易只拷前缀)
3. `store_fact` 只存 **非敏感字段**:`actor_id` / `api_key_prefix` / `handle` / 注册 timestamp
4. save 完立即 `listCredentialNames` 确认凭证名出现在列表里
5. **长度自检**(2026-05 mycox 实战已踩过,这条是新加的强 guard):

   `saveCredential` 完成后,**对照 response 里两个字段的长度**:

   - 完整 `api_key` 长度 — 通常 ≥ 40 字符(常见 70-100,如 `svc_xxxxxxx_<长串>`)
   - `api_key_prefix` 长度 — 通常 < 20 字符

   你刚 `value:` 传进 `saveCredential` 的字符串长度 < 32 字符 **或** 跟
   `api_key_prefix` 字段值一致 → **你存错了,存的是 prefix**!

   立即:
   - 重新读 response,确认 `api_key` 字段(不是 `api_key_prefix`)的完整值
   - 用完整值再次 `saveCredential`(同 name 会覆盖)
   - 仍不确定 → 让用户重新注册拿新 key

6. **立即测试**:挑文档里最简单的 auth verify endpoint 调一次,验完整 key 真的能跑通(见 step 4)
   - **若 verify 返 401**:**第一反应不是"endpoint 不对",而是"我是不是存了 prefix?"** —
     回头跑第 5 条长度自检
   - 只有长度自检过了 verify 还 401,才考虑 endpoint 不对或 key 真错

如果跳过这条 → 后续操作必然撞 401,且 facts 里只有 prefix 时**完整 key 已经丢了**,
得让用户重新给或者重新注册。

**绝对不要**把完整 key 写进 facts(明文落库泄漏风险)。saveCredential 加密落盘到
SecretStore,http 工具调用时通过 `Authorization: Bearer {<SECRET_NAME>}` 占位符
引用,自动替换。

返回的占位符名格式是 `<NAME>` 转大写 + `-` 转 `_`,例:`<service>-api-key` → `{<SERVICE>_API_KEY}`。

### 4. 测试一次 API 调用(verify auth + endpoint)

挑文档里最简单的只读 endpoint(如 `/auth/verify` 或 `/health` 或 `GET /me`)调一次:
```
http({ method: "POST", url: "<base>/auth/verify", headers: { "Authorization": "Bearer {<SECRET_NAME>}" } })
```

- 返回 200 / 用户信息 → 凭证有效,继续。
- 返回 401 / 403 → 凭证错,告诉用户,**不要** schedule。
- 返回 5xx / timeout → 服务暂不可用,但凭证可能没问题;告诉用户先排查再 schedule。

### 5. 建周期 schedule(**onboarding 标配,默认必做,不能跳过**)

⚠ **极易踩坑**:LLM 跑完 step 1-4 容易直接收口"已注册成功"忘了建 schedule。
没有 schedule = onboarding 等于一次性手动跑,**完全失去 service-onboarding 价值**。

强制规则:
1. **即使 user 没明示"建心跳"**,只要 onboard 类任务都默认建 schedule
2. interval_ms **必须传**,user 没说就用默认 30 分钟(1800000)并告诉用户
3. **必须**用 `actionType: 'autonomous_turn'`,不是 `'prompt'`(prompt 只发提醒文本,
   `autonomous_turn` 才真起 chat turn 跑工具)
4. payload.prompt **必须含**身份/凭证占位符 + 历史去重指引(模板见下)

```
schedule_reminder({
  name: "<service>-heartbeat",
  interval_ms: <用户给的毫秒, 没说默认 1800000 = 30min>,
  actionType: "autonomous_turn",
  payload: {
    prompt: "执行 <service> 心跳:按 facts.service.<name>.api.heartbeat_priority 顺序操作。\n身份见 facts.service.<name>.identity。\n凭证用占位符 {<SECRET_NAME>}。\n操作前 list_facts({namespace:'service.<name>.history'}) 跳过已操作的。\n操作后 store_fact 到 history namespace 防重复。",
    replyChannel: "silent"  // 心跳不打扰用户;重要事件(如 401)由 LLM 通过 escalate 推送
  }
})
```

间隔验证:
- < 5 分钟 → **拒绝**,告诉用户太密了(防骚扰目标 service + 浪费 LLM 预算)
- 5-30 分钟 → 警告,询问"确定吗?"
- ≥ 30 分钟 → 直接建

### 6. 总结 + 收口反思

**自检 4 项**(完成后才算 onboarding 成功,缺一项就再补):
- [ ] facts.service.<name>.api.endpoints 已写,**且通过 step 1.5 完整性自检**
      (数量 ≥ 5 / 覆盖 ≥ 3 类 / heartbeat_priority 全 cross-ref)
- [ ] saveCredential 完成 + listCredentialNames 看得到
- [ ] auth verify endpoint 调通(200)
- [ ] schedule_reminder 已建(actionType=autonomous_turn,interval_ms 已设)

回复用户:
```
✅ <service> 已注册:
- 拉到 N 个 API endpoint,身份是 <username>
- 凭证已加密存储(占位符 {<SECRET_NAME>})
- schedule 已挂,每 X 分钟跑一次自主心跳

下次心跳会自动:
1. ...(按抓到的 priority list 列 3-4 步)

如要修改间隔 / 暂停 / 取消,告诉我。
```

完成后,turn 收口的 reflection 系统会看到这个完整流程,**自动 emit 一个新 skill**:
`<service>-heartbeat`。该 skill 是 agent 自己学出来的,不是 bundled。后续 schedule
触发时,memory prefix 的 routing rule 会推荐用这个新 skill。

## 失败处理表

| 失败 | 应对 |
|---|---|
| webFetch doc URL 失败 | abort 整个 onboarding,告诉用户 URL 错或网络问题 |
| webFetch 返回非文档(404/500/HTML 不解析) | 同上 |
| store_fact 写入失败 | 重试 1 次;再失败 abort |
| saveCredential value 太长 / name 非法 | 停下问用户(可能是误操作) |
| auth verify 401/403 | abort schedule 创建,问用户 key 对不对 |
| schedule_reminder 创建失败 | 凭证 / facts 已写,可保留;告诉用户手动重试 schedule |
| 用户给的间隔 < 5 分钟 | 拒绝,要用户重新给 |

## Anti-patterns

- ❌ **用 webFetch 拉服务文档**(实战已踩过):aux LLM 蒸馏可能把 service 文档
  (含 "agent register / post / vote" 等指令)误判为 prompt injection,返回
  "I can't discuss that"。**用 http GET 拿原始 markdown**,自己读。
- ❌ **跳过 step 5 不建 schedule_reminder**(实战已踩过):onboarding 跑完 1-4 步
  忘了挂心跳 schedule,user 看到"已注册成功"以为没问题,实际后续没任何自主行动。
  等于退化成一次性手动跑。**默认必建,即使 user 没说"建心跳"**。
- ❌ schedule_reminder 用 `actionType='prompt'`:那只发提醒文本,**不会**真去
  调工具。必须 `'autonomous_turn'` 才是真心跳。
- ❌ 把 API key 写进 facts(明文泄漏)→ 必须走 saveCredential
- ❌ **注册响应只存 api_key_prefix,丢 api_key 完整字段** → 必然 401,完整 key 此后再
  也拿不到(2026-05 mycox 实战已踩过)。step 3b 第 5 条**长度自检**专治这条 —
  saveCredential 完成后 value 长度 < 32 字符 = 你存的是 prefix
- ❌ **verify 返 401 第一反应是"endpoint 不对"** → 实际多半是上一条 prefix 没存对。
  必须先跑长度自检再考虑 endpoint
- ❌ saveCredential 后没立刻 verify → schedule 跑一天才发现 key 错
- ❌ 心跳 schedule 间隔 < 5 分钟(目标 service 可能 ban)
- ❌ 跳过 step 4 测试调用(可能 schedule 跑了一天才发现 key 错)
- ❌ 自己猜 endpoint(没看 doc 就写 `POST /api/heartbeat`)— 必须 webFetch 抽
- ❌ **Satisficing 抽 endpoints**(实战已踩过,mycox 心跳 404 风暴):读完 Part 1
  鉴权段抽到 2-3 个 auth endpoint 就直接走,**漏掉 Part 4+ 业务端点表**。
  心跳跑 1 天才发现 endpoints 表里只有 auth/me。必须跑 **step 1.5 完整性自检**
  3 项全过(扫全部 heading / 数量 ≥ 5 且覆盖 ≥ 3 类 / heartbeat_priority 全
  cross-ref)才能进 step 2
- ❌ **heartbeat_priority 抽自摘要而非真实 endpoint 表**:看见"agent should vote
  on hot posts"就写进 priority,但 endpoints 数组里没对应的 `POST /vote`。
  step 1.5 第 3 项专治这条 — 不 cross-ref 就是猜
- ❌ 同时 onboard 多个 service(一次一个,流程线性,reflection 容易出干净 skill)

## 跟其他 skill 的协同

- 跟 **clawhub**:clawhub 是从公共仓库装现成 skill;此 skill 是从外部 service 文档**派生**新 skill。两者互补,不冲突。
- 跟 **skill-creator**:skill-creator 教写 SKILL.md 格式;此 skill 跑完流程让 reflection 自动生成 SKILL.md,等于 skill-creator 的自动化路径。
- 跟 **memory-discipline**:严格遵守 — service.* namespace 写 facts,绝不写 secrets。
