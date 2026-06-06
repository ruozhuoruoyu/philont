/**
 * user_pattern_observer 单测。
 *
 * 验证 keyword 抽取 / 模式聚类 / 候选生成。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  detectRecurringUserPatterns,
  extractPatternKeywords,
} from '../src/index.js';

function setup() {
  const handle = openMemoryDb(':memory:');
  return handle;
}

const NOW = 1_700_000_000_000; // 任意 epoch ms

function ensureSession(handle: ReturnType<typeof setup>, sessionId: string, ts: number) {
  (handle as any).db.prepare(
    `INSERT OR IGNORE INTO memory_raw_sessions (id, started_at) VALUES (?, ?)`
  ).run(sessionId, ts);
}

function pushUserMsg(handle: ReturnType<typeof setup>, sessionId: string, content: string, ts: number) {
  ensureSession(handle, sessionId, ts);
  // appendMessage 用 Date.now,我们直接 raw insert 控制 timestamp
  (handle as any).db.prepare(
    `INSERT INTO memory_raw_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`
  ).run(sessionId, 'user', content, ts);
}

function pushAction(handle: ReturnType<typeof setup>, sessionId: string, toolName: string, ts: number) {
  ensureSession(handle, sessionId, ts);
  (handle as any).db.prepare(
    `INSERT INTO memory_actions (session_id, trigger, tool_name, params_json, result, success, timestamp, linked_skill)
     VALUES (?, NULL, ?, ?, NULL, 1, ?, NULL)`
  ).run(sessionId, toolName, '{}', ts);
}

// ── extractKeywords ────────────────────────────────────────────────────

test('extractPatternKeywords:中文 2-gram + 英文 word + 去停用词', () => {
  const k = extractPatternKeywords('帮我读未读邮件并总结');
  assert.ok(k.has('未读') || k.has('读未'));
  assert.ok(k.has('邮件'));
  // 停用词不能单独成词,但可作为 bigram 一部分(当前实现)
});

test('extractKeywords:英文混合', () => {
  const k = extractPatternKeywords('use webSearch to find docs');
  assert.ok(k.has('websearch'));
  assert.ok(k.has('find'));
  assert.ok(k.has('docs'));
  assert.ok(!k.has('the'));
  assert.ok(!k.has('to'));
});

test('extractKeywords:空 / 仅停用词 → 空集', () => {
  assert.equal(extractPatternKeywords('').size, 0);
  assert.equal(extractPatternKeywords('the a of').size, 0);
});

// ── detectRecurringUserPatterns ───────────────────────────────────────

test('3 次相似操作链 → 命中候选', () => {
  const handle = setup();
  // 模拟 3 次"读邮件 → 总结 → 写文件"操作链
  // 用高度相似的 user 消息以满足 jaccard ≥ 0.5
  pushUserMsg(handle, 's1', '帮我读邮件总结', NOW - 10 * 86400_000);
  pushAction(handle, 's1', 'webFetch', NOW - 10 * 86400_000 + 1000);
  pushAction(handle, 's1', 'writeFile', NOW - 10 * 86400_000 + 2000);

  pushUserMsg(handle, 's2', '帮我看邮件总结', NOW - 5 * 86400_000);
  pushAction(handle, 's2', 'webFetch', NOW - 5 * 86400_000 + 1000);
  pushAction(handle, 's2', 'writeFile', NOW - 5 * 86400_000 + 2000);

  pushUserMsg(handle, 's3', '帮我读邮件总结一下', NOW - 1 * 86400_000);
  pushAction(handle, 's3', 'webFetch', NOW - 1 * 86400_000 + 1000);
  pushAction(handle, 's3', 'writeFile', NOW - 1 * 86400_000 + 2000);

  const candidates = detectRecurringUserPatterns({
    raw: handle.raw,
    actions: handle.actions,
    now: NOW,
    minOccurrences: 3,
  });

  assert.ok(candidates.length >= 1, `应找到至少 1 个候选,实际 ${candidates.length}`);
  const c = candidates[0];
  assert.equal(c.occurrences, 3);
  assert.deepEqual(c.toolSequence, ['webFetch', 'writeFile']);
  assert.ok(c.signature.length === 12);
  assert.ok(c.examples.length === 3);
  handle.close();
});

test('< minOccurrences → 不命中', () => {
  const handle = setup();
  pushUserMsg(handle, 's1', '帮我读邮件总结', NOW - 5 * 86400_000);
  pushAction(handle, 's1', 'webFetch', NOW - 5 * 86400_000 + 1000);
  pushUserMsg(handle, 's2', '看下邮件并总结', NOW - 1 * 86400_000);
  pushAction(handle, 's2', 'webFetch', NOW - 1 * 86400_000 + 1000);

  const candidates = detectRecurringUserPatterns({
    raw: handle.raw,
    actions: handle.actions,
    now: NOW,
    minOccurrences: 3,
  });
  assert.equal(candidates.length, 0);
  handle.close();
});

test('不同关键词不聚类', () => {
  const handle = setup();
  pushUserMsg(handle, 's1', '帮我读邮件', NOW - 3 * 86400_000);
  pushAction(handle, 's1', 'webFetch', NOW - 3 * 86400_000 + 1000);
  pushUserMsg(handle, 's2', '查一下天气', NOW - 2 * 86400_000);
  pushAction(handle, 's2', 'webSearch', NOW - 2 * 86400_000 + 1000);
  pushUserMsg(handle, 's3', '生成一首诗', NOW - 1 * 86400_000);
  pushAction(handle, 's3', 'echo', NOW - 1 * 86400_000 + 1000);

  const candidates = detectRecurringUserPatterns({
    raw: handle.raw,
    actions: handle.actions,
    now: NOW,
    minOccurrences: 3,
  });
  assert.equal(candidates.length, 0, '完全不同的 3 个 turn 不应聚类');
  handle.close();
});

test('windowDays 截断:30 天前的不进窗', () => {
  const handle = setup();
  // 都 60 天前 → 不进默认 30 天窗
  for (let i = 0; i < 5; i++) {
    pushUserMsg(handle, `s${i}`, '读邮件总结', NOW - (60 - i) * 86400_000);
    pushAction(handle, `s${i}`, 'webFetch', NOW - (60 - i) * 86400_000 + 1000);
  }
  const candidates = detectRecurringUserPatterns({
    raw: handle.raw,
    actions: handle.actions,
    now: NOW,
    windowDays: 30,
    minOccurrences: 3,
  });
  assert.equal(candidates.length, 0);
  handle.close();
});

test('工具序列差异 ≤ 1 仍聚类', () => {
  const handle = setup();
  // 3 次,工具序列分别 [a, b]、[a, b]、[a, b, c](edit dist=1)
  pushUserMsg(handle, 's1', '帮我读邮件总结', NOW - 5 * 86400_000);
  pushAction(handle, 's1', 'webFetch', NOW - 5 * 86400_000 + 1000);
  pushAction(handle, 's1', 'writeFile', NOW - 5 * 86400_000 + 2000);

  pushUserMsg(handle, 's2', '帮我读邮件总结', NOW - 3 * 86400_000);
  pushAction(handle, 's2', 'webFetch', NOW - 3 * 86400_000 + 1000);
  pushAction(handle, 's2', 'writeFile', NOW - 3 * 86400_000 + 2000);

  pushUserMsg(handle, 's3', '帮我读邮件总结一下', NOW - 1 * 86400_000);
  pushAction(handle, 's3', 'webFetch', NOW - 1 * 86400_000 + 1000);
  pushAction(handle, 's3', 'writeFile', NOW - 1 * 86400_000 + 2000);
  pushAction(handle, 's3', 'echo', NOW - 1 * 86400_000 + 3000); // 多一个

  const candidates = detectRecurringUserPatterns({
    raw: handle.raw,
    actions: handle.actions,
    now: NOW,
    minOccurrences: 3,
  });
  assert.ok(candidates.length >= 1, `edit≤1 容忍下应聚类成功`);
  handle.close();
});

test('signature 稳定:同样 keywords + tool seq 多次跑得同 sig', () => {
  const handle = setup();
  for (let i = 0; i < 3; i++) {
    pushUserMsg(handle, `s${i}`, '帮我读邮件总结', NOW - (5 - i) * 86400_000);
    pushAction(handle, `s${i}`, 'webFetch', NOW - (5 - i) * 86400_000 + 1000);
    pushAction(handle, `s${i}`, 'writeFile', NOW - (5 - i) * 86400_000 + 2000);
  }
  const a = detectRecurringUserPatterns({ raw: handle.raw, actions: handle.actions, now: NOW });
  const b = detectRecurringUserPatterns({ raw: handle.raw, actions: handle.actions, now: NOW });
  assert.equal(a[0]?.signature, b[0]?.signature);
  handle.close();
});
