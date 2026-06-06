/**
 * RoutingRuleStore + confidence 状态机测试
 *
 * 覆盖:
 *   - createRule: write-time 强制 carveout / evidence;contextKeywords 自动抽取
 *   - confidence 状态机所有迁移
 *   - match: task_signature + keyword 匹配 + score / specificity 排序
 *   - invalidateBySkillName: 引用 prefer_skill 的规则被 retired
 *   - keyword overlap / specificity 算分边界
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  nextConfidence,
  confidenceRank,
  isActiveConfidence,
  confidenceCaveat,
  parseConfidence,
  extractKeywords,
  keywordOverlap,
  specificity,
} from '../src/index.js';
import type { RoutingConfidence, RoutingRule } from '../src/index.js';

// ── nextConfidence (纯函数) ─────────────────────────────────────────────

test('confidence: provisional + 1 succ → tentative', () => {
  const r = nextConfidence({
    current: 'provisional',
    consecutiveSuccesses: 1,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'tentative');
});

test('confidence: tentative + 1 succ (streak < 2) → 仍 tentative', () => {
  const r = nextConfidence({
    current: 'tentative',
    consecutiveSuccesses: 1,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'tentative');
});

test('confidence: tentative + 2 succ streak → validated', () => {
  const r = nextConfidence({
    current: 'tentative',
    consecutiveSuccesses: 2,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'validated');
});

test('confidence: validated + 1 fail → disputed', () => {
  const r = nextConfidence({
    current: 'validated',
    consecutiveSuccesses: 0,
    consecutiveFailures: 1,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'disputed');
});

test('confidence: disputed + 2 succ streak → validated (恢复)', () => {
  const r = nextConfidence({
    current: 'disputed',
    consecutiveSuccesses: 2,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(r, 'validated');
});

test('confidence: disputed + 2 fail streak → retired', () => {
  const r = nextConfidence({
    current: 'disputed',
    consecutiveSuccesses: 0,
    consecutiveFailures: 2,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'retired');
});

test('confidence: disputed + 1 fail (streak < 2) → 仍 disputed', () => {
  const r = nextConfidence({
    current: 'disputed',
    consecutiveSuccesses: 0,
    consecutiveFailures: 1,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'disputed');
});

test('confidence: tentative + 1 fail → provisional (catch-all 降一档)', () => {
  const r = nextConfidence({
    current: 'tentative',
    consecutiveSuccesses: 0,
    consecutiveFailures: 1,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'provisional');
});

test('confidence: provisional + 1 fail → disputed (escalate alarm)', () => {
  const r = nextConfidence({
    current: 'provisional',
    consecutiveSuccesses: 0,
    consecutiveFailures: 1,
    lastOutcome: 'failure',
  });
  assert.equal(r, 'disputed');
});

test('confidence: retired 任何情况都不变(终态)', () => {
  const succ = nextConfidence({
    current: 'retired',
    consecutiveSuccesses: 100,
    consecutiveFailures: 0,
    lastOutcome: 'success',
  });
  assert.equal(succ, 'retired');
  const fail = nextConfidence({
    current: 'retired',
    consecutiveSuccesses: 0,
    consecutiveFailures: 100,
    lastOutcome: 'failure',
  });
  assert.equal(fail, 'retired');
});

// ── 辅助函数 ────────────────────────────────────────────────────────────

test('confidenceRank: validated > tentative > provisional > disputed > retired', () => {
  assert.ok(confidenceRank('validated') > confidenceRank('tentative'));
  assert.ok(confidenceRank('tentative') > confidenceRank('provisional'));
  assert.ok(confidenceRank('provisional') > confidenceRank('disputed'));
  assert.ok(confidenceRank('disputed') > confidenceRank('retired'));
});

test('isActiveConfidence: retired=false 其余=true', () => {
  assert.equal(isActiveConfidence('retired'), false);
  assert.equal(isActiveConfidence('disputed'), true);
  assert.equal(isActiveConfidence('provisional'), true);
});

test('confidenceCaveat: 各档有特征字样', () => {
  assert.match(confidenceCaveat('provisional'), /not yet validated/);
  assert.match(confidenceCaveat('disputed'), /caution|counter-examples/);
  assert.equal(confidenceCaveat('validated'), '[validated]');
});

test('parseConfidence: 合法 / fallback', () => {
  assert.equal(parseConfidence('validated'), 'validated');
  assert.equal(parseConfidence('xxx'), 'provisional');
  assert.equal(parseConfidence(null, 'tentative'), 'tentative');
});

// ── extractKeywords ─────────────────────────────────────────────────────

test('extractKeywords: 英文按空格分词', () => {
  const k = extractKeywords('PDF conversion using OCR');
  assert.ok(k.includes('pdf'));
  assert.ok(k.includes('conversion'));
  assert.ok(k.includes('ocr'));
});

test('extractKeywords: 中文产生 bigram', () => {
  const k = extractKeywords('扫描版');
  // 整段 + bigram
  assert.ok(k.includes('扫描版'));
  assert.ok(k.includes('扫描'));
});

test('extractKeywords: 标点切分', () => {
  const k = extractKeywords('PDF, scanned / no text layer');
  assert.ok(k.includes('pdf'));
  assert.ok(k.includes('scanned'));
  assert.ok(k.includes('layer'));
});

test('extractKeywords: 去重', () => {
  const k = extractKeywords('aa aa aa');
  // aa 只出现一次
  assert.equal(k.filter((x) => x === 'aa').length, 1);
});

// ── keywordOverlap ──────────────────────────────────────────────────────

test('keywordOverlap: 完全重叠 = 1', () => {
  assert.equal(keywordOverlap(['a', 'b'], ['a', 'b']), 1);
});

test('keywordOverlap: 完全不重叠 = 0', () => {
  assert.equal(keywordOverlap(['a', 'b'], ['c', 'd']), 0);
});

test('keywordOverlap: 部分重叠 (Jaccard 简化版)', () => {
  // intersection=1, union=3 → 1/3 ≈ 0.333
  const score = keywordOverlap(['a', 'b'], ['a', 'c']);
  assert.ok(Math.abs(score - 1 / 3) < 0.01);
});

test('keywordOverlap: 空数组 = 0', () => {
  assert.equal(keywordOverlap([], ['a']), 0);
  assert.equal(keywordOverlap(['a'], []), 0);
});

// ── specificity ──────────────────────────────────────────────────────────

test('specificity: 关键词多 + carveout 长 → 分数高', () => {
  const ruleA: RoutingRule = makeMockRule({
    contextKeywords: ['a', 'b', 'c', 'd'],
    carveout: 'x'.repeat(200),
  });
  const ruleB: RoutingRule = makeMockRule({
    contextKeywords: ['a'],
    carveout: '简短',
  });
  assert.ok(specificity(ruleA) > specificity(ruleB));
});

function makeMockRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 1,
    taskSignature: 'sig',
    triggerCondition: 'cond',
    preferSkill: null,
    avoidSkills: [],
    carveout: 'cv',
    evidence: 'ev',
    confidence: 'tentative',
    successCount: 0,
    failureCount: 0,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    contextKeywords: [],
    reflectionId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ── E2E: RoutingRuleStore ────────────────────────────────────────────────

test('createRule: write-time 强制 carveout 非空', () => {
  const { routingRules } = openMemoryDb(':memory:');
  assert.throws(() =>
    routingRules.createRule({
      taskSignature: 'pdf-to-word',
      triggerCondition: '扫描版 PDF',
      carveout: '',
      evidence: 'turn 5-12',
    }),
    /carveout/,
  );
});

test('createRule: write-time 强制 evidence 非空', () => {
  const { routingRules } = openMemoryDb(':memory:');
  assert.throws(() =>
    routingRules.createRule({
      taskSignature: 'pdf-to-word',
      triggerCondition: '扫描版 PDF',
      carveout: '不适用 X',
      evidence: '   ',
    }),
    /evidence/,
  );
});

test('createRule: 默认 confidence=provisional + 自动抽 keywords', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'pdf-to-word',
    triggerCondition: 'scanned PDF without text layer',
    preferSkill: 'camscanner-pdf2office',
    avoidSkills: ['pdf2docx'],
    carveout: '不适用于含可选文本层的 PDF',
    evidence: '本次 turn 5-12 验证',
  });
  assert.equal(r.confidence, 'provisional');
  assert.ok(r.contextKeywords.length > 0);
  assert.ok(r.contextKeywords.includes('pdf') || r.contextKeywords.includes('scanned'));
  assert.equal(r.preferSkill, 'camscanner-pdf2office');
  assert.deepEqual(r.avoidSkills, ['pdf2docx']);
});

test('createRule: caller 显式 contextKeywords / confidence 透传', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'x',
    carveout: 'y',
    evidence: 'z',
    confidence: 'tentative',
    contextKeywords: ['custom-kw-1', 'custom-kw-2'],
  });
  assert.equal(r.confidence, 'tentative');
  assert.deepEqual(r.contextKeywords, ['custom-kw-1', 'custom-kw-2']);
});

test('recordRuleOutcome: 1 succ 后 provisional → tentative', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'cond',
    carveout: 'cv',
    evidence: 'ev',
  });
  const after = routingRules.recordRuleOutcome(r.id, true);
  assert.equal(after?.confidence, 'tentative');
  assert.equal(after?.successCount, 1);
  assert.equal(after?.consecutiveSuccesses, 1);
});

test('recordRuleOutcome: 整个升级 + 降级生命周期', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'cond',
    carveout: 'cv',
    evidence: 'ev',
  });
  // provisional → tentative
  let s = routingRules.recordRuleOutcome(r.id, true);
  assert.equal(s?.confidence, 'tentative');
  // tentative + 1 more succ → validated (streak >= 2)
  s = routingRules.recordRuleOutcome(r.id, true);
  assert.equal(s?.confidence, 'validated');
  // validated + 1 fail → disputed
  s = routingRules.recordRuleOutcome(r.id, false);
  assert.equal(s?.confidence, 'disputed');
  // disputed + 1 succ → 仍 disputed (streak < 2)
  s = routingRules.recordRuleOutcome(r.id, true);
  assert.equal(s?.confidence, 'disputed');
  // disputed + 1 succ (streak = 2) → validated (恢复)
  s = routingRules.recordRuleOutcome(r.id, true);
  assert.equal(s?.confidence, 'validated');
});

test('recordRuleOutcome: disputed + 2 fail streak → retired', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'cond',
    carveout: 'cv',
    evidence: 'ev',
    confidence: 'disputed',
  });
  routingRules.recordRuleOutcome(r.id, false);
  let s = routingRules.recordRuleOutcome(r.id, false);
  assert.equal(s?.confidence, 'retired');
});

test('recordRuleOutcome: retired 自动机不复活', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'cond',
    carveout: 'cv',
    evidence: 'ev',
  });
  routingRules.setConfidence(r.id, 'retired');
  const s = routingRules.recordRuleOutcome(r.id, true);
  assert.equal(s?.confidence, 'retired');
});

test('match: task_signature exact + keyword 重叠命中 → 命中规则', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({
    taskSignature: 'pdf-to-word',
    triggerCondition: '扫描版 PDF 无文本层',
    preferSkill: 'camscanner',
    carveout: 'x',
    evidence: 'y',
    confidence: 'validated',
  });
  routingRules.createRule({
    taskSignature: 'image-resize',
    triggerCondition: 'image transform',
    preferSkill: 'sharp',
    carveout: 'x',
    evidence: 'y',
    confidence: 'validated',
  });

  const matches = routingRules.match('pdf-to-word', extractKeywords('扫描版 PDF'), { limit: 5 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].preferSkill, 'camscanner');
});

test('match: retired 不返回', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'pdf-to-word',
    triggerCondition: 'a b c',
    carveout: 'x',
    evidence: 'y',
  });
  routingRules.setConfidence(r.id, 'retired');
  const matches = routingRules.match('pdf-to-word', ['a', 'b', 'c']);
  assert.equal(matches.length, 0);
});

test('match: 高 confidence 优先', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'a b',
    carveout: 'x',
    evidence: 'y',
    confidence: 'provisional',
  });
  const high = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'a b',
    carveout: 'x',
    evidence: 'y',
    confidence: 'validated',
  });

  const matches = routingRules.match('sig', ['a', 'b'], { limit: 5 });
  assert.equal(matches[0].id, high.id);
});

test('invalidateBySkillName: 引用 prefer_skill 的规则被 retired', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r1 = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'cond',
    preferSkill: 'pdf2docx',
    carveout: 'x',
    evidence: 'y',
    confidence: 'validated',
  });
  const r2 = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'cond',
    preferSkill: 'camscanner',
    carveout: 'x',
    evidence: 'y',
    confidence: 'validated',
  });
  // avoid 引用不动
  const r3 = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'cond',
    preferSkill: null,
    avoidSkills: ['pdf2docx'],
    carveout: 'x',
    evidence: 'y',
    confidence: 'validated',
  });

  const n = routingRules.invalidateBySkillName('pdf2docx');
  assert.equal(n, 1);
  assert.equal(routingRules.getById(r1.id)?.confidence, 'retired');
  assert.equal(routingRules.getById(r2.id)?.confidence, 'validated');
  assert.equal(routingRules.getById(r3.id)?.confidence, 'validated');
});

test('count / countActive: retired 不计入 active', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'c',
    carveout: 'x',
    evidence: 'y',
  });
  routingRules.createRule({
    taskSignature: 'sig2',
    triggerCondition: 'c2',
    carveout: 'x',
    evidence: 'y',
  });
  routingRules.setConfidence(r.id, 'retired');

  assert.equal(routingRules.count(), 2);
  assert.equal(routingRules.countActive(), 1);
});

test('listBySignature: 仅返回该 signature 的规则', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({ taskSignature: 'a', triggerCondition: 'x', carveout: 'c', evidence: 'e' });
  routingRules.createRule({ taskSignature: 'a', triggerCondition: 'y', carveout: 'c', evidence: 'e' });
  routingRules.createRule({ taskSignature: 'b', triggerCondition: 'z', carveout: 'c', evidence: 'e' });
  assert.equal(routingRules.listBySignature('a').length, 2);
  assert.equal(routingRules.listBySignature('b').length, 1);
});

test('delete: 物理删除', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'c',
    carveout: 'x',
    evidence: 'y',
  });
  assert.equal(routingRules.delete(r.id), true);
  assert.equal(routingRules.getById(r.id), null);
  assert.equal(routingRules.delete(99999), false);
});
