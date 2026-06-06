/**
 * verifySelfSummaryIntegrity 单测 —— 启动时跑这个,失效引用率高就异步触发
 * reflectSelf 重生。
 *
 * 关注点:
 *   - 全 valid → score=1.0
 *   - 部分 stale(skill 被删) → 反映在 staleRefs
 *   - sourceRefs 字段缺失 / 为 null → 不抛错
 *   - 没有 self.summary → totalRefs=0 但不抛
 *   - 多 namespace(summary + strengths + growth_edges)合并去重
 *   - unknown 格式的 ref(没有 'kind:' 前缀)记 unknownRefs + 算 stale
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';
import { MemoryStore } from '../src/store.js';
import { SkillStore } from '../src/skills.js';
import { PursuitStore } from '../src/pursuit.js';
import { verifySelfSummaryIntegrity } from '../src/index.js';

function mkStores() {
  const db = new Database(':memory:');
  initSchema(db);
  return {
    db,
    facts: new MemoryStore(db),
    skills: new SkillStore(db),
    pursuits: new PursuitStore(db),
  };
}

function seedSkill(skills: SkillStore, name: string): void {
  skills.createSkill({
    name,
    description: `${name} 的描述`,
    triggerKeywords: [name],
    actionTemplate: `## 触发\n...\n## 避免\n...\n## 改做\n...`,
    kind: 'positive',
  });
}

function seedPursuit(pursuits: PursuitStore, id: string): void {
  pursuits.createChild({
    id,
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    title: `pursuit ${id}`,
    intent: 'test',
    origin: 'extractor',
    stake: 'medium',
  });
}

// ── 全 valid ───────────────────────────────────────────────────────────

test('integrity: 全 valid → score=1.0', () => {
  const { facts, skills, pursuits } = mkStores();
  seedSkill(skills, 'typing');
  seedSkill(skills, 'docs-first');
  seedPursuit(pursuits, 'p-typing');

  facts.updateSelfFact(
    'summary',
    '我对类型系统敏感',
    ['skill:typing', 'skill:docs-first', 'pursuit:p-typing'],
    'self-reflector',
  );

  const r = verifySelfSummaryIntegrity({ facts, skills, pursuits });
  assert.equal(r.totalRefs, 3);
  assert.equal(r.validRefs, 3);
  assert.deepEqual(r.staleRefs, []);
  assert.equal(r.integrityScore, 1.0);
});

// ── 部分 stale ─────────────────────────────────────────────────────────

test('integrity: skill 被删 → staleRefs 反映,score 下降', () => {
  const { facts, skills, pursuits } = mkStores();
  seedSkill(skills, 'typing');
  // 不塞 'docs-first' —— 模拟被删
  seedPursuit(pursuits, 'p-typing');

  facts.updateSelfFact(
    'summary',
    '我对类型系统敏感',
    ['skill:typing', 'skill:docs-first', 'pursuit:p-typing'],
    'self-reflector',
  );

  const r = verifySelfSummaryIntegrity({ facts, skills, pursuits });
  assert.equal(r.totalRefs, 3);
  assert.equal(r.validRefs, 2);
  assert.deepEqual(r.staleRefs, ['skill:docs-first']);
  assert.ok(r.integrityScore > 0.6 && r.integrityScore < 0.7);
});

// ── 多 namespace 合并 ─────────────────────────────────────────────────

test('integrity: summary + strengths + growth_edges 跨 key 去重', () => {
  const { facts, skills, pursuits } = mkStores();
  seedSkill(skills, 'typing');
  seedSkill(skills, 'docs-first');
  seedPursuit(pursuits, 'p-typing');

  // summary 引用 typing + docs-first
  facts.updateSelfFact(
    'summary',
    '我对类型系统敏感',
    ['skill:typing', 'skill:docs-first'],
    'self-reflector',
  );
  // strengths 也引用 typing(重复 ref) + 新加 pursuit
  facts.updateSelfFact(
    'strengths',
    ['类型敏感', '文档优先'],
    ['skill:typing', 'pursuit:p-typing'],
    'self-reflector',
  );
  // growth_edges 引用一个不存在的
  facts.updateSelfFact(
    'growth_edges',
    ['架构级设计'],
    ['skill:nonexistent'],
    'self-reflector',
  );

  const r = verifySelfSummaryIntegrity({ facts, skills, pursuits });
  // 跨 key 去重后:typing, docs-first, p-typing, nonexistent = 4 unique
  assert.equal(r.totalRefs, 4);
  assert.equal(r.validRefs, 3);
  assert.deepEqual(r.staleRefs, ['skill:nonexistent']);
  // byKey 反映原始计数(去重前 typing 两次,但只在第一次出现的 key 里计入)
  const byKeyMap = new Map(r.byKey.map((b) => [b.key, b]));
  assert.equal(byKeyMap.get('summary')!.total, 2);
  // strengths 里的 typing 已被 summary 占了,不再计数
  assert.equal(byKeyMap.get('strengths')!.total, 1);
  assert.equal(byKeyMap.get('growth_edges')!.total, 1);
});

// ── 没有 self.summary ──────────────────────────────────────────────────

test('integrity: 没写过 self.* fact → totalRefs=0, score=1.0(优雅)', () => {
  const { facts, skills, pursuits } = mkStores();
  const r = verifySelfSummaryIntegrity({ facts, skills, pursuits });
  assert.equal(r.totalRefs, 0);
  assert.equal(r.validRefs, 0);
  assert.deepEqual(r.staleRefs, []);
  assert.equal(r.integrityScore, 1.0, '没引用 = 完整(没东西可坏)');
});

// ── unknown 格式的 ref ─────────────────────────────────────────────────

test('integrity: ref 不带 kind: 前缀 → unknownRefs + 算 stale', () => {
  const { facts, skills, pursuits } = mkStores();
  seedSkill(skills, 'typing');

  facts.updateSelfFact(
    'summary',
    'x',
    ['skill:typing', 'malformed-no-prefix', 'note:something'], // note: 不是支持的 kind
    'self-reflector',
  );

  const r = verifySelfSummaryIntegrity({ facts, skills, pursuits });
  assert.equal(r.totalRefs, 3);
  assert.equal(r.validRefs, 1);
  // 'malformed' 完全没 ':',会被 parseRef 判定 null → unknown
  // 'note:something' 有 ':' 但 kind 不在白名单,parseRef 也判 null → unknown
  assert.equal(r.unknownRefs.length, 2);
  assert.equal(r.staleRefs.length, 2);
});

// ── sourceRefs 字段损坏的容错 ─────────────────────────────────────────

test('integrity: SelfFactValue.sourceRefs 缺失或非数组 → 不抛错,跳过该 fact', () => {
  const { facts, skills, pursuits, db } = mkStores();
  // 直接 raw insert 一条没有 sourceRefs 字段的 self.summary,模拟旧数据
  // ⚠️ 这是测试专用 hack,生产 code path 必须走 updateSelfFact
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_facts (
      id, namespace, key, value_json,
      confidence, created_at, fact_kind
    ) VALUES (
      'broken-1', 'self', 'summary',
      '{"content":"x","updatedAt":${now}}',
      1.0, ${now}, 'state'
    )`,
  ).run();

  // 不抛错
  const r = verifySelfSummaryIntegrity({ facts, skills, pursuits });
  assert.equal(r.totalRefs, 0, '损坏的 fact 视为 0 ref,不算错');
  assert.equal(r.integrityScore, 1.0);
});
