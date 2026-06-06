/**
 * routing_bundled.ts:bundled skill 自动 routing rule 生成单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  ensureBundledRoutingRule,
  shouldAutoRouteSkill,
  AUTO_BUNDLED_PREFIX,
} from '../src/index.js';
import { extractKeywords } from '../src/routing_rules.js';
import type { ImportableSkill } from '../src/index.js';

function makeSkill(over: Partial<ImportableSkill> = {}): ImportableSkill {
  return {
    name: 'sample',
    description: 'desc',
    triggerKeywords: ['k1', 'k2'],
    actionTemplate: '...',
    whenToUse: 'when user says X',
    source: null,
    ...over,
  };
}

// ── shouldAutoRouteSkill ─────────────────────────────────────────────

test('shouldAutoRouteSkill: 标准 bundled skill → true', () => {
  assert.equal(shouldAutoRouteSkill(makeSkill()), true);
});

test('shouldAutoRouteSkill: whenToUse 空 → false', () => {
  assert.equal(shouldAutoRouteSkill(makeSkill({ whenToUse: '' })), false);
  assert.equal(shouldAutoRouteSkill(makeSkill({ whenToUse: '   ' })), false);
  assert.equal(shouldAutoRouteSkill(makeSkill({ whenToUse: undefined })), false);
});

test('shouldAutoRouteSkill: kind=negative → false', () => {
  assert.equal(shouldAutoRouteSkill(makeSkill({ kind: 'negative' })), false);
});

test('shouldAutoRouteSkill: source self:reflect-* → false', () => {
  assert.equal(shouldAutoRouteSkill(makeSkill({ source: 'self:reflect-abc' })), false);
});

test('shouldAutoRouteSkill: source self:doc-to-skill:* → false', () => {
  assert.equal(shouldAutoRouteSkill(makeSkill({ source: 'self:doc-to-skill:abc' })), false);
});

test('shouldAutoRouteSkill: source clawhub:* → true(社区 skill 也自动建 routing)', () => {
  assert.equal(shouldAutoRouteSkill(makeSkill({ source: 'clawhub:foo@1.0' })), true);
});

// ── ensureBundledRoutingRule ─────────────────────────────────────────

test('ensureBundledRoutingRule: 首次创建', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const rule = ensureBundledRoutingRule(routingRules, makeSkill());
  assert.ok(rule);
  assert.equal(rule.taskSignature, `${AUTO_BUNDLED_PREFIX}sample`);
  assert.equal(rule.preferSkill, 'sample');
  assert.equal(rule.confidence, 'tentative');
  assert.match(rule.triggerCondition, /when user says X/);
  // contextKeywords 是 tokens(extractKeywords 提取自 whenToUse + description + triggerKeywords)
  assert.ok(rule.contextKeywords.includes('k1'));
  assert.ok(rule.contextKeywords.includes('k2'));
  // whenToUse 'when user says X' 提 token
  assert.ok(rule.contextKeywords.includes('when'));
  assert.ok(rule.contextKeywords.includes('user'));
});

test('ensureBundledRoutingRule: 第二次调用同 skill → no-op return null', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r1 = ensureBundledRoutingRule(routingRules, makeSkill());
  assert.ok(r1);
  const r2 = ensureBundledRoutingRule(routingRules, makeSkill());
  assert.equal(r2, null, '第二次应 skip');
  // DB 仍只有 1 条
  const all = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}sample`);
  assert.equal(all.length, 1);
});

test('ensureBundledRoutingRule: 已 retired 的同 sig 不复活', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = ensureBundledRoutingRule(routingRules, makeSkill());
  assert.ok(r);
  routingRules.setConfidence(r.id, 'retired');
  // 重新装入 → 不应复活,也不应再创建一条
  const r2 = ensureBundledRoutingRule(routingRules, makeSkill());
  assert.equal(r2, null);
  const all = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}sample`);
  assert.equal(all.length, 1);
  assert.equal(all[0].confidence, 'retired', 'retired 状态保留');
});

test('ensureBundledRoutingRule: skill skipped → null + 无副作用', () => {
  const { routingRules } = openMemoryDb(':memory:');
  // negative
  assert.equal(ensureBundledRoutingRule(routingRules, makeSkill({ kind: 'negative' })), null);
  // self:reflect
  assert.equal(ensureBundledRoutingRule(routingRules, makeSkill({ source: 'self:reflect-x' })), null);
  // 空 whenToUse
  assert.equal(ensureBundledRoutingRule(routingRules, makeSkill({ whenToUse: '' })), null);
  // routing_rules 表没新增
  const all = routingRules.listAll();
  assert.equal(all.length, 0);
});

test('ensureBundledRoutingRule: contextKeywords 提 tokens(粒度跟 user 端 extractKeywords 一致)', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const r = ensureBundledRoutingRule(routingRules, makeSkill({
    triggerKeywords: ['用户说 register 或 onboard 类请求', 'API 调用'],
    whenToUse: '用户给 service 文档 URL',
    description: '从文档归纳 skill',
  }));
  assert.ok(r);
  // 应该是 tokens 而不是整段文本
  // 英文小写,中文走 char-bigram + trigram
  assert.ok(r.contextKeywords.includes('register'), 'tokens 应含 register');
  assert.ok(r.contextKeywords.includes('onboard'), 'tokens 应含 onboard');
  assert.ok(r.contextKeywords.includes('api'), 'tokens 应含 api(小写化)');
  // 不应包含整段文本(那是错误的旧格式)
  assert.ok(
    !r.contextKeywords.some((k) => k.length > 30),
    'contextKeywords 不应含 >30 字符的整段文本',
  );
});

test('ensureBundledRoutingRule: 跟 user 端 extractKeywords 真匹配上(通用,任意 service)', () => {
  const { routingRules } = openMemoryDb(':memory:');
  // 模拟 service-onboarding skill 写入(generic 描述,不绑特定 service)
  ensureBundledRoutingRule(routingRules, makeSkill({
    name: 'service-onboarding',
    triggerKeywords: [
      '用户希望 agent 周期性跟外部 service 交互',
      '例:帮我注册 X service,key 是 xxx,每 30 分钟心跳',
      'Slack workspace / 内部 API / 第三方 service 集成',
    ],
    whenToUse: '用户给 service 文档 URL + 凭证 + 心跳间隔时',
    description: '从外部 service 文档自动 onboard',
  }));

  // 模拟 user 发任意 service onboarding 请求(通用形态,不限 mycox)
  // 真实 routing-inject 路径:user message → extractKeywords → match
  const userKeywords = extractKeywords('Read https://api.example.com/service/guide.md, then register with invite_code "inv_xxx"');

  const matches = routingRules.match(null, userKeywords, { minScore: 0.01 });
  assert.ok(matches.length >= 1, 'service URL + register 应该命中 service-onboarding rule');
  assert.equal(matches[0].preferSkill, 'service-onboarding');
});
