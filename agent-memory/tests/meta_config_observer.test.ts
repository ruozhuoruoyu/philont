/**
 * MetaConfigObserver 测试(v18 Phase 8 M3)
 *
 * 覆盖:
 *   - D1 autonomous turn 工具反复 auth_pending → 提议 autonomous_blacklist 加项
 *   - D2 同 sessionPrefix 反复 auto_task_mode + plan_update_step 失败 → skip pattern
 *   - 查重(同 scope+value 已存在不重复插)
 *   - 阈值边界 / 时间窗口边界
 *   - fail-soft(单 detector 抛错不影响其它)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, runMetaConfigObserver } from '../src/index.js';
import type { AuditEventLike } from '../src/autonomous/meta_config_observer.js';

function makeEvent(
  type: string,
  data: Record<string, unknown>,
  timestamp: number,
): AuditEventLike {
  return { type, timestamp, data };
}

// ── D1 autonomous turn auth_pending → autonomous_blacklist ─────────────

test('D1: autonomous turn 3x permission_denied on env → 提议 blacklist 加 env', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'system:scheduled:mycox-checkin', toolName: 'env' }, now - 1000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:mycox-checkin', toolName: 'env' }, now - 2000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:mycox-checkin', toolName: 'env' }, now - 3000),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 1);
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].scope, 'autonomous_blacklist');
  assert.equal(r.proposals[0].value, 'env');
  assert.equal(r.proposals[0].pattern, 'D1');

  const rule = configRules.get(r.insertedRuleIds[0])!;
  assert.equal(rule.scope, 'autonomous_blacklist');
  assert.equal(rule.value, 'env');
  assert.equal(rule.confidence, 'provisional');
  assert.equal(rule.source, 'self:meta-detector');
  assert.match(rule.evidence ?? '', /D1.*env.*3x/);
});

test('D1: 跨 autonomous sessions 聚合 — 3 个 session 各 1 次 env auth_pending → 总和触发', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 1000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:B', toolName: 'env' }, now - 2000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:C', toolName: 'env' }, now - 3000),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 1, '总和 ≥ 3 即触发');
});

test('D1: 非 autonomous session(user)不触发', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'wechat:user1', toolName: 'env' }, now - 1000),
    makeEvent('permission_denied', { sessionId: 'wechat:user1', toolName: 'env' }, now - 2000),
    makeEvent('permission_denied', { sessionId: 'wechat:user1', toolName: 'env' }, now - 3000),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 0, 'user session 不在 D1 范围');
});

test('D1: < threshold 不触发', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 1000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 2000),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 0, '2 < threshold(3)');
});

test('D1: 时间窗口外的事件不计入', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  // 3 个事件,但 25h 前(超过 24h 窗口)
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 25 * 3600_000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 25 * 3600_000 - 1000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 25 * 3600_000 - 2000),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 0);
});

// ── D2 同 sessionPrefix 反复 auto_task_mode + plan_update_step 失败 ────

test('D2: system:scheduled:* 3x auto_task_mode + 3x plan_update_step 失败 → 提议 skip pattern', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    // 3 次 auto_task_mode
    makeEvent('self_domain_write', {
      sessionId: 'system:scheduled:A',
      toolName: 'task_mode_auto_slow',
      reasons: ['heavy-keyword', 'contains-url'],
    }, now - 100),
    makeEvent('self_domain_write', {
      sessionId: 'system:scheduled:B',
      toolName: 'task_mode_auto_slow',
      reasons: ['heavy-keyword'],
    }, now - 200),
    makeEvent('self_domain_write', {
      sessionId: 'system:scheduled:C',
      toolName: 'task_mode_auto_slow',
      reasons: ['heavy-keyword'],
    }, now - 300),
    // 3 次 plan_update_step 失败(同 prefix)
    makeEvent('self_domain_write', {
      sessionId: 'system:scheduled:A',
      source: 'plan_protocol_gate',
      blockedTool: 'plan_update_step',
    }, now - 50),
    makeEvent('self_domain_write', {
      sessionId: 'system:scheduled:B',
      source: 'plan_protocol_gate',
      blockedTool: 'plan_update_step',
    }, now - 150),
    makeEvent('self_domain_write', {
      sessionId: 'system:scheduled:C',
      source: 'plan_protocol_gate',
      blockedTool: 'plan_update_step',
    }, now - 250),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 1);
  assert.equal(r.proposals[0].scope, 'task_mode_classifier.skip_patterns');
  assert.equal(r.proposals[0].value, 'system:scheduled:');
  assert.equal(r.proposals[0].pattern, 'D2');
});

test('D2: 只 auto_task_mode 没 plan_update_step 失败 → 不触发', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('self_domain_write', { sessionId: 'system:scheduled:A', toolName: 'task_mode_auto_slow' }, now - 100),
    makeEvent('self_domain_write', { sessionId: 'system:scheduled:B', toolName: 'task_mode_auto_slow' }, now - 200),
    makeEvent('self_domain_write', { sessionId: 'system:scheduled:C', toolName: 'task_mode_auto_slow' }, now - 300),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 0, 'D2 需要 auto + 失败两个信号');
});

// ── 查重 / 幂等 ─────────────────────────────────────────────────────

test('查重:同 scope + value 已存在 → 不重复插', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  // 先种一条 env 规则
  configRules.insertRule({
    scope: 'autonomous_blacklist',
    value: 'env',
    source: 'manual',
  });
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 1000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:B', toolName: 'env' }, now - 2000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:C', toolName: 'env' }, now - 3000),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 0, '已存在 → 跳过');
  assert.equal(r.skippedExisting, 1);
  // 总规则数仍为 1
  assert.equal(configRules.count(), 1);
});

test('幂等:观察器跑两次 — 第二次不会重复插', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 1000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:B', toolName: 'env' }, now - 2000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:C', toolName: 'env' }, now - 3000),
  ];
  runMetaConfigObserver({ auditEvents: events, configRules, now });
  const r2 = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r2.insertedRuleIds.length, 0);
  assert.equal(r2.skippedExisting, 1);
});

// ── 自定义参数 ──────────────────────────────────────────────────────

test('自定义 threshold=2 → 2 次也能触发', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A', toolName: 'env' }, now - 1000),
    makeEvent('permission_denied', { sessionId: 'system:scheduled:B', toolName: 'env' }, now - 2000),
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now, threshold: 2 });
  assert.equal(r.insertedRuleIds.length, 1);
});

test('空 audit events → 无 proposal', () => {
  const { configRules } = openMemoryDb(':memory:');
  const r = runMetaConfigObserver({ auditEvents: [], configRules });
  assert.equal(r.insertedRuleIds.length, 0);
  assert.equal(r.proposals.length, 0);
});

test('audit 缺字段 → 跳过不抛', () => {
  const { configRules } = openMemoryDb(':memory:');
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('permission_denied', { sessionId: 'system:scheduled:A' }, now - 1000), // 缺 toolName
    makeEvent('permission_denied', { toolName: 'env' }, now - 2000), // 缺 sessionId
    makeEvent('permission_denied', {}, now - 3000), // 都缺
  ];
  const r = runMetaConfigObserver({ auditEvents: events, configRules, now });
  assert.equal(r.insertedRuleIds.length, 0);
});
