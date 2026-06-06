/**
 * PushSubscriptionStore 单测:CRUD + opt-in 状态 + 软删 + 静默配置。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

test('subscribe: 新订阅 enabled=1 + 默认间隔', () => {
  const h = openMemoryDb(':memory:');
  const sub = h.pushSubscriptions.subscribe({ channel: 'wechat:abc', peer: 'user-1' });
  assert.equal(sub.channel, 'wechat:abc');
  assert.equal(sub.peer, 'user-1');
  assert.equal(sub.enabled, true);
  assert.equal(sub.digestMinIntervalMs, 4 * 60 * 60_000);
  assert.equal(sub.urgentMinIntervalMs, 1 * 60 * 60_000);
  assert.equal(sub.lastDigestAt, null);
  h.close();
});

test('subscribe: 重复订阅同 (channel, peer) 是 idempotent 更新而非新建', () => {
  const h = openMemoryDb(':memory:');
  h.pushSubscriptions.subscribe({ channel: 'wechat:a', peer: 'p1', digestMinIntervalMs: 1000 });
  h.pushSubscriptions.subscribe({ channel: 'wechat:a', peer: 'p1', digestMinIntervalMs: 9999 });
  const sub = h.pushSubscriptions.get('wechat:a', 'p1');
  assert.equal(sub!.digestMinIntervalMs, 9999);
  assert.equal(h.pushSubscriptions.count(), 1);
  h.close();
});

test('subscribe: quietStartHour / quietEndHour 必须同时给', () => {
  const h = openMemoryDb(':memory:');
  assert.throws(() =>
    h.pushSubscriptions.subscribe({
      channel: 'x', peer: 'y', quietStartHour: 22,
    }),
  );
  h.close();
});

test('subscribe: quietHour 越界抛错', () => {
  const h = openMemoryDb(':memory:');
  assert.throws(() =>
    h.pushSubscriptions.subscribe({
      channel: 'x', peer: 'y', quietStartHour: 24, quietEndHour: 7,
    }),
  );
  assert.throws(() =>
    h.pushSubscriptions.subscribe({
      channel: 'x', peer: 'y', quietStartHour: 22, quietEndHour: -1,
    }),
  );
  h.close();
});

test('subscribe: 空 channel/peer 抛错', () => {
  const h = openMemoryDb(':memory:');
  assert.throws(() => h.pushSubscriptions.subscribe({ channel: '', peer: 'p' }));
  assert.throws(() => h.pushSubscriptions.subscribe({ channel: 'c', peer: '' }));
  h.close();
});

test('unsubscribe: 软删 enabled=0,记录保留', () => {
  const h = openMemoryDb(':memory:');
  h.pushSubscriptions.subscribe({ channel: 'x', peer: 'y' });
  const ok = h.pushSubscriptions.unsubscribe('x', 'y');
  assert.equal(ok, true);

  const sub = h.pushSubscriptions.get('x', 'y');
  assert.ok(sub, '记录还在');
  assert.equal(sub!.enabled, false);
  assert.equal(h.pushSubscriptions.count(), 1);
  assert.equal(h.pushSubscriptions.countActive(), 0);
  h.close();
});

test('unsubscribe: 不存在返 false', () => {
  const h = openMemoryDb(':memory:');
  assert.equal(h.pushSubscriptions.unsubscribe('nope', 'nope'), false);
  h.close();
});

test('subscribe 后再 unsubscribe 再 subscribe → enabled 恢复', () => {
  const h = openMemoryDb(':memory:');
  h.pushSubscriptions.subscribe({ channel: 'x', peer: 'y' });
  h.pushSubscriptions.unsubscribe('x', 'y');
  h.pushSubscriptions.subscribe({ channel: 'x', peer: 'y' });
  assert.equal(h.pushSubscriptions.get('x', 'y')!.enabled, true);
  assert.equal(h.pushSubscriptions.countActive(), 1);
  h.close();
});

test('listActive: 只返 enabled=1', () => {
  const h = openMemoryDb(':memory:');
  h.pushSubscriptions.subscribe({ channel: 'a', peer: 'p1' });
  h.pushSubscriptions.subscribe({ channel: 'a', peer: 'p2' });
  h.pushSubscriptions.subscribe({ channel: 'b', peer: 'p3' });
  h.pushSubscriptions.unsubscribe('a', 'p2');

  const active = h.pushSubscriptions.listActive();
  assert.equal(active.length, 2);
  assert.ok(active.find((s) => s.peer === 'p1'));
  assert.ok(active.find((s) => s.peer === 'p3'));
  assert.ok(!active.find((s) => s.peer === 'p2'));
  h.close();
});

test('listByChannel: filter 单 channel', () => {
  const h = openMemoryDb(':memory:');
  h.pushSubscriptions.subscribe({ channel: 'wechat:1', peer: 'a' });
  h.pushSubscriptions.subscribe({ channel: 'wechat:2', peer: 'b' });

  const w1 = h.pushSubscriptions.listByChannel('wechat:1');
  assert.equal(w1.length, 1);
  assert.equal(w1[0].peer, 'a');
  h.close();
});

test('markDigestSent / markUrgentSent 各自独立更新', () => {
  const h = openMemoryDb(':memory:');
  h.pushSubscriptions.subscribe({ channel: 'x', peer: 'y' });
  h.pushSubscriptions.markDigestSent('x', 'y', 1000);
  let sub = h.pushSubscriptions.get('x', 'y')!;
  assert.equal(sub.lastDigestAt, 1000);
  assert.equal(sub.lastUrgentAt, null);

  h.pushSubscriptions.markUrgentSent('x', 'y', 2000);
  sub = h.pushSubscriptions.get('x', 'y')!;
  assert.equal(sub.lastUrgentAt, 2000);
  assert.equal(sub.lastDigestAt, 1000);
  h.close();
});

test('setQuietHours: 设置 + 清空', () => {
  const h = openMemoryDb(':memory:');
  h.pushSubscriptions.subscribe({ channel: 'x', peer: 'y' });

  const ok = h.pushSubscriptions.setQuietHours('x', 'y', 22, 7, 'Asia/Shanghai');
  assert.equal(ok, true);
  let sub = h.pushSubscriptions.get('x', 'y')!;
  assert.equal(sub.quietStartHour, 22);
  assert.equal(sub.quietEndHour, 7);
  assert.equal(sub.timezone, 'Asia/Shanghai');

  h.pushSubscriptions.setQuietHours('x', 'y', null, null, null);
  sub = h.pushSubscriptions.get('x', 'y')!;
  assert.equal(sub.quietStartHour, null);
  assert.equal(sub.quietEndHour, null);
  h.close();
});

test('setQuietHours: 一边 null 一边非 null 抛错', () => {
  const h = openMemoryDb(':memory:');
  h.pushSubscriptions.subscribe({ channel: 'x', peer: 'y' });
  assert.throws(() => h.pushSubscriptions.setQuietHours('x', 'y', 22, null, null));
  h.close();
});
