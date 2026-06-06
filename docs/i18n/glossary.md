# Translation Glossary (ZH → EN canonical)

The authoritative terminology map. **Review/correct this first** — every other translation must use
these exact English terms so wording stays consistent across ~240 files. If a term here is wrong,
fixing it here fixes the whole rollout.

> Convention: identifiers (code names) are already English and unchanged. This table governs prose,
> comments, prompts, and user-facing strings.

## Core deep-exploration subsystem (deep_explore)

| 中文 | English | Notes |
|---|---|---|
| 深度探索 | deep exploration | the subsystem (renamed from 深度推理/"deep reasoning" — that collides with model-level o1/R1 reasoning). Code renamed: tool `deep_reason`→`deep_explore`, env `PHILONT_DEEP_REASON_*`→`PHILONT_DEEP_EXPLORE_*`, experimental-math action `explore`→`discover`. DB tables `reasoning_*` + `ReasoningStore` kept (internal, avoids a migration). |
| 推理树 | reasoning tree | |
| 子问题树 | subproblem tree | |
| 根命题 | root proposition | the goal claim at the tree root |
| 子目标 | subgoal | node kind `subgoal` |
| 引理 | lemma | node kind `lemma` |
| 构造 | construction | node kind `construction` |
| 反例 | counterexample | node kind `counterexample` |
| 猜想 | conjecture | node kind `conjecture` |
| 前提 / 已知前提 | assumption / known assumption | |
| frontier | frontier | keep English |
| 死胡同 | dead end | node status `dead_end` |
| 回溯记忆 | backtracking memory | `approaches_tried` |
| 证明 / 已证 | proof / proved | node status `proved` |
| 证伪 / 反驳 | refute / refuted | node status `refuted` |
| 收敛判定 | convergence check | `judgeConvergence` |
| 验证牙齿 | verifier (external verifier) | z3Verify / pariGp / skeptics — the components that can actually refute a false claim. "牙齿"=teeth/enforcement; keep the "teeth" metaphor only in prose, term is `verifier`. |
| 对抗验证 | adversarial verification | the skeptic pass |
| 审稿人 (skeptic) | reviewer (skeptic) | |
| 弃权 | abstain | unparseable skeptic verdict |
| 价值 / 估值 | value / valuation | LATS-style value score |
| 探索 (UCB) | exploration | UCB explore term |
| 技法 | technique | MAP-Elites behavior descriptor |
| 新颖度 | novelty | |
| 多样性档案 | diversity archive | MAP-Elites |
| 实验数学 | experimental mathematics | `explore` mode |
| 挂载点 | attach point | where conjectures hang on the tree |

## Agent loop / turn machinery

| 中文 | English | Notes |
|---|---|---|
| 回合 / turn | turn | keep `turn` |
| 自主回合 / 后台回合 | autonomous turn | `system:scheduled:*` |
| 子 loop / 子 turn | sub-loop / sub-turn | mini-agent-loop |
| 内驱 | intrinsic drive | the drives system (short form: "drive") |
| 诚实门 | honesty gate | HonestyGate |
| 完成宣言 | completion claim | a claim of being done |
| 兜底 / 兜底机制 | fallback / fallback mechanism | |
| 墙钟(预算) | wall-clock (budget) | |
| 孤儿循环 | orphan loop | un-aborted background loop |
| 急停 | kill switch / emergency stop | global stop |
| 时间线召回 | timeline recall | |
| 持久化 | persist / persistence | |
| 脚手架 | scaffolding | |
| 命门 | crux / lifeline | the core differentiator |

## Output / channel contract

| 中文 | English | Notes |
|---|---|---|
| 两段式 | two-section format | the reply contract |
| ## 给用户 | ## For User | **parsed heading** — flip in lockstep, parser already bilingual |
| ## 工作日志 | ## Work Log | **parsed heading** — same |
| 渠道 | channel | wechat / telegram / webui |
| 推送 | push | |
| 前端 | client / frontend | the user-facing terminal |

## Memory / research

| 中文 | English | Notes |
|---|---|---|
| 记忆 | memory | |
| 事实 | fact | `store_fact` |
| 笔记 | note | |
| 技能 | skill | |
| 主动研究 / 广度调研 | proactive research / breadth research | research_focus |
| 申请权限 | request a tool grant | |
| 授权 / 批准 | grant / approve | |
| 待批准 | pending approval | |
| 心跳 | heartbeat | periodic check-in schedule |

## Tools / policy

| 中文 | English | Notes |
|---|---|---|
| 工具白名单 | tool whitelist | |
| 能力矩阵 | capability matrix | policy layer |
| 只读 | read-only | |
| 安全沙箱 | security sandbox | |
| 验证 / 校验 | verify / validation | |
| 求解器 | solver | z3 |

## Do NOT translate

- Third-party / library / model names; attributions and cited authors.
- Quoted user content or example user utterances inside prompts (keep representative; may stay bilingual).
- `[[memory-link]]` slugs, env var names, code identifiers, file paths.
