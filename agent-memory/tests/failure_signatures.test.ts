/**
 * failure_signatures 单测:extractFailureSignature 各 error class +
 * countSameRootCauseFailures 聚类。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  extractFailureSignature,
  countSameRootCauseFailures,
  groupFailures,
} from '../src/index.js';
import type { Action } from '../src/types.js';

// ── extractFailureSignature ────────────────────────────────────────────

test('sig: shell command not found', () => {
  const s = extractFailureSignature(
    'shell',
    '⚠ TOOL FAILED: bash: command not found: rg',
  );
  assert.equal(s, 'shell:cmd-not-found:rg');
});

test('sig: command not found 反向词序("rg: command not found")', () => {
  const s = extractFailureSignature('shell', 'rg: command not found');
  assert.equal(s, 'shell:cmd-not-found:rg');
});

test('sig: ENOENT', () => {
  const s = extractFailureSignature(
    'readFile',
    'ENOENT: no such file or directory, open /tmp/x.docx',
  );
  assert.equal(s, 'readFile:enoent');
});

test('sig: no such file 文本', () => {
  const s = extractFailureSignature('shell', 'cat: /tmp/x.docx: No such file or directory');
  assert.equal(s, 'shell:enoent');
});

test('sig: permission denied', () => {
  assert.equal(
    extractFailureSignature('writeFile', 'EACCES: permission denied'),
    'writeFile:permission-denied',
  );
  assert.equal(
    extractFailureSignature('shell', 'rm: cannot remove: Operation not permitted'),
    'shell:permission-denied',
  );
});

test('sig: timeout', () => {
  assert.equal(
    extractFailureSignature('webFetch', '⚠ ETIMEDOUT'),
    'webFetch:timeout',
  );
  assert.equal(
    extractFailureSignature('shell', 'process killed at default timeout'),
    'shell:timeout',
  );
  assert.equal(
    extractFailureSignature('webSearch', 'request timed out after 30s'),
    'webSearch:timeout',
  );
});

test('sig: ECONNREFUSED', () => {
  assert.equal(
    extractFailureSignature('http', 'connect ECONNREFUSED 127.0.0.1:5432'),
    'http:econnrefused',
  );
  assert.equal(
    extractFailureSignature('http', 'Connection refused by peer'),
    'http:econnrefused',
  );
});

test('sig: EADDRINUSE', () => {
  assert.equal(
    extractFailureSignature('process', 'EADDRINUSE: port 3000'),
    'process:eaddrinuse',
  );
});

test('sig: HTTP status 4xx/5xx', () => {
  assert.equal(extractFailureSignature('webFetch', 'HTTP 404 Not Found'), 'webFetch:http-404');
  assert.equal(
    extractFailureSignature('webFetch', 'received status: 503'),
    'webFetch:http-503',
  );
  assert.equal(
    extractFailureSignature('webFetch', '500 Internal Server Error'),
    'webFetch:http-500',
  );
});

test('sig: 兜底前 30 字', () => {
  const s = extractFailureSignature(
    'webFetch',
    '⚠ TOOL FAILED: weird unknown error blah blah',
  );
  assert.match(s, /^webFetch:other:weird unknown error blah blah/);
});

test('sig: 兜底剥 ⚠ 与多余空白', () => {
  const s = extractFailureSignature('shell', '⚠   TOOL FAILED:  some weird error here');
  assert.match(s, /^shell:other:some weird error/);
});

test('sig: 空 result → other 后续是空字符串', () => {
  const s1 = extractFailureSignature('shell', '');
  const s2 = extractFailureSignature('shell', null);
  const s3 = extractFailureSignature('shell', undefined);
  assert.equal(s1, 'shell:other:');
  assert.equal(s2, 'shell:other:');
  assert.equal(s3, 'shell:other:');
});

test('sig: 不同 tool 同 error class → 不同签名', () => {
  const s1 = extractFailureSignature('readFile', 'ENOENT: no such file');
  const s2 = extractFailureSignature('shell', 'ENOENT: no such file');
  assert.notEqual(s1, s2);
});

test('sig: cmd 名特殊字符过滤', () => {
  const s = extractFailureSignature('shell', "command not found: ../bad'cmd");
  // 只留 a-zA-Z0-9._-+
  assert.match(s, /^shell:cmd-not-found:/);
  assert.ok(!s.includes("'"), `不应含引号: ${s}`);
});

// ── countSameRootCauseFailures ─────────────────────────────────────────

function fail(toolName: string, result: string, ts = 0): Action {
  return {
    id: 0,
    sessionId: 's',
    trigger: null,
    toolName,
    params: {},
    result,
    success: false,
    timestamp: ts,
    linkedSkill: null,
  };
}

test('count: 空 → 0', () => {
  assert.equal(countSameRootCauseFailures([]), 0);
});

test('count: 1 个失败 → 1', () => {
  assert.equal(
    countSameRootCauseFailures([fail('shell', 'command not found: rg')]),
    1,
  );
});

test('count: 3 同签 → 3', () => {
  assert.equal(
    countSameRootCauseFailures([
      fail('shell', 'command not found: rg'),
      fail('shell', 'rg: command not found'),
      fail('shell', 'bash: command not found: rg'),
    ]),
    3,
  );
});

test('count: 3 不同签 → 1(每组只有 1)', () => {
  assert.equal(
    countSameRootCauseFailures([
      fail('shell', 'command not found: rg'),
      fail('webFetch', 'ETIMEDOUT'),
      fail('readFile', 'ENOENT'),
    ]),
    1,
  );
});

test('count: 混合 — 4 同签 + 2 异签 → 4', () => {
  const f = countSameRootCauseFailures([
    fail('shell', 'command not found: rg'),
    fail('shell', 'rg: command not found'),
    fail('webFetch', 'ETIMEDOUT'),
    fail('shell', 'rg: command not found'),
    fail('shell', 'rg: command not found'),
    fail('readFile', 'ENOENT'),
  ]);
  assert.equal(f, 4);
});

test('count: 不同 tool 同 error class 不算同根因', () => {
  // shell ENOENT 和 readFile ENOENT 是两种不同的"漏洞",各算各的
  assert.equal(
    countSameRootCauseFailures([
      fail('shell', 'ENOENT: no such file: /a'),
      fail('readFile', 'ENOENT: no such file: /b'),
    ]),
    1,
  );
});

// ── groupFailures(详细聚类)─────────────────────────────────────────

test('group: 排序按 count DESC', () => {
  const groups = groupFailures([
    fail('shell', 'command not found: rg'),
    fail('webFetch', 'ETIMEDOUT'),
    fail('shell', 'rg: command not found'),
    fail('shell', 'rg: command not found'),
  ]);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].toolName, 'shell');
  assert.equal(groups[1].count, 1);
});

test('group: 机制拒绝 rejected_by_* 被排除(回归:旧正则写成 [mechanism 漏匹配 → 噪声漏进 same_root_cause)', () => {
  const groups = groupFailures([
    fail('deep_explore', 'rejected_by_plan_protocol_gate'),
    fail('deep_explore', 'rejected_by_plan_protocol_gate'),
    fail('deep_explore', 'rejected_by_plan_protocol_gate'),
    fail('shell', 'rejected_by_autonomous_blacklist'),
    fail('plan_update_step', 'rejected_by_research_before_retry'),
    fail('x', 'rejected_by_in_turn_reflection'),
    fail('y', 'rejected_by_ask_guard'),
    fail('shell', 'command not found: rg'), // a REAL failure must still count
  ]);
  // every rejected_by_* mechanism rejection is excluded → only the real shell failure groups remain
  assert.equal(groups.length, 1);
  assert.equal(groups[0].signature, 'shell:cmd-not-found:rg');
  assert.equal(groups[0].count, 1);
});

test('group: latestTs 取该签命中的最大 timestamp', () => {
  const groups = groupFailures([
    fail('shell', 'rg: command not found', 100),
    fail('shell', 'rg: command not found', 300),
    fail('shell', 'rg: command not found', 200),
  ]);
  assert.equal(groups[0].latestTs, 300);
});

// ── ActionLog.listRecentFailures ───────────────────────────────────────

test('listRecentFailures: 仅返 success=0 + DESC 时间', () => {
  const h = openMemoryDb(':memory:');
  // 注入 3 个失败 + 1 个成功
  h.actions.log({
    sessionId: 's', toolName: 'shell', params: {}, result: 'bash: command not found: rg',
    success: false,
  });
  h.actions.log({
    sessionId: 's', toolName: 'shell', params: {}, result: '',
    success: true,
  });
  h.actions.log({
    sessionId: 's', toolName: 'webFetch', params: {}, result: 'ETIMEDOUT',
    success: false,
  });
  h.actions.log({
    sessionId: 's', toolName: 'shell', params: {}, result: 'rg: command not found',
    success: false,
  });

  const failures = h.actions.listRecentFailures({ limit: 10 });
  assert.equal(failures.length, 3);
  // 全 success=false
  for (const f of failures) {
    assert.equal(f.success, false);
  }
  // 应按时间 DESC,所以最新的 shell:rg 在前
  assert.equal(failures[0].toolName, 'shell');
  assert.match(failures[0].result ?? '', /rg/);

  // 喂 countSameRootCauseFailures
  assert.equal(countSameRootCauseFailures(failures), 2); // 两条 cmd-not-found:rg
  h.close();
});

test('listRecentFailures: sinceTs cutoff 生效', () => {
  const h = openMemoryDb(':memory:');
  h.actions.log({
    sessionId: 's', toolName: 'shell', params: {}, result: 'old fail',
    success: false,
  });
  // 等 5ms 让 timestamp 不同
  const cutoff = Date.now() + 1;
  h.actions.log({
    sessionId: 's', toolName: 'shell', params: {}, result: 'new fail',
    success: false,
  });

  const recent = h.actions.listRecentFailures({ sinceTs: cutoff, limit: 10 });
  // 只剩 new
  for (const f of recent) {
    assert.match(f.result ?? '', /new/);
  }
  h.close();
});

test('listRecentFailures: limit 截断', () => {
  const h = openMemoryDb(':memory:');
  for (let i = 0; i < 5; i++) {
    h.actions.log({
      sessionId: 's', toolName: 'shell', params: {}, result: `fail ${i}`,
      success: false,
    });
  }
  const r = h.actions.listRecentFailures({ limit: 3 });
  assert.equal(r.length, 3);
  h.close();
});

// Phase 11(2026-05-14):sessionId 过滤
test('listRecentFailures: sessionId 过滤生效', () => {
  const h = openMemoryDb(':memory:');
  // 3 个 session-A 失败 + 2 个 session-B 失败
  for (let i = 0; i < 3; i++) {
    h.actions.log({
      sessionId: 'sess-A',
      toolName: 'http',
      params: {},
      result: 'http-404 Post not found',
      success: false,
    });
  }
  for (let i = 0; i < 2; i++) {
    h.actions.log({
      sessionId: 'sess-B',
      toolName: 'shell',
      params: {},
      result: 'cmd not found',
      success: false,
    });
  }
  // 不过滤 → 5 条
  assert.equal(h.actions.listRecentFailures({ limit: 10 }).length, 5);
  // sessionId=A → 3 条
  const aOnly = h.actions.listRecentFailures({ limit: 10, sessionId: 'sess-A' });
  assert.equal(aOnly.length, 3);
  for (const a of aOnly) assert.equal(a.sessionId, 'sess-A');
  // sessionId=B → 2 条
  const bOnly = h.actions.listRecentFailures({ limit: 10, sessionId: 'sess-B' });
  assert.equal(bOnly.length, 2);
  // sessionId 不存在 → 0 条
  assert.equal(
    h.actions.listRecentFailures({ limit: 10, sessionId: 'sess-X' }).length,
    0,
  );
  h.close();
});

test('listRecentFailures: sessionId + sinceTs 组合 — sessionId 过滤后再 sinceTs', () => {
  const h = openMemoryDb(':memory:');
  // session-A 一次失败
  h.actions.log({
    sessionId: 'sess-A',
    toolName: 'http',
    params: {},
    result: 'A fail',
    success: false,
  });
  // session-B 一次失败
  h.actions.log({
    sessionId: 'sess-B',
    toolName: 'http',
    params: {},
    result: 'B fail',
    success: false,
  });
  const r = h.actions.listRecentFailures({
    sinceTs: Date.now() - 60_000,
    sessionId: 'sess-A',
    limit: 10,
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].sessionId, 'sess-A');
  assert.match(r[0].result ?? '', /A fail/);
  h.close();
});
