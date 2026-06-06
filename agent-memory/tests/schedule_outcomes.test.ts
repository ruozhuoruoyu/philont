/**
 * ScheduleOutcomeStore + 摘要 + 渲染 + 抽取 测试
 *
 * 覆盖:
 *   - extractScheduleIdFromSession:scheduled vs 普通 session
 *   - simplifyUrlPattern:uuid / hex / 数字段归一化
 *   - summarizeTurnTrace:三档 outcome / http stats / 失败签名去重
 *   - ScheduleOutcomeStore.record/recent/deleteBySchedule
 *   - renderScheduleOutcomesSection:空 vs 多条 + 排序
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';
import {
  extractScheduleIdFromSession,
  simplifyUrlPattern,
  summarizeTurnTrace,
  renderScheduleOutcomesSection,
  type ScheduleOutcomeInput,
} from '../src/schedule_outcomes.js';

// ── extractScheduleIdFromSession ──────────────────────────────────────

test('extractScheduleIdFromSession: scheduled session → id', () => {
  assert.equal(
    extractScheduleIdFromSession('system:scheduled:mycox-checkin'),
    'mycox-checkin',
  );
});

test('extractScheduleIdFromSession: 普通 user session → null', () => {
  assert.equal(
    extractScheduleIdFromSession('wechat:o9cq80...:o9cq80...'),
    null,
  );
});

test('extractScheduleIdFromSession: 空后缀 → null', () => {
  assert.equal(extractScheduleIdFromSession('system:scheduled:'), null);
});

// ── simplifyUrlPattern ────────────────────────────────────────────────

test('simplifyUrlPattern: uuid 段 → :id', () => {
  const out = simplifyUrlPattern(
    'https://mycox.ai/api/posts/0388aea8-39c6-4a76-b873-497e445d5674/upvote',
  );
  assert.equal(out, 'mycox.ai/api/posts/:id/upvote');
});

test('simplifyUrlPattern: 8+ hex public_id → :id', () => {
  const out = simplifyUrlPattern(
    'https://mycox.ai/api/posts/2f589e80/upvote',
  );
  assert.equal(out, 'mycox.ai/api/posts/:id/upvote');
});

test('simplifyUrlPattern: 4+ digit id → :id', () => {
  const out = simplifyUrlPattern('https://api.x/v1/users/12345/profile');
  assert.equal(out, 'api.x/v1/users/:id/profile');
});

test('simplifyUrlPattern: 保留语义路径段', () => {
  const out = simplifyUrlPattern('https://mycox.ai/api/posts?sort=hot&limit=15');
  assert.equal(out, 'mycox.ai/api/posts');
});

test('simplifyUrlPattern: 解析失败 → 截前 60 字符', () => {
  const out = simplifyUrlPattern('not-a-url');
  assert.equal(out, 'not-a-url');
});

// ── summarizeTurnTrace ────────────────────────────────────────────────

test('summarizeTurnTrace: 全成功 → outcome=ok', () => {
  const r = summarizeTurnTrace([
    { toolName: 'http', success: true, httpStatus: 200, httpMethod: 'GET' },
    { toolName: 'http', success: true, httpStatus: 201, httpMethod: 'POST' },
  ]);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.httpOkCount, 2);
  assert.equal(r.httpFailCount, 0);
  assert.deepEqual(r.httpStatusCounts, { '200': 1, '201': 1 });
  assert.deepEqual(r.failureSignatures, []);
  assert.match(r.textSummary, /http 2/);
});

test('summarizeTurnTrace: 全失败 → outcome=failed', () => {
  const r = summarizeTurnTrace([
    {
      toolName: 'http',
      success: false,
      httpStatus: 404,
      httpMethod: 'GET',
      httpUrl: 'https://mycox.ai/api/posts/2f589e80/upvote',
      errorSignature: 'http:404',
    },
    {
      toolName: 'http',
      success: false,
      httpStatus: 404,
      httpMethod: 'GET',
      httpUrl: 'https://mycox.ai/api/posts/764273b9/upvote',
      errorSignature: 'http:404',
    },
  ]);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.httpFailCount, 2);
  assert.deepEqual(r.failureSignatures, ['http:404']);  // 去重
  // URL pattern 应统一为 :id,所以两个失败合并成一行
  assert.match(r.textSummary, /GET mycox.ai\/api\/posts\/:id\/upvote → 404/);
});

test('summarizeTurnTrace: 有成功也有失败 → outcome=partial', () => {
  const r = summarizeTurnTrace([
    { toolName: 'http', success: true, httpStatus: 200, httpMethod: 'GET' },
    {
      toolName: 'http',
      success: false,
      httpStatus: 401,
      httpMethod: 'POST',
      httpUrl: 'https://mycox.ai/api/auth/verify',
      errorSignature: 'http:401',
    },
  ]);
  assert.equal(r.outcome, 'partial');
});

test('summarizeTurnTrace: 多个不同失败 url pattern → 最多列 3 个', () => {
  const traces = [];
  for (let i = 0; i < 6; i++) {
    traces.push({
      toolName: 'http',
      success: false,
      httpStatus: 500 + i,
      httpMethod: 'POST',
      httpUrl: `https://api.x/endpoint-${i}`,
      errorSignature: `http:5${i}`,
    });
  }
  const r = summarizeTurnTrace(traces);
  // textSummary 里只列前 3 个独特 pattern
  const detailMatch = r.textSummary.match(/POST [^;]+ → /g);
  assert.ok(detailMatch);
  assert.ok(detailMatch!.length <= 3);
});

test('summarizeTurnTrace: 非 http 工具不计入 stats', () => {
  const r = summarizeTurnTrace([
    { toolName: 'readFile', success: true },
    { toolName: 'http', success: true, httpStatus: 200 },
  ]);
  assert.equal(r.httpOkCount, 1);
});

test('summarizeTurnTrace: 空 trace → outcome=ok + textSummary 占位', () => {
  const r = summarizeTurnTrace([]);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.textSummary, '(no http calls)');
});

// ── ScheduleOutcomeStore CRUD ─────────────────────────────────────────

function makeOutcome(
  scheduleId: string,
  firedAt: number,
  outcome: 'ok' | 'partial' | 'failed' = 'ok',
  text = 'feed ✓',
): ScheduleOutcomeInput {
  return {
    scheduleId,
    firedAt,
    durationMs: 60_000,
    outcome,
    httpOkCount: 5,
    httpFailCount: outcome === 'ok' ? 0 : 2,
    httpStatusCounts: { '200': 5 },
    failureSignatures: outcome === 'ok' ? [] : ['http:404'],
    textSummary: text,
  };
}

test('ScheduleOutcomeStore.record + recent: 单条往返', () => {
  const memory = openMemoryDb(':memory:');
  const store = memory.scheduleOutcomes;
  const written = store.record(makeOutcome('mycox-checkin', 1000));
  assert.ok(written.id);
  assert.ok(written.createdAt > 0);
  const got = store.recent('mycox-checkin', 5);
  assert.equal(got.length, 1);
  assert.equal(got[0].textSummary, 'feed ✓');
});

test('ScheduleOutcomeStore.recent: 多条按 firedAt DESC', () => {
  const memory = openMemoryDb(':memory:');
  const store = memory.scheduleOutcomes;
  store.record(makeOutcome('s1', 1000, 'ok', 'old'));
  store.record(makeOutcome('s1', 2000, 'failed', 'mid'));
  store.record(makeOutcome('s1', 3000, 'ok', 'new'));
  const got = store.recent('s1', 10);
  assert.equal(got.length, 3);
  assert.equal(got[0].textSummary, 'new');
  assert.equal(got[1].textSummary, 'mid');
  assert.equal(got[2].textSummary, 'old');
});

test('ScheduleOutcomeStore.recent: limit 截断', () => {
  const memory = openMemoryDb(':memory:');
  const store = memory.scheduleOutcomes;
  for (let i = 0; i < 10; i++) store.record(makeOutcome('s2', i + 1));
  const got = store.recent('s2', 3);
  assert.equal(got.length, 3);
});

test('ScheduleOutcomeStore.recent: 不同 schedule 隔离', () => {
  const memory = openMemoryDb(':memory:');
  const store = memory.scheduleOutcomes;
  store.record(makeOutcome('sched-A', 1000));
  store.record(makeOutcome('sched-B', 2000));
  const a = store.recent('sched-A', 10);
  const b = store.recent('sched-B', 10);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0].id, b[0].id);
});

test('ScheduleOutcomeStore.recent: 未知 schedule → 空数组', () => {
  const memory = openMemoryDb(':memory:');
  const got = memory.scheduleOutcomes.recent('nonexistent', 5);
  assert.deepEqual(got, []);
});

test('ScheduleOutcomeStore.deleteBySchedule: 清空 + 返回删除数', () => {
  const memory = openMemoryDb(':memory:');
  const store = memory.scheduleOutcomes;
  store.record(makeOutcome('s3', 1));
  store.record(makeOutcome('s3', 2));
  store.record(makeOutcome('other', 3));
  const deleted = store.deleteBySchedule('s3');
  assert.equal(deleted, 2);
  assert.equal(store.recent('s3', 10).length, 0);
  assert.equal(store.recent('other', 10).length, 1);
});

test('ScheduleOutcomeStore.listScheduleIds: 去重', () => {
  const memory = openMemoryDb(':memory:');
  const store = memory.scheduleOutcomes;
  store.record(makeOutcome('a', 1));
  store.record(makeOutcome('a', 2));
  store.record(makeOutcome('b', 3));
  const ids = store.listScheduleIds().sort();
  assert.deepEqual(ids, ['a', 'b']);
});

// ── renderScheduleOutcomesSection ─────────────────────────────────────

test('renderScheduleOutcomesSection: 空数组 → 空串', () => {
  const out = renderScheduleOutcomesSection([], 'sched-X');
  assert.equal(out, '');
});

test('renderScheduleOutcomesSection: 多条 → 含 schedule id + 每条标志', () => {
  const memory = openMemoryDb(':memory:');
  const store = memory.scheduleOutcomes;
  store.record(makeOutcome('mycox-checkin', 1_700_000_000_000, 'ok', 'feed ✓ x3'));
  store.record(makeOutcome('mycox-checkin', 1_700_001_000_000, 'failed', 'GET /upvote → 404'));
  const list = store.recent('mycox-checkin', 5);
  const out = renderScheduleOutcomesSection(list, 'mycox-checkin');
  assert.match(out, /## Recent runs for this schedule/);
  assert.match(out, /mycox-checkin/);
  assert.match(out, /✓/);
  assert.match(out, /✗/);
  assert.match(out, /feed ✓ x3/);
  assert.match(out, /GET \/upvote → 404/);
  // hint line 提醒 LLM 别重试同 URL+method
  assert.match(out, /change approach, do not retry the same URL\+method/);
});
