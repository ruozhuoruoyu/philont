/**
 * PlanStore 测试(v17 复杂任务协议)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

test('PlanStore: create 基本属性', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 'sess-1',
    taskSignature: 'pdf-to-word',
    steps: [
      { description: '调研 PDF 转 Word 工具' },
      { description: '尝试用 libreoffice 转' },
      { description: '验证输出文件大小' },
    ],
    guideRef: 'skill:pdf-to-word',
  });
  assert.equal(p.sessionId, 'sess-1');
  assert.equal(p.taskSignature, 'pdf-to-word');
  assert.equal(p.status, 'draft');
  assert.equal(p.steps.length, 3);
  assert.equal(p.steps[0].id, 'step-1');
  assert.equal(p.steps[0].status, 'pending');
  assert.equal(p.steps[0].evidence, null);
  assert.equal(p.steps[0].startedAt, null);
  assert.deepEqual(p.reviewHistory, []);
  assert.equal(p.guideRef, 'skill:pdf-to-word');
  assert.equal(p.outcomeSummary, null);
  assert.equal(p.completedAt, null);
});

test('PlanStore: create 自定义 step.id 保留', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 's',
    steps: [
      { id: 'discovery', description: 'a' },
      { description: 'b' }, // 自动 step-2
      { id: 'verify', description: 'c' },
    ],
  });
  assert.equal(p.steps[0].id, 'discovery');
  assert.equal(p.steps[1].id, 'step-2');
  assert.equal(p.steps[2].id, 'verify');
});

test('PlanStore: create 空 steps 拒绝', () => {
  const { plans } = openMemoryDb(':memory:');
  assert.throws(
    () => plans.create({ sessionId: 's', steps: [] }),
    /steps must be non-empty/,
  );
});

test('PlanStore: create 缺 sessionId 拒绝', () => {
  const { plans } = openMemoryDb(':memory:');
  assert.throws(
    () => plans.create({ sessionId: '', steps: [{ description: 'a' }] }),
    /sessionId is required/,
  );
});

test('PlanStore: get / listBySession', () => {
  const { plans } = openMemoryDb(':memory:');
  const p1 = plans.create({ sessionId: 's-A', steps: [{ description: 'x' }] });
  const p2 = plans.create({ sessionId: 's-A', steps: [{ description: 'y' }] });
  plans.create({ sessionId: 's-B', steps: [{ description: 'z' }] });

  assert.equal(plans.get(p1.id)?.id, p1.id);
  assert.equal(plans.get('no-such-id'), null);

  const aPlans = plans.listBySession('s-A');
  assert.equal(aPlans.length, 2);
  // ORDER BY created_at DESC → 最新优先
  assert.equal(aPlans[0].id, p2.id);
  assert.equal(aPlans[1].id, p1.id);

  assert.equal(plans.listBySession('s-none').length, 0);
});

test('PlanStore: listBySignature', () => {
  const { plans } = openMemoryDb(':memory:');
  plans.create({ sessionId: 's1', taskSignature: 'pdf-to-word', steps: [{ description: 'a' }] });
  plans.create({ sessionId: 's2', taskSignature: 'pdf-to-word', steps: [{ description: 'b' }] });
  plans.create({ sessionId: 's3', taskSignature: 'http-debug', steps: [{ description: 'c' }] });
  plans.create({ sessionId: 's4', steps: [{ description: 'd' }] }); // 无 signature

  assert.equal(plans.listBySignature('pdf-to-word').length, 2);
  assert.equal(plans.listBySignature('http-debug').length, 1);
  assert.equal(plans.listBySignature('nope').length, 0);
});

test('PlanStore: listByStatus', () => {
  const { plans } = openMemoryDb(':memory:');
  const p1 = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  const p2 = plans.create({ sessionId: 's', steps: [{ description: 'b' }] });
  const p3 = plans.create({ sessionId: 's', steps: [{ description: 'c' }] });

  plans.appendReview(p1.id, { gaps: [], decision: 'pass' });
  plans.close(p2.id, 'success', '搞定');
  // p3 保持 draft

  const drafts = plans.listByStatus('draft');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, p3.id);

  // M3(2026-05-15):'reviewed' 状态删,appendReview pass 直接进 'executing'
  const executing = plans.listByStatus('executing');
  assert.equal(executing.length, 1);
  assert.equal(executing[0].id, p1.id);

  const completed = plans.listByStatus('completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].id, p2.id);
});

test('PlanStore: appendReview pass+gap=[] → draft 转 reviewed', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  assert.equal(p.status, 'draft');

  const after = plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  assert.equal(after?.status, 'executing');
  assert.equal(after?.reviewHistory.length, 1);
  assert.equal(after?.reviewHistory[0].decision, 'pass');
  assert.deepEqual(after?.reviewHistory[0].gaps, []);
  assert.equal(after?.reviewHistory[0].reason, null);
  assert.ok(after?.reviewHistory[0].at);
});

test('PlanStore: appendReview gaps 非空 → 保持 draft', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  const after = plans.appendReview(p.id, {
    gaps: ['第 2 步未覆盖 guide 第 4 条', '验证步缺评判依据'],
    decision: 'pass',
  });
  assert.equal(after?.status, 'draft', 'gaps 非空不该放行');
  assert.equal(after?.reviewHistory[0].gaps.length, 2);
});

test('PlanStore: appendReview decision=revise → 保持 draft', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  const after = plans.appendReview(p.id, {
    gaps: [],
    decision: 'revise',
    reason: '我重新看了 guide,要拆 step',
  });
  assert.equal(after?.status, 'draft');
  assert.equal(after?.reviewHistory[0].decision, 'revise');
  assert.equal(after?.reviewHistory[0].reason, '我重新看了 guide,要拆 step');
});

test('PlanStore: appendReview 二次 pass 不退档已 reviewed 的 plan', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  // 模拟 LLM 又调了一次 plan_review (异常但应防御)
  const after = plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  assert.equal(after?.status, 'executing', '保持 reviewed,不会再变');
  assert.equal(after?.reviewHistory.length, 2);
});

test('PlanStore: updateStep doing → executing 直跳 自动转', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }, { description: 'b' }] });
  plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  assert.equal(plans.get(p.id)?.status, 'executing');

  const after = plans.updateStep(p.id, 'step-1', 'doing');
  assert.equal(after?.status, 'executing');
  assert.equal(after?.steps[0].status, 'doing');
  assert.ok(after?.steps[0].startedAt);
  assert.equal(after?.steps[0].completedAt, null);
  assert.equal(after?.steps[1].status, 'pending');
});

test('PlanStore: updateStep done 填 completedAt', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  plans.updateStep(p.id, 'step-1', 'doing');
  const after = plans.updateStep(p.id, 'step-1', 'done', 'evidence: 跑通了');
  assert.equal(after?.steps[0].status, 'done');
  assert.equal(after?.steps[0].evidence, 'evidence: 跑通了');
  assert.ok(after?.steps[0].completedAt);
  assert.ok(after?.steps[0].startedAt);
});

test('PlanStore: updateStep blocked 也填 completedAt', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  const after = plans.updateStep(p.id, 'step-1', 'blocked', '依赖外部服务');
  assert.equal(after?.steps[0].status, 'blocked');
  assert.ok(after?.steps[0].completedAt);
  assert.equal(after?.steps[0].evidence, '依赖外部服务');
});

test('PlanStore: updateStep 找不到 stepId → null', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  assert.equal(plans.updateStep(p.id, 'no-such-step', 'doing'), null);
});

test('PlanStore: updateStep 找不到 planId → null', () => {
  const { plans } = openMemoryDb(':memory:');
  assert.equal(plans.updateStep('no-such-plan', 'step-1', 'doing'), null);
});

test('PlanStore: revise 替换 steps + 追加 reason 记录 + 回 draft', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }, { description: 'b' }] });
  plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  plans.updateStep(p.id, 'step-1', 'doing');
  // 现在 status=executing

  const after = plans.revise(
    p.id,
    [
      { description: '改方法 1' },
      { description: '改方法 2' },
      { description: '改方法 3' },
    ],
    null,
    'in-turn-reflection 发现原方案在 API X 上失败',
  );
  assert.equal(after?.status, 'draft', 'revise 后回 draft 重新审');
  assert.equal(after?.steps.length, 3);
  assert.equal(after?.steps[0].description, '改方法 1');
  // 最后一条 review 是 revise
  const last = after?.reviewHistory.at(-1);
  assert.equal(last?.decision, 'revise');
  assert.equal(last?.reason, 'in-turn-reflection 发现原方案在 API X 上失败');
});

test('PlanStore: revise 已 completed 拒绝', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  plans.close(p.id, 'success', 'done');
  assert.equal(plans.revise(p.id, [{ description: 'new' }], null, 'try'), null);
});

test('PlanStore: revise 空 steps 拒绝', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  assert.throws(() => plans.revise(p.id, [], null, 'reason'), /newSteps must be non-empty/);
});

test('PlanStore: close success → completed + summary', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  const after = plans.close(p.id, 'success', '所有步骤完成,生成了 report.pdf');
  assert.equal(after?.status, 'completed');
  assert.equal(after?.outcomeSummary, '所有步骤完成,生成了 report.pdf');
  assert.ok(after?.completedAt);
});

test('PlanStore: close failure → failed', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  const after = plans.close(p.id, 'failure', '第 2 步外部 API 永久 401');
  assert.equal(after?.status, 'failed');
  assert.equal(after?.outcomeSummary, '第 2 步外部 API 永久 401');
});

test('PlanStore: close 已 closed → null(防误调)', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  plans.close(p.id, 'success', 'ok');
  assert.equal(plans.close(p.id, 'failure', 'try-again'), null);
});

test('PlanStore: updateStatus 直接设(管理 tool 用)', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  // M3(2026-05-15):'reviewed' 删,改测 draft → executing 直接设
  const after = plans.updateStatus(p.id, 'executing');
  assert.equal(after?.status, 'executing');
});

test('PlanStore: updateStatus 非法值抛错', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  assert.throws(() => plans.updateStatus(p.id, 'invalid' as any), /invalid status/);
});

test('PlanStore: delete / count', () => {
  const { plans } = openMemoryDb(':memory:');
  const p1 = plans.create({ sessionId: 's', steps: [{ description: 'a' }] });
  plans.create({ sessionId: 's', steps: [{ description: 'b' }] });
  assert.equal(plans.count(), 2);
  assert.equal(plans.delete(p1.id), true);
  assert.equal(plans.count(), 1);
  assert.equal(plans.delete('no-such-id'), false);
});

test('PlanStore: 完整生命周期 draft→executing→completed', () => {
  const { plans } = openMemoryDb(':memory:');
  // draft
  const p = plans.create({
    sessionId: 'sess',
    taskSignature: 'svc-onboarding',
    steps: [
      { description: '抽取 endpoint 列表' },
      { description: '保存 credential' },
      { description: '调通 ping' },
    ],
  });
  assert.equal(p.status, 'draft');

  // gap 第 1 次:不通过
  plans.appendReview(p.id, {
    gaps: ['缺第 4 步:写 routing rule'],
    decision: 'pass',
  });
  assert.equal(plans.get(p.id)?.status, 'draft');

  // revise
  plans.revise(
    p.id,
    [
      { description: '抽取 endpoint 列表' },
      { description: '保存 credential' },
      { description: '调通 ping' },
      { description: '写 routing rule' },
    ],
    null,
    '补 step-4',
  );
  // status 又回 draft
  assert.equal(plans.get(p.id)?.status, 'draft');

  // 第 2 次 review:pass
  plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  assert.equal(plans.get(p.id)?.status, 'executing');

  // 执行
  plans.updateStep(p.id, 'step-1', 'doing');
  assert.equal(plans.get(p.id)?.status, 'executing');
  plans.updateStep(p.id, 'step-1', 'done', '抽到 19 个 endpoint');
  plans.updateStep(p.id, 'step-2', 'doing');
  plans.updateStep(p.id, 'step-2', 'done', '存了 api_key');
  plans.updateStep(p.id, 'step-3', 'doing');
  plans.updateStep(p.id, 'step-3', 'done', 'ping 返 200');
  plans.updateStep(p.id, 'step-4', 'doing');
  plans.updateStep(p.id, 'step-4', 'done', 'rule#42 已写');

  // close
  const closed = plans.close(p.id, 'success', '4 步全跑通,routing rule 已落');
  assert.equal(closed?.status, 'completed');
  assert.ok(closed?.completedAt);
  assert.equal(closed?.steps.every((s) => s.status === 'done'), true);
  // 历史:[gap-fail, revise, gap-pass] = 3 条
  assert.equal(closed?.reviewHistory.length, 3);
});

// ── v19 inner_iter / outer_iter(双层 loop 计数器,2026-05-13)─────────

test('PlanStore: create 初始 innerIter=0 outerIter=0', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 's',
    steps: [{ description: 'a' }],
  });
  assert.equal(p.innerIter, 0);
  assert.equal(p.outerIter, 0);
});

test('PlanStore: appendReview 失败 → inner_iter +1', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 's',
    steps: [{ description: 'a' }],
  });
  const r1 = plans.appendReview(p.id, { gaps: ['缺步骤 X'], decision: 'revise' });
  assert.equal(r1?.innerIter, 1);
  assert.equal(r1?.status, 'draft');
  const r2 = plans.appendReview(p.id, { gaps: [], decision: 'revise' });
  assert.equal(r2?.innerIter, 2);
  const r3 = plans.appendReview(p.id, { gaps: ['仍缺'], decision: 'pass' });
  // gaps 非空 + pass 也算 fail(不是真 pass)
  assert.equal(r3?.innerIter, 3);
  assert.equal(r3?.status, 'draft');
});

test('PlanStore: appendReview pass(gaps=[] AND pass)→ inner_iter reset 0', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 's',
    steps: [{ description: 'a' }],
  });
  plans.appendReview(p.id, { gaps: ['gap1'], decision: 'revise' });
  plans.appendReview(p.id, { gaps: ['gap2'], decision: 'revise' });
  const before = plans.get(p.id);
  assert.equal(before?.innerIter, 2);
  const after = plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  assert.equal(after?.innerIter, 0);
  assert.equal(after?.status, 'executing');
});

test('PlanStore: bumpInnerIter / bumpOuterIter / resetInnerIter', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 's',
    steps: [{ description: 'a' }],
  });
  assert.equal(plans.bumpInnerIter(p.id), 1);
  assert.equal(plans.bumpInnerIter(p.id), 2);
  assert.equal(plans.bumpOuterIter(p.id), 1);
  const r = plans.resetInnerIter(p.id);
  assert.equal(r?.innerIter, 0);
  // outer_iter 不受 resetInnerIter 影响
  assert.equal(r?.outerIter, 1);
});

test('PlanStore: bump* 对不存在的 plan 返回 null', () => {
  const { plans } = openMemoryDb(':memory:');
  assert.equal(plans.bumpInnerIter('nope'), null);
  assert.equal(plans.bumpOuterIter('nope'), null);
  assert.equal(plans.resetInnerIter('nope'), null);
});

test('PlanStore: revise 不动 inner_iter(只重置 status)', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 's',
    steps: [{ description: 'a' }],
  });
  plans.appendReview(p.id, { gaps: ['gap1'], decision: 'revise' });
  const beforeRevise = plans.get(p.id);
  assert.equal(beforeRevise?.innerIter, 1);
  const afterRevise = plans.revise(
    p.id,
    [{ description: '改了' }],
    null,
    '按 review feedback 改',
  );
  assert.equal(afterRevise?.innerIter, 1, 'revise 不动 inner_iter');
  assert.equal(afterRevise?.status, 'draft');
});

test('PlanStore: 双层 loop 端到端 — outer 校验 reject 后回 inner', () => {
  const { plans } = openMemoryDb(':memory:');
  const p = plans.create({
    sessionId: 's',
    steps: [{ description: 'a' }, { description: 'b' }],
  });
  // inner 1:fail, fail, pass
  plans.appendReview(p.id, { gaps: ['x'], decision: 'revise' });
  plans.appendReview(p.id, { gaps: ['y'], decision: 'revise' });
  let plan = plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  assert.equal(plan?.status, 'executing');
  assert.equal(plan?.innerIter, 0);
  // outer 收口 reject:模拟 plan_close 强校验失败,bump outer + 强制回 inner
  assert.equal(plans.bumpOuterIter(p.id), 1);
  plans.updateStatus(p.id, 'draft'); // 状态回 draft 重新走 inner
  // inner 2:再 fail 一次然后 pass
  plans.appendReview(p.id, { gaps: ['仍缺'], decision: 'revise' });
  plan = plans.appendReview(p.id, { gaps: [], decision: 'pass' });
  assert.equal(plan?.status, 'executing');
  assert.equal(plan?.innerIter, 0, 'inner 在第二轮 pass 时重新 reset');
  assert.equal(plan?.outerIter, 1, 'outer 计数保留(不受 inner 影响)');
});
