/**
 * ConfigRuleStore 测试(v18 Phase 8 M1)
 *
 * 覆盖:
 *   - CRUD(insertRule / get / listByScope / listAll / delete / count)
 *   - 白名单校验(非法 scope / 非法 source 抛错)
 *   - getActiveRules vs getProductionRules 区别(dry-run 边界)
 *   - 5 档 confidence 状态机 outcome 回流(复用 routing_rules.nextConfidence)
 *   - setConfidence 显式设置(rollback 路径)
 *   - decayStale 时间衰减(30/90 天)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, CONFIG_SCOPES, isConfigScope } from '../src/index.js';

// ── CRUD 基本 ──────────────────────────────────────────────────────────

test('ConfigRuleStore: insertRule 默认 provisional + 返回完整字段', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    evidence: 'session=system:scheduled:X 5x auth_pending on env',
  });
  assert.equal(r.scope, 'autonomous_blacklist');
  assert.equal(r.key, null);
  assert.equal(r.value, 'env');
  assert.equal(r.source, 'self:meta-detector');
  assert.equal(r.confidence, 'provisional');
  assert.equal(r.evidence, 'session=system:scheduled:X 5x auth_pending on env');
  assert.equal(r.successCount, 0);
  assert.equal(r.failureCount, 0);
  assert.equal(r.consecutiveSuccesses, 0);
  assert.equal(r.consecutiveFailures, 0);
  assert.ok(r.id > 0);
  assert.ok(r.createdAt);
  assert.ok(r.updatedAt);
});

test('ConfigRuleStore: insertRule 可指定 confidence(bootstrap 默认 validated)', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'in_turn_reflection.threshold',
    key: 'value',
    value: 2,
    source: 'bootstrap',
    confidence: 'validated',
  });
  assert.equal(r.confidence, 'validated');
  assert.equal(r.key, 'value');
  assert.equal(r.value, 2);
});

test('ConfigRuleStore: insertRule 复杂 value(数组 / 对象)JSON 序列化', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'task_mode_classifier.skip_patterns',
    value: ['system:scheduled:*', 'system:cron:*'],
    source: 'bootstrap',
  });
  assert.deepEqual(r.value, ['system:scheduled:*', 'system:cron:*']);

  const r2 = configRules.insertRule({
    scope: 'task_mode_classifier.heuristic_rules',
    key: 'multi-step',
    value: { pattern: 'foo|bar', weight: 0.5 },
    source: 'manual',
  });
  assert.deepEqual(r2.value, { pattern: 'foo|bar', weight: 0.5 });
});

test('ConfigRuleStore: insertRule 非法 scope → 抛错(白名单防自修失控)', () => {
  const { configRules } = openMemoryDb(':memory:');
  assert.throws(
    () => configRules.insertRule({
      scope: 'arbitrary_scope' as any,
      value: 'x',
      source: 'self:meta-detector',
    }),
    /whitelist/,
  );
});

test('ConfigRuleStore: insertRule 非法 source → 抛错', () => {
  const { configRules } = openMemoryDb(':memory:');
  assert.throws(
    () => configRules.insertRule({
      scope: 'autonomous_blacklist',
      value: 'x',
      source: 'evil-source' as any,
    }),
    /invalid source/,
  );
});

test('ConfigRuleStore: isConfigScope guard', () => {
  assert.equal(isConfigScope('autonomous_blacklist'), true);
  assert.equal(isConfigScope('task_mode_classifier.skip_patterns'), true);
  assert.equal(isConfigScope('arbitrary'), false);
  assert.equal(isConfigScope(null), false);
  assert.equal(isConfigScope(undefined), false);
  assert.equal(isConfigScope(123), false);
});

test('ConfigRuleStore: CONFIG_SCOPES 包含 5 个 v18 初始 scope', () => {
  assert.equal(CONFIG_SCOPES.length, 5);
  assert.ok(CONFIG_SCOPES.includes('autonomous_blacklist'));
  assert.ok(CONFIG_SCOPES.includes('task_mode_classifier.skip_patterns'));
  assert.ok(CONFIG_SCOPES.includes('task_mode_classifier.heuristic_rules'));
  assert.ok(CONFIG_SCOPES.includes('in_turn_reflection.threshold'));
  assert.ok(CONFIG_SCOPES.includes('plan_protocol_gate.exempt_tools'));
});

// ── 查询 ────────────────────────────────────────────────────────────────

test('ConfigRuleStore: getActiveRules 排除 retired / disputed', () => {
  const { configRules } = openMemoryDb(':memory:');
  const a = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
  });
  const b = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'shell',
    source: 'manual',
    confidence: 'validated',
  });
  configRules.setConfidence(a.id, 'retired');

  const active = configRules.getActiveRules('autonomous_blacklist');
  assert.equal(active.length, 1);
  assert.equal(active[0].value, 'shell');
});

test('ConfigRuleStore: getProductionRules 只返 validated / tentative(dry-run 边界)', () => {
  const { configRules } = openMemoryDb(':memory:');
  const a = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
  });
  const b = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'shell',
    source: 'manual',
    confidence: 'validated',
  });
  // a 还是 provisional,b 是 validated
  const active = configRules.getActiveRules('autonomous_blacklist');
  assert.equal(active.length, 2, 'getActiveRules 包含 provisional');

  const prod = configRules.getProductionRules('autonomous_blacklist');
  assert.equal(prod.length, 1, 'getProductionRules 排除 provisional');
  assert.equal(prod[0].value, 'shell');
});

test('ConfigRuleStore: listByScope 含 retired / disputed(管理用)', () => {
  const { configRules } = openMemoryDb(':memory:');
  const a = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
  });
  const b = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'shell',
    source: 'manual',
  });
  configRules.setConfidence(a.id, 'retired');

  const all = configRules.listByScope('autonomous_blacklist');
  assert.equal(all.length, 2, 'listByScope 包含 retired');
});

test('ConfigRuleStore: getActiveRules 非法 scope 抛错', () => {
  const { configRules } = openMemoryDb(':memory:');
  assert.throws(
    () => configRules.getActiveRules('invalid' as any),
    /invalid scope/,
  );
});

// ── 5 档 confidence 状态机 ─────────────────────────────────────────────

test('ConfigRuleStore: recordOutcome provisional + success → tentative', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
  });
  assert.equal(r.confidence, 'provisional');

  const after = configRules.recordOutcome(r.id, true);
  assert.equal(after?.confidence, 'tentative');
  assert.equal(after?.successCount, 1);
  assert.equal(after?.consecutiveSuccesses, 1);
});

test('ConfigRuleStore: tentative + 2 succ → validated', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'tentative',
  });
  configRules.recordOutcome(r.id, true);  // tentative → tentative (1 streak < 2)
  const after = configRules.recordOutcome(r.id, true);  // tentative + 2 streak → validated
  assert.equal(after?.confidence, 'validated');
  assert.equal(after?.consecutiveSuccesses, 2);
});

test('ConfigRuleStore: validated + 1 fail → disputed', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'validated',
  });
  const after = configRules.recordOutcome(r.id, false);
  assert.equal(after?.confidence, 'disputed');
});

test('ConfigRuleStore: disputed + 2 fail streak → retired', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'disputed',
  });
  configRules.recordOutcome(r.id, false);  // disputed + 1 fail (streak 1) → stays
  const after = configRules.recordOutcome(r.id, false);  // disputed + 2 fail streak → retired
  assert.equal(after?.confidence, 'retired');
});

test('ConfigRuleStore: disputed + 2 succ → validated (恢复)', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'disputed',
  });
  configRules.recordOutcome(r.id, true);
  const after = configRules.recordOutcome(r.id, true);
  assert.equal(after?.confidence, 'validated');
});

test('ConfigRuleStore: retired 终态 — recordOutcome 不复活', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'retired',
  });
  configRules.recordOutcome(r.id, true);
  configRules.recordOutcome(r.id, true);
  configRules.recordOutcome(r.id, true);
  const after = configRules.get(r.id);
  assert.equal(after?.confidence, 'retired');
});

test('ConfigRuleStore: setConfidence 显式覆盖(rollback 路径)', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'validated',
  });
  // 模拟 admin rollback:从 validated 直接 retire
  const after = configRules.setConfidence(r.id, 'retired');
  assert.equal(after?.confidence, 'retired');
  // 计数不变(setConfidence 不动 count)
  assert.equal(after?.successCount, 0);
});

test('ConfigRuleStore: recordOutcome 不存在 id → null', () => {
  const { configRules } = openMemoryDb(':memory:');
  assert.equal(configRules.recordOutcome(9999, true), null);
});

// ── 时间衰减(同 routing_rules.decayStale 模式)──────────────────────

test('ConfigRuleStore: decayStale 30 天降一档', () => {
  const { configRules, db } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'validated',
  });
  // 把 updated_at 改到 35 天前
  const stale = Date.now() - 35 * 86_400_000;
  db.prepare('UPDATE config_rules SET updated_at = ? WHERE id = ?').run(stale, r.id);

  const { demoted, retired } = configRules.decayStale(Date.now());
  assert.equal(demoted, 1);
  assert.equal(retired, 0);
  const after = configRules.get(r.id);
  assert.equal(after?.confidence, 'tentative', 'validated 降到 tentative');
});

test('ConfigRuleStore: decayStale 90 天强制 retired', () => {
  const { configRules, db } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'validated',
  });
  // 100 天前
  const ancient = Date.now() - 100 * 86_400_000;
  db.prepare('UPDATE config_rules SET updated_at = ? WHERE id = ?').run(ancient, r.id);

  const { demoted, retired } = configRules.decayStale(Date.now());
  assert.equal(retired, 1, '90 天强制 retired');
  const after = configRules.get(r.id);
  assert.equal(after?.confidence, 'retired');
});

test('ConfigRuleStore: decayStale 非 stale 不动', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
    confidence: 'validated',
  });
  // 刚创建,不 stale
  const { demoted, retired } = configRules.decayStale(Date.now());
  assert.equal(demoted, 0);
  assert.equal(retired, 0);
  const after = configRules.get(r.id);
  assert.equal(after?.confidence, 'validated');
});

test('ConfigRuleStore: decayStale 阈值非法抛错', () => {
  const { configRules } = openMemoryDb(':memory:');
  assert.throws(
    () => configRules.decayStale(Date.now(), { tierDownDays: 0 }),
    /tierDownDays/,
  );
  assert.throws(
    () => configRules.decayStale(Date.now(), { tierDownDays: 30, retireDays: 20 }),
    /retireDays/,
  );
});

// ── delete + count ─────────────────────────────────────────────────────

test('ConfigRuleStore: delete / count / countByScope', () => {
  const { configRules } = openMemoryDb(':memory:');
  const a = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
  });
  configRules.insertRule({
    scope: 'in_turn_reflection.threshold',
    value: 3,
    source: 'manual',
  });
  assert.equal(configRules.count(), 2);
  assert.equal(configRules.countByScope('autonomous_blacklist'), 1);
  assert.equal(configRules.countByScope('in_turn_reflection.threshold'), 1);
  assert.equal(configRules.delete(a.id), true);
  assert.equal(configRules.count(), 1);
  assert.equal(configRules.delete(9999), false);
});

// ── 事件 ───────────────────────────────────────────────────────────────

test('ConfigRuleStore: emit changed event(created / confidence_changed / deleted)', () => {
  const { configRules } = openMemoryDb(':memory:');
  const events: any[] = [];
  configRules.on('changed', (e) => events.push(e));

  const r = configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'self:meta-detector',
  });
  configRules.setConfidence(r.id, 'validated');
  configRules.delete(r.id);

  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'created');
  assert.equal(events[1].type, 'confidence_changed');
  assert.equal(events[2].type, 'deleted');
});
