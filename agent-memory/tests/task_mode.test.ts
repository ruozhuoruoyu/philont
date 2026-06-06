import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskModeTools,
  InMemoryTaskModeStore,
} from '../src/task_mode.js';

function setup(opts: {
  hasActive?: { id: string; status: string; reviewCount: number; updatedAt?: number } | null;
} = {}) {
  const store = new InMemoryTaskModeStore();
  const sessionId = 'sess-test';
  let getActivePlanCalled = 0;
  const tools = createTaskModeTools({
    store,
    getCurrentSessionId: () => sessionId,
    getActivePlan: () => {
      getActivePlanCalled++;
      if (!opts.hasActive) return null;
      // default updatedAt 到 now(active plan 都视为刚 update 过)
      return { updatedAt: Date.now(), ...opts.hasActive };
    },
  });
  const classify = tools[0];
  return { classify, store, sessionId, getActivePlanCalled: () => getActivePlanCalled };
}

test('task_mode_classify: fast → slow → fast 干净路径(无活 plan)', async () => {
  const { classify, store, sessionId } = setup();
  // 默认 fast
  assert.equal(store.get(sessionId), 'fast');
  // 设 slow
  const r1 = await classify.execute({ mode: 'slow', reason: 'complex task' });
  assert.equal(r1.success, true);
  assert.equal(store.get(sessionId), 'slow');
  // 回 fast(无活 plan → 允许)
  const r2 = await classify.execute({ mode: 'fast', reason: 'misclassified' });
  assert.equal(r2.success, true);
  assert.equal(store.get(sessionId), 'fast');
});

test('task_mode_classify: slow→fast 有活 draft plan → reject', async () => {
  const { classify, store, sessionId } = setup({
    hasActive: { id: 'plan-abc', status: 'draft', reviewCount: 3 },
  });
  // 先 slow
  await classify.execute({ mode: 'slow', reason: 'complex' });
  assert.equal(store.get(sessionId), 'slow');
  // 想回 fast → reject
  const r = await classify.execute({ mode: 'fast', reason: '想绕协议' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /task_mode_lock/);
  assert.match(r.error ?? '', /plan-abc/);
  assert.match(r.error ?? '', /plan_close/);
  // mode 没变
  assert.equal(store.get(sessionId), 'slow');
});

// M3(2026-05-15):'reviewed' 状态删,此 case 改测 draft 活 plan(reject 同款)
test('task_mode_classify: slow→fast 有活 draft plan → reject', async () => {
  const { classify } = setup({
    hasActive: { id: 'p', status: 'draft', reviewCount: 1 },
  });
  await classify.execute({ mode: 'slow', reason: 'x' });
  const r = await classify.execute({ mode: 'fast', reason: 'try' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /task_mode_lock/);
});

test('task_mode_classify: slow→fast 有活 executing plan → reject', async () => {
  const { classify } = setup({
    hasActive: { id: 'p', status: 'executing', reviewCount: 2 },
  });
  await classify.execute({ mode: 'slow', reason: 'x' });
  const r = await classify.execute({ mode: 'fast', reason: 'try' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /task_mode_lock/);
});

test('task_mode_classify: fast→slow 不检查活 plan(只反向锁)', async () => {
  const { classify, store, sessionId, getActivePlanCalled } = setup({
    hasActive: { id: 'p', status: 'draft', reviewCount: 0 },
  });
  // fast→slow,有活 plan 也不该 reject
  const r = await classify.execute({ mode: 'slow', reason: 'complex' });
  assert.equal(r.success, true);
  assert.equal(store.get(sessionId), 'slow');
  // getActivePlan 不该被调用(只 slow→fast 路径才查)
  assert.equal(getActivePlanCalled(), 0);
});

test('task_mode_classify: slow→fast 无活 plan → 允许', async () => {
  const { classify, store, sessionId } = setup({ hasActive: null });
  await classify.execute({ mode: 'slow', reason: 'x' });
  const r = await classify.execute({ mode: 'fast', reason: 'now simple' });
  assert.equal(r.success, true);
  assert.equal(store.get(sessionId), 'fast');
});

test('task_mode_classify: PHILONT_TASK_MODE_LOCK_ON_PLAN=0 → 关闭拦截', async () => {
  const orig = process.env.PHILONT_TASK_MODE_LOCK_ON_PLAN;
  process.env.PHILONT_TASK_MODE_LOCK_ON_PLAN = '0';
  try {
    const { classify, store, sessionId } = setup({
      hasActive: { id: 'p', status: 'draft', reviewCount: 0 },
    });
    await classify.execute({ mode: 'slow', reason: 'x' });
    const r = await classify.execute({ mode: 'fast', reason: 'force' });
    assert.equal(r.success, true);
    assert.equal(store.get(sessionId), 'fast');
  } finally {
    if (orig === undefined) delete process.env.PHILONT_TASK_MODE_LOCK_ON_PLAN;
    else process.env.PHILONT_TASK_MODE_LOCK_ON_PLAN = orig;
  }
});

// Phase 12(2026-05-17):删除 60s 冷却窗口,改纯派生于 plan 状态。
// failed/completed 是终态 → 任务已结束 → 允许 slow→fast,无冷却。
test('task_mode_classify: plan close failed → 允许 slow→fast(无冷却)', async () => {
  const { classify, store, sessionId } = setup({
    hasActive: {
      id: 'p',
      status: 'failed',
      reviewCount: 7,
      updatedAt: Date.now() - 5_000, // 5 秒前刚 close — 老逻辑会 reject,新逻辑放
    },
  });
  await classify.execute({ mode: 'slow', reason: 'x' });
  const r = await classify.execute({ mode: 'fast', reason: 'plan 失败,新任务' });
  assert.equal(r.success, true);
  assert.equal(store.get(sessionId), 'fast');
});

test('task_mode_classify: plan close completed → 允许 slow→fast(无冷却)', async () => {
  const { classify, store, sessionId } = setup({
    hasActive: {
      id: 'p',
      status: 'completed',
      reviewCount: 3,
      updatedAt: Date.now() - 1_000, // 1s 前刚 close — 老逻辑会 reject,新逻辑放
    },
  });
  await classify.execute({ mode: 'slow', reason: 'x' });
  const r = await classify.execute({ mode: 'fast', reason: '任务完成,切回 fast' });
  assert.equal(r.success, true);
  assert.equal(store.get(sessionId), 'fast');
});

test('task_mode_classify: getActivePlan 未注入 → 不检查(向后兼容)', async () => {
  const store = new InMemoryTaskModeStore();
  const sessionId = 'sess-x';
  const tools = createTaskModeTools({
    store,
    getCurrentSessionId: () => sessionId,
    // 不传 getActivePlan
  });
  const classify = tools[0];
  await classify.execute({ mode: 'slow', reason: 'x' });
  const r = await classify.execute({ mode: 'fast', reason: 'try' });
  // 没探针 → 允许回退(向后兼容)
  assert.equal(r.success, true);
});
