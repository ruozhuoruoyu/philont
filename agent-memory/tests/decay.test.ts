/**
 * Phase 5:衰退打分 + 主动遗忘池测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  scoreMemory,
  namespaceTauDays,
  PIN_SENTINEL,
  DEFAULT_FORGET_THRESHOLD,
} from '../src/index.js';

const DAY = 86_400_000;

test('namespaceTauDays: user=Infinity, project=60, context/session=1, default=365', () => {
  assert.equal(namespaceTauDays('user'), Infinity);
  assert.equal(namespaceTauDays('user.preferences.drinks'), Infinity);
  assert.equal(namespaceTauDays('project'), 60);
  assert.equal(namespaceTauDays('project.currentSprint'), 60);
  assert.equal(namespaceTauDays('context'), 1);
  assert.equal(namespaceTauDays('session'), 1);
  assert.equal(namespaceTauDays('decisions'), 365);
  assert.equal(namespaceTauDays('custom'), 365);
});

test('scoreMemory: recent fact has high score, old fact has low', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');

  const recent = {
    namespace: 'project',
    confidence: 1.0,
    createdAt: now - 5 * DAY,
    lastAccessedAt: null,
    decayTauDays: null,
  };
  const old = {
    namespace: 'project',
    confidence: 1.0,
    createdAt: now - 180 * DAY,
    lastAccessedAt: null,
    decayTauDays: null,
  };
  const recentScore = scoreMemory(recent, now);
  const oldScore = scoreMemory(old, now);

  assert.ok(recentScore > 0.9, `recent score ${recentScore}`);
  assert.ok(oldScore < 0.1, `old score ${oldScore}`);
});

test('scoreMemory: user.* namespace never decays', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const old = {
    namespace: 'user.preferences',
    confidence: 0.8,
    createdAt: now - 10_000 * DAY,
    lastAccessedAt: null,
    decayTauDays: null,
  };
  assert.equal(scoreMemory(old, now), 0.8);
});

test('scoreMemory: pinned (decay_tau_days = PIN_SENTINEL) never decays', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const old = {
    namespace: 'project',
    confidence: 1.0,
    createdAt: now - 1000 * DAY,
    lastAccessedAt: null,
    decayTauDays: PIN_SENTINEL,
  };
  assert.equal(scoreMemory(old, now), 1.0);
});

test('scoreMemory: last_accessed_at 是 LRU 锚点,访问刷新会让老事实复活', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const fact = {
    namespace: 'project',
    confidence: 1.0,
    createdAt: now - 180 * DAY,
    lastAccessedAt: now - 2 * DAY, // 最近访问
    decayTauDays: null,
  };
  assert.ok(scoreMemory(fact, now) > 0.9);
});

// ── getForgetCandidates ────────────────────────────────────────────────

test('getForgetCandidates: returns low-score facts below threshold, ascending', () => {
  const { facts } = openMemoryDb(':memory:');
  const now = Date.now();

  // 写一些老的 project 事实
  const oldFact = facts.storeFact({
    namespace: 'project',
    key: 'ancient',
    value: 'x',
    confidence: 0.5,
  });
  // 手工把 created_at + last_accessed_at 一起往回调 180 天。
  // 2026-05-23 后 storeFact 把 last_accessed_at 初始化为 createdAt(LRU 锚点
  // 真正生效),所以"老 fact"必须把两个字段都回拨。
  (facts as any).db
    .prepare(`UPDATE memory_facts SET created_at = ?, last_accessed_at = ? WHERE id = ?`)
    .run(now - 180 * DAY, now - 180 * DAY, oldFact.id);

  // 一条新 project 事实
  facts.storeFact({
    namespace: 'project',
    key: 'fresh',
    value: 'y',
    confidence: 1.0,
  });

  // 一条 user 事实(永不衰退,不应出现)
  facts.storeFact({
    namespace: 'user',
    key: 'name',
    value: '张三',
  });

  const candidates = facts.getForgetCandidates({ now });
  assert.equal(candidates.length, 1, '只应有 1 条低分候选');
  assert.equal(candidates[0].fact.key, 'ancient');
  assert.ok(candidates[0].score < DEFAULT_FORGET_THRESHOLD);
});

test('getForgetCandidates: 过滤 pinned 的事实', () => {
  const { facts } = openMemoryDb(':memory:');
  const now = Date.now();

  const old = facts.storeFact({
    namespace: 'project',
    key: 'old',
    value: 'x',
  });
  (facts as any).db
    .prepare(`UPDATE memory_facts SET created_at = ?, last_accessed_at = ? WHERE id = ?`)
    .run(now - 500 * DAY, now - 500 * DAY, old.id);

  // 低分候选
  assert.equal(facts.getForgetCandidates({ now }).length, 1);

  // pin 后应消失
  facts.pin(old.id);
  assert.equal(facts.getForgetCandidates({ now }).length, 0);

  // unpin 又出现
  facts.unpin(old.id);
  assert.equal(facts.getForgetCandidates({ now }).length, 1);
});

test('softForget: hides fact from getFact / listFacts / count; unforget 恢复', () => {
  const { facts } = openMemoryDb(':memory:');
  const f = facts.storeFact({
    namespace: 'project',
    key: 'temporary',
    value: 'x',
  });

  assert.ok(facts.getFact('project', 'temporary'));
  assert.equal(facts.listFacts('project').length, 1);
  assert.equal(facts.count(), 1);

  const ok = facts.softForget(f.id);
  assert.ok(ok);

  assert.equal(facts.getFact('project', 'temporary'), null);
  assert.equal(facts.listFacts('project').length, 0);
  assert.equal(facts.count(), 0);

  // includeForgotten 可回溯
  const still = facts.getById(f.id, true);
  assert.ok(still);
  assert.ok(still.forgottenAt !== null);

  // unforget 恢复
  assert.ok(facts.unforget(f.id));
  assert.ok(facts.getFact('project', 'temporary'));
});

test('markAccessed 刷新 last_accessed_at', () => {
  // 2026-05-23 后:storeFact 初始化 lastAccessedAt=createdAt,getFact 命中也会
  // 自动 markAccessed → 想测 markAccessed 本身行为,改走 listFacts(无 bump)
  // 取快照,再显式 markAccessed,验证生效。
  const { facts } = openMemoryDb(':memory:');
  const f = facts.storeFact({
    namespace: 'project',
    key: 'accessed',
    value: 'x',
  });

  const initial = facts.listFacts('project')[0].lastAccessedAt;
  assert.ok(initial !== null && initial > 0, 'storeFact 应初始化 lastAccessedAt');

  const at = Date.now() + 1000;
  facts.markAccessed(f.id, at);

  const after = facts.listFacts('project')[0].lastAccessedAt;
  assert.equal(after, at, 'markAccessed 应覆盖到指定时间');
});

// ── AccessLog ──────────────────────────────────────────────────────────

test('AccessLog: record + countFor + recentFor', () => {
  const { access } = openMemoryDb(':memory:');

  access.record({ targetType: 'fact', targetId: 'f1', context: 'search' });
  access.record({ targetType: 'fact', targetId: 'f1' });
  access.record({ targetType: 'fact', targetId: 'f2' });
  access.record({ targetType: 'skill', targetId: 'f1' });

  assert.equal(access.countFor('fact', 'f1'), 2);
  assert.equal(access.countFor('fact', 'f2'), 1);
  assert.equal(access.countFor('skill', 'f1'), 1);

  const recent = access.recentFor('fact', 'f1', 10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].targetId, 'f1');
});
