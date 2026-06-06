/**
 * user_pattern_inject 单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import type { PatternCandidate } from '@agent/memory';
import {
  savePatternCandidate,
  listPendingPatterns,
  markPatternStatus,
  buildUserPatternObservationSection,
  detectPatternConfirmation,
} from '../src/user_pattern_inject.js';

function setup() {
  return openMemoryDb(':memory:');
}

function makeCandidate(sig = 'abc123def456'): PatternCandidate {
  return {
    signature: sig,
    occurrences: 3,
    examples: [
      { ts: Date.now() - 86400_000, userMessage: '帮我读邮件总结', toolSequence: ['webFetch', 'writeFile'] },
      { ts: Date.now() - 2 * 86400_000, userMessage: '帮我看邮件总结', toolSequence: ['webFetch', 'writeFile'] },
      { ts: Date.now() - 3 * 86400_000, userMessage: '帮我读邮件总结一下', toolSequence: ['webFetch', 'writeFile'] },
    ],
    keywords: ['帮我', '邮件', '总结'],
    toolSequence: ['webFetch', 'writeFile'],
    firstSeenTs: Date.now() - 3 * 86400_000,
    lastSeenTs: Date.now() - 86400_000,
    rationale: '最近 30 天发生 3 次类似操作',
  };
}

// ── 持久化 ────────────────────────────────────────────────────────────

test('savePatternCandidate + listPendingPatterns', () => {
  const handle = setup();
  const c = makeCandidate('aaa111bbb222');
  savePatternCandidate(handle.facts, c);
  const pending = listPendingPatterns(handle.facts);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].signature, 'aaa111bbb222');
  assert.equal(pending[0].status, 'pending');
  assert.equal(pending[0].candidate.occurrences, 3);
  handle.close();
});

test('markPatternStatus → 后续 listPending 不返', () => {
  const handle = setup();
  savePatternCandidate(handle.facts, makeCandidate('aaa111bbb222'));
  const ok = markPatternStatus(handle.facts, 'aaa111bbb222', 'confirmed');
  assert.equal(ok, true);
  const pending = listPendingPatterns(handle.facts);
  assert.equal(pending.length, 0);
  handle.close();
});

test('markPatternStatus 不存在的 sig → false', () => {
  const handle = setup();
  const ok = markPatternStatus(handle.facts, 'nonexistent12', 'declined');
  assert.equal(ok, false);
  handle.close();
});

// ── 渲染 ──────────────────────────────────────────────────────────────

test('buildUserPatternObservationSection:0 patterns → 空', () => {
  const r = buildUserPatternObservationSection([]);
  assert.equal(r.matched, false);
  assert.equal(r.text, '');
});

test('buildUserPatternObservationSection:1 pattern 渲染 + 含确认提示', () => {
  const c = makeCandidate('aaa111bbb222');
  const r = buildUserPatternObservationSection([
    { signature: c.signature, status: 'pending', candidate: c, proposedAt: Date.now() },
  ]);
  assert.equal(r.matched, true);
  assert.match(r.text, /我观察到的模式/);
  assert.match(r.text, /aaa111bbb222/);
  assert.match(r.text, /webFetch.*writeFile/);
  assert.match(r.text, /学.*自动化/);
  assert.match(r.text, /不要.*跳过/);
});

test('buildUserPatternObservationSection:多 pattern,maxPatterns 截断', () => {
  const patterns = [
    { signature: 'sig1abc12345', status: 'pending' as const, candidate: makeCandidate('sig1abc12345'), proposedAt: 100 },
    { signature: 'sig2def12345', status: 'pending' as const, candidate: makeCandidate('sig2def12345'), proposedAt: 200 },
    { signature: 'sig3ghi12345', status: 'pending' as const, candidate: makeCandidate('sig3ghi12345'), proposedAt: 300 },
  ];
  const r = buildUserPatternObservationSection(patterns, { maxPatterns: 2 });
  assert.equal(r.shownPatterns.length, 2);
  // sig1 应该被截掉(最旧)? sort by proposedAt desc → sig3, sig2, sig1
  // 等等,patterns 是数组顺序,不是 sorted。listPendingPatterns 排序了,buildUserPatternObservationSection 接受任意顺序
  // 该函数取前 maxPatterns 个,所以是数组前两个
  assert.equal(r.shownPatterns[0].signature, 'sig1abc12345');
});

// ── 确认 / 拒绝 检测 ─────────────────────────────────────────────────

test('detectPatternConfirmation:确认词', () => {
  assert.equal(detectPatternConfirmation('学').kind, 'confirm');
  assert.equal(detectPatternConfirmation('学吧').kind, 'confirm');
  assert.equal(detectPatternConfirmation('好的,学一个').kind, 'confirm');
  assert.equal(detectPatternConfirmation('帮我自动化').kind, 'confirm');
  assert.equal(detectPatternConfirmation('yes').kind, 'confirm');
  assert.equal(detectPatternConfirmation('OK').kind, 'confirm');
  assert.equal(detectPatternConfirmation('好').kind, 'confirm');
  assert.equal(detectPatternConfirmation('确认').kind, 'confirm');
});

test('detectPatternConfirmation:拒绝词', () => {
  assert.equal(detectPatternConfirmation('不要').kind, 'decline');
  assert.equal(detectPatternConfirmation('不学').kind, 'decline');
  assert.equal(detectPatternConfirmation('跳过').kind, 'decline');
  assert.equal(detectPatternConfirmation('no').kind, 'decline');
  assert.equal(detectPatternConfirmation('不要学').kind, 'decline');
});

test('detectPatternConfirmation:含 signature 引用', () => {
  const r = detectPatternConfirmation('学 aaa111bbb222');
  assert.equal(r.kind, 'confirm');
  assert.equal(r.signature, 'aaa111bbb222');
});

test('detectPatternConfirmation:无关消息 → none', () => {
  assert.equal(detectPatternConfirmation('帮我查 Python 文档').kind, 'none');
  assert.equal(detectPatternConfirmation('').kind, 'none');
  assert.equal(detectPatternConfirmation('今天天气').kind, 'none');
});

test('detectPatternConfirmation:歧义"不要学"识别为 decline 不是 confirm', () => {
  // 如果 "学" 和 "不要" 都在,decline 应该优先
  assert.equal(detectPatternConfirmation('不要学').kind, 'decline');
  assert.equal(detectPatternConfirmation('不学吧').kind, 'decline');
});
