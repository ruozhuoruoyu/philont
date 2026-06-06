/**
 * Plan tools + task_mode_classify 测试
 *
 * 关注点:
 *   - task_mode_classify 写入 TaskModeStore + 拒绝非法输入
 *   - plan_draft / plan_review / plan_update_step / plan_revise / plan_close 端到端
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';
import {
  createPlanTools,
  createTaskModeTools,
  InMemoryTaskModeStore,
  PlanFileStore,
} from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(sessionId = 'sess-A', opts: { withPlanFiles?: boolean } = {}) {
  const memory = openMemoryDb(':memory:');
  let planFiles: PlanFileStore | undefined;
  let planFileBaseDir: string | undefined;
  if (opts.withPlanFiles) {
    planFileBaseDir = mkdtempSync(join(tmpdir(), 'philont-plantools-test-'));
    planFiles = new PlanFileStore({ baseDir: planFileBaseDir, runsKeep: 5 });
  }
  const tools = createPlanTools({
    plans: memory.plans,
    skills: memory.skills,
    getCurrentSessionId: () => sessionId,
    planFiles,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    memory,
    sessionId,
    planFiles,
    planFileBaseDir,
    drafts: byName.get('plan_draft')!,
    review: byName.get('plan_review')!,
    updateStep: byName.get('plan_update_step')!,
    revise: byName.get('plan_revise')!,
    close: byName.get('plan_close')!,
  };
}

/**
 * v19 helper:把 plan 的所有 step 标 done + 加 evidence。
 * 用于配合 plan_close('success') close-time 强校验(要求 step done + evidence)。
 */
async function markAllStepsDone(
  updateStep: { execute: (p: Record<string, unknown>) => Promise<{ success: boolean }> },
  planId: string,
  steps: { id: string }[],
  evidencePrefix = 'evidence-',
) {
  for (const s of steps) {
    await updateStep.execute({ plan_id: planId, step_id: s.id, status: 'doing' });
    await updateStep.execute({
      plan_id: planId,
      step_id: s.id,
      status: 'done',
      evidence: `${evidencePrefix}${s.id}`,
    });
  }
}

/**
 * M4 / Phase 11 spec-coverage helper(2026-05-15):
 * 标准最小 plan_draft 入参 — 基于 steps 自动生成 deliverables + covers。
 * 每个 step 对应一个 deliverable(id=`d${i+1}`,description 凑足 8 字 R2 阈值)。
 */
function specDraftArgs(opts: {
  steps: Array<{ description: string; id?: string }>;
  task_signature?: string;
  guide_ref?: string;
}): Record<string, unknown> {
  const deliverables = opts.steps.map((_, i) => ({
    id: `d${i + 1}`,
    description: `deliverable for step ${i + 1}`,
  }));
  const stepsWithCovers = opts.steps.map((s, i) => ({
    ...s,
    covers: [`d${i + 1}`],
  }));
  const out: Record<string, unknown> = {
    steps: stepsWithCovers,
    deliverables,
  };
  if (opts.task_signature) out.task_signature = opts.task_signature;
  if (opts.guide_ref) out.guide_ref = opts.guide_ref;
  return out;
}

/** plan_close 入参 helper:基于 deliverable ids 生成 deliverable_status。 */
function specCloseArgs(
  planId: string,
  deliverableCount: number,
  outcome: 'success' | 'failure',
  summary: string,
  status: 'done' | 'failed' | 'not-attempted' | 'partial' | 'skipped' =
    outcome === 'success' ? 'done' : 'failed',
): Record<string, unknown> {
  const ds: Record<string, string> = {};
  for (let i = 0; i < deliverableCount; i++) ds[`d${i + 1}`] = status;
  return { plan_id: planId, outcome, summary, deliverable_status: ds };
}

// ── task_mode_classify ──────────────────────────────────────────────

test('task_mode_classify: slow + reason 合法 → 写 store', async () => {
  const store = new InMemoryTaskModeStore();
  const tools = createTaskModeTools({
    store,
    getCurrentSessionId: () => 'sess-1',
  });
  const tool = tools[0];
  assert.equal(tool.name, 'task_mode_classify');
  const r = await tool.execute({ mode: 'slow', reason: '用户给了 19 个 endpoint guide' });
  assert.equal(r.success, true);
  assert.match(r.output ?? "", /slow/);
  assert.equal(store.get('sess-1'), 'slow');
  assert.equal(store.getLastReason('sess-1'), '用户给了 19 个 endpoint guide');
});

test('task_mode_classify: fast 模式默认值', () => {
  const store = new InMemoryTaskModeStore();
  assert.equal(store.get('any-session'), 'fast');
  assert.equal(store.getLastReason('any-session'), null);
});

test('task_mode_classify: 非法 mode 拒绝', async () => {
  const store = new InMemoryTaskModeStore();
  const tool = createTaskModeTools({ store, getCurrentSessionId: () => 's' })[0];
  const r = await tool.execute({ mode: 'medium', reason: 'x' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /必须是 'fast' 或 'slow'/);
});

test('task_mode_classify: 缺 reason 拒绝', async () => {
  const store = new InMemoryTaskModeStore();
  const tool = createTaskModeTools({ store, getCurrentSessionId: () => 's' })[0];
  const r = await tool.execute({ mode: 'slow', reason: '   ' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /reason 必填/);
});

test('InMemoryTaskModeStore: set 覆盖 + getLastReason', () => {
  const s = new InMemoryTaskModeStore();
  s.set('a', 'slow', '第一次');
  s.set('a', 'fast', '改回来');
  assert.equal(s.get('a'), 'fast');
  assert.equal(s.getLastReason('a'), '改回来');
});

// ── plan_draft ──────────────────────────────────────────────

test('plan_draft: 合法 steps 创建 + 提示下一步 plan_update_step', async () => {
  const { drafts, memory, sessionId } = setup();
  const r = await drafts.execute(specDraftArgs({
    steps: [
      { description: '调研工具' },
      { description: '运行测试' },
    ],
    task_signature: 'svc-onboarding',
    guide_ref: 'skill:service-onboarding',
  }));
  assert.equal(r.success, true);
  assert.match(r.output ?? "", /plan created/);
  // M2(2026-05-15)plan_review 删:下一步引导直接 plan_update_step
  assert.match(r.output ?? "", /plan_update_step/);
  const plans = memory.plans.listBySession(sessionId);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].steps.length, 2);
  assert.equal(plans[0].taskSignature, 'svc-onboarding');
  assert.equal(plans[0].guideRef, 'skill:service-onboarding');
});

test('plan_draft: steps 空 → 拒绝', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({ steps: [] });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /non-empty array/);
});

test('plan_draft: step.description 缺失 → 拒绝', async () => {
  const { drafts } = setup();
  // 直接传非法 steps,不走 helper(helper 会强加 description)
  const r = await drafts.execute({
    steps: [{ description: 'a' }, { foo: 'bar' }],
    deliverables: [{ id: 'd1', description: 'placeholder' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /description is required/);
});

// Phase 10 P0(2026-05-14):plan_draft 拦活 plan,强 LLM 改 plan_revise
test('plan_draft: 同 session 已有 draft plan → reject + 引导 plan_revise', async () => {
  const { drafts, memory, sessionId } = setup();
  // 先建一个 placeholder plan
  const placeholder = memory.plans.create({
    sessionId,
    steps: [{ description: 'understand' }],
    guideRef: 'https://mycox.ai/mycox/guide.md',
    taskSignature: 'auto-slow-test',
  });
  assert.equal(placeholder.status, 'draft');
  // 再调 plan_draft → 应该 reject
  const r = await drafts.execute(specDraftArgs({
    steps: [{ description: 'new step' }],
  }));
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /already exists/);
  assert.match(r.error ?? '', /plan_revise/);
  assert.match(r.error ?? '', new RegExp(placeholder.id));
  // 没新建
  const plans = memory.plans.listBySession(sessionId);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, placeholder.id);
});

test('plan_draft: 已有 executing plan → reject (M3 删 reviewed)', async () => {
  const { drafts, memory, sessionId } = setup();
  const existing = memory.plans.create({
    sessionId,
    steps: [{ description: 'x' }],
  });
  // M3(2026-05-15):'reviewed' 删,appendReview pass 直接进 executing
  memory.plans.appendReview(existing.id, { gaps: [], decision: 'pass' });
  const r = await drafts.execute(specDraftArgs({ steps: [{ description: 'new' }] }));
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /already exists/);
});

test('plan_draft: 已有 completed plan → 允许新建', async () => {
  const { drafts, memory, sessionId } = setup();
  const old = memory.plans.create({ sessionId, steps: [{ description: 'x' }] });
  memory.plans.close(old.id, 'success', 'done');
  const r = await drafts.execute(
    specDraftArgs({ steps: [{ description: 'brand new task' }] }),
  );
  assert.equal(r.success, true);
  const plans = memory.plans.listBySession(sessionId);
  assert.equal(plans.length, 2);
});

test('plan_draft: PHILONT_PLAN_DRAFT_REJECT_ACTIVE=0 → 关闭拦截', async () => {
  const orig = process.env.PHILONT_PLAN_DRAFT_REJECT_ACTIVE;
  process.env.PHILONT_PLAN_DRAFT_REJECT_ACTIVE = '0';
  try {
    const { drafts, memory, sessionId } = setup();
    memory.plans.create({ sessionId, steps: [{ description: 'old' }] });
    const r = await drafts.execute(
      specDraftArgs({ steps: [{ description: 'allow' }] }),
    );
    assert.equal(r.success, true);
    assert.equal(memory.plans.listBySession(sessionId).length, 2);
  } finally {
    if (orig === undefined) delete process.env.PHILONT_PLAN_DRAFT_REJECT_ACTIVE;
    else process.env.PHILONT_PLAN_DRAFT_REJECT_ACTIVE = orig;
  }
});

// ── plan_review 测试段已删(2026-05-15,M2 Phase 11)──────────────────
// plan_review tool 已删,改由 LLM 自反思 + reflection 蒸馏承担"review"语义。
// M4 加 spec-coverage R1-R5 结构强制后,plan_draft 入参校验替代 review 角色。

// ── plan_update_step ──────────────────────────────────────────────

test('plan_update_step: step 推进 + evidence 记录', async () => {
  // M2(2026-05-15)plan_review 删后,plan_update_step 直接对 draft plan 操作。
  // M3 状态机收紧后 draft + doing → executing 直跳;M2 中间态 plan.status
  // 暂留 draft,本测试只验 step.evidence + count 推进。
  const { drafts, updateStep, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [{ description: 'a' }, { description: 'b' }],
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;

  const r1 = await updateStep.execute({
    plan_id: planId,
    step_id: 'step-1',
    status: 'doing',
  });
  assert.equal(r1.success, true);
  assert.match(r1.output ?? "", /0\/2 done/);

  const r2 = await updateStep.execute({
    plan_id: planId,
    step_id: 'step-1',
    status: 'done',
    evidence: '跑通了',
  });
  assert.equal(r2.success, true);
  assert.match(r2.output ?? "", /1\/2 done/);
  assert.match(r2.output ?? "", /跑通了/);
});

test('plan_update_step: 非法 status 拒绝', async () => {
  const { drafts, updateStep, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  const r = await updateStep.execute({
    plan_id: planId,
    step_id: 'step-1',
    status: 'whatever' as any,
  });
  assert.equal(r.success, false);
});

test('plan_update_step: stepId 不存在 → 失败 + 列真实 step ids', async () => {
  const { drafts, updateStep, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [{ description: 'step alpha' }, { description: 'step beta' }],
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  const r = await updateStep.execute({
    plan_id: planId,
    step_id: 'step-99',
    status: 'doing',
  });
  assert.equal(r.success, false);
  // Phase 12 cont(2026-05-17):error 必须列出真实 step ids
  assert.match(r.error ?? '', /has no step/);
  assert.match(r.error ?? '', /step-1/);
  assert.match(r.error ?? '', /step-2/);
  assert.match(r.error ?? '', /step alpha|step beta/);  // 也带 description
});

test('plan_update_step: planId 不存在 → 明确错误', async () => {
  const { updateStep } = setup();
  const r = await updateStep.execute({
    plan_id: 'plan-nonexistent',
    step_id: 'step-1',
    status: 'doing',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /plan 'plan-nonexistent' does not exist/);
});

// ── plan_revise ──────────────────────────────────────────────

test('plan_revise: 改 steps + reason + 仍 draft + reviewHistory 加 revise 记录', async () => {
  const { drafts, revise, memory, sessionId } = setup();
  // 原 plan 1 个 deliverable d1
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;

  // 不传 new_deliverables → 沿用 d1;新 steps 必须 covers d1
  const r = await revise.execute({
    plan_id: planId,
    new_steps: [
      { description: 'a-改', covers: ['d1'] },
      { description: 'b-新', covers: ['d1'] },
    ],
    reason: '反思发现要补一步',
  });
  assert.equal(r.success, true);
  assert.match(r.output ?? "", /draft/);
  const p = memory.plans.get(planId)!;
  assert.equal(p.status, 'draft');
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[0].description, 'a-改');
  assert.equal(p.reviewHistory.at(-1)?.decision, 'revise');
});

test('plan_revise: 缺 reason 拒绝', async () => {
  const { drafts, revise, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  const r = await revise.execute({
    plan_id: planId,
    new_steps: [{ description: 'b', covers: ['d1'] }],
    reason: '',
  });
  assert.equal(r.success, false);
});

test('Phase 15.7 Fix Bug 2: plan_revise 缺 plan_id 自动 fallback 到 session active plan', async () => {
  const { drafts, revise, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const expectedPlan = memory.plans.listBySession(sessionId)[0];
  // 故意不传 plan_id,机制层应 fallback 到该 session 最近 active plan
  const r = await revise.execute({
    new_steps: [{ description: 'fallback test step', covers: ['d1'] }],
    reason: '测试 fallback',
  });
  assert.equal(r.success, true, 'fallback 应成功');
  const updated = memory.plans.listBySession(sessionId)[0];
  assert.equal(updated.id, expectedPlan.id);
  assert.equal(updated.steps.length, 1);
  assert.match(updated.steps[0].description, /fallback test step/);
});

test('Phase 15.7 Fix Bug 2: plan_revise 缺 plan_id + session 无 active plan → reject', async () => {
  const { revise } = setup();
  const r = await revise.execute({
    new_steps: [{ description: 'foo', covers: ['d1'] }],
    reason: '测试',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /plan_id is required/);
});

test('plan_revise: 已 closed plan 拒绝', async () => {
  const { drafts, revise, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  await close.execute(specCloseArgs(planId, 1, 'success', 'done'));
  const r = await revise.execute({
    plan_id: planId,
    new_steps: [{ description: 'b', covers: ['d1'] }],
    reason: '想再改',
  });
  assert.equal(r.success, false);
});

// ── plan_close ──────────────────────────────────────────────

test('plan_close: success → completed + MECE 固化提示', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute(specCloseArgs(planId, 1, 'success', '搞定 19 个 endpoint'));
  assert.equal(r.success, true);
  assert.match(r.output ?? "", /completed/);
  assert.match(r.output ?? "", /MECE/);
});

test('plan_close: failure → failed + 失败模式 playbook 提示', async () => {
  const { drafts, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [{ description: 'a' }],
    task_signature: 'heartbeat-401',
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  const r = await close.execute(specCloseArgs(planId, 1, 'failure', '心跳永久 401'));
  assert.equal(r.success, true);
  assert.match(r.output ?? "", /failed/);
  assert.match(r.output ?? "", /failure pattern playbook/);
});

test('plan_close: 二次 close 拒绝', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  await close.execute({ plan_id: planId, outcome: 'success', summary: 'a' });
  const r = await close.execute({ plan_id: planId, outcome: 'failure', summary: 'b' });
  assert.equal(r.success, false);
});

test('plan_close: 缺 summary 拒绝', async () => {
  const { drafts, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  const r = await close.execute(specCloseArgs(planId, 1, 'success', '   '));
  assert.equal(r.success, false);
});

// ── 端到端 ──────────────────────────────────────────────

test('端到端: slow turn 走完全程 draft→执行→close(M2 删 plan_review)', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();

  // 1. plan_draft
  const r1 = await drafts.execute(specDraftArgs({
    steps: [
      { description: '获取 token' },
      { description: '调 /me 验证' },
    ],
    task_signature: 'auth-flow',
  }));
  assert.equal(r1.success, true);
  const planId = memory.plans.listBySession(sessionId)[0].id;

  // 2. 直接执行(M2 删 plan_review;M3 状态机收紧后 draft+doing→executing 直跳)
  await updateStep.execute({ plan_id: planId, step_id: 'step-1', status: 'doing' });
  await updateStep.execute({
    plan_id: planId,
    step_id: 'step-1',
    status: 'done',
    evidence: 'token=xxx',
  });
  await updateStep.execute({ plan_id: planId, step_id: 'step-2', status: 'doing' });
  await updateStep.execute({
    plan_id: planId,
    step_id: 'step-2',
    status: 'done',
    evidence: '/me 返 200',
  });

  // 3. plan_close(2 deliverables)
  const r4 = await close.execute(specCloseArgs(planId, 2, 'success', 'auth flow 通'));
  assert.equal(r4.success, true);

  const final = memory.plans.get(planId)!;
  assert.equal(final.status, 'completed');
  assert.equal(final.steps.every((s) => s.status === 'done'), true);
});

// ── M5: MECE 固化(2026-05-11)──────────────────────────────────────────

test('plan_close success + 无 task_signature → 跳过 MECE 固化', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [{ description: 'a' }],
    // 无 task_signature
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute(specCloseArgs(planId, 1, 'success', 'done'));
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /skipped/);
  // 不应创建任何 skill
  assert.equal(memory.skills.search('done', 10).length, 0);
});

test('plan_close success + task_signature 未命中 → 新建 new_skill', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [
      { description: '注册 mycox' },
      { description: '调心跳' },
    ],
    task_signature: 'mycox-novel-task',
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }, { id: 'step-2' }]);
  const r = await close.execute(specCloseArgs(planId, 2, 'success', '注册并心跳通'));
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /created new skill/);
  const skill = memory.skills.getByName('mycox-novel-task-skill');
  assert.ok(skill);
  assert.equal(skill?.maturity, 'draft');
  assert.equal(skill?.source, `plan-success:${planId}`);
  assert.match(skill?.description ?? '', /注册并心跳通/);
});

test('plan_close success + task_signature 命中已有 skill → refined,不新建', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  // 先种一条同任务 skill
  memory.skills.createSkill({
    name: 'mycox-onboard-skill',
    description: '原 skill',
    whenToUse: '任务签名: mycox-onboard;当用户提出同类任务时套用',
    triggerKeywords: ['mycox', 'onboard'],
    actionTemplate: '原步骤',
    maturity: 'stable',
  });
  const beforeCount = memory.skills.search('mycox', 20).length;

  await drafts.execute(specDraftArgs({
    steps: [{ description: '新做法' }],
    task_signature: 'mycox-onboard',
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute(specCloseArgs(planId, 1, 'success', '又跑了一次'));
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /refined existing skill/);
  // 没新建第二条 skill
  const afterCount = memory.skills.search('mycox', 20).length;
  assert.equal(afterCount, beforeCount, '不应新建第二条 skill');
  // 现有 skill description 应被追加
  const existing = memory.skills.getByName('mycox-onboard-skill');
  assert.match(existing?.description ?? '', /又跑了一次/);
});

test('plan_close failure + task_signature → 写失败模式 playbook', async () => {
  const { drafts, revise, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [{ description: '原 plan' }],
    task_signature: 'broken-svc',
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  // 加一次 revise 让 reviewHistory 有内容
  await revise.execute({
    plan_id: planId,
    new_steps: [{ description: '改 plan', covers: ['d1'] }],
    reason: 'API 返 404',
  });

  const r = await close.execute(specCloseArgs(planId, 1, 'failure', 'API 永久不可用'));
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /failure pattern playbook/);
  // 找到这条 playbook
  const playbooks = memory.skills.listByMaturity('playbook', 20);
  const failure = playbooks.find((p) => p.source === `plan-failure:${planId}`);
  assert.ok(failure);
  assert.equal(failure?.kind, 'negative');
  assert.match(failure?.description ?? '', /API 永久不可用/);
  assert.match(failure?.description ?? '', /API 返 404/, '修订原因应在描述里');
});

test('plan_close: skills 未注入 → 跳过 MECE 但 plan 仍 close', async () => {
  const memory = openMemoryDb(':memory:');
  // 故意不传 skills
  const tools = createPlanTools({
    plans: memory.plans,
    getCurrentSessionId: () => 's',
  });
  const close = tools.find((t) => t.name === 'plan_close')!;
  const drafts = tools.find((t) => t.name === 'plan_draft')!;
  const updateStep = tools.find((t) => t.name === 'plan_update_step')!;

  await drafts.execute(specDraftArgs({
    steps: [{ description: 'a' }],
    task_signature: 'x',
  }));
  const planId = memory.plans.listBySession('s')[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute(specCloseArgs(planId, 1, 'success', 'ok'));
  assert.equal(r.success, true);
  assert.equal(memory.plans.get(planId)?.status, 'completed');
  // 不应有 MECE 行
  assert.doesNotMatch(r.output ?? '', /MECE/);
});

// ── SkillStore.findDuplicateCandidates 单测 ─────────────────────────────

test('SkillStore.findDuplicateCandidates: 高相似度命中', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'mycox-onboard-skill',
    description: 'x',
    whenToUse: '任务: mycox onboarding service register',
    triggerKeywords: [],
    actionTemplate: '',
    maturity: 'stable',
  });
  // 高相似度查询
  const dupes = skills.findDuplicateCandidates(
    'mycox-onboard-skill',
    '任务: mycox onboarding service register',
  );
  assert.ok(dupes.length >= 1);
  assert.equal(dupes[0].skill.name, 'mycox-onboard-skill');
  assert.ok(dupes[0].jaccard >= 0.5);
});

test('SkillStore.findDuplicateCandidates: 低相似度不返回', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'mycox-onboard-skill',
    description: 'x',
    whenToUse: '任务: mycox onboarding',
    triggerKeywords: [],
    actionTemplate: '',
    maturity: 'stable',
  });
  // 完全不同的 name + whenToUse
  const dupes = skills.findDuplicateCandidates(
    'pdf-to-word-skill',
    '任务: 文档格式转换 doc 转 word',
  );
  assert.equal(dupes.length, 0);
});

test('SkillStore.findDuplicateCandidates: 排除 deprecated 和 negative', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'mycox-deprecated',
    description: 'x',
    whenToUse: 'mycox onboarding deprecated',
    triggerKeywords: [],
    actionTemplate: '',
    maturity: 'deprecated',
  });
  skills.createSkill({
    name: 'mycox-negative',
    description: 'x',
    whenToUse: 'mycox onboarding negative',
    triggerKeywords: [],
    actionTemplate: '',
    maturity: 'stable',
    kind: 'negative',
  });
  const dupes = skills.findDuplicateCandidates(
    'mycox-onboard',
    'mycox onboarding general',
  );
  assert.equal(dupes.length, 0, 'deprecated 和 negative 不该参与候选');
});

// ── Phase 7 固化 2 配套:recovery-* 签名特判 ──────────────────────────────

test('plan_close: recovery-* 签名 + success → 走 negative playbook(不污染正向 skill)', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [{ description: 'diagnose' }],
    task_signature: 'recovery-abc12345',  // recovery-* 模拟 in-turn-reflection 自动创建
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute(specCloseArgs(planId, 1, 'success', '诊断完成,绕过失败模式'));
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /negative playbook|recovery/);
  // 不应创建正向 'recovery-abc12345-skill'(那是正常 path 会建的)
  const positive = memory.skills.getByName('recovery-abc12345-skill');
  assert.equal(positive, null, '不应创建正向 skill');
  // 应创建 playbook-recovery-* (negative)
  const playbooks = memory.skills.listByMaturity('playbook', 20);
  const recoveryPB = playbooks.find((p) => p.name.startsWith('playbook-recovery-'));
  assert.ok(recoveryPB, '应创建 negative playbook');
  assert.equal(recoveryPB?.kind, 'negative');
  assert.match(recoveryPB?.source ?? '', /^auto-recovery:/);
});

test('plan_close: recovery-* 签名 + failure → 也走 negative playbook', async () => {
  const { drafts, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [{ description: 'diagnose' }],
    task_signature: 'recovery-xyz789',
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  const r = await close.execute(specCloseArgs(planId, 1, 'failure', '诊断也失败了'));
  assert.equal(r.success, true);
  const playbooks = memory.skills.listByMaturity('playbook', 20);
  const recoveryPB = playbooks.find((p) => p.name === 'playbook-recovery-xyz789-failed');
  assert.ok(recoveryPB);
  assert.equal(recoveryPB?.kind, 'negative');
});

test('plan_close: 非 recovery- 签名 + success → 正常路径(正向 skill)', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({
    steps: [{ description: 'register' }],
    task_signature: 'mycox-onboarding',  // 正常 sig
  }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute(specCloseArgs(planId, 1, 'success', '完成'));
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /created new skill/);
  const skill = memory.skills.getByName('mycox-onboarding-skill');
  assert.ok(skill);
  assert.equal(skill?.kind, 'positive');
});

// ── v19 plan_review auto-gap-check + inner-loop 升级(2026-05-13)─────

// Phase 9.2 M1(2026-05-13)/ M2(2026-05-15)删除:auto-gap-check token coverage
// 路径已撤;v19 plan_review inner_iter / force-close 系列 5 个测试随 plan_review
// tool 一起删(M2 Phase 11)。inner_iter / outer_iter / appendReview API 在 M5
// 终态清理时删字段,中间态仍保留向后兼容。

// ── M4 / Phase 11 spec-coverage 测试(2026-05-15)─────────────────────────
// helper specDraftArgs / specCloseArgs 已移到顶部,基础测试可复用。

// ── R1-R5 单测:plan_draft 入参结构校验 ─────────────────────────────────

test('spec-coverage R1: 非占位 plan + deliverables 空 → reject', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: [] }],
    deliverables: [],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /deliverables\.length=0/);
});

test('spec-coverage R1: slow + deliverables.length=1 → reject(默认 MIN=2)', async () => {
  const memory = openMemoryDb(':memory:');
  const tools = createPlanTools({
    plans: memory.plans,
    skills: memory.skills,
    getCurrentSessionId: () => 'sess-slow',
    getIsSlow: () => true,
  });
  const drafts = tools.find((t) => t.name === 'plan_draft')!;
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: ['d1'] }],
    deliverables: [{ id: 'd1', description: 'deliverable 1' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /slow task requires at least/);
});

test('spec-coverage R2: deliverable.id 非 kebab → reject', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: ['Bad_ID'] }],
    deliverables: [{ id: 'Bad_ID', description: 'description here' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /is not kebab-case/);
});

test('spec-coverage R2: deliverable.id 在黑名单 → reject', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: ['task-done'] }],
    deliverables: [{ id: 'task-done', description: 'catch-all 走过场' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /blacklist/);
});

test('spec-coverage R2: deliverable.description < 8 字 → reject', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: ['d1'] }],
    deliverables: [{ id: 'd1', description: 'short' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /description length/);
});

test('spec-coverage R2: deliverable.id 重复 → reject', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: ['d1'] }],
    deliverables: [
      { id: 'd1', description: 'deliverable one' },
      { id: 'd1', description: 'deliverable two' },
    ],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /is duplicate/);
});

test('spec-coverage R3: step.covers 空 → reject', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: [] }],
    deliverables: [{ id: 'd1', description: 'deliverable one' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /has empty covers/);
});

test('spec-coverage R4: step.covers 引用未知 deliverable → reject', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: ['unknown'] }],
    deliverables: [{ id: 'd1', description: 'deliverable one' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /covers references unknown/);
});

test('spec-coverage R5: deliverable 无 step 覆盖 → reject', async () => {
  const { drafts } = setup();
  const r = await drafts.execute({
    steps: [{ description: 'a', covers: ['d1'] }],
    deliverables: [
      { id: 'd1', description: 'deliverable one' },
      { id: 'd2', description: 'deliverable two (uncovered)' },
    ],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /is not covered by any step/);
});

test('spec-coverage: 所有 R1-R5 通过 → 成功创建 plan', async () => {
  const { drafts, memory, sessionId } = setup();
  const r = await drafts.execute(
    specDraftArgs({ steps: [{ description: 'a' }, { description: 'b' }] }),
  );
  assert.equal(r.success, true);
  const plans = memory.plans.listBySession(sessionId);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].deliverables.length, 2);
  assert.equal(plans[0].steps[0].covers.length, 1);
});

// ── C1-C4 单测:plan_close deliverable_status 校验 ─────────────────────

test('spec-coverage C1: deliverable_status 缺 key → reject', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }, { description: 'b' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }, { id: 'step-2' }]);
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: 'done',
    deliverable_status: { d1: 'done' }, // 缺 d2
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /missing: \[d2\]/);
});

test('spec-coverage C1: deliverable_status 多 key → reject', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: 'done',
    deliverable_status: { d1: 'done', d_extra: 'done' },
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /extra: \[d_extra\]/);
});

test('spec-coverage C2: deliverable_status value 非法 → reject', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: 'done',
    deliverable_status: { d1: 'bogus' },
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /invalid status/);
});

test('spec-coverage C3: outcome=success + 有非 done/skipped → reject', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }, { description: 'b' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }, { id: 'step-2' }]);
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: 'mostly',
    deliverable_status: { d1: 'done', d2: 'partial' },
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /non-done\/skipped/);
});

test('spec-coverage C3: outcome=success + 全 done/skipped → pass', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }, { description: 'b' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }, { id: 'step-2' }]);
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: 'done + skipped',
    deliverable_status: { d1: 'done', d2: 'skipped' },
  });
  assert.equal(r.success, true);
  assert.equal(memory.plans.get(planId)?.status, 'completed');
});

test('spec-coverage C4: evidence 含 EXCEPTION + success → reject', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'step a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await updateStep.execute({ plan_id: planId, step_id: 'step-1', status: 'doing' });
  // 谎报:evidence 写 raw tool error,但声称 done + success
  await updateStep.execute({
    plan_id: planId,
    step_id: 'step-1',
    status: 'done',
    evidence: 'POST /api/auth/verify → EXCEPTION TypeError: fetch failed',
  });
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: '注册完成',
    deliverable_status: { d1: 'done' },
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /\[spec-coverage C4\]/);
  assert.match(r.error ?? '', /EXCEPTION/);
  assert.notEqual(memory.plans.get(planId)?.status, 'completed');
});

test('spec-coverage C4: evidence 含 fetch failed + success → reject', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'step a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await updateStep.execute({ plan_id: planId, step_id: 'step-1', status: 'doing' });
  await updateStep.execute({
    plan_id: planId,
    step_id: 'step-1',
    status: 'done',
    evidence: 'attempted register, fetch failed',
  });
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: 'done',
    deliverable_status: { d1: 'done' },
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /fetch failed/);
});

test('spec-coverage C4: evidence 干净 + success → 放行(无误报)', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'step a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await updateStep.execute({ plan_id: planId, step_id: 'step-1', status: 'doing' });
  await updateStep.execute({
    plan_id: planId,
    step_id: 'step-1',
    status: 'done',
    evidence: 'POST /register returned 200, account_id=abc123',
  });
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: '注册成功 account_id=abc123',
    deliverable_status: { d1: 'done' },
  });
  assert.equal(r.success, true);
  assert.equal(memory.plans.get(planId)?.status, 'completed');
});

test('spec-coverage C4: outcome=failure 不触发(允许 evidence 含错误词)', async () => {
  const { drafts, updateStep, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'step a' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await updateStep.execute({ plan_id: planId, step_id: 'step-1', status: 'doing' });
  await updateStep.execute({
    plan_id: planId,
    step_id: 'step-1',
    status: 'failed',
    evidence: 'POST /auth/verify EXCEPTION fetch failed after 3 retries',
  });
  // outcome=failure + status=failed → C3/C4 都不阻
  const r = await close.execute({
    plan_id: planId,
    outcome: 'failure',
    summary: '注册失败 — 网络异常 fetch failed',
    deliverable_status: { d1: 'failed' },
  });
  assert.equal(r.success, true);
  assert.equal(memory.plans.get(planId)?.status, 'failed');
});

test('spec-coverage C5: 全 not-attempted + success → 自动转 failure', async () => {
  const { drafts, close, memory, sessionId } = setup();
  await drafts.execute(specDraftArgs({ steps: [{ description: 'a' }, { description: 'b' }] }));
  const planId = memory.plans.listBySession(sessionId)[0].id;
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: 'tried nothing',
    deliverable_status: { d1: 'not-attempted', d2: 'not-attempted' },
  });
  // C3 会先拦 not-attempted ∉ {done, skipped},不进 C5 自动转换
  // (C5 设计是 C3 跳过的边缘场景兜底,实际 C3 已覆盖)
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /non-done\/skipped/);
  // 不应被 close
  assert.notEqual(memory.plans.get(planId)?.status, 'completed');
});

// ── plan_revise:占位转正 + new_deliverables ─────────────────────────────

test('plan_revise: 占位 plan(isPlaceholder=true)转正必须提供 new_deliverables', async () => {
  const memory = openMemoryDb(':memory:');
  const tools = createPlanTools({
    plans: memory.plans,
    skills: memory.skills,
    getCurrentSessionId: () => 'sess-rev',
  });
  const revise = tools.find((t) => t.name === 'plan_revise')!;
  // 直接通过 store 创建占位 plan(模拟 chat-handler 占位路径)
  const placeholder = memory.plans.create({
    sessionId: 'sess-rev',
    isPlaceholder: true,
    deliverables: [],
    steps: [{ description: 'placeholder', covers: [] }],
  });
  // revise 不提供 new_deliverables → reject
  const r = await revise.execute({
    plan_id: placeholder.id,
    new_steps: [{ description: 'real', covers: ['d1'] }],
    reason: '试图转正不提供 deliverables',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /non-empty new_deliverables/);
});

test('plan_revise: 占位 plan 提供 new_deliverables → 转正(isPlaceholder=false)', async () => {
  const memory = openMemoryDb(':memory:');
  const tools = createPlanTools({
    plans: memory.plans,
    skills: memory.skills,
    getCurrentSessionId: () => 'sess-rev2',
  });
  const revise = tools.find((t) => t.name === 'plan_revise')!;
  const placeholder = memory.plans.create({
    sessionId: 'sess-rev2',
    isPlaceholder: true,
    deliverables: [],
    steps: [{ description: 'placeholder', covers: [] }],
  });
  const r = await revise.execute({
    plan_id: placeholder.id,
    new_steps: [{ description: 'real step', covers: ['d1'] }],
    new_deliverables: [{ id: 'd1', description: 'first deliverable item' }],
    reason: '占位转正',
  });
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /转正/);
  const updated = memory.plans.get(placeholder.id)!;
  assert.equal(updated.isPlaceholder, false);
  assert.equal(updated.deliverables.length, 1);
});

test('plan_update_step: 占位 plan → reject(逼 plan_revise 转正)', async () => {
  const memory = openMemoryDb(':memory:');
  const tools = createPlanTools({
    plans: memory.plans,
    skills: memory.skills,
    getCurrentSessionId: () => 'sess-ph-up',
  });
  const updateStep = tools.find((t) => t.name === 'plan_update_step')!;
  const placeholder = memory.plans.create({
    sessionId: 'sess-ph-up',
    isPlaceholder: true,
    deliverables: [],
    steps: [{ description: 'placeholder step', covers: [] }],
    guideRef: 'https://example.com/guide.md',
  });
  const stepId = placeholder.steps[0].id;
  const r = await updateStep.execute({
    plan_id: placeholder.id,
    step_id: stepId,
    status: 'doing',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /[Pp]laceholder plan/);
  assert.match(r.error ?? '', /plan_revise/);
  // guide_ref 是 URL → 提示 webFetch
  assert.match(r.error ?? '', /webFetch/);
  // plan 状态保持 draft(没被推到 executing)
  const after = memory.plans.get(placeholder.id)!;
  assert.equal(after.status, 'draft');
});

test('plan_close: 占位 plan + success → reject(允许 failure 兜底)', async () => {
  const memory = openMemoryDb(':memory:');
  const tools = createPlanTools({
    plans: memory.plans,
    skills: memory.skills,
    getCurrentSessionId: () => 'sess-ph-close',
  });
  const close = tools.find((t) => t.name === 'plan_close')!;
  const placeholder = memory.plans.create({
    sessionId: 'sess-ph-close',
    isPlaceholder: true,
    deliverables: [],
    steps: [{ description: 'placeholder', covers: [] }],
  });
  // success → reject
  const rs = await close.execute({
    plan_id: placeholder.id,
    outcome: 'success',
    summary: '占位 plan 全步走完',
    deliverable_status: {},
  });
  assert.equal(rs.success, false);
  assert.match(rs.error ?? '', /[Pp]laceholder plan/);
  assert.match(rs.error ?? '', /plan_revise/);
  // 状态保持 draft(没被推到 completed)
  assert.equal(memory.plans.get(placeholder.id)!.status, 'draft');

  // failure → 放行(允许收尾承认未执行)
  const rf = await close.execute({
    plan_id: placeholder.id,
    outcome: 'failure',
    summary: '占位 plan 实际未执行,失败收尾',
    deliverable_status: {},
  });
  assert.equal(rf.success, true);
  assert.equal(memory.plans.get(placeholder.id)!.status, 'failed');
});

// ── Phase 13 PlanFileStore hook 集成 ─────────────────────────────────

test('Phase 13: plan_draft 不传 persist → 不开 plan.md', async () => {
  const { drafts, planFiles } = setup('sess-pf', { withPlanFiles: true });
  await drafts.execute(specDraftArgs({
    steps: [{ description: 'do a' }],
  }));
  // planFiles 在但没有 project 创建
  assert.deepEqual(planFiles!.list(), []);
});

test('Phase 13: plan_draft persist:true + project → 创建 plan.md', async () => {
  const { drafts, planFiles, planFileBaseDir, memory, sessionId } = setup(
    'sess-pf',
    { withPlanFiles: true },
  );
  await drafts.execute({
    ...specDraftArgs({ steps: [{ description: 'register account' }] }),
    project: 'mycox',
    persist: true,
  });
  const plan = memory.plans.listBySession(sessionId)[0];
  assert.equal(plan.persistedTo, 'mycox');
  assert.deepEqual(planFiles!.list(), ['mycox']);
  const md = planFiles!.getMarkdown('mycox')!;
  assert.match(md, /## Goal/);
  assert.match(md, /\*\*d1\*\*: deliverable for step 1/);
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 13: plan_draft persist:true + 无 project → fallback task_signature', async () => {
  const { drafts, planFiles, planFileBaseDir, memory, sessionId } = setup(
    'sess-pf',
    { withPlanFiles: true },
  );
  await drafts.execute({
    ...specDraftArgs({
      steps: [{ description: 'do a' }],
      task_signature: 'pdf-batch',
    }),
    persist: true,
  });
  const plan = memory.plans.listBySession(sessionId)[0];
  assert.equal(plan.persistedTo, 'pdf-batch');
  assert.ok(planFiles!.getMarkdown('pdf-batch'));
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 13: plan_draft persist:true + 无 project + 无 task_signature → reject', async () => {
  const { drafts } = setup('sess-pf', { withPlanFiles: true });
  const r = await drafts.execute({
    ...specDraftArgs({ steps: [{ description: 'do a' }] }),
    persist: true,
    // 无 project,无 task_signature
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /at least one of project or task_signature/);
});

test('Phase 13: 非法 project 名 reject', async () => {
  const { drafts } = setup('sess-pf', { withPlanFiles: true });
  const r = await drafts.execute({
    ...specDraftArgs({ steps: [{ description: 'do a' }] }),
    project: 'My_Cox',  // 含大写 + 下划线
    persist: true,
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /kebab-case/);
});

test('Phase 13: plan_close success → planFiles.appendRun', async () => {
  const { drafts, updateStep, close, planFiles, planFileBaseDir, memory, sessionId } = setup(
    'sess-pf',
    { withPlanFiles: true },
  );
  await drafts.execute({
    ...specDraftArgs({ steps: [{ description: 'do a' }] }),
    project: 'mycox',
    persist: true,
  });
  const planId = memory.plans.listBySession(sessionId)[0].id;
  await markAllStepsDone(updateStep, planId, [{ id: 'step-1' }]);
  const r = await close.execute({
    plan_id: planId,
    outcome: 'success',
    summary: 'feed read x6,upvote x3 done',
    deliverable_status: { d1: 'done' },
  });
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /plan\.md: run written/);
  const md = planFiles!.getMarkdown('mycox')!;
  assert.match(md, /### Run 1/);
  assert.match(md, /ok/);
  assert.match(md, /feed read x6,upvote x3 done/);
  assert.match(md, /runs_completed: 1/);
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 13: plan_close failure → appendRun + appendLesson', async () => {
  const { drafts, close, planFiles, planFileBaseDir, memory, sessionId } = setup(
    'sess-pf',
    { withPlanFiles: true },
  );
  await drafts.execute({
    ...specDraftArgs({ steps: [{ description: 'do a' }] }),
    project: 'mycox',
    persist: true,
  });
  const planId = memory.plans.listBySession(sessionId)[0].id;
  const r = await close.execute({
    plan_id: planId,
    outcome: 'failure',
    summary: 'upvote 用 GET 失败 — 应该 POST',
    deliverable_status: { d1: 'failed' },
  });
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /lesson appended/);
  const md = planFiles!.getMarkdown('mycox')!;
  assert.match(md, /### Run 1.*failed/);
  assert.match(md, /upvote 用 GET 失败/);
  // Lesson 段也包含
  const lessonsBody = md.split('## Lessons')[1]?.split('## Recent')[0] ?? '';
  assert.match(lessonsBody, /upvote 用 GET 失败/);
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 13: plan_revise persist:true + project → 占位 plan 转正时落 plan.md', async () => {
  // 这是实战 bug 路径:LLM 不调 plan_draft,只走 plan_revise 转正占位
  const { revise, planFiles, planFileBaseDir, memory, sessionId } = setup(
    'sess-pf-revise',
    { withPlanFiles: true },
  );
  // 模拟 chat-handler auto-plan-on-slow 路径:直接 plans.create 占位
  const placeholder = memory.plans.create({
    sessionId,
    taskSignature: null,
    guideRef: 'https://mycox.ai/guide.md',
    isPlaceholder: true,
    steps: [{ description: 'placeholder' }],
    deliverables: [],
  });
  // LLM 调 plan_revise 转正 + 声明 persist
  const r = await revise.execute({
    plan_id: placeholder.id,
    project: 'mycox',
    persist: true,
    reason: '读了 guide 列出真实 deliverables',
    new_steps: [
      { description: 'register account', covers: ['d-register'] },
      { description: 'save credentials', covers: ['d-cred'] },
    ],
    new_deliverables: [
      { id: 'd-register', description: 'register and get actor_id' },
      { id: 'd-cred', description: 'save api_key to SecretStore' },
    ],
  });
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /plan\.md: project=mycox ready/);
  // DB 行 persistedTo 已更新
  const refreshed = memory.plans.get(placeholder.id)!;
  assert.equal(refreshed.persistedTo, 'mycox');
  // 文件存在 + 含 deliverables
  const md = planFiles!.getMarkdown('mycox');
  assert.ok(md, 'plan.md 应已创建');
  assert.match(md!, /\*\*d-register\*\*: register and get actor_id/);
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 13: plan_revise 不传 persist → 不动 persistedTo / 不开文件', async () => {
  const { revise, planFiles, planFileBaseDir, memory, sessionId } = setup(
    'sess-pf-no-revise',
    { withPlanFiles: true },
  );
  const placeholder = memory.plans.create({
    sessionId,
    isPlaceholder: true,
    steps: [{ description: 'p' }],
    deliverables: [],
  });
  const r = await revise.execute({
    plan_id: placeholder.id,
    reason: '转正',
    new_steps: [{ description: 'do', covers: ['d1'] }],
    new_deliverables: [{ id: 'd1', description: 'first deliverable item' }],
  });
  assert.equal(r.success, true);
  assert.doesNotMatch(r.output ?? '', /plan\.md/);
  assert.equal(memory.plans.get(placeholder.id)!.persistedTo, null);
  assert.deepEqual(planFiles!.list(), []);
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 13: plan_revise persist:true + 无 project + 无 task_signature → reject', async () => {
  const { revise, memory, sessionId } = setup('sess-pf-noproject', {
    withPlanFiles: true,
  });
  const placeholder = memory.plans.create({
    sessionId,
    isPlaceholder: true,
    steps: [{ description: 'p' }],
    deliverables: [],
    // 不传 taskSignature
  });
  const r = await revise.execute({
    plan_id: placeholder.id,
    persist: true,
    // 不传 project + plan 也无 task_signature
    reason: '转正',
    new_steps: [{ description: 'do', covers: ['d1'] }],
    new_deliverables: [{ id: 'd1', description: 'first deliverable item' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /at least one of project or current plan\.task_signature/);
});

test('Phase 13: plan_revise persist:true + plan 有 task_signature → fallback', async () => {
  const { revise, planFiles, planFileBaseDir, memory, sessionId } = setup(
    'sess-pf-fallback',
    { withPlanFiles: true },
  );
  const placeholder = memory.plans.create({
    sessionId,
    taskSignature: 'pdf-batch-job',
    isPlaceholder: true,
    steps: [{ description: 'p' }],
    deliverables: [],
  });
  const r = await revise.execute({
    plan_id: placeholder.id,
    persist: true, // 不传 project,用 task_signature
    reason: '转正',
    new_steps: [{ description: 'do', covers: ['d1'] }],
    new_deliverables: [{ id: 'd1', description: 'first deliverable item' }],
  });
  assert.equal(r.success, true);
  assert.equal(memory.plans.get(placeholder.id)!.persistedTo, 'pdf-batch-job');
  assert.ok(planFiles!.getMarkdown('pdf-batch-job'));
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 13: plan_revise 非法 project 名 → reject', async () => {
  const { revise, memory, sessionId } = setup('sess-pf-bad-name', {
    withPlanFiles: true,
  });
  const placeholder = memory.plans.create({
    sessionId,
    isPlaceholder: true,
    steps: [{ description: 'p' }],
    deliverables: [],
  });
  const r = await revise.execute({
    plan_id: placeholder.id,
    project: 'My_Cox', // 含大写 + 下划线
    persist: true,
    reason: '转正',
    new_steps: [{ description: 'do', covers: ['d1'] }],
    new_deliverables: [{ id: 'd1', description: 'first deliverable item' }],
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /kebab-case/);
});

test('Phase 13: 不传 planFiles deps → persisted plan 不破,无文件副作用', async () => {
  // 默认 setup 不带 planFiles
  const { drafts, close, updateStep, memory, sessionId } = setup('sess-no-pf');
  await drafts.execute({
    ...specDraftArgs({ steps: [{ description: 'do a' }] }),
    project: 'mycox',
    persist: true,
  });
  const plan = memory.plans.listBySession(sessionId)[0];
  assert.equal(plan.persistedTo, 'mycox'); // DB 还是记
  await markAllStepsDone(updateStep, plan.id, [{ id: 'step-1' }]);
  const r = await close.execute({
    plan_id: plan.id,
    outcome: 'success',
    summary: 'ok',
    deliverable_status: { d1: 'done' },
  });
  assert.equal(r.success, true);
  // output 不含 plan.md 行(没注入 store)
  assert.doesNotMatch(r.output ?? '', /plan\.md/);
});

// ── Phase 16 C6: operational-handoff 强制 ─────────────────────────────

test('Phase 16 C6: 持续性任务 + plan.md Operational Knowledge 空 → 拒 close success', async () => {
  const { drafts, updateStep, close, memory, sessionId, planFileBaseDir } = setup(
    'sess-c6',
    { withPlanFiles: true },
  );
  // step description 含 "schedule_reminder" 关键字 → 触发 C6 校验
  await drafts.execute({
    ...specDraftArgs({
      steps: [{ description: 'setup schedule_reminder for periodic check-in' }],
    }),
    project: 'mycox',
    persist: true,
  });
  const plan = memory.plans.listBySession(sessionId)[0];
  await markAllStepsDone(updateStep, plan.id, [{ id: 'step-1' }]);
  // plan.md Operational Knowledge 段仍空(LLM 没调 plan_knowledge)
  const r = await close.execute({
    plan_id: plan.id,
    outcome: 'success',
    summary: 'done',
    deliverable_status: { d1: 'done' },
  });
  assert.equal(r.success, false, 'C6 应拒');
  assert.match(r.error ?? '', /spec-coverage C6.*Operational Knowledge section is an empty skeleton/s);
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 16 C6: 持续性任务 + plan_knowledge 已写 → 允许 close success', async () => {
  const { drafts, updateStep, close, memory, sessionId, planFiles, planFileBaseDir } = setup(
    'sess-c6-ok',
    { withPlanFiles: true },
  );
  await drafts.execute({
    ...specDraftArgs({
      steps: [{ description: 'setup schedule_reminder for periodic check-in' }],
    }),
    project: 'mycox',
    persist: true,
  });
  const plan = memory.plans.listBySession(sessionId)[0];
  await markAllStepsDone(updateStep, plan.id, [{ id: 'step-1' }]);
  // 模拟 LLM 调 plan_knowledge 写入 endpoint
  planFiles!.appendKnowledge('mycox', 'POST /api/foo with auth header', 'endpoints');
  const r = await close.execute({
    plan_id: plan.id,
    outcome: 'success',
    summary: 'done',
    deliverable_status: { d1: 'done' },
  });
  assert.equal(r.success, true, 'C6 写过 endpoint 后应允许 close');
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 16 C6: 非持续性任务 + 空 Operational Knowledge → 仍允许 close', async () => {
  const { drafts, updateStep, close, memory, sessionId, planFileBaseDir } = setup(
    'sess-c6-onceonly',
    { withPlanFiles: true },
  );
  // step 不含持续性关键字 → C6 不触发
  await drafts.execute({
    ...specDraftArgs({ steps: [{ description: 'render report once' }] }),
    project: 'pdf-batch',
    persist: true,
  });
  const plan = memory.plans.listBySession(sessionId)[0];
  await markAllStepsDone(updateStep, plan.id, [{ id: 'step-1' }]);
  const r = await close.execute({
    plan_id: plan.id,
    outcome: 'success',
    summary: 'done',
    deliverable_status: { d1: 'done' },
  });
  assert.equal(r.success, true, '非持续性任务不受 C6 约束');
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});

test('Phase 16 C6: 持续性任务 + outcome=failure → 跳过 C6(失败收尾允许)', async () => {
  const { drafts, updateStep, close, memory, sessionId, planFileBaseDir } = setup(
    'sess-c6-fail',
    { withPlanFiles: true },
  );
  await drafts.execute({
    ...specDraftArgs({
      steps: [{ description: 'setup heartbeat with cron' }],
    }),
    project: 'mycox',
    persist: true,
  });
  const plan = memory.plans.listBySession(sessionId)[0];
  await markAllStepsDone(updateStep, plan.id, [{ id: 'step-1' }]);
  const r = await close.execute({
    plan_id: plan.id,
    outcome: 'failure',
    summary: 'failed at step',
    deliverable_status: { d1: 'failed' },
  });
  assert.equal(r.success, true, 'failure 收尾不该被 C6 拦');
  if (planFileBaseDir) rmSync(planFileBaseDir, { recursive: true, force: true });
});
