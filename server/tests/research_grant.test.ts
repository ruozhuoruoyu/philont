/**
 * research_grant 纯逻辑单测:渲染卡片 / sessionId 重构 / 用户回复确定性裁决。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderResearchGrantPrompt,
  reconstructDmSessionId,
  decideResearchGrantAction,
  type PendingResearchGrant,
} from '../src/research_grant.js';

const NOW = 1_750_000_000_000;
const TTL = 2 * 60 * 60 * 1000; // 2h

function pending(over: Partial<PendingResearchGrant> = {}): PendingResearchGrant {
  return { pursuitId: 'p1', questionId: 'q1', tool: 'runLean', why: '验证', ts: NOW, ...over };
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────

test('renderResearchGrantPrompt: 含标题/工具/回复提示', () => {
  const t = renderResearchGrantPrompt('研究猜想 X', 'runLean', '跑形式化验证', TTL);
  assert.match(t, /后台研究请求授权/);
  assert.match(t, /研究猜想 X/);
  assert.match(t, /runLean/);
  assert.match(t, /跑形式化验证/);
  assert.match(t, /同意/);
  assert.match(t, /拒绝/);
  assert.match(t, /120 分钟/); // 2h ttl
});

test('renderResearchGrantPrompt: why 为空时不带括号', () => {
  const t = renderResearchGrantPrompt('研究 X', 'runZ3', '', TTL);
  assert.match(t, /runZ3/);
  assert.doesNotMatch(t, /\(\)/);
});

// ── sessionId 重构 ───────────────────────────────────────────────────────────

test('reconstructDmSessionId: 微信 DM → wechat:<acct>:<user>', () => {
  assert.equal(reconstructDmSessionId('wechat:acctA', 'userX'), 'wechat:acctA:userX');
});

test('reconstructDmSessionId: telegram DM → telegram:<bot>:<user>', () => {
  assert.equal(reconstructDmSessionId('telegram:bot1', 'u1'), 'telegram:bot1:u1');
});

test('reconstructDmSessionId: 未知渠道 → null', () => {
  assert.equal(reconstructDmSessionId('email', 'a@b.com'), null);
});

test('reconstructDmSessionId: 群订阅(peer group:) → null', () => {
  assert.equal(reconstructDmSessionId('wechat:acctA', 'group:g1'), null);
  assert.equal(reconstructDmSessionId('telegram:bot1', 'group:g1'), null);
});

// ── 确定性裁决 ───────────────────────────────────────────────────────────────

test('decide: 无 pending → passthrough', () => {
  assert.equal(decideResearchGrantAction(undefined, 'grant', NOW, TTL), 'passthrough');
});

test('decide: 未过期 + grant → grant', () => {
  assert.equal(decideResearchGrantAction(pending(), 'grant', NOW + 1000, TTL), 'grant');
});

test('decide: 未过期 + deny → deny', () => {
  assert.equal(decideResearchGrantAction(pending(), 'deny', NOW + 1000, TTL), 'deny');
});

test('decide: 未过期 + unclear → passthrough(交 LLM)', () => {
  assert.equal(decideResearchGrantAction(pending(), 'unclear', NOW + 1000, TTL), 'passthrough');
});

test('decide: 超 TTL → expired(即便 intent=grant 也不消费)', () => {
  assert.equal(decideResearchGrantAction(pending(), 'grant', NOW + TTL + 1, TTL), 'expired');
});

test('decide: 恰好 TTL 边界内 → 仍按 intent', () => {
  assert.equal(decideResearchGrantAction(pending(), 'grant', NOW + TTL, TTL), 'grant');
});
