/**
 * PushDispatcher 单测:全局 kill / 订阅检查 / 频次 / 静默 / dedup / fan-out。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../agent-memory/src/index.js';
import {
  PushDispatcher,
  isInQuietHours,
  type PushRequest,
} from '../src/push/dispatcher.js';
import {
  registerPushChannel,
  unregisterPushChannel,
  _resetPushChannelsForTest,
  type PushChannel,
  type PushTextResult,
} from '../src/push/channel.js';

function fakeChannel(name = 'wechat:test', ready = true): {
  channel: PushChannel;
  sent: Array<{ peer: string; text: string }>;
  setReady: (v: boolean) => void;
  setReturn: (r: PushTextResult) => void;
} {
  const sent: Array<{ peer: string; text: string }> = [];
  let isReady = ready;
  let nextResult: PushTextResult = { ok: true, messageIds: ['m1'] };
  const channel: PushChannel = {
    name,
    isReady: () => isReady,
    pushText: async (peer, text) => {
      sent.push({ peer, text });
      return nextResult;
    },
  };
  return {
    channel,
    sent,
    setReady: (v) => {
      isReady = v;
    },
    setReturn: (r) => {
      nextResult = r;
    },
  };
}

function setup(opts: { globalEnabled?: boolean; now?: () => number } = {}) {
  _resetPushChannelsForTest();
  const h = openMemoryDb(':memory:');
  const dispatcher = new PushDispatcher({
    subscriptions: h.pushSubscriptions,
    isGloballyEnabled: () => opts.globalEnabled ?? true,
    now: opts.now ?? (() => Date.now()),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return { h, dispatcher };
}

const URGENT_REQ: PushRequest = {
  severity: 'urgent',
  kind: 'autonomous_finding',
  targetRef: 'initiative:abc',
  text: 'urgent text',
};

const DIGEST_REQ: PushRequest = {
  severity: 'digest',
  kind: 'service:dormancy-checkin',
  targetRef: 'service:checkin:day-1',
  text: 'digest text',
};

// ── 全局 kill ───────────────────────────────────────────────────────────

test('dispatcher: 全局 kill → skip global_disabled', async () => {
  const { h, dispatcher } = setup({ globalEnabled: false });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(r.skipped[0].reason, 'global_disabled');
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 无订阅 ──────────────────────────────────────────────────────────────

test('dispatcher: 无订阅 → 静默丢(不报错)', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped.length, 0);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── channel 不存在 / 不 ready ───────────────────────────────────────────

test('dispatcher: 订阅了但 channel 未注册 → skip channel_not_found', async () => {
  const { h, dispatcher } = setup();
  h.pushSubscriptions.subscribe({ channel: 'wechat:nonexist', peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped[0].reason, 'channel_not_found');
  h.close();
});

test('dispatcher: channel.isReady=false → skip channel_not_ready', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel('wechat:test', false);
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped[0].reason, 'channel_not_ready');
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── happy path ──────────────────────────────────────────────────────────

test('dispatcher: 订阅 + ready + 无限速 → urgent push 成功', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].peer, 'p1');
  assert.match(f.sent[0].text, /urgent text/);

  // last_urgent_at 已写
  const sub = h.pushSubscriptions.get(f.channel.name, 'p1')!;
  assert.ok(sub.lastUrgentAt !== null);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: digest push 写 lastDigestAt 而非 lastUrgentAt', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  await dispatcher.enqueue(DIGEST_REQ);
  const sub = h.pushSubscriptions.get(f.channel.name, 'p1')!;
  assert.ok(sub.lastDigestAt !== null);
  assert.equal(sub.lastUrgentAt, null);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 频次限速 ───────────────────────────────────────────────────────────

test('dispatcher: urgent 频次限速 → skip rate_limited', async () => {
  let now = 1_000_000;
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    urgentMinIntervalMs: 60_000, // 1 分钟
  });

  // 第一次 OK
  await dispatcher.enqueue(URGENT_REQ);
  // 30s 后第二次同 kind 但不同 targetRef(避免 dedup 影响)
  now += 30_000;
  const r = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:def' });
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped[0].reason, 'rate_limited');

  // 60s 后(总 90s)第三次 → 通过
  now += 60_000;
  const r2 = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:ghi' });
  assert.equal(r2.delivered, 1);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 24h dedup ──────────────────────────────────────────────────────────

test('dispatcher: 同 (kind, targetRef) 24h 内 dedup', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    urgentMinIntervalMs: 0, // 关闭频次限速,只测 dedup
  });

  await dispatcher.enqueue(URGENT_REQ);
  const r2 = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r2.delivered, 0);
  assert.equal(r2.skipped[0].reason, 'duplicate');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: 不同 targetRef → 不 dedup', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    urgentMinIntervalMs: 0,
  });

  await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:1' });
  const r = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:2' });
  assert.equal(r.delivered, 1);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 静默时段 ───────────────────────────────────────────────────────────

test('isInQuietHours: 同日窗口 [22, 7) 跨午夜', () => {
  assert.equal(isInQuietHours(23, 22, 7), true);
  assert.equal(isInQuietHours(0, 22, 7), true);
  assert.equal(isInQuietHours(6, 22, 7), true);
  assert.equal(isInQuietHours(7, 22, 7), false);
  assert.equal(isInQuietHours(8, 22, 7), false);
  assert.equal(isInQuietHours(21, 22, 7), false);
});

test('isInQuietHours: 不跨午夜 [9, 17)', () => {
  assert.equal(isInQuietHours(10, 9, 17), true);
  assert.equal(isInQuietHours(8, 9, 17), false);
  assert.equal(isInQuietHours(17, 9, 17), false);
});

test('isInQuietHours: 0 长度窗口 [10, 10) → 永不命中', () => {
  for (let h = 0; h < 24; h++) {
    assert.equal(isInQuietHours(h, 10, 10), false);
  }
});

test('dispatcher: 静默时段命中 → skip quiet_hours(urgent 也尊重)', async () => {
  // mock now 在 UTC 23 点(quiet [22, 7) 内)
  const utcMidnight = Date.UTC(2026, 4, 6, 23, 0); // 2026-05-06 23:00 UTC
  const { h, dispatcher } = setup({ now: () => utcMidnight });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    quietStartHour: 22,
    quietEndHour: 7,
    // timezone 不给 → UTC
  });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped[0].reason, 'quiet_hours');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: 静默窗外 → 通过', async () => {
  const utcNoon = Date.UTC(2026, 4, 6, 12, 0); // 12:00 UTC
  const { h, dispatcher } = setup({ now: () => utcNoon });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    quietStartHour: 22,
    quietEndHour: 7,
  });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 1);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── routing 显式 vs fan-out ────────────────────────────────────────────

test('dispatcher: 多订阅同 channel,无 routing → fan-out 全发', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p2', urgentMinIntervalMs: 0 });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 2);
  assert.equal(f.sent.length, 2);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: 显式 routing → 只发指定 (channel, peer)', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p2', urgentMinIntervalMs: 0 });

  const r = await dispatcher.enqueue({
    ...URGENT_REQ,
    routing: { channel: f.channel.name, peer: 'p2' },
  });
  assert.equal(r.delivered, 1);
  assert.equal(f.sent[0].peer, 'p2');
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 失败处理 ───────────────────────────────────────────────────────────

test('dispatcher: channel.pushText 返 ok=false → failed 计数', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  f.setReturn({ ok: false, error: 'network down' });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.failed, 1);
  assert.equal(r.delivered, 0);
  // last_urgent_at 不应写(不是成功)
  const sub = h.pushSubscriptions.get(f.channel.name, 'p1')!;
  assert.equal(sub.lastUrgentAt, null);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: 失败不写 dedup ring,下次同请求可重试', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  f.setReturn({ ok: false });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });

  await dispatcher.enqueue(URGENT_REQ);
  // 修复 channel
  f.setReturn({ ok: true, messageIds: ['m1'] });
  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 1, '失败后 dedup 不应记录 fingerprint');
  unregisterPushChannel(f.channel.name);
  h.close();
});
