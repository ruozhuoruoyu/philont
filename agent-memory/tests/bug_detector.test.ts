/**
 * BugDetector 测试(v18 Phase 8 M4 = 8B)
 *
 * 覆盖 B1-B3 三个 pattern + dedup + 空输入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBugDetector } from '../src/index.js';
import type { AuditEventLike } from '../src/autonomous/meta_config_observer.js';

function makeEvent(
  type: string,
  data: Record<string, unknown>,
  timestamp: number,
): AuditEventLike {
  return { type, timestamp, data };
}

// ── B1: gate 漏放 ──────────────────────────────────────────────────────

test('B1: mode 升 slow 但没看到 plan_protocol_gate_blocked + 有 memory tool 写 → 报 gate 漏放', () => {
  const now = Date.now();
  const events: AuditEventLike[] = [
    // 1. mode 升 slow
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      toolName: 'task_mode_auto_slow',
      reasons: ['heavy-keyword', 'contains-url'],
    }, now - 1000),
    // 2. 同 session 内 5min 窗口里有 get_fact 调用(应被 gate 拦但没被)
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      toolName: 'get_fact',
    }, now - 500),
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      toolName: 'listCredentialNames',
    }, now - 300),
    // 没有 plan_protocol_gate_blocked event!
  ];
  const r = runBugDetector({ auditEvents: events, now });
  assert.equal(r.reports.length, 1);
  assert.equal(r.reports[0].pattern, 'B1');
  assert.match(r.reports[0].title, /get_fact|listCredentialNames/);
  assert.equal(r.reports[0].severity, 'high');
  assert.match(r.reports[0].fileHint, /chat-handler\.ts.*plan_protocol_gate/);
  assert.match(r.reports[0].fixProposal, /isPlanProtocolTool|short-circuit/);
});

test('B1: mode 升 slow + 看到 plan_protocol_gate_blocked → 不报(gate 正常工作)', () => {
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      toolName: 'task_mode_auto_slow',
    }, now - 1000),
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      source: 'plan_protocol_gate',
      toolName: 'plan_protocol_gate_blocked',
      blockedTool: 'webFetch',
    }, now - 500),
  ];
  const r = runBugDetector({ auditEvents: events, now });
  assert.equal(r.reports.filter((r) => r.pattern === 'B1').length, 0);
});

test('B1: 不同 session 各自独立判断', () => {
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('self_domain_write', { sessionId: 'A', toolName: 'task_mode_auto_slow' }, now - 1000),
    makeEvent('self_domain_write', { sessionId: 'A', toolName: 'get_fact' }, now - 500),
    makeEvent('self_domain_write', { sessionId: 'B', toolName: 'task_mode_auto_slow' }, now - 1000),
    makeEvent('self_domain_write', {
      sessionId: 'B', source: 'plan_protocol_gate', toolName: 'plan_protocol_gate_blocked',
    }, now - 500),
  ];
  const r = runBugDetector({ auditEvents: events, now });
  const b1 = r.reports.filter((r) => r.pattern === 'B1');
  assert.equal(b1.length, 1);
  assert.equal(b1[0].evidence[0].sessionId, 'A');
});

// ── B2: reject 后 LLM 继续撞 ──────────────────────────────────────────

test('B2: 同 session 3x plan_protocol_gate_blocked → 报 reject loop', () => {
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      source: 'plan_protocol_gate',
      toolName: 'plan_protocol_gate_blocked',
      blockedTool: 'webFetch',
    }, now - 3000),
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      source: 'plan_protocol_gate',
      toolName: 'plan_protocol_gate_blocked',
      blockedTool: 'http',
    }, now - 2000),
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      source: 'plan_protocol_gate',
      toolName: 'plan_protocol_gate_blocked',
      blockedTool: 'shell',
    }, now - 1000),
  ];
  const r = runBugDetector({ auditEvents: events, now });
  const b2 = r.reports.find((r) => r.pattern === 'B2');
  assert.ok(b2);
  assert.match(b2.title, /3x plan_protocol_gate reject/);
  assert.equal(b2.severity, 'medium');
  assert.equal(b2.count, 3);
});

test('B2: 1-2 次 reject 不报(LLM 自然 pivot)', () => {
  const now = Date.now();
  const events: AuditEventLike[] = [
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      source: 'plan_protocol_gate',
      toolName: 'plan_protocol_gate_blocked',
    }, now - 2000),
    makeEvent('self_domain_write', {
      sessionId: 'wechat:user1',
      source: 'plan_protocol_gate',
      toolName: 'plan_protocol_gate_blocked',
    }, now - 1000),
  ];
  const r = runBugDetector({ auditEvents: events, now });
  assert.equal(r.reports.filter((r) => r.pattern === 'B2').length, 0);
});

// ── B3: honesty fired N 次同根因 ──────────────────────────────────────

test('B3: 5x unverified_destructive honesty → 报 routing 学习失败', () => {
  const now = Date.now();
  const events: AuditEventLike[] = Array.from({ length: 5 }).map((_, i) =>
    makeEvent('self_domain_write', {
      source: 'k7_bridge',
      toolName: 'k7_bridge_enqueued',
      honestyReason: 'unverified_destructive',
      sessionId: `s${i}`,
    }, now - (5 - i) * 1000),
  );
  const r = runBugDetector({ auditEvents: events, now });
  const b3 = r.reports.find((r) => r.pattern === 'B3');
  assert.ok(b3);
  assert.match(b3.title, /unverified_destructive.*5x/);
  assert.match(b3.fixProposal, /routing_rule|reflection/);
});

test('B3: 不同 reason 各自独立', () => {
  const now = Date.now();
  const events: AuditEventLike[] = [
    ...Array.from({ length: 5 }).map((_, i) =>
      makeEvent('self_domain_write', {
        source: 'k7_bridge', honestyReason: 'unverified_destructive', sessionId: `s${i}`,
      }, now - (5 - i) * 1000)),
    makeEvent('self_domain_write', {
      source: 'k7_bridge', honestyReason: 'failures_with_claim', sessionId: 'sx',
    }, now - 500),
  ];
  const r = runBugDetector({ auditEvents: events, now });
  const b3 = r.reports.filter((r) => r.pattern === 'B3');
  assert.equal(b3.length, 1, '只有 unverified_destructive 达阈值');
  assert.match(b3[0].title, /unverified_destructive/);
});

// ── Dedup ────────────────────────────────────────────────────────────

test('dedup: 已报告过的 key 在 recentlyReported 里 → 跳过', () => {
  const now = Date.now();
  const events: AuditEventLike[] = Array.from({ length: 5 }).map((_, i) =>
    makeEvent('self_domain_write', {
      source: 'k7_bridge', honestyReason: 'unverified_destructive',
    }, now - (5 - i) * 1000),
  );
  const recentlyReported = new Set(['B3:unverified_destructive']);
  const r = runBugDetector({ auditEvents: events, now, recentlyReported });
  assert.equal(r.reports.length, 0);
  assert.equal(r.dedupSkipped.length, 1);
  assert.ok(r.dedupSkipped[0].startsWith('B3:'));
});

// ── 空输入 / 时间窗 ───────────────────────────────────────────────────

test('空 audit 不报 bug', () => {
  const r = runBugDetector({ auditEvents: [] });
  assert.equal(r.reports.length, 0);
});

test('窗口外事件不计入', () => {
  const now = Date.now();
  const old = now - 25 * 3600_000;
  const events: AuditEventLike[] = [
    makeEvent('self_domain_write', { sessionId: 'A', toolName: 'task_mode_auto_slow' }, old),
    makeEvent('self_domain_write', { sessionId: 'A', toolName: 'get_fact' }, old + 1000),
  ];
  const r = runBugDetector({ auditEvents: events, now });
  assert.equal(r.reports.length, 0);
});
