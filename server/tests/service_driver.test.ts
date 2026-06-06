/**
 * ServiceDriver tick 单测:dormancy 阈值 + findings 阈值 + dispatcher 联动。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  GLOBAL_TIMELINE_SESSION_ID,
} from '../../agent-memory/src/index.js';
import {
  PushDispatcher,
} from '../src/push/dispatcher.js';
import {
  serviceDriverTick,
  renderCheckInText,
} from '../src/push/service_driver.js';
import {
  registerPushChannel,
  unregisterPushChannel,
  _resetPushChannelsForTest,
  type PushChannel,
} from '../src/push/channel.js';

function fakeChannel(name = 'wechat:test'): {
  channel: PushChannel;
  sent: Array<{ peer: string; text: string }>;
} {
  const sent: Array<{ peer: string; text: string }> = [];
  return {
    channel: {
      name,
      isReady: () => true,
      pushText: async (peer, text) => {
        sent.push({ peer, text });
        return { ok: true, messageIds: ['m1'] };
      },
    },
    sent,
  };
}

function setup() {
  _resetPushChannelsForTest();
  const h = openMemoryDb(':memory:');
  const dispatcher = new PushDispatcher({
    subscriptions: h.pushSubscriptions,
    isGloballyEnabled: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return { h, dispatcher };
}

function pushAssistant(h: ReturnType<typeof setup>['h'], at: number) {
  // 直接写 raw 表设定 timestamp
  h.db.prepare(
    `INSERT INTO memory_raw_messages (session_id, role, content, timestamp)
     VALUES (?, 'assistant', ?, ?)`,
  ).run(GLOBAL_TIMELINE_SESSION_ID, 'past reply', at);
}

function insertDoneInitiative(
  h: ReturnType<typeof setup>['h'],
  doneAt: number,
  driver = 'gap',
  kind = 'fact_gap',
) {
  // 通过 InitiativeStore 创建 + mark done,但 markDone 用 Date.now,所以
  // 我们直接 SQL 注入精确时间
  const id = `init-${Math.random().toString(36).slice(2, 10)}`;
  h.db.prepare(
    `INSERT INTO memory_initiatives
     (id, kind, driver, target_ref, rationale, utility, status,
      budget_estimate, outcome_summary, outcome_refs,
      created_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 0.7, 'done', 1000, '查了 X', '{"facts":[],"notes":[],"pursuits":[]}',
             ?, ?, ?)`,
  ).run(id, kind, driver, `t:${id}`, 'r', doneAt - 100, doneAt - 50, doneAt);
}

// ── 触发条件 ────────────────────────────────────────────────────────────

test('service: 无 assistant 历史 → 不触发', async () => {
  const { h, dispatcher } = setup();
  const r = await serviceDriverTick({
    raw: h.raw,
    initiatives: { listRecentDone: () => [] } as any,
    dispatcher,
    now: () => 1_000_000_000,
  });
  assert.equal(r.triggered, false);
  assert.equal(r.reason, 'no_assistant_history');
  h.close();
});

test('service: dormancy 不够(< minDormantHours)→ 不触发', async () => {
  const { h, dispatcher } = setup();
  const now = Date.now();
  pushAssistant(h, now - 6 * 3600_000); // 6h 前

  const r = await serviceDriverTick({
    raw: h.raw,
    initiatives: { listRecentDone: () => [] } as any,
    dispatcher,
    now: () => now,
  });
  assert.equal(r.triggered, false);
  assert.equal(r.reason, 'not_dormant_enough');
  h.close();
});

test('service: dormancy 跨过 minDormant 但低于 dormancyHours → 不触发', async () => {
  const { h, dispatcher } = setup();
  const now = Date.now();
  pushAssistant(h, now - 18 * 3600_000); // 18h(默认 minDormant=12, dormancy=24)

  const r = await serviceDriverTick({
    raw: h.raw,
    initiatives: { listRecentDone: () => [] } as any,
    dispatcher,
    now: () => now,
  });
  assert.equal(r.triggered, false);
  assert.equal(r.reason, 'not_dormant_enough');
  h.close();
});

test('service: dormant 够 + 无 findings → not triggered (no_findings)', async () => {
  const { h, dispatcher } = setup();
  const now = Date.now();
  pushAssistant(h, now - 30 * 3600_000); // 30h

  const r = await serviceDriverTick({
    raw: h.raw,
    initiatives: h.db ? { listRecentDone: () => [] } as any : null as any,
    dispatcher,
    now: () => now,
  });
  assert.equal(r.triggered, false);
  assert.equal(r.reason, 'no_findings');
  h.close();
});

test('service: dormant + findings + 无订阅 → enqueued 但 dispatch 0 delivered', async () => {
  const { h, dispatcher } = setup();
  const now = Date.now();
  pushAssistant(h, now - 30 * 3600_000);
  insertDoneInitiative(h, now - 5 * 3600_000);
  insertDoneInitiative(h, now - 3 * 3600_000);

  const f = fakeChannel();
  registerPushChannel(f.channel);
  // 不订阅 → dispatcher 应静默 skip

  const { InitiativeStore } = await import('../../agent-memory/src/index.js');
  const store = new InitiativeStore(h.db);
  const r = await serviceDriverTick({
    raw: h.raw,
    initiatives: store,
    dispatcher,
    now: () => now,
  });
  assert.equal(r.triggered, true);
  assert.equal(r.reason, 'enqueued');
  assert.equal(r.findings, 2);
  assert.equal(r.dispatchDelivered, 0); // 没订阅
  assert.equal(f.sent.length, 0);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('service: dormant + findings + 有订阅 + 无频次限速 → 真发出', async () => {
  const { h, dispatcher } = setup();
  const now = Date.now();
  pushAssistant(h, now - 30 * 3600_000);
  insertDoneInitiative(h, now - 5 * 3600_000);

  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    digestMinIntervalMs: 0,
  });

  const { InitiativeStore } = await import('../../agent-memory/src/index.js');
  const store = new InitiativeStore(h.db);
  const r = await serviceDriverTick({
    raw: h.raw,
    initiatives: store,
    dispatcher,
    now: () => now,
  });
  assert.equal(r.triggered, true);
  assert.equal(r.dispatchDelivered, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /没聊了/);
  assert.match(f.sent[0].text, /取消订阅/);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('service: 同 day dedup — 第二次同 day 不再 enqueue 成功', async () => {
  const { h, dispatcher } = setup();
  const now = Date.now();
  pushAssistant(h, now - 30 * 3600_000);
  insertDoneInitiative(h, now - 5 * 3600_000);

  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    digestMinIntervalMs: 0,
  });

  const { InitiativeStore } = await import('../../agent-memory/src/index.js');
  const store = new InitiativeStore(h.db);
  await serviceDriverTick({ raw: h.raw, initiatives: store, dispatcher, now: () => now });
  // 第二次同 now 调,dispatcher 24h dedup 命中
  const r2 = await serviceDriverTick({ raw: h.raw, initiatives: store, dispatcher, now: () => now });
  assert.equal(r2.triggered, true);
  assert.equal(r2.dispatchDelivered, 0); // dispatcher 内部 dedup
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 渲染 ────────────────────────────────────────────────────────────────

test('renderCheckInText: 包含 hours / count / 取消订阅 hint', () => {
  const t = renderCheckInText(30, [
    {
      id: 'i1',
      kind: 'fact_gap',
      driver: 'gap',
      targetRef: 'fact:abc',
      rationale: 'r',
      utility: 0.7,
      budgetEstimate: 1000,
      status: 'done',
      budgetActual: 100,
      outcomeSummary: '查了 X 是 Y',
      outcomeRefs: { facts: [], notes: [], pursuits: [] },
      error: null,
      createdAt: 0,
      startedAt: 0,
      completedAt: 0,
    },
  ]);
  assert.match(t, /没聊了/);
  assert.match(t, /我自己做了 1 件事/);
  assert.match(t, /查了 X 是 Y/);
  assert.match(t, /取消订阅/);
});

test('renderCheckInText: K7-bridge initiative 显示"自我复核"标签', () => {
  const t = renderCheckInText(48, [
    {
      id: 'i1',
      kind: 'honesty:verify-size',
      driver: 'k7-bridge',
      targetRef: 'honesty:verify-size:t1',
      rationale: 'r',
      utility: 0.9,
      budgetEstimate: 1000,
      status: 'done',
      budgetActual: 100,
      outcomeSummary: '核对了文件大小',
      outcomeRefs: { facts: [], notes: [], pursuits: [] },
      error: null,
      createdAt: 0, startedAt: 0, completedAt: 0,
    },
  ]);
  assert.match(t, /自我复核/);
});

test('renderCheckInText: 超过 3 条显示 "还有 N 条"', () => {
  const findings = Array.from({ length: 5 }, (_, i) => ({
    id: `i${i}`,
    kind: 'fact_gap',
    driver: 'gap',
    targetRef: `t:${i}`,
    rationale: 'r',
    utility: 0.7,
    budgetEstimate: 1000,
    status: 'done' as const,
    budgetActual: 100,
    outcomeSummary: `summary ${i}`,
    outcomeRefs: { facts: [], notes: [], pursuits: [] },
    error: null,
    createdAt: 0, startedAt: 0, completedAt: 0,
  }));
  const t = renderCheckInText(30, findings);
  assert.match(t, /还有 2 条/);
});
