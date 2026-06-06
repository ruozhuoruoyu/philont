/**
 * MemoryStore 单元测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

test('store and retrieve a fact', () => {
  const { facts } = openMemoryDb(':memory:');

  facts.storeFact({ namespace: 'user', key: 'name', value: '张三' });
  const f = facts.getFact('user', 'name');

  assert.ok(f);
  assert.equal(f.value, '张三');
  assert.equal(f.confidence, 1.0);
  assert.equal(f.supersededBy, null);
});

test('getFact returns null for missing key', () => {
  const { facts } = openMemoryDb(':memory:');
  assert.equal(facts.getFact('user', 'ghost'), null);
});

test('storeFact with complex JSON value', () => {
  const { facts } = openMemoryDb(':memory:');

  facts.storeFact({
    namespace: 'user',
    key: 'preferences',
    value: { drinks: ['coffee', 'tea'], language: 'zh' },
  });

  const f = facts.getFact('user', 'preferences');
  assert.ok(f);
  assert.deepEqual(f.value, { drinks: ['coffee', 'tea'], language: 'zh' });
});

test('new fact supersedes old fact', () => {
  const { facts } = openMemoryDb(':memory:');

  const v1 = facts.storeFact({ namespace: 'user', key: 'city', value: '北京' });
  const v2 = facts.storeFact({ namespace: 'user', key: 'city', value: '上海' });

  // 现役版本应该是新的
  const active = facts.getFact('user', 'city');
  assert.ok(active);
  assert.equal(active.value, '上海');
  assert.equal(active.id, v2.id);

  // 历史应该保留两条
  const history = facts.getFactHistory('user', 'city');
  assert.equal(history.length, 2);
  // supersede 链关系
  assert.equal(history[0].id, v2.id);
  assert.equal(history[0].supersedes, v1.id);
  assert.equal(history[1].id, v1.id);
  assert.equal(history[1].supersededBy, v2.id);
});

test('listFacts returns only active facts in namespace', () => {
  const { facts } = openMemoryDb(':memory:');

  facts.storeFact({ namespace: 'user', key: 'name', value: 'A' });
  facts.storeFact({ namespace: 'user', key: 'age', value: 30 });
  facts.storeFact({ namespace: 'user', key: 'name', value: 'B' }); // supersedes
  facts.storeFact({ namespace: 'project', key: 'lang', value: 'rust' });

  const userFacts = facts.listFacts('user');
  assert.equal(userFacts.length, 2);
  const names = userFacts.map((f) => f.key).sort();
  assert.deepEqual(names, ['age', 'name']);

  // 确保返回的是最新版本
  const nameFact = userFacts.find((f) => f.key === 'name');
  assert.equal(nameFact?.value, 'B');
});

test('listNamespaces returns distinct namespaces with active facts', () => {
  const { facts } = openMemoryDb(':memory:');

  facts.storeFact({ namespace: 'user', key: 'a', value: 1 });
  facts.storeFact({ namespace: 'project', key: 'b', value: 2 });
  facts.storeFact({ namespace: 'user', key: 'c', value: 3 });

  const ns = facts.listNamespaces();
  assert.deepEqual(ns.sort(), ['project', 'user']);
});

test('count returns number of active facts', () => {
  const { facts } = openMemoryDb(':memory:');
  assert.equal(facts.count(), 0);

  facts.storeFact({ namespace: 'user', key: 'a', value: 1 });
  assert.equal(facts.count(), 1);

  facts.storeFact({ namespace: 'user', key: 'b', value: 2 });
  assert.equal(facts.count(), 2);

  // supersede 不增加 count
  facts.storeFact({ namespace: 'user', key: 'a', value: 11 });
  assert.equal(facts.count(), 2);
});

test('custom confidence is preserved', () => {
  const { facts } = openMemoryDb(':memory:');
  facts.storeFact({
    namespace: 'user',
    key: 'job',
    value: 'engineer',
    confidence: 0.7,
  });
  const f = facts.getFact('user', 'job');
  assert.equal(f?.confidence, 0.7);
});

// ── lastAccessedAt 行为(2026-05-23,接通到 chat-handler 排序)───────────

test('lastAccessedAt:storeFact 初始化为 createdAt', () => {
  const { facts } = openMemoryDb(':memory:');
  const before = Date.now();
  facts.storeFact({ namespace: 'user', key: 'name', value: 'A' });
  // 直接读 DB 不走 getFact(避免 getFact 自带的 bump 干扰)
  const all = facts.listFacts('user');
  assert.equal(all.length, 1);
  const f = all[0];
  assert.ok(f.lastAccessedAt !== null, '新 fact lastAccessedAt 不应为 null');
  assert.equal(f.lastAccessedAt, f.createdAt, '初始化应等于 createdAt');
  assert.ok(f.lastAccessedAt! >= before, 'lastAccessedAt 应为正常时间戳');
});

test('lastAccessedAt:getFact 命中后刷新', async () => {
  const { facts } = openMemoryDb(':memory:');
  facts.storeFact({ namespace: 'user', key: 'name', value: 'A' });
  const initial = facts.listFacts('user')[0].lastAccessedAt!;

  // 等几 ms 确保 timestamp 差能体现
  await new Promise((r) => setTimeout(r, 5));

  const f = facts.getFact('user', 'name');
  assert.ok(f);
  assert.ok(
    (f.lastAccessedAt ?? 0) > initial,
    `getFact 后 lastAccessedAt 应 > 初始(${f.lastAccessedAt} vs ${initial})`,
  );

  // 再确认 DB 持久化:listFacts 拿到最新值
  const after = facts.listFacts('user')[0].lastAccessedAt!;
  assert.equal(after, f.lastAccessedAt, '持久化值应与返回值一致');
});

test('lastAccessedAt:getFact miss(key 不存在)不影响其他 fact', async () => {
  const { facts } = openMemoryDb(':memory:');
  facts.storeFact({ namespace: 'user', key: 'name', value: 'A' });
  facts.storeFact({ namespace: 'user', key: 'age', value: 30 });
  const beforeName = facts.listFacts('user').find((f) => f.key === 'name')!.lastAccessedAt!;

  await new Promise((r) => setTimeout(r, 5));
  const miss = facts.getFact('user', 'ghost-key');
  assert.equal(miss, null);

  const afterName = facts.listFacts('user').find((f) => f.key === 'name')!.lastAccessedAt!;
  assert.equal(afterName, beforeName, 'miss 不应刷别人的 lastAccessedAt');
});

test('lastAccessedAt:listFacts 不刷任何 fact', async () => {
  const { facts } = openMemoryDb(':memory:');
  facts.storeFact({ namespace: 'user', key: 'a', value: 1 });
  facts.storeFact({ namespace: 'user', key: 'b', value: 2 });
  const before = facts.listFacts('user').map((f) => [f.key, f.lastAccessedAt!] as const);

  await new Promise((r) => setTimeout(r, 5));
  const _again = facts.listFacts('user'); // 这次扫描不该 bump
  void _again;

  const after = facts.listFacts('user').map((f) => [f.key, f.lastAccessedAt!] as const);
  for (const [k, v] of before) {
    const matched = after.find((p) => p[0] === k);
    assert.ok(matched, `key ${k} 应仍存在`);
    assert.equal(matched![1], v, `listFacts 不应改 ${k} 的 lastAccessedAt`);
  }
});

test('lastAccessedAt:可以稳定地按它排序("写一次但常被读" 应排前)', async () => {
  const { facts } = openMemoryDb(':memory:');
  // 顺序:先写 timezone(老 createdAt),再写多条新 fact
  facts.storeFact({ namespace: 'user', key: 'timezone', value: 'Asia/Shanghai' });
  await new Promise((r) => setTimeout(r, 5));
  facts.storeFact({ namespace: 'user', key: 'recent_topic', value: 'PDF' });
  await new Promise((r) => setTimeout(r, 5));
  facts.storeFact({ namespace: 'user', key: 'recent_topic2', value: 'CSV' });

  // 不读 timezone → 按 lastAccessedAt 排,timezone 在最后
  let sorted = facts.listFacts('user').sort(
    (a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0),
  );
  assert.equal(sorted[sorted.length - 1].key, 'timezone', '未读时 timezone 在尾');

  // 显式 getFact('user','timezone')一次,刷新它
  await new Promise((r) => setTimeout(r, 5));
  facts.getFact('user', 'timezone');

  sorted = facts.listFacts('user').sort(
    (a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0),
  );
  assert.equal(sorted[0].key, 'timezone', '读后 timezone 浮顶');
});
