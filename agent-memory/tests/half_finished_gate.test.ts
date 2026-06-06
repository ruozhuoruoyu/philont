/**
 * HalfFinishedGate 测试(Phase 15,2026-05-18)
 *
 * 覆盖:
 *   - 承诺型短语识别(中英双语,各模式)
 *   - mode=fast → 不触发(只检 slow)
 *   - 无 placeholder plan / 已 plan_update_step → 不触发
 *   - 有完成宣言 → 不触发(归 HonestyGate 管)
 *   - 命中条件 5/5 满足 → 返 detection
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectHalfFinishedTurn,
  findCommitmentPhrase,
} from '../src/half_finished_gate.js';

// ── findCommitmentPhrase 单测 ─────────────────────────────────────────

test('findCommitmentPhrase: 中文"让我看看 / 让我先 X"', () => {
  assert.ok(findCommitmentPhrase('让我看看热门社区的帖子'));
  assert.ok(findCommitmentPhrase('让我先了解一下'));
  assert.ok(findCommitmentPhrase('让我试一试'));
});

test('findCommitmentPhrase: 中文"我先 X 再 Y"', () => {
  assert.ok(findCommitmentPhrase('好,我先看看再决定'));
  assert.ok(findCommitmentPhrase('我先研究下风格'));
  assert.ok(findCommitmentPhrase('我先了解当前讨论'));
});

test('findCommitmentPhrase: 中文"我需要先 X"', () => {
  assert.ok(findCommitmentPhrase('我需要先了解当前讨论的内容'));
  assert.ok(findCommitmentPhrase('我需要先看一下'));
});

test('findCommitmentPhrase: 中文"接下来我会"', () => {
  assert.ok(findCommitmentPhrase('接下来我会处理这个问题'));
  assert.ok(findCommitmentPhrase('之后我要去测试'));
});

test('findCommitmentPhrase: 中文"下次再 / 改天 / 稍后"', () => {
  assert.ok(findCommitmentPhrase('下次再做'));
  assert.ok(findCommitmentPhrase('改天再处理'));
  assert.ok(findCommitmentPhrase('稍后再来看'));
  assert.ok(findCommitmentPhrase('待会儿来跑'));
});

test('findCommitmentPhrase: 英文 let me / I\'ll', () => {
  assert.ok(findCommitmentPhrase('Let me check the API first'));
  assert.ok(findCommitmentPhrase("I'll look at this later"));
  assert.ok(findCommitmentPhrase('I need to read the docs first'));
});

test('findCommitmentPhrase: 不命中 — 指引用户 / 过去时', () => {
  assert.equal(findCommitmentPhrase('已完成 X,接下来用户应该 Y'), null);
  assert.equal(findCommitmentPhrase('已经把文件写完了'), null);
  assert.equal(findCommitmentPhrase('刚才让 fetch 跑了一下'), null);
});

// ── detectHalfFinishedTurn 单测 ───────────────────────────────────────

test('detectHalfFinishedTurn: fast 模式直接返 null', () => {
  const r = detectHalfFinishedTurn('让我先看看', {
    mode: 'fast',
    hasPlaceholderPlanInDraft: true,
    hasPlanUpdateStepCallInTurn: false,
  });
  assert.equal(r, null);
});

test('detectHalfFinishedTurn: 无 placeholder plan → null', () => {
  const r = detectHalfFinishedTurn('让我先看看', {
    mode: 'slow',
    hasPlaceholderPlanInDraft: false,
    hasPlanUpdateStepCallInTurn: false,
  });
  assert.equal(r, null);
});

test('detectHalfFinishedTurn: 已 plan_update_step → null(LLM 在推进)', () => {
  const r = detectHalfFinishedTurn('让我先看看', {
    mode: 'slow',
    hasPlaceholderPlanInDraft: true,
    hasPlanUpdateStepCallInTurn: true,
  });
  assert.equal(r, null);
});

test('detectHalfFinishedTurn: 有完成宣言 → null(归 HonestyGate)', () => {
  const r = detectHalfFinishedTurn('任务已完成,接下来我会休息', {
    mode: 'slow',
    hasPlaceholderPlanInDraft: true,
    hasPlanUpdateStepCallInTurn: false,
  });
  // "已完成" 是完成宣言,findCompletionClaim 命中,half-finished 不抢
  assert.equal(r, null);
});

test('detectHalfFinishedTurn: 5/5 命中 → 返 detection', () => {
  const r = detectHalfFinishedTurn(
    '好,看到了这些社区。我需要先了解当前讨论的内容,再写一篇有质量的帖子。让我看看热门社区的帖子…',
    {
      mode: 'slow',
      hasPlaceholderPlanInDraft: true,
      hasPlanUpdateStepCallInTurn: false,
    },
  );
  assert.ok(r);
  assert.equal(r.reason, 'commitment_without_progress');
  assert.ok(r.matchedPhrase.length > 0);
  assert.match(r.evidence, /fire-and-forget/);
});

test('detectHalfFinishedTurn: 无承诺型短语的 final text → null', () => {
  const r = detectHalfFinishedTurn(
    '已读 guide。task_signature=mycox-onboarding。准备 plan_revise。',
    {
      mode: 'slow',
      hasPlaceholderPlanInDraft: true,
      hasPlanUpdateStepCallInTurn: false,
    },
  );
  assert.equal(r, null);
});
