/**
 * WeChat 准入策略层测试。纯函数,完全确定性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkInboundPolicy,
  policyFromEnv,
  DEFAULT_POLICY,
  type PolicyConfig,
} from '../src/channels/wechat/policy.js';

// ── DM 路径 ────────────────────────────────────────────

test('DM/open: 任何用户允许', () => {
  const cfg: PolicyConfig = { ...DEFAULT_POLICY, dmPolicy: 'open' };
  const r = checkInboundPolicy({ fromUserId: 'random' }, cfg);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'dm_open');
});

test('DM/disabled: 全拒', () => {
  const cfg: PolicyConfig = { ...DEFAULT_POLICY, dmPolicy: 'disabled' };
  const r = checkInboundPolicy({ fromUserId: 'alice' }, cfg);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'dm_disabled');
});

test('DM/allowlist: 命中放行', () => {
  const cfg: PolicyConfig = {
    ...DEFAULT_POLICY,
    dmPolicy: 'allowlist',
    allowedUsers: ['alice', 'bob'],
  };
  assert.equal(checkInboundPolicy({ fromUserId: 'alice' }, cfg).allowed, true);
  assert.equal(checkInboundPolicy({ fromUserId: 'bob' }, cfg).allowed, true);
  assert.equal(checkInboundPolicy({ fromUserId: 'carol' }, cfg).allowed, false);
});

test('DM/allowlist 空白名单: 全拒', () => {
  const cfg: PolicyConfig = {
    ...DEFAULT_POLICY,
    dmPolicy: 'allowlist',
    allowedUsers: [],
  };
  const r = checkInboundPolicy({ fromUserId: 'anyone' }, cfg);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'dm_allowlist_miss');
});

test('DM/pairing: v1 当 disabled', () => {
  const cfg: PolicyConfig = { ...DEFAULT_POLICY, dmPolicy: 'pairing' };
  const r = checkInboundPolicy({ fromUserId: 'alice' }, cfg);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'dm_pairing');
});

test('DM 缺 fromUserId 拒绝', () => {
  const r = checkInboundPolicy({ fromUserId: '' }, DEFAULT_POLICY);
  assert.equal(r.allowed, false);
});

// ── Group 路径 ────────────────────────────────────────────

test('Group/disabled: 全拒(默认配置)', () => {
  const r = checkInboundPolicy({ fromUserId: 'alice', groupId: 'g1' }, DEFAULT_POLICY);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'group_disabled');
});

test('Group/open: 任何群任何人放行', () => {
  const cfg: PolicyConfig = { ...DEFAULT_POLICY, groupPolicy: 'open' };
  const r = checkInboundPolicy({ fromUserId: 'alice', groupId: 'g1' }, cfg);
  assert.equal(r.allowed, true);
});

test('Group/allowlist + 群在白名单 + 用户在 allowedUsers → 允许', () => {
  const cfg: PolicyConfig = {
    dmPolicy: 'disabled',
    groupPolicy: 'allowlist',
    allowedUsers: ['alice'],
    allowedGroups: ['g1'],
  };
  assert.equal(checkInboundPolicy({ fromUserId: 'alice', groupId: 'g1' }, cfg).allowed, true);
  // 群不在白名单
  assert.equal(checkInboundPolicy({ fromUserId: 'alice', groupId: 'g2' }, cfg).allowed, false);
  // 用户不在白名单
  assert.equal(checkInboundPolicy({ fromUserId: 'mallory', groupId: 'g1' }, cfg).allowed, false);
});

test('Group/allowlist + groupOverrides.allowFrom 覆盖 allowedUsers', () => {
  const cfg: PolicyConfig = {
    dmPolicy: 'disabled',
    groupPolicy: 'allowlist',
    allowedUsers: ['alice'],
    allowedGroups: ['g1'],
    groupOverrides: {
      g1: { allowFrom: ['bob'] }, // 在该群只有 bob 能发,alice 不行
    },
  };
  assert.equal(checkInboundPolicy({ fromUserId: 'bob', groupId: 'g1' }, cfg).allowed, true);
  assert.equal(checkInboundPolicy({ fromUserId: 'alice', groupId: 'g1' }, cfg).allowed, false);
});

// ── policyFromEnv ────────────────────────────────────────────

test('policyFromEnv: 缺省值 = allowlist + disabled', () => {
  const cfg = policyFromEnv({});
  assert.equal(cfg.dmPolicy, 'allowlist');
  assert.equal(cfg.groupPolicy, 'disabled');
  assert.deepEqual(cfg.allowedUsers, []);
  assert.deepEqual(cfg.allowedGroups, []);
});

test('policyFromEnv: 解析 ALLOWED_USERS 逗号分隔', () => {
  const cfg = policyFromEnv({
    WECHAT_DM_POLICY: 'allowlist',
    WECHAT_ALLOWED_USERS: 'alice,bob , carol',
    WECHAT_ALLOWED_GROUPS: 'g1,g2',
  });
  assert.deepEqual(cfg.allowedUsers, ['alice', 'bob', 'carol']);
  assert.deepEqual(cfg.allowedGroups, ['g1', 'g2']);
});

test('policyFromEnv: 空字符串过滤', () => {
  const cfg = policyFromEnv({
    WECHAT_ALLOWED_USERS: ',,alice,,',
  });
  assert.deepEqual(cfg.allowedUsers, ['alice']);
});

test('policyFromEnv: 显式 open / disabled 透传', () => {
  const cfg = policyFromEnv({
    WECHAT_DM_POLICY: 'open',
    WECHAT_GROUP_POLICY: 'open',
  });
  assert.equal(cfg.dmPolicy, 'open');
  assert.equal(cfg.groupPolicy, 'open');
});
