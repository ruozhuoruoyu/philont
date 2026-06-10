---
name: complex-task-protocol
description: Standard protocol for complex tasks: self-assess slow → plan_draft to break into steps → plan_review to self-check gaps → execute plan_update_step → plan_close to wrap up. The mechanism layer enforces full completion; skipping will be rejected by plan_protocol_gate.
when_to_use: User provided a guide document / task has ≥ 5 steps / you previously got stuck on the same type of task / task has external API dependencies with inter-step dependencies. **Decision rule**: if your first reaction after seeing the task is "this needs to be broken into steps" → complex; "one tool call handles it" → simple.
version: 1.0.0
---

# Complex Task Protocol

## When to Use

- User provided a document/guide and the task requires running a multi-step flow following the document (e.g., mycox onboarding with 19 endpoints)
- Estimated tool calls ≥ 5
- Same task_signature that you've attempted before but never passed on the first try
- Task spans multiple tools/services with inter-step dependencies (e.g., must fetch token before calling API)
- High cost of failure (e.g., modifying production config / sending external messages to users / modifying the database)

## When NOT to Use

- Simple lookups (check weather / check time / check if file exists)
- Casual conversation / follow-up short answers
- Single tool call is sufficient (read one file / run one shell command)
- User is ping-pong debugging a single line of code with you → fast, don't invoke the protocol

## Core Principle

The failure mode for complex tasks: **LLMs tend to "just do it", and once they fail they retry from memory, hitting the same wall again and again**.
The protocol replaces this "optimism" with an explicit contract:

1. First **assess** complexity (task_mode_classify slow)
2. Then **break down** steps (plan_draft, each step verifiable)
3. Then **review** your own breakdown vs. the guide (plan_review, list gaps)
4. Then **execute** (plan_update_step with visible progress)
5. Stuck / failed → **revise plan** (plan_revise + review again), don't keep hitting the wall
6. Finally **close** (plan_close, triggers MECE solidification into a skill)

Mechanism-layer enforcement: slow mode + plan not yet reviewed → all other tools are disabled by `plan_protocol_gate`.
**Skipping plan_review and going straight to work = you will be rejected**.

## Action Templates (strictly follow this order)

### 1. Self-assess slow: `task_mode_classify({ mode: 'slow', reason })`

First step, and **only done at the start of a turn**. The reason must specifically explain why this is a complex task:

Good example: `"User provided the mycox guide with 19 endpoints, needs to be split into registration + heartbeat + diagnostics phases"`
Bad example: `"User's task"` (vague) / `"looks complex"` (no basis)

When in doubt, **default to slow**: the extra overhead is 5–10 tool calls; the cost of hitting a wall and retrying is an entire turn.

### 2. `plan_draft({ steps, task_signature, guide_ref })`

Break into steps; each step **starts with a verb in one sentence**, granularity = "the smallest unit that can be verified when done".

```json
{
  "steps": [
    { "description": "Call http GET /endpoints to extract endpoint list" },
    { "description": "Use saveCredential to store api_key credential" },
    { "description": "Call http POST /ping to verify token works" },
    { "description": "Write routing_rule so the same task type hits directly next time" }
  ],
  "task_signature": "mycox-onboarding",
  "guide_ref": "skill:service-onboarding"
}
```

**Bad examples** (will always fail during review):
- `[{ "description": "complete the task" }]` — granularity too coarse
- `[{ "description": "read doc" }, { "description": "call API" }]` — actions are vague
- Steps have dependencies but they aren't expressed (e.g., step 3 depends on the token obtained in step 1, but step 1 doesn't say "save token")

### 3. `plan_review({ plan_id, gaps, decision })`

**This is the core of the protocol**. Cross-reference with the guide / user's original words and **honestly list gaps**:

```json
{
  "plan_id": "<plan_id>",
  "gaps": [
    "Guide item 4 requires auto-pause after 3 heartbeat failures; my plan doesn't cover this",
    "step-2 lacks verification criteria (how do we know the credential was saved correctly? should add a verify call)"
  ],
  "decision": "pass"  // write pass even when gaps are non-empty, meaning "I see the gap, I know it needs to be addressed, but I choose to execute this version"
}
```

Or:

```json
{
  "plan_id": "<plan_id>",
  "gaps": [],
  "decision": "pass"  // I believe the plan covers all requirements and can proceed
}
```

**Key constraints**:
- gap=[] AND decision='pass' → plan → reviewed, **mechanism layer unlocks other tools**
- Either condition not met → plan stays draft, **must** plan_revise + review again before continuing
- **Can't find gaps but plan obviously has problems** (missed coverage / vague steps) → you're cutting corners. LLM common failure: rubber-stamping a checkbox. **Honesty is more important than "passing"**

### 4. Execute: `plan_update_step({ plan_id, step_id, status, evidence })`

Call with status='doing' when each step starts, call with status='done' + evidence when it completes.

```json
{ "plan_id": "...", "step_id": "step-1", "status": "doing" }
// call http tool to fetch endpoint
{ "plan_id": "...", "step_id": "step-1", "status": "done", "evidence": "fetch returned 200, 19 endpoints stored" }
```

**evidence must always be filled**: when distilling failed plans into playbooks, evidence is the key material. Empty evidence = the next time the same task signature comes up you'll have to figure it out from scratch again.

### 5. Stuck / Failed → `plan_revise({ plan_id, new_steps, reason })`

When the plan no longer works (wrong API path / wrong credential format / missed a line in the guide): **don't keep pushing**.
Call plan_revise to update steps; the plan automatically reverts to draft → plan_review again → must pass before continuing.

```json
{
  "plan_id": "...",
  "new_steps": [
    { "description": "step-3 changed to use /v2/ping (original /ping returns 404)" },
    ...
  ],
  "reason": "in-turn-reflection found /ping is deprecated in mycox v2, need to use /v2/ping"
}
```

### 6. `plan_close({ plan_id, outcome, summary })`

Call when fully complete or irrecoverably failed:

```json
{ "plan_id": "...", "outcome": "success", "summary": "19 endpoints registered successfully, heartbeat schedule is set up" }
// or
{ "plan_id": "...", "outcome": "failure", "summary": "heartbeat permanently 401, credential obtained is a prefix not the full key, user needs to provide it again" }
```

**effect** (triggered asynchronously by chat-handler):
- success → query SkillStore for same task_signature → match found: extend / no match: create new_skill
- failure → distill review_history + step evidence into a "failure mode playbook", so the next time the same task opens a turn you can see the lesson upfront

## Anti-Patterns

### ⚠ Skipping plan_review and directly calling http / shell
You will be rejected by `plan_protocol_gate`, then see an error message saying "must plan_review pass first". **Continuing to push is just wasting a turn**.

### ⚠ Listing empty gaps in plan_review when the plan obviously has problems
**Honesty is more important than "passing"**. The mechanism layer can't stop you, but the next time the same task fails, reflection will pull your review_history as a counter-example. The LLM's own integrity score is its own responsibility.

### ⚠ plan_close('success') but not all steps are done
The mechanism doesn't strictly check this (allows blocked steps + overall success), but when MECE solidifies, the skill sponsoring those steps will carry a "did not complete X" counter-example label. Recommendation: only use success when truly complete, otherwise failure.

### ⚠ Entering slow mode but abandoning it halfway through to chat
A plan in draft state under slow mode will continuously block tools. **If the user changes their mind mid-way, call task_mode_classify({ mode: 'fast' })** to proactively revert; the plan stays as a historical record.

## Boundaries with Other Skills

- **service-onboarding** is a skill for a specific scenario (credentials + heartbeat + schedule); this protocol is a meta-skill that can be layered on top:
  - User provides mycox guide → task_mode_classify('slow') → plan_draft incorporating service-onboarding steps into the plan → execute per plan
- **goal-driven-execution** emphasizes "what does done look like and how to verify"; this protocol **mechanizes** that idea (plan + review = an explicit contract for "what done looks like + how to verify it")
- **surgical-changes** emphasizes "only touch what needs to be touched"; this protocol emphasizes "draft before doing, track progress while doing". The two are orthogonal; both should be used for complex tasks

## Fallback Recovery

If you've been rejected by plan_protocol_gate multiple times and aren't sure how to get plan_review to pass:

1. Re-read the steps assembled in plan_draft and ask yourself "what evidence can I produce when each step is done?" Can't produce any = step is too vague, needs to be broken down further
2. Re-read the guide_ref (user's original words / SKILL.md), and for each item ask "which step in the plan covers this guide item?" Can't find a match = something was missed
3. Call plan_revise to update steps + write a reason explaining your findings → review again

If nothing works, call task_mode_classify('fast', reason='complexity assessment for this task was wrong, reverting') to exit the protocol — but **this is a failure signal**; reflection will record it, and the next time the same task_signature comes up you should get it right from the start.
