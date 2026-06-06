/**
 * RoutingRuleStore.decayStale 单测。
 *
 * 关键不变量:
 *   - 30 天没动 → 降一档(validated→tentative→provisional→retired)
 *   - 90 天没动 → 强制 retired
 *   - retired 终态,不动
 *   - 降档后 updated_at = now,idempotent(再调一次不重复降)
 *   - disputed 30+ 天 → 直接 retired
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

const NOW = 1_750_000_000_000;

function setup() {
  const handle = openMemoryDb(':memory:');
  return handle;
}

function makeRule(
  store: ReturnType<typeof setup>['routingRules'],
  confidence:
    | 'provisional'
    | 'tentative'
    | 'validated'
    | 'disputed'
    | 'retired',
  ageDays: number,
  taskSig = 'test-sig',
) {
  const r = store.createRule({
    taskSignature: taskSig,
    triggerCondition: 'cond',
    carveout: 'carve',
    evidence: 'ev',
    confidence,
  });
  // 手工把 updated_at 推后到 ageDays 天前(NOW - ageDays * day)
  const past = NOW - ageDays * 86_400_000;
  store['db' as keyof typeof store];
  // store 私有 db 不暴露,直接用 underlying handle 写
  return { id: r.id, past };
}

function setUpdatedAt(handle: ReturnType<typeof setup>, id: number, ts: number) {
  handle.db.prepare(
    `UPDATE routing_rules SET updated_at = ? WHERE id = ?`,
  ).run(ts, id);
}

// ── 30 天降一档 ─────────────────────────────────────────────────────────

test('decay: validated 30+ 天 → tentative', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a',
    triggerCondition: 'c',
    carveout: 'cv',
    evidence: 'ev',
    confidence: 'validated',
  });
  setUpdatedAt(h, r.id, NOW - 35 * 86_400_000);
  const result = h.routingRules.decayStale(NOW);
  assert.equal(result.demoted, 1);
  assert.equal(result.retired, 0);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'tentative');
  h.close();
});

test('decay: tentative 30+ 天 → provisional', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'tentative',
  });
  setUpdatedAt(h, r.id, NOW - 40 * 86_400_000);
  h.routingRules.decayStale(NOW);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'provisional');
  h.close();
});

test('decay: provisional 30+ 天 → retired(没爬过 validated 视为废)', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'provisional',
  });
  setUpdatedAt(h, r.id, NOW - 31 * 86_400_000);
  const result = h.routingRules.decayStale(NOW);
  assert.equal(result.retired, 1);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'retired');
  h.close();
});

test('decay: disputed 30+ 天 → retired(失败回路 + 长闲 = 弃)', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'disputed',
  });
  setUpdatedAt(h, r.id, NOW - 31 * 86_400_000);
  h.routingRules.decayStale(NOW);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'retired');
  h.close();
});

// ── 90 天强制 retired ───────────────────────────────────────────────────

test('decay: validated 90+ 天 → retired(直接强 retire,不走 tier-down 链)', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'validated',
  });
  setUpdatedAt(h, r.id, NOW - 95 * 86_400_000);
  const result = h.routingRules.decayStale(NOW);
  assert.equal(result.retired, 1);
  assert.equal(result.demoted, 0);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'retired');
  h.close();
});

test('decay: tentative 90+ 天 → retired', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'tentative',
  });
  setUpdatedAt(h, r.id, NOW - 120 * 86_400_000);
  h.routingRules.decayStale(NOW);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'retired');
  h.close();
});

// ── 不动 ────────────────────────────────────────────────────────────────

test('decay: < 30 天 → 不动', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'validated',
  });
  setUpdatedAt(h, r.id, NOW - 20 * 86_400_000);
  const result = h.routingRules.decayStale(NOW);
  assert.equal(result.demoted, 0);
  assert.equal(result.retired, 0);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'validated');
  h.close();
});

test('decay: 已 retired → 不动', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'validated',
  });
  h.routingRules.setConfidence(r.id, 'retired');
  setUpdatedAt(h, r.id, NOW - 200 * 86_400_000);
  const result = h.routingRules.decayStale(NOW);
  assert.equal(result.demoted, 0);
  assert.equal(result.retired, 0);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'retired');
  h.close();
});

// ── 幂等 ────────────────────────────────────────────────────────────────

test('decay: 调用后 updated_at 刷为 now → 同 NOW 第二次调不重复降', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'validated',
  });
  setUpdatedAt(h, r.id, NOW - 35 * 86_400_000);

  const r1 = h.routingRules.decayStale(NOW);
  assert.equal(r1.demoted, 1);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'tentative');

  // 第二次同 NOW → updated_at 已是 NOW,30 天阈值不命中
  const r2 = h.routingRules.decayStale(NOW);
  assert.equal(r2.demoted, 0);
  assert.equal(r2.retired, 0);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'tentative');
  h.close();
});

test('decay: 30 天后再调,衰减再走一档(validated→tentative→provisional)', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'validated',
  });
  setUpdatedAt(h, r.id, NOW - 35 * 86_400_000);

  // 第一次:validated → tentative,updated_at = NOW
  h.routingRules.decayStale(NOW);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'tentative');

  // 模拟 35 天后再 idle:第二次 decayStale
  const later = NOW + 35 * 86_400_000;
  h.routingRules.decayStale(later);
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'provisional');
  h.close();
});

// ── 批量 + 混合 ────────────────────────────────────────────────────────

test('decay: 多条规则同时存在时各自走自己的轨迹', () => {
  const h = setup();
  const validatedOld = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'validated',
  });
  const tentativeFresh = h.routingRules.createRule({
    taskSignature: 'b', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'tentative',
  });
  const provisionalAncient = h.routingRules.createRule({
    taskSignature: 'c', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'provisional',
  });
  setUpdatedAt(h, validatedOld.id, NOW - 35 * 86_400_000);
  // tentativeFresh 不动,刚创建即 NOW
  setUpdatedAt(h, provisionalAncient.id, NOW - 95 * 86_400_000);

  const result = h.routingRules.decayStale(NOW);
  // validatedOld → tentative (demoted)
  // tentativeFresh → 不动
  // provisionalAncient → retired (90+ 天直接 retire)
  assert.equal(result.demoted, 1);
  assert.equal(result.retired, 1);
  assert.equal(h.routingRules.getById(validatedOld.id)!.confidence, 'tentative');
  assert.equal(h.routingRules.getById(tentativeFresh.id)!.confidence, 'tentative');
  assert.equal(h.routingRules.getById(provisionalAncient.id)!.confidence, 'retired');
  h.close();
});

// ── 自定义阈值 ──────────────────────────────────────────────────────────

test('decay: 自定义 tierDownDays / retireDays', () => {
  const h = setup();
  const r = h.routingRules.createRule({
    taskSignature: 'a', triggerCondition: 'c', carveout: 'cv', evidence: 'ev',
    confidence: 'validated',
  });
  setUpdatedAt(h, r.id, NOW - 8 * 86_400_000);
  // tierDownDays=7 → 8 天命中
  h.routingRules.decayStale(NOW, { tierDownDays: 7, retireDays: 30 });
  assert.equal(h.routingRules.getById(r.id)!.confidence, 'tentative');
  h.close();
});

test('decay: 非法阈值抛错', () => {
  const h = setup();
  assert.throws(() => h.routingRules.decayStale(NOW, { tierDownDays: 0 }));
  assert.throws(
    () => h.routingRules.decayStale(NOW, { tierDownDays: 60, retireDays: 30 }),
  );
  h.close();
});
