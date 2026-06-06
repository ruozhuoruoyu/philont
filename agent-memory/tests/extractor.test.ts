/**
 * SessionExtractor 测试
 *
 * 使用 Mock LLM 客户端避免真实 API 调用
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, SessionExtractor } from '../src/index.js';
import type { ExtractorLlmClient } from '../src/extractor.js';

// Mock LLM：返回预设的响应
class MockLlm implements ExtractorLlmClient {
  constructor(private readonly response: string) {}
  async complete(_prompt: string) {
    return { text: this.response, tokensUsed: 100 };
  }
}

test('extract structured facts from session', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');

  // 准备会话
  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '我叫张三，项目地址 github.com/acme/core',
  });
  raw.appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '好的，张三',
  });

  // Mock LLM 返回提取结果
  const mockLlm = new MockLlm(
    JSON.stringify([
      { action: 'store_fact', namespace: 'user', key: 'name', value: '张三' },
      {
        action: 'store_fact',
        namespace: 'project',
        key: 'repo_url',
        value: 'github.com/acme/core',
      },
    ])
  );

  const extractor = new SessionExtractor(mockLlm, facts, notes, raw);
  const result = await extractor.extractFromSession(session.id);

  assert.equal(result.factsStored, 2);
  assert.equal(result.notesStored, 0);

  // 验证实际存入
  assert.equal(facts.getFact('user', 'name')?.value, '张三');
  assert.equal(facts.getFact('project', 'repo_url')?.value, 'github.com/acme/core');
});

test('extract mixed facts and notes', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');

  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '我对 Rust 的借用检查器感到困惑',
  });

  const mockLlm = new MockLlm(
    JSON.stringify([
      {
        action: 'store_note',
        content: '用户对 Rust borrow checker 表示困惑',
        importance: 0.6,
      },
    ])
  );

  const extractor = new SessionExtractor(mockLlm, facts, notes, raw);
  const result = await extractor.extractFromSession(session.id);

  assert.equal(result.factsStored, 0);
  assert.equal(result.notesStored, 1);
  assert.equal(notes.count(), 1);
});

test('handle empty session gracefully', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const session = raw.startSession();

  const mockLlm = new MockLlm('[]');
  const extractor = new SessionExtractor(mockLlm, facts, notes, raw);
  const result = await extractor.extractFromSession(session.id);

  assert.equal(result.factsStored, 0);
  assert.equal(result.notesStored, 0);
  assert.equal(result.llmCostTokens, 0); // 短路：未调用 LLM
});

test('parser handles markdown code block wrapping', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');

  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: 'hello',
  });

  // LLM 有时会包 ```json ... ```
  const mockLlm = new MockLlm(
    '```json\n[{"action":"store_fact","namespace":"user","key":"greeting","value":"hello"}]\n```'
  );

  const extractor = new SessionExtractor(mockLlm, facts, notes, raw);
  const result = await extractor.extractFromSession(session.id);

  assert.equal(result.factsStored, 1);
  assert.equal(facts.getFact('user', 'greeting')?.value, 'hello');
});

test('parser gracefully handles malformed output', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');

  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: 'test',
  });

  const mockLlm = new MockLlm('this is not json at all');
  const extractor = new SessionExtractor(mockLlm, facts, notes, raw);
  const result = await extractor.extractFromSession(session.id);

  assert.equal(result.factsStored, 0);
  assert.equal(result.notesStored, 0);
  // 不应抛错
});

test('extract fact with ISO8601 time fields (occurred_at, valid_until)', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '我下周一下午3点要开评审,休假到下下周五',
  });

  // Mock LLM 返回带时间字段的 fact
  const mockLlm = new MockLlm(
    JSON.stringify([
      {
        action: 'store_fact',
        namespace: 'project',
        key: 'review_meeting',
        value: '下周一评审',
        fact_kind: 'event',
        occurred_at: '2026-04-20T15:00:00+08:00',
      },
      {
        action: 'store_fact',
        namespace: 'user',
        key: 'status',
        value: 'on_leave',
        fact_kind: 'state',
        valid_from: '2026-04-17T00:00:00+08:00',
        valid_until: '2026-04-24T23:59:59+08:00',
      },
    ])
  );

  const extractor = new SessionExtractor(mockLlm, facts, notes, raw, {
    currentDate: () => new Date('2026-04-17T10:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });
  const result = await extractor.extractFromSession(session.id);

  assert.equal(result.factsStored, 2);

  const reviewFact = facts.getFact('project', 'review_meeting');
  assert.ok(reviewFact);
  assert.equal(reviewFact.factKind, 'event');
  assert.equal(reviewFact.occurredAt, Date.parse('2026-04-20T15:00:00+08:00'));

  const statusFact = facts.getFact('user', 'status');
  assert.ok(statusFact);
  assert.equal(statusFact.factKind, 'state');
  assert.equal(statusFact.validFrom, Date.parse('2026-04-17T00:00:00+08:00'));
  assert.equal(statusFact.validUntil, Date.parse('2026-04-24T23:59:59+08:00'));
});

test('extractor mirrors future event fact to CalendarStore', async () => {
  const { facts, notes, raw, calendar } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '下周一下午 3 点开评审',
  });

  const mockLlm = new MockLlm(
    JSON.stringify([
      {
        action: 'store_fact',
        namespace: 'project',
        key: 'review_meeting',
        value: '评审会议',
        fact_kind: 'event',
        occurred_at: '2026-04-20T15:00:00+08:00',
      },
    ])
  );

  const extractor = new SessionExtractor(mockLlm, facts, notes, raw, {
    currentDate: () => new Date('2026-04-17T10:00:00+08:00'),
    timezone: 'Asia/Shanghai',
    calendar,
  });
  await extractor.extractFromSession(session.id);

  // 日历应有一条镜像事件
  const upcoming = calendar.upcoming(
    10 * 86_400_000,
    Date.parse('2026-04-17T10:00:00+08:00')
  );
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].title, '评审会议');
  assert.equal(upcoming[0].timezone, 'Asia/Shanghai');
  assert.ok(upcoming[0].relatedFactId, '应关联到原 fact');
});

test('extractor skips calendar mirror for past events', async () => {
  const { facts, notes, raw, calendar } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '昨天提了 PR',
  });

  const mockLlm = new MockLlm(
    JSON.stringify([
      {
        action: 'store_fact',
        namespace: 'project',
        key: 'pr_event',
        value: '提 PR',
        fact_kind: 'event',
        occurred_at: '2026-04-16T10:00:00+08:00', // 过去
      },
    ])
  );

  const extractor = new SessionExtractor(mockLlm, facts, notes, raw, {
    currentDate: () => new Date('2026-04-17T10:00:00+08:00'),
    timezone: 'Asia/Shanghai',
    calendar,
  });
  await extractor.extractFromSession(session.id);

  assert.equal(calendar.count(), 0, '过去事件不该写入日历');
});

test('getActiveAt: temporal query over validity window', async () => {
  const { facts } = openMemoryDb(':memory:');

  const t1 = Date.parse('2026-01-01T00:00:00Z');
  const t2 = Date.parse('2026-03-01T00:00:00Z');
  const t3 = Date.parse('2026-06-01T00:00:00Z');

  facts.storeFact({
    namespace: 'user',
    key: 'role',
    value: 'engineer',
    factKind: 'state',
    validFrom: t1,
    validUntil: t2 - 1,
  });
  facts.storeFact({
    namespace: 'user',
    key: 'role',
    value: 'lead',
    factKind: 'state',
    validFrom: t2,
    validUntil: null,
  });

  // 2026-02 时应是 engineer
  const feb = facts.getActiveAt('user', 'role', Date.parse('2026-02-15T00:00:00Z'));
  assert.equal(feb?.value, 'engineer');

  // 2026-06 时应是 lead
  const jun = facts.getActiveAt('user', 'role', t3);
  assert.equal(jun?.value, 'lead');

  // 2025-12 时不存在(早于所有 valid_from)
  const before = facts.getActiveAt('user', 'role', Date.parse('2025-12-01T00:00:00Z'));
  assert.equal(before, null);
});

test('storeFact rejects invalid validity window', () => {
  const { facts } = openMemoryDb(':memory:');

  assert.throws(
    () =>
      facts.storeFact({
        namespace: 'user',
        key: 'x',
        value: 'v',
        validFrom: 2000,
        validUntil: 1000, // 早于 from
      }),
    /valid_until/
  );
});

test('skip malformed action entries', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');

  const session = raw.startSession();
  raw.appendMessage({ sessionId: session.id, role: 'user', content: 'x' });

  const mockLlm = new MockLlm(
    JSON.stringify([
      { action: 'store_fact', namespace: 'user', key: 'valid', value: 'ok' },
      { action: 'store_fact', namespace: 'user' }, // 缺 key/value
      { action: 'unknown' }, // 未知 action
      { action: 'store_fact', namespace: 'user', key: 'another', value: 42 },
    ])
  );

  const extractor = new SessionExtractor(mockLlm, facts, notes, raw);
  const result = await extractor.extractFromSession(session.id);

  // 只有 2 条有效
  assert.equal(result.factsStored, 2);
  assert.equal(facts.getFact('user', 'valid')?.value, 'ok');
  assert.equal(facts.getFact('user', 'another')?.value, 42);
});
