/**
 * RawStore 测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

test('session lifecycle: start, append, end', () => {
  const { raw } = openMemoryDb(':memory:');

  const session = raw.startSession();
  assert.ok(session.id);
  assert.equal(session.endedAt, null);

  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: 'hello',
  });
  raw.appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: 'hi',
  });

  const msgs = raw.getMessages(session.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');

  raw.endSession(session.id);
  const s = raw.getSession(session.id);
  assert.ok(s);
  assert.ok(s.endedAt);
});

test('listRecentSessions returns in reverse chronological order', async () => {
  const { raw } = openMemoryDb(':memory:');

  const s1 = raw.startSession();
  await new Promise((r) => setTimeout(r, 5));
  const s2 = raw.startSession();
  await new Promise((r) => setTimeout(r, 5));
  const s3 = raw.startSession();

  // v8: initSchema 自带 'global' session 行(K0 时间线 bookkeeping 用)
  // 它的 started_at < s1,所以排在最末
  const list = raw.listRecentSessions(5);
  const userSessions = list.filter((s) => s.id !== 'global');
  assert.equal(userSessions.length, 3);
  assert.equal(userSessions[0].id, s3.id);
  assert.equal(userSessions[2].id, s1.id);
});

test('getSession returns null for missing id', () => {
  const { raw } = openMemoryDb(':memory:');
  assert.equal(raw.getSession('nonexistent'), null);
});

test('messages from different sessions are isolated', () => {
  const { raw } = openMemoryDb(':memory:');

  const a = raw.startSession();
  const b = raw.startSession();

  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'msgA' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'msgB' });

  assert.equal(raw.getMessages(a.id).length, 1);
  assert.equal(raw.getMessages(b.id).length, 1);
  assert.equal(raw.getMessages(a.id)[0].content, 'msgA');
});

// ── v6: searchMessages / listSessions ─────────────────────────────────

test('searchMessages: FTS trigram hits content across sessions', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();

  raw.appendMessage({ sessionId: a.id, role: 'user', content: '讨论数据库迁移策略' });
  raw.appendMessage({ sessionId: a.id, role: 'assistant', content: '建议先建影子表' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: '今晚要加班写报告' });

  const hits = raw.searchMessages('数据库');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, a.id);
  assert.ok(hits[0].content.includes('数据库'));
});

test('searchMessages: since / until filter by timestamp', async () => {
  const { raw } = openMemoryDb(':memory:');
  const s = raw.startSession();
  const before = Date.now();
  raw.appendMessage({ sessionId: s.id, role: 'user', content: '老消息含关键词 migration' });
  await new Promise((r) => setTimeout(r, 10));
  const boundary = Date.now();
  await new Promise((r) => setTimeout(r, 10));
  raw.appendMessage({ sessionId: s.id, role: 'user', content: '新消息含关键词 migration' });

  const olderHalf = raw.searchMessages('migration', { until: boundary });
  assert.equal(olderHalf.length, 1);
  assert.ok(olderHalf[0].content.startsWith('老消息'));

  const newerHalf = raw.searchMessages('migration', { since: boundary });
  assert.equal(newerHalf.length, 1);
  assert.ok(newerHalf[0].content.startsWith('新消息'));

  // full range
  const all = raw.searchMessages('migration', { since: before });
  assert.equal(all.length, 2);
});

test('searchMessages: sessionId filter scopes to one session', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'alpha content' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'alpha content too' });

  const scoped = raw.searchMessages('alpha', { sessionId: a.id });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].sessionId, a.id);
});

// ── 2026-05-09:sessionIds 多值过滤(autonomous turn 隔离根治路径) ──────

test('searchMessages: sessionIds (multi-value) IN filter', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();
  const c = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'alpha foo' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'alpha bar' });
  raw.appendMessage({ sessionId: c.id, role: 'user', content: 'alpha baz' });

  const scoped = raw.searchMessages('alpha', { sessionIds: [a.id, c.id] });
  assert.equal(scoped.length, 2);
  const ids = scoped.map((m) => m.sessionId).sort();
  assert.deepEqual(ids, [a.id, c.id].sort());
});

test('searchMessages: sessionIds 空数组 → 等价于不过滤', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'alpha here' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'alpha there' });

  const scoped = raw.searchMessages('alpha', { sessionIds: [] });
  assert.equal(scoped.length, 2, '空 sessionIds 不应过滤');
});

test('searchMessages: sessionIds 不存在 sessionId → 空数组', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'alpha here' });

  const scoped = raw.searchMessages('alpha', { sessionIds: ['nonexistent-sid'] });
  assert.equal(scoped.length, 0);
});

test('searchMessages: sessionIds 优先于 sessionId(同传时)', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'alpha A' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'alpha B' });

  // sessionId 单值传 a,sessionIds 多值传 [b];sessionIds 优先
  const scoped = raw.searchMessages('alpha', { sessionId: a.id, sessionIds: [b.id] });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].sessionId, b.id);
});

test('queryTimeline: sessionIds 单值过滤', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'a-msg-1' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'b-msg-1' });
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'a-msg-2' });

  const scoped = raw.queryTimeline({ sessionIds: [a.id], order: 'asc' });
  assert.equal(scoped.length, 2);
  assert.equal(scoped[0].content, 'a-msg-1');
  assert.equal(scoped[1].content, 'a-msg-2');
});

test('queryTimeline: sessionIds 多值过滤(IN 并集)', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();
  const c = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'a-msg' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'b-msg' });
  raw.appendMessage({ sessionId: c.id, role: 'user', content: 'c-msg' });

  const scoped = raw.queryTimeline({ sessionIds: [a.id, c.id], order: 'asc' });
  const contents = scoped.map((m) => m.content);
  assert.deepEqual(contents.sort(), ['a-msg', 'c-msg'].sort());
});

test('queryTimeline: sessionIds 空数组 → 等价于不过滤(全局召回)', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'a-msg' });
  raw.appendMessage({ sessionId: b.id, role: 'user', content: 'b-msg' });

  const all = raw.queryTimeline({ sessionIds: [], order: 'asc' });
  // 至少包含我们插入的 2 条(global session 自带 0 条 raw msg)
  assert.ok(all.length >= 2, '空数组不应过滤掉任何 session 的消息');
});

test('queryTimeline: sessionIds 不存在 sessionId → 空数组', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: 'a-msg' });

  const empty = raw.queryTimeline({ sessionIds: ['nonexistent-sid'] });
  assert.equal(empty.length, 0);
});

test('queryTimeline: sessionIds 与 fromTs/limit 组合可叠加', () => {
  const { raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  const b = raw.startSession();
  // 写 5 条 a 消息,同时穿插写 b 消息
  for (let i = 0; i < 5; i++) {
    raw.appendMessage({ sessionId: a.id, role: 'user', content: `a-${i}` });
    raw.appendMessage({ sessionId: b.id, role: 'user', content: `b-${i}` });
  }
  // 限本 session a + limit 3
  const scoped = raw.queryTimeline({ sessionIds: [a.id], limit: 3, order: 'desc' });
  assert.equal(scoped.length, 3);
  for (const m of scoped) assert.equal(m.sessionId, a.id);
});

test('searchMessages: short query falls back to LIKE path', () => {
  const { raw } = openMemoryDb(':memory:');
  const s = raw.startSession();
  raw.appendMessage({ sessionId: s.id, role: 'user', content: 'hit' });

  // 2 字符查询 (<3) 触发 LIKE 兜底
  const hits = raw.searchMessages('hi', { limit: 5 });
  assert.ok(hits.length >= 1);
});

test('searchMessages: sanitization of FTS special chars does not throw', () => {
  const { raw } = openMemoryDb(':memory:');
  const s = raw.startSession();
  raw.appendMessage({ sessionId: s.id, role: 'user', content: 'task completed ok' });

  // FTS5 语法特殊字符(" * ( ) ')应被 sanitize 掉,不抛错即可
  assert.doesNotThrow(() => raw.searchMessages('"completed"'));
  assert.doesNotThrow(() => raw.searchMessages('task*'));
  assert.doesNotThrow(() => raw.searchMessages("task'"));
  // sanitize 后剩 'task' 的查询能命中
  const hits = raw.searchMessages('(task)');
  assert.ok(hits.length >= 1);
});

test('searchMessages: empty query returns empty array', () => {
  const { raw } = openMemoryDb(':memory:');
  assert.deepEqual(raw.searchMessages('   '), []);
  assert.deepEqual(raw.searchMessages(''), []);
});

test('listSessions: since / until / offset / limit', async () => {
  const { raw } = openMemoryDb(':memory:');
  // v8 'global' session 在 initSchema 时插入,所有 boundary < global.started_at
  // 测试用大 boundary 把 global 排除在外
  const beforeStart = Date.now();
  const s1 = raw.startSession();
  await new Promise((r) => setTimeout(r, 5));
  const boundary = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  const s2 = raw.startSession();
  await new Promise((r) => setTimeout(r, 5));
  const s3 = raw.startSession();

  const newer = raw.listSessions({ since: boundary }).filter((s) => s.id !== 'global');
  assert.equal(newer.length, 2);
  assert.equal(newer[0].id, s3.id);
  assert.equal(newer[1].id, s2.id);

  const older = raw
    .listSessions({ since: beforeStart, until: boundary })
    .filter((s) => s.id !== 'global');
  assert.equal(older.length, 1);
  assert.equal(older[0].id, s1.id);

  const paged = raw
    .listSessions({ since: beforeStart, limit: 4 })
    .filter((s) => s.id !== 'global');
  // 取首条 = 最新 = s3,这里用 limit/offset 在过滤后也成立
  assert.equal(paged.length, 3);
  assert.equal(paged[0].id, s3.id);
});

test('listRecentSessions remains a thin wrapper over listSessions', () => {
  const { raw } = openMemoryDb(':memory:');
  raw.startSession();
  raw.startSession();
  // v8: + 'global' session 自动建,所以 list 总数 = 用户建的 + 1
  const userSessions = raw.listRecentSessions().filter((s) => s.id !== 'global');
  assert.equal(userSessions.length, 2);
  assert.equal(raw.listRecentSessions(1).length, 1);
});
