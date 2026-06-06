/**
 * 记忆工具测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, createMemoryTools } from '../src/index.js';

test('store_fact tool stores and returns success', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  const r = await storeFact.execute({
    namespace: 'user',
    key: 'name',
    value: 'alice',
  });

  assert.equal(r.success, true);
  assert.ok(r.output?.includes('user.name'));
  assert.equal(facts.getFact('user', 'name')?.value, 'alice');
});

test('get_fact tool returns value', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  facts.storeFact({ namespace: 'user', key: 'age', value: 30 });

  const tools = createMemoryTools(facts, notes);
  const getFact = tools.find((t) => t.name === 'get_fact')!;

  const r = await getFact.execute({ namespace: 'user', key: 'age' });
  assert.equal(r.success, true);
  // output 现在带时间元数据前缀（见 formatFactTimes）
  assert.ok(r.output?.startsWith('30 ['), `unexpected output: ${r.output}`);
  assert.ok(r.output?.includes('recorded '));
});

test('get_fact returns error when missing', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const tools = createMemoryTools(facts, notes);
  const getFact = tools.find((t) => t.name === 'get_fact')!;

  const r = await getFact.execute({ namespace: 'user', key: 'ghost' });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('Not found'));
});

test('list_facts tool returns formatted list', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  facts.storeFact({ namespace: 'user', key: 'name', value: 'a' });
  facts.storeFact({ namespace: 'user', key: 'age', value: 30 });

  const tools = createMemoryTools(facts, notes);
  const listFacts = tools.find((t) => t.name === 'list_facts')!;

  const r = await listFacts.execute({ namespace: 'user' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('user.name'));
  assert.ok(r.output?.includes('user.age'));
});

test('search_notes tool finds matching content', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  notes.storeNote({ content: '用户讨论了缓存策略' });
  notes.storeNote({ content: '项目使用 Redis' });

  const tools = createMemoryTools(facts, notes);
  const searchNotes = tools.find((t) => t.name === 'search_notes')!;

  const r = await searchNotes.execute({ query: '缓存' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('缓存'));
});

test('store_fact rejects invalid namespace', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  const r = await storeFact.execute({ namespace: '', key: 'x', value: 1 });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('namespace'));
});

test('store_fact accepts ISO8601 time fields for event kind', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  const r = await storeFact.execute({
    namespace: 'user',
    key: 'lunch',
    value: '饺子',
    fact_kind: 'event',
    occurred_at: '2026-04-22T12:00:00+08:00',
  });

  assert.equal(r.success, true);
  const fact = facts.getFact('user', 'lunch')!;
  assert.equal(fact.factKind, 'event');
  assert.equal(fact.occurredAt, Date.parse('2026-04-22T12:00:00+08:00'));
  // output 带 event@ 标签
  assert.ok(r.output?.includes('event@'), `output missing event tag: ${r.output}`);
});

test('store_fact accepts valid_until for state kind (with expiry)', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  const r = await storeFact.execute({
    namespace: 'user',
    key: 'status',
    value: 'on_leave',
    fact_kind: 'state',
    valid_from: '2026-04-22T00:00:00+08:00',
    valid_until: '2026-04-26T23:59:59+08:00',
  });

  assert.equal(r.success, true);
  const fact = facts.getFact('user', 'status')!;
  assert.equal(fact.factKind, 'state');
  assert.equal(fact.validFrom, Date.parse('2026-04-22T00:00:00+08:00'));
  assert.equal(fact.validUntil, Date.parse('2026-04-26T23:59:59+08:00'));
  assert.ok(r.output?.includes('state '));
});

test('get_fact output embeds event timestamp and recorded time', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  facts.storeFact({
    namespace: 'user',
    key: 'meeting',
    value: 'weekly review',
    factKind: 'event',
    occurredAt: Date.parse('2026-04-22T15:00:00+08:00'),
  });

  const tools = createMemoryTools(facts, notes);
  const getFact = tools.find((t) => t.name === 'get_fact')!;

  const r = await getFact.execute({ namespace: 'user', key: 'meeting' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('event@'));
  assert.ok(r.output?.includes('2026-04-22T07:00:00.000Z')); // 15:00 +08 → 07:00 UTC
  assert.ok(r.output?.includes('recorded '));
});

// ── v6: recall_sessions tool ────────────────────────────────────────────

test('recall_sessions: aggregates message hits by session + attaches summary', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: '讨论数据库迁移策略' });
  raw.appendMessage({ sessionId: a.id, role: 'assistant', content: '建议跑影子表 backfill' });
  notes.upsertNote(`session-summary-${a.id}`, {
    content: '本次会话决定先建影子表再切流量',
    importance: 1.0,
    sessionId: a.id,
  });

  const b = raw.startSession();
  raw.appendMessage({ sessionId: b.id, role: 'user', content: '今晚要做迁移演练' });

  const tools = createMemoryTools(facts, notes, undefined, undefined, undefined, raw);
  const recall = tools.find((t) => t.name === 'recall_sessions');
  assert.ok(recall, 'recall_sessions 应被注册');

  const r = await recall!.execute({ query: '迁移' });
  assert.equal(r.success, true);
  const data = r.data as Array<{
    sessionId: string;
    summary: string | null;
    topHits: Array<{ snippet: string }>;
  }>;
  assert.equal(data.length, 2, '两个 session 都有命中');
  const aEntry = data.find((d) => d.sessionId === a.id)!;
  assert.ok(aEntry.summary?.includes('影子表'));
  assert.ok(aEntry.topHits.length >= 1);
});

test('recall_sessions: without RawStore the tool is not registered', () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const tools = createMemoryTools(facts, notes);
  assert.equal(tools.find((t) => t.name === 'recall_sessions'), undefined);
});

test('recall_sessions: empty query is rejected', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const tools = createMemoryTools(facts, notes, undefined, undefined, undefined, raw);
  const recall = tools.find((t) => t.name === 'recall_sessions')!;
  const r = await recall.execute({ query: '   ' });
  assert.equal(r.success, false);
});

test('recall_sessions: since / until filter scopes results', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const s = raw.startSession();
  raw.appendMessage({ sessionId: s.id, role: 'user', content: '旧消息 project alpha' });
  await new Promise((r) => setTimeout(r, 10));
  const boundary = Date.now();
  await new Promise((r) => setTimeout(r, 10));
  raw.appendMessage({ sessionId: s.id, role: 'user', content: '新消息 project alpha' });

  const tools = createMemoryTools(facts, notes, undefined, undefined, undefined, raw);
  const recall = tools.find((t) => t.name === 'recall_sessions')!;

  const older = await recall.execute({
    query: 'alpha',
    until: new Date(boundary).toISOString(),
  });
  assert.equal(older.success, true);
  const olderData = older.data as Array<{ topHits: Array<{ snippet: string }> }>;
  assert.equal(olderData.length, 1);
  assert.ok(olderData[0].topHits.some((h) => h.snippet.startsWith('旧消息')));

  const newer = await recall.execute({
    query: 'alpha',
    since: new Date(boundary).toISOString(),
  });
  const newerData = newer.data as Array<{ topHits: Array<{ snippet: string }> }>;
  assert.ok(newerData[0].topHits.some((h) => h.snippet.startsWith('新消息')));
});

test('list_facts output shows time label per fact', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  facts.storeFact({
    namespace: 'user',
    key: 'lunch',
    value: '面条',
    factKind: 'event',
    occurredAt: Date.parse('2026-04-21T12:00:00+08:00'),
  });
  facts.storeFact({
    namespace: 'user',
    key: 'role',
    value: 'engineer',
    factKind: 'state',
  });

  const tools = createMemoryTools(facts, notes);
  const listFacts = tools.find((t) => t.name === 'list_facts')!;

  const r = await listFacts.execute({ namespace: 'user' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('event@2026-04-21T04:00:00.000Z'));
  assert.ok(r.output?.includes('state '));
  const lines = r.output!.split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(/\[.*recorded .*\]/.test(line), `line missing time tag: ${line}`);
  }
});
