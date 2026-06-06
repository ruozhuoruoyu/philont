/**
 * PursuitDriver propose() 单测。
 *
 * 关键不变量:
 *   - evidenceRefs.length === 0 → 跳过(交给 CuriosityDriver)
 *   - lastTouchedAt 在 stalledDays 内 → 跳过
 *   - isEvergreen → 跳过
 *   - 优先 advance-question(open question 存在);否则 check-resolution
 *   - deadline 临近 boost utility 0.10
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PursuitDriver,
  type MemorySnapshot,
} from '../src/index.js';
import type { Pursuit, OpenQuestion } from '../src/types.js';

const NOW = 1_750_000_000_000;
const STALE_AGO = 10 * 86_400_000; // 10 天前

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

function pursuit(over: Partial<Pursuit> = {}): Pursuit {
  return {
    id: 'p1',
    parentPursuitId: 'default',
    rootPursuitId: 'default',
    title: '迁移 SQLite 到 Postgres',
    intent: '稳定性 + 多用户并发',
    status: 'active',
    isEvergreen: false,
    stake: 'high',
    deadline: null,
    origin: 'user',
    openQuestions: [],
    resolutionCriteria: null,
    evidenceRefs: ['note-a', 'fact-b'],
    progressMarkers: [],
    lastProgressTurn: 0,
    values: null,
    redLines: null,
    driveBounds: null,
    pursuitGovernance: null,
    lastTouchedAt: NOW - STALE_AGO,
    stakeWeight: 8,
    isActiveResearch: false,
    researchIterations: 0,
    createdAt: NOW - 60 * 86_400_000,
    updatedAt: NOW - STALE_AGO,
    ...over,
  };
}

function openQ(over: Partial<OpenQuestion> = {}): OpenQuestion {
  return {
    id: 'q1',
    text: 'Postgres connection pooling 选什么?',
    status: 'open',
    createdTurn: 1,
    updatedTurn: 1,
    ...over,
  };
}

// ── advance-question 路径 ────────────────────────────────────────────────

test('PursuitDriver: 有 open question + evidence + 7+ 天 stalled → advance-question', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ openQuestions: [openQ()] })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'pursuit:advance-question');
  assert.equal(ps[0].targetRef, 'pursuit:p1:q:q1');
  assert.equal(ps[0].plan?.length, 3);
  assert.equal(ps[0].plan?.[0].tool, 'searchNotes');
  assert.equal(ps[0].plan?.[2].tool, 'webSearch');
});

test('PursuitDriver: 多 open question 选最早的(createdTurn 升序)', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      openQuestions: [
        openQ({ id: 'q-newer', text: 'newer', createdTurn: 5 }),
        openQ({ id: 'q-oldest', text: 'oldest', createdTurn: 1 }),
        openQ({ id: 'q-mid', text: 'mid', createdTurn: 3 }),
      ],
    })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].targetRef, 'pursuit:p1:q:q-oldest');
});

test('PursuitDriver: 跳过 status=resolved 的 question', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      openQuestions: [
        openQ({ id: 'q-done', status: 'resolved' }),
        openQ({ id: 'q-open', status: 'open', text: 'still open' }),
      ],
    })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].targetRef, 'pursuit:p1:q:q-open');
});

// ── check-resolution 路径 ────────────────────────────────────────────────

test('PursuitDriver: 无 open question + 有 resolutionCriteria → check-resolution', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      openQuestions: [],
      resolutionCriteria: '所有 SQL 查询通过 prisma client',
    })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'pursuit:check-resolution');
  assert.equal(ps[0].targetRef, 'pursuit:p1:resolve');
});

test('PursuitDriver: open question 优先于 check-resolution', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      openQuestions: [openQ()],
      resolutionCriteria: 'something',
    })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'pursuit:advance-question');
});

test('PursuitDriver: 无 open question 也无 resolutionCriteria → 不产 proposal', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      openQuestions: [],
      resolutionCriteria: null,
    })],
  }));
  assert.equal(ps.length, 0);
});

// ── 跳过条件 ─────────────────────────────────────────────────────────────

test('PursuitDriver: evidenceRefs 空 → 跳过(留给 CuriosityDriver)', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      evidenceRefs: [],
      openQuestions: [openQ()],
    })],
  }));
  assert.equal(ps.length, 0);
});

test('PursuitDriver: lastTouchedAt 在 stalled 阈值内 → 跳过', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      lastTouchedAt: NOW - 3 * 86_400_000, // 3 天前(< 7 天阈值)
      openQuestions: [openQ()],
    })],
  }));
  assert.equal(ps.length, 0);
});

test('PursuitDriver: isEvergreen → 跳过', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      isEvergreen: true,
      openQuestions: [openQ()],
    })],
  }));
  assert.equal(ps.length, 0);
});

test('PursuitDriver: targetRef 已在 24h dedup 集合 → 跳过', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ openQuestions: [openQ()] })],
    recentDoneTargetRefs: new Set(['pursuit:p1:q:q1']),
  }));
  assert.equal(ps.length, 0);
});

// ── utility 计算 ─────────────────────────────────────────────────────────

test('PursuitDriver: stake 越高 utility 越高', () => {
  const d = new PursuitDriver();
  const low = d.propose(snap({
    activePursuits: [pursuit({ id: 'lo', stakeWeight: 3, openQuestions: [openQ({ id: 'q-lo' })] })],
  }))[0];
  const hi = d.propose(snap({
    activePursuits: [pursuit({ id: 'hi', stakeWeight: 9, openQuestions: [openQ({ id: 'q-hi' })] })],
  }))[0];
  assert.ok(hi.utility > low.utility, `hi=${hi.utility} low=${low.utility}`);
});

test('PursuitDriver: deadline < 24h → utility 加 0.10', () => {
  const d = new PursuitDriver();
  const noDeadline = d.propose(snap({
    activePursuits: [pursuit({ id: 'a', openQuestions: [openQ({ id: 'qa' })] })],
  }))[0];
  const urgent = d.propose(snap({
    activePursuits: [pursuit({
      id: 'b',
      deadline: NOW + 12 * 60 * 60_000, // 12h 后
      openQuestions: [openQ({ id: 'qb' })],
    })],
  }))[0];
  assert.ok(urgent.utility - noDeadline.utility >= 0.09, `Δ=${urgent.utility - noDeadline.utility}`);
});

test('PursuitDriver: deadline 已过 → 不加 boost', () => {
  const d = new PursuitDriver();
  const overdue = d.propose(snap({
    activePursuits: [pursuit({
      deadline: NOW - 1000, // 已过
      openQuestions: [openQ()],
    })],
  }))[0];
  const baseline = d.propose(snap({
    activePursuits: [pursuit({ id: 'p2', deadline: null, openQuestions: [openQ({ id: 'q2' })] })],
  }))[0];
  // overdue 与无 deadline 应等价
  assert.ok(Math.abs(overdue.utility - baseline.utility) < 0.001);
});

test('PursuitDriver: utility 不超 0.95', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      stakeWeight: 10,
      lastTouchedAt: NOW - 365 * 86_400_000, // 1 年
      deadline: NOW + 60_000, // 即将到期
      openQuestions: [openQ()],
    })],
  }));
  assert.ok(ps[0].utility <= 0.95);
});

test('PursuitDriver: utility 不低于 0.5', () => {
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({
      stakeWeight: 1,
      lastTouchedAt: NOW - 8 * 86_400_000, // 刚过 stalled 阈值
      openQuestions: [openQ()],
    })],
  }));
  assert.ok(ps[0].utility >= 0.5);
});

// ── maxProposals 截断 ───────────────────────────────────────────────────

test('PursuitDriver: maxProposals 限制 + 按 utility 排序', () => {
  const d = new PursuitDriver({ stalledDays: 7, deadlineSoonMs: 24 * 3600_000, maxProposals: 2 });
  const pursuits: Pursuit[] = [];
  for (let i = 0; i < 5; i++) {
    pursuits.push(pursuit({
      id: `p${i}`,
      stakeWeight: i + 4, // 4..8
      openQuestions: [openQ({ id: `q${i}` })],
    }));
  }
  const ps = d.propose(snap({ activePursuits: pursuits }));
  assert.equal(ps.length, 2);
  // 第一条应该是 stake 最高那条(p4)
  assert.equal(ps[0].targetRef, 'pursuit:p4:q:q4');
});

// ── 与 CuriosityDriver 互补性 ───────────────────────────────────────────

test('PursuitDriver: evidenceRefs > 0 时与 CuriosityDriver 不冲突', () => {
  // CuriosityDriver dormant-pursuit 要求 evidenceRefs.length === 0;
  // PursuitDriver 要求 evidenceRefs.length > 0。两者严格互补。
  const d = new PursuitDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ evidenceRefs: ['x'], openQuestions: [openQ()] })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].driver, 'pursuit');
});
