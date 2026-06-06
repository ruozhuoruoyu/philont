/**
 * Routing rule 注入单测
 *
 * 覆盖:
 *   - 无规则 → 不注入(text='')
 *   - 关键词匹配 → 注入含 caveat / preferSkill / avoidSkills / carveout 的段
 *   - 不匹配的规则不注入(minScore 阈值)
 *   - 多规则按 confidence 排序后 top-K
 *   - retired 规则被排除(由 store.match 内部已实现)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../agent-memory/src/index.js';
import { buildRoutingInjection } from '../src/routing_inject.js';

test('inject: 空 user 消息 → 不注入', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = buildRoutingInjection('', routingRules);
  assert.equal(r.text, '');
  assert.equal(r.matched, 0);
});

test('inject: 无规则时 → 不注入', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = buildRoutingInjection('帮我转 PDF 为 Word 文档', routingRules);
  assert.equal(r.matched, 0);
  assert.equal(r.text, '');
});

test('inject: 关键词命中 validated 规则 → 注入含 caveat + prefer + carveout', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({
    taskSignature: 'pdf-to-word',
    triggerCondition: 'PDF 无文本层 / 扫描版',
    preferSkill: 'camscanner-pdf2office',
    avoidSkills: ['pdf2docx'],
    carveout: '不适用于含可选文本层的扫描版 PDF',
    evidence: 'turn 5-12',
    confidence: 'validated',
    contextKeywords: ['pdf', '扫描', 'word'],
  });

  const r = buildRoutingInjection('帮我把扫描版 PDF 转成 Word', routingRules);
  assert.ok(r.matched >= 1, `期望至少 1 条命中,实际 ${r.matched}`);
  assert.match(r.text, /历史经验路由/);
  assert.match(r.text, /pdf-to-word/);
  assert.match(r.text, /camscanner-pdf2office/);
  assert.match(r.text, /pdf2docx/);
  assert.match(r.text, /不适用/);
  assert.match(r.text, /\[validated\]/);
});

test('inject: ruleIds 返回命中规则的 id 列表(Phase 3 outcome 回流依赖)', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r1 = routingRules.createRule({
    taskSignature: 'pdf',
    triggerCondition: 'PDF 转换',
    preferSkill: 's1',
    carveout: 'c1',
    evidence: 'e1',
    confidence: 'validated',
    contextKeywords: ['pdf'],
  });
  const r2 = routingRules.createRule({
    taskSignature: 'word',
    triggerCondition: 'Word 文档',
    preferSkill: 's2',
    carveout: 'c2',
    evidence: 'e2',
    confidence: 'tentative',
    contextKeywords: ['word'],
  });

  const result = buildRoutingInjection('转 PDF 到 Word', routingRules);
  assert.ok(result.matched >= 2);
  assert.equal(result.ruleIds.length, result.matched);
  // 两个规则 id 都该在返回里
  assert.ok(result.ruleIds.includes(r1.id), '应含 r1.id');
  assert.ok(result.ruleIds.includes(r2.id), '应含 r2.id');
  // ruleIds 都是数字
  for (const id of result.ruleIds) {
    assert.equal(typeof id, 'number');
  }
});

test('inject: 不命中时 ruleIds 是空数组,matched=0', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = buildRoutingInjection('完全无关的消息', routingRules);
  assert.equal(r.matched, 0);
  assert.deepEqual(r.ruleIds, []);
  assert.equal(r.text, '');
});

test('inject: provisional 规则带"未验证" caveat', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({
    taskSignature: 't',
    triggerCondition: 'web scraping with html parser',
    preferSkill: 'cheerio',
    carveout: 'JavaScript-rendered 站不行',
    evidence: 'first try',
    confidence: 'provisional',
    contextKeywords: ['web', 'scraping', 'html'],
  });

  const r = buildRoutingInjection('我要 web scraping 一下 html', routingRules);
  assert.ok(r.matched >= 1);
  assert.match(r.text, /未验证/);
});

test('inject: 关键词不匹配 → 不注入(minScore 阈值)', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({
    taskSignature: 't',
    triggerCondition: 'video encoding',
    preferSkill: 'ffmpeg',
    carveout: 'GPU 加速另说',
    evidence: 'first',
    confidence: 'validated',
    contextKeywords: ['video', 'encoding', 'ffmpeg'],
  });

  const r = buildRoutingInjection('画图工具推荐', routingRules);
  assert.equal(r.matched, 0);
});

test('inject: top-K 限制', () => {
  const { routingRules } = openMemoryDb(':memory:');
  for (let i = 0; i < 5; i++) {
    routingRules.createRule({
      taskSignature: `sig-${i}`,
      triggerCondition: `cond ${i} pdf word`,
      preferSkill: `skill-${i}`,
      carveout: `c-${i}`,
      evidence: 'e',
      confidence: 'validated',
      contextKeywords: ['pdf', 'word', `kw-${i}`],
    });
  }
  const r = buildRoutingInjection('PDF Word 转换', routingRules, { topK: 2 });
  assert.equal(r.matched, 2);
});

test('inject: retired 规则被 store.match 排除', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const created = routingRules.createRule({
    taskSignature: 't',
    triggerCondition: 'pdf word',
    preferSkill: 'old-skill',
    carveout: 'c',
    evidence: 'e',
    confidence: 'validated',
    contextKeywords: ['pdf', 'word'],
  });
  routingRules.setConfidence(created.id, 'retired');

  const r = buildRoutingInjection('PDF Word', routingRules);
  assert.equal(r.matched, 0);
});

test('inject: 注入文本含底部"agent 自身蒸馏"提示', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({
    taskSignature: 't',
    triggerCondition: 'pdf transform',
    preferSkill: 'x',
    carveout: 'c',
    evidence: 'e',
    confidence: 'validated',
    contextKeywords: ['pdf', 'transform'],
  });
  const r = buildRoutingInjection('我要做 pdf transform', routingRules);
  assert.match(r.text, /agent 自身/);
  assert.match(r.text, /忽略并按当前情况处理/);
});
