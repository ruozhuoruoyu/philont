/**
 * Phase 6:ScheduleStore + scheduler 测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, startScheduler, computeNextRun } from '../src/index.js';
import type { Schedule } from '../src/index.js';

test('computeNextRun: interval 表达式', () => {
  assert.equal(computeNextRun('interval:60000', 1000), 61000);
  assert.equal(computeNextRun(null, 1000), null);
  assert.equal(computeNextRun('cron:* * * *', 1000), null);
  assert.equal(computeNextRun('interval:0', 1000), null);
});

test('ScheduleStore: create + get', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: '每日反思',
    nextRunAt: 1000,
    actionType: 'reflect',
    payload: { sessionId: 's1' },
  });

  const got = schedules.get(s.id);
  assert.ok(got);
  assert.equal(got.name, '每日反思');
  assert.equal(got.actionType, 'reflect');
  assert.deepEqual(got.payload, { sessionId: 's1' });
  assert.equal(got.enabled, true);
});

test('ScheduleStore: invalid action_type 拒绝', () => {
  const { schedules } = openMemoryDb(':memory:');
  assert.throws(
    () =>
      schedules.create({
        name: 'bad',
        nextRunAt: 0,
        actionType: 'nuke' as any,
        payload: {},
      }),
    /action_type/
  );
});

test('ScheduleStore: invalid cron_expr 拒绝', () => {
  const { schedules } = openMemoryDb(':memory:');
  assert.throws(
    () =>
      schedules.create({
        name: 'bad',
        cronExpr: 'nonsense',
        nextRunAt: 0,
        actionType: 'reflect',
        payload: {},
      }),
    /cron_expr/
  );
});

test('dueBefore: 只返回 enabled 且到期', () => {
  const { schedules } = openMemoryDb(':memory:');
  schedules.create({
    name: 'past',
    nextRunAt: 500,
    actionType: 'prompt',
    payload: {},
  });
  schedules.create({
    name: 'future',
    nextRunAt: 5000,
    actionType: 'prompt',
    payload: {},
  });
  const disabled = schedules.create({
    name: 'past-disabled',
    nextRunAt: 100,
    actionType: 'prompt',
    payload: {},
  });
  schedules.setEnabled(disabled.id, false);

  const due = schedules.dueBefore(1000);
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'past');
});

test('markRun: 一次性任务触发后 enabled=false', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: 'one-shot',
    nextRunAt: 1000,
    actionType: 'prompt',
    payload: {},
  });

  const after = schedules.markRun(s.id, 1000);
  assert.ok(after);
  assert.equal(after.enabled, false);
  assert.equal(after.lastRunAt, 1000);
});

test('markRun: 周期任务推进 next_run_at', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: 'periodic',
    cronExpr: 'interval:10000',
    nextRunAt: 1000,
    actionType: 'reflect',
    payload: {},
  });

  const after = schedules.markRun(s.id, 1500);
  assert.ok(after);
  assert.equal(after.enabled, true);
  assert.equal(after.nextRunAt, 11500); // 1500 + 10000
  assert.equal(after.lastRunAt, 1500);
});

// ── scheduler ──────────────────────────────────────────────────────────

test('startScheduler.tick: 触发到期任务并 markRun', async () => {
  const { schedules } = openMemoryDb(':memory:');

  const oneShot = schedules.create({
    name: 'one-shot',
    nextRunAt: 500,
    actionType: 'prompt',
    payload: { msg: 'hello' },
  });
  const periodic = schedules.create({
    name: 'periodic',
    cronExpr: 'interval:5000',
    nextRunAt: 1000,
    actionType: 'reflect',
    payload: {},
  });
  // 未到期
  schedules.create({
    name: 'future',
    nextRunAt: 10_000,
    actionType: 'prompt',
    payload: {},
  });

  const fired: Schedule[] = [];
  const handle = startScheduler(
    schedules,
    async (s) => { fired.push(s); },
    { intervalMs: 999999, now: () => 2000 }
  );

  const count = await handle.tick();
  handle.stop();

  assert.equal(count, 2);
  assert.deepEqual(fired.map((s) => s.name).sort(), ['one-shot', 'periodic']);

  // 触发后,one-shot 应 disabled,periodic 应被推到 7000 (2000 + 5000)
  assert.equal(schedules.get(oneShot.id)?.enabled, false);
  assert.equal(schedules.get(periodic.id)?.nextRunAt, 7000);
});

test('startScheduler: onFire 抛错不阻塞其它任务', async () => {
  const { schedules } = openMemoryDb(':memory:');
  schedules.create({
    name: 'poison',
    nextRunAt: 100,
    actionType: 'prompt',
    payload: {},
  });
  schedules.create({
    name: 'good',
    nextRunAt: 100,
    actionType: 'prompt',
    payload: {},
  });

  let goodRan = false;
  const errors: unknown[] = [];
  const handle = startScheduler(
    schedules,
    async (s) => {
      if (s.name === 'poison') throw new Error('boom');
      goodRan = true;
    },
    {
      intervalMs: 999999,
      now: () => 1000,
      onError: (err) => errors.push(err),
    }
  );

  await handle.tick();
  handle.stop();

  assert.ok(goodRan, 'good task 应照样跑');
  assert.equal(errors.length, 1);
  // 两个任务都要 markRun(防止卡住)
  const poison = schedules.list().find((s) => s.name === 'poison');
  assert.equal(poison?.enabled, false, 'poison 已 markRun 禁用');
});

// ── v16: 自动熔断(consecutive_failures + paused_until) ──────────────

test('ScheduleStore: 新建 schedule 默认 consecutiveFailures=0 / pausedUntil=null', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: 'fresh',
    nextRunAt: 1000,
    actionType: 'reflect',
    payload: { sessionId: 's1' },
  });
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.pausedUntil, null);
  // 重读也是
  const got = schedules.get(s.id);
  assert.equal(got?.consecutiveFailures, 0);
  assert.equal(got?.pausedUntil, null);
});

test('recordFailure: 累加 consecutiveFailures,未达阈值不暂停', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: 'flaky',
    cronExpr: 'interval:60000',
    nextRunAt: 1000,
    actionType: 'reflect',
    payload: {},
  });
  const after1 = schedules.recordFailure(s.id, 5000);
  assert.equal(after1?.consecutiveFailures, 1);
  assert.equal(after1?.pausedUntil, null, '1 次未达阈值不暂停');
  const after2 = schedules.recordFailure(s.id, 6000);
  assert.equal(after2?.consecutiveFailures, 2);
  assert.equal(after2?.pausedUntil, null);
});

test('recordFailure: 第 3 次失败触发暂停 1h', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: 'broken',
    cronExpr: 'interval:60000',
    nextRunAt: 1000,
    actionType: 'reflect',
    payload: {},
  });
  schedules.recordFailure(s.id, 1000);
  schedules.recordFailure(s.id, 2000);
  const after3 = schedules.recordFailure(s.id, 3000);
  assert.equal(after3?.consecutiveFailures, 3);
  assert.equal(after3?.pausedUntil, 3000 + 60 * 60 * 1000, '阈值触发后 paused_until = at + 1h');
});

test('recordFailure: 自定义 threshold / pauseMs', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: 't',
    cronExpr: 'interval:60000',
    nextRunAt: 0,
    actionType: 'reflect',
    payload: {},
  });
  const r = schedules.recordFailure(s.id, 100, { threshold: 1, pauseMs: 5000 });
  assert.equal(r?.consecutiveFailures, 1);
  assert.equal(r?.pausedUntil, 5100);
});

test('recordSuccess: 清零计数 + 清暂停', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: 'recovery',
    cronExpr: 'interval:60000',
    nextRunAt: 0,
    actionType: 'reflect',
    payload: {},
  });
  schedules.recordFailure(s.id, 100, { threshold: 1, pauseMs: 999999 });
  const before = schedules.get(s.id);
  assert.ok(before?.pausedUntil ?? 0 > 0, '前置:已暂停');
  const after = schedules.recordSuccess(s.id);
  assert.equal(after?.consecutiveFailures, 0);
  assert.equal(after?.pausedUntil, null);
});

test('dueBefore: 暂停期内的 schedule 不返回', () => {
  const { schedules } = openMemoryDb(':memory:');
  const s = schedules.create({
    name: 'paused',
    cronExpr: 'interval:60000',
    nextRunAt: 100, // 早就到期
    actionType: 'reflect',
    payload: {},
  });
  // 暂停到 ms=10000
  schedules.recordFailure(s.id, 0, { threshold: 1, pauseMs: 10000 });
  // now=5000(暂停内)
  assert.equal(schedules.dueBefore(5000).length, 0, '暂停期内不参与调度');
  // now=15000(暂停过期)
  assert.equal(schedules.dueBefore(15000).length, 1, '暂停过期后又能跑');
});

test('dueBefore: paused_until IS NULL 的老 row 始终参与(向后兼容)', () => {
  const { schedules } = openMemoryDb(':memory:');
  schedules.create({
    name: 'old',
    cronExpr: 'interval:60000',
    nextRunAt: 100,
    actionType: 'reflect',
    payload: {},
  });
  // 不调 recordFailure → paused_until 保持 NULL
  assert.equal(schedules.dueBefore(5000).length, 1);
});

test('recordFailure/recordSuccess: 不存在的 id → 返回 null', () => {
  const { schedules } = openMemoryDb(':memory:');
  assert.equal(schedules.recordFailure('no-such-id', 0), null);
  assert.equal(schedules.recordSuccess('no-such-id'), null);
});
