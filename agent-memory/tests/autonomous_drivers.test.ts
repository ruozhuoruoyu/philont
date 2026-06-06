/**
 * GapDriver / CuriosityDriver propose() 单测。
 *
 * 测试是纯函数(driver 不写 DB,不调 LLM),用手工构造 MemorySnapshot 喂入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GapDriver,
  CuriosityDriver,
  extractSpecificTokens,
  type MemorySnapshot,
} from '../src/index.js';
import type { Fact, Pursuit, Skill } from '../src/types.js';
import type { RoutingRule } from '../src/routing_rules.js';

const NOW = 1_750_000_000_000; // 固定时刻方便复现

function snap(partial: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    facts: [],
    routingRules: [],
    skills: [],
    activePursuits: [],
    recentTimelineTokens: [],
    recentDoneTargetRefs: new Set(),
    now: NOW,
    ...partial,
  };
}

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: 'f1',
    namespace: 'project',
    key: 'foo',
    value: { text: 'bar' },
    confidence: 1.0,
    supersededBy: null,
    supersedes: null,
    createdAt: NOW - 60_000,
    occurredAt: null,
    validFrom: null,
    validUntil: null,
    lastAccessedAt: null,
    decayTauDays: null,
    forgottenAt: null,
    factKind: 'state',
    ...over,
  };
}

function rule(over: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 1,
    taskSignature: 'pdf-to-word',
    triggerCondition: '',
    preferSkill: null,
    avoidSkills: [],
    carveout: 'x',
    evidence: 'y',
    confidence: 'provisional',
    successCount: 0,
    failureCount: 0,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    contextKeywords: [],
    reflectionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: 's1',
    name: 'web-research',
    description: '',
    whenToUse: '',
    triggerKeywords: [],
    actionTemplate: '',
    useCount: 0,
    lastUsedAt: null,
    createdAt: NOW - 86_400_000,
    successCount: 0,
    failureCount: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    maturity: 'draft',
    kind: 'positive',
    source: null,
    ...over,
  };
}

function pursuit(over: Partial<Pursuit> = {}): Pursuit {
  return {
    id: 'p1',
    parentPursuitId: 'default',
    rootPursuitId: 'default',
    title: 'investigate something',
    intent: '',
    status: 'active',
    isEvergreen: false,
    stake: 'high',
    deadline: null,
    origin: 'system',
    openQuestions: [],
    resolutionCriteria: null,
    evidenceRefs: [],
    progressMarkers: [],
    lastProgressTurn: 0,
    values: null,
    redLines: null,
    driveBounds: null,
    pursuitGovernance: null,
    lastTouchedAt: NOW - 30 * 86_400_000,
    stakeWeight: 8,
    isActiveResearch: false,
    researchIterations: 0,
    createdAt: NOW - 60 * 86_400_000,
    updatedAt: NOW - 30 * 86_400_000,
    ...over,
  };
}

// ── extractSpecificTokens 复用旧测试场景 ─────────────────────────────────

test('extractSpecificTokens: arxiv / CVE / RFC / lib@version / URL', () => {
  assert.ok(extractSpecificTokens('arxiv 2507.21046').some((t) => /2507\.21046/.test(t)));
  assert.ok(extractSpecificTokens('CVE-2024-12345').some((t) => /CVE-2024/i.test(t)));
  assert.ok(extractSpecificTokens('RFC 9234').some((t) => /9234/.test(t)));
  assert.ok(extractSpecificTokens('react@18.3').some((t) => /react@18/.test(t)));
  assert.ok(extractSpecificTokens('https://x.com/foo').length > 0);
});

test('extractSpecificTokens: 普通对话 → 空', () => {
  assert.deepEqual(extractSpecificTokens('你好,今天天气怎么样?'), []);
});

test('extractSpecificTokens: 引号包裹的纯中文短语 → 滤掉(无结构化信号)', () => {
  // 防 CuriosityDriver 把"工具调用" / "上下文" 等元概念词当 specific token
  assert.deepEqual(extractSpecificTokens('模型在做"工具调用"时'), []);
  assert.deepEqual(extractSpecificTokens('上下文"指代"问题'), []);
  assert.deepEqual(extractSpecificTokens('「记忆」是关键'), []);
  assert.deepEqual(extractSpecificTokens('"智能体"概念在演进'), []);
});

test('extractSpecificTokens: 引号包裹含英文/数字 → 保留', () => {
  // 真正的具体名词应该过
  assert.ok(extractSpecificTokens('叫做"Hermes-2"的模型').some((t) => /Hermes-2/.test(t)));
  assert.ok(extractSpecificTokens('"GPT-4" 表现').some((t) => /GPT-4/.test(t)));
  assert.ok(extractSpecificTokens('「v1.2.3」版本').some((t) => /v1\.2\.3/.test(t)));
});

test('extractSpecificTokens: 书名号《》→ 即使纯中文也保留(书名/作品名)', () => {
  assert.ok(extractSpecificTokens('《动手学深度学习》一书').some((t) => /动手学深度学习/.test(t)));
  assert.ok(extractSpecificTokens('参考《人月神话》').some((t) => /人月神话/.test(t)));
});

// ── GapDriver ───────────────────────────────────────────────────────────

test('GapDriver: 低 confidence fact 命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ confidence: 0.2, value: { x: 1, sourceRefs: ['url'] } })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'fact_gap');
  assert.equal(ps[0].targetRef, 'fact:f1');
  assert.ok(ps[0].utility >= 0.7);
});

test('GapDriver: sourceRefs 空命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ confidence: 0.9, value: { x: 1 } })], // 无 sourceRefs
  }));
  assert.equal(ps.length, 1);
  assert.match(ps[0].rationale, /no sourceRefs/);
});

test('GapDriver: 高 confidence + 有 sourceRefs → 不命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ confidence: 0.9, value: { x: 1, sourceRefs: ['url'] } })],
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: self.* / system.* 不在范围', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [
      fact({ namespace: 'self', confidence: 0.1 }),
      fact({ namespace: 'system', confidence: 0.1 }),
    ],
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: 老 fact(超出 recent 窗口)不命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ confidence: 0.1, createdAt: NOW - 30 * 86_400_000 })], // 30 天前
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: routing dispute + ≥2 连败命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    routingRules: [rule({ confidence: 'disputed', consecutiveFailures: 3 })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'routing_dispute');
  assert.equal(ps[0].targetRef, 'routing:1');
});

test('GapDriver: routing dispute 但连败 < 阈值 → 不命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    routingRules: [rule({ confidence: 'disputed', consecutiveFailures: 1 })],
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: draft skill + ≥2 连败命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    skills: [skill({ maturity: 'draft', consecutiveFailures: 2 })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'skill_failing');
  assert.equal(ps[0].targetRef, 'skill:web-research');
});

test('GapDriver: stable skill 不在范围', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    skills: [skill({ maturity: 'stable', consecutiveFailures: 5 })],
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: 24h 已 done 的 targetRef 跳过', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ id: 'f1', confidence: 0.1 })],
    recentDoneTargetRefs: new Set(['fact:f1']),
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: maxProposals 截断', () => {
  const d = new GapDriver({
    factConfidenceThreshold: 0.3,
    factRecentDays: 7,
    routingMinConsecutiveFailures: 2,
    skillMinConsecutiveFailures: 2,
    maxProposals: 2,
  });
  const facts = Array.from({ length: 5 }, (_, i) =>
    fact({ id: `f${i}`, confidence: 0.1 - i * 0.01 }),
  );
  const ps = d.propose(snap({ facts }));
  assert.equal(ps.length, 2);
});

// ── CuriosityDriver ─────────────────────────────────────────────────────

test('CuriosityDriver: token 未被任何 fact 引用 → 命中', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001'],
    facts: [fact({ key: 'something-else', value: { sourceRefs: ['url'] } })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'curiosity_token');
  assert.equal(ps[0].targetRef, 'token:CVE-2026-0001');
});

test('CuriosityDriver: token 在某 fact.sourceRefs 字符串里 → 跳过', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001'],
    facts: [fact({ value: { sourceRefs: ['https://x.com/CVE-2026-0001'] } })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: token 在某 fact.key 命中 → 跳过', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001'],
    facts: [fact({ key: 'CVE-2026-0001', value: {} })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: 已 done targetRef 跳过', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001'],
    recentDoneTargetRefs: new Set(['token:CVE-2026-0001']),
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: dormant high-stake pursuit 命中', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 8, lastTouchedAt: NOW - 30 * 86_400_000 })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'curiosity_dormant_pursuit');
  assert.equal(ps[0].targetRef, 'pursuit:p1');
});

test('CuriosityDriver: low stake pursuit 不命中', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 5 })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: pursuit 有 evidenceRefs → 不算"许愿没碰"', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 8, evidenceRefs: ['some-ref'] })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: 最近触碰过的 pursuit 不算 dormant', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 8, lastTouchedAt: NOW - 1 * 86_400_000 })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: 学术 ID utility > 普通 token utility', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001', 'RANDOMACRO'],
  }));
  // utility 排序后 CVE 在前
  assert.equal(ps[0].targetRef, 'token:CVE-2026-0001');
  assert.ok(ps[0].utility > ps[1].utility);
});

test('CuriosityDriver: maxProposals 截断', () => {
  const d = new CuriosityDriver({
    minTokenMentions: 1,
    pursuitAgingDays: 14,
    pursuitMinStakeWeight: 7,
    maxProposals: 2,
  });
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-1', 'CVE-2', 'CVE-3', 'CVE-4'],
  }));
  assert.equal(ps.length, 2);
});
