/**
 * ActionLog + SkillStore + SessionReflector 测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  SessionReflector,
  createMemoryTools,
  scoreSkill,
} from '../src/index.js';
import { recordLinkedSkillOutcomes } from '../src/reflector.js';
import type { ExtractorLlmClient } from '../src/index.js';

// ── Mock LLM ────────────────────────────────────────────────────────────

class MockLlm implements ExtractorLlmClient {
  constructor(private readonly response: string) {}
  async complete(_prompt: string) {
    return { text: this.response, tokensUsed: 100 };
  }
}

// ── ActionLog 测试 ─────────────────────────────────────────────────────

test('ActionLog: log and retrieve by session', () => {
  const { actions } = openMemoryDb(':memory:');

  actions.log({
    sessionId: 's1',
    trigger: '用户要求部署',
    toolName: 'shell',
    params: { command: 'cargo build' },
    result: 'compiled',
    success: true,
  });
  actions.log({
    sessionId: 's1',
    toolName: 'shell',
    params: { command: 'cargo test' },
    result: 'passed',
    success: true,
  });
  actions.log({
    sessionId: 's2',
    toolName: 'read_file',
    params: { path: 'README.md' },
    success: true,
  });

  const s1Actions = actions.getBySession('s1');
  assert.equal(s1Actions.length, 2);
  assert.equal(s1Actions[0].trigger, '用户要求部署');
  assert.deepEqual(s1Actions[0].params, { command: 'cargo build' });
  assert.equal(s1Actions[0].success, true);

  const s2Actions = actions.getBySession('s2');
  assert.equal(s2Actions.length, 1);
  assert.equal(s2Actions[0].toolName, 'read_file');
});

test('ActionLog: countByTool', () => {
  const { actions } = openMemoryDb(':memory:');

  actions.log({ sessionId: 's1', toolName: 'shell', params: {}, success: true });
  actions.log({ sessionId: 's1', toolName: 'shell', params: {}, success: false });
  actions.log({ sessionId: 's2', toolName: 'read_file', params: {}, success: true });

  assert.equal(actions.countByTool('shell'), 2);
  assert.equal(actions.countByTool('read_file'), 1);
  assert.equal(actions.countByTool('ghost'), 0);
});

// ── SkillStore 测试 ────────────────────────────────────────────────────

test('SkillStore: create and retrieve', () => {
  const { skills } = openMemoryDb(':memory:');

  const skill = skills.createSkill({
    name: 'deploy-rust',
    description: '编译并部署 Rust 项目',
    triggerKeywords: ['deploy', '部署', 'rust'],
    actionTemplate: '# 步骤\n1. cargo build --release\n2. cargo test\n3. scp binary',
  });

  assert.equal(skill.name, 'deploy-rust');
  assert.equal(skill.useCount, 0);
  assert.equal(skill.lastUsedAt, null);
  assert.deepEqual(skill.triggerKeywords, ['deploy', '部署', 'rust']);

  const fetched = skills.getByName('deploy-rust');
  assert.ok(fetched);
  assert.equal(fetched.id, skill.id);
});

test('SkillStore: search by keyword', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'deploy-rust',
    description: '编译并部署 Rust 项目',
    triggerKeywords: ['deploy', 'rust'],
    actionTemplate: '...',
  });
  skills.createSkill({
    name: 'debug-typescript',
    description: '调试 TypeScript 编译错误',
    triggerKeywords: ['debug', 'typescript', 'tsc'],
    actionTemplate: '...',
  });

  const rustResults = skills.search('rust');
  assert.equal(rustResults.length, 1);
  assert.equal(rustResults[0].name, 'deploy-rust');

  const debugResults = skills.search('debug');
  assert.equal(debugResults.length, 1);
  assert.equal(debugResults[0].name, 'debug-typescript');
});

// ── 2026-05-09:deprecated 不再 surface ──────────────────────────────

test('SkillStore: search 过滤 deprecated', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'service-x-active',
    description: 'service-x 活跃 skill',
    triggerKeywords: ['service-x'],
    actionTemplate: '...',
  });
  skills.createSkill({
    name: 'service-x-old-broken',
    description: 'service-x 旧 broken skill,已 deprecated',
    triggerKeywords: ['service-x'],
    actionTemplate: '...',
  });
  skills.setMaturity('service-x-old-broken', 'deprecated');

  const r = skills.search('service-x');
  assert.equal(r.length, 1, 'deprecated 不应 surface');
  assert.equal(r[0].name, 'service-x-active');
});

test('SkillStore: search FTS 路径(query ≥ 3 字符)过滤 deprecated', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'service-onboarding',
    description: '元技能 — onboard 任意 service 的标准流程',
    triggerKeywords: ['onboard', 'service'],
    actionTemplate: '...',
  });
  skills.createSkill({
    name: 'service-x-onboarding-old',
    description: 'service-x 旧 onboarding 流程,缺 step 5',
    triggerKeywords: ['onboard', 'service-x'],
    actionTemplate: '...',
  });
  skills.setMaturity('service-x-onboarding-old', 'deprecated');

  const r = skills.search('onboarding');
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'service-onboarding');
});

test('SkillStore: listAll 过滤 deprecated', () => {
  const { skills } = openMemoryDb(':memory:');

  for (let i = 0; i < 3; i++) {
    skills.createSkill({
      name: `active-${i}`,
      description: 'active skill',
      triggerKeywords: ['x'],
      actionTemplate: '...',
    });
  }
  for (let i = 0; i < 5; i++) {
    skills.createSkill({
      name: `old-${i}`,
      description: 'old skill',
      triggerKeywords: ['x'],
      actionTemplate: '...',
    });
    skills.setMaturity(`old-${i}`, 'deprecated');
  }

  const all = skills.listAll();
  assert.equal(all.length, 3, 'listAll 只返 active 3 条');
  for (const s of all) {
    assert.notEqual(s.maturity, 'deprecated');
  }
});

test('SkillStore: listNegative 过滤 deprecated', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'bad-pattern-active',
    description: '反模式',
    triggerKeywords: [],
    actionTemplate: '...',
    kind: 'negative',
  });
  skills.createSkill({
    name: 'bad-pattern-old',
    description: '过期反模式',
    triggerKeywords: [],
    actionTemplate: '...',
    kind: 'negative',
  });
  skills.setMaturity('bad-pattern-old', 'deprecated');

  const r = skills.listNegative();
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'bad-pattern-active');
});

test('SkillStore: incrementUseCount', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'test-skill',
    description: 'desc',
    triggerKeywords: ['test'],
    actionTemplate: '...',
  });

  const before = skills.getByName('test-skill');
  assert.equal(before?.useCount, 0);

  skills.incrementUseCount('test-skill');
  skills.incrementUseCount('test-skill');
  skills.incrementUseCount('test-skill');

  const after = skills.getByName('test-skill');
  assert.equal(after?.useCount, 3);
  assert.ok(after?.lastUsedAt);
});

test('SkillStore: updateSkill preserves use_count', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'target',
    description: 'old desc',
    triggerKeywords: ['old'],
    actionTemplate: 'old template',
  });
  skills.incrementUseCount('target');
  skills.incrementUseCount('target');

  skills.updateSkill('target', { description: 'new desc' });

  const s = skills.getByName('target');
  assert.equal(s?.description, 'new desc');
  assert.equal(s?.useCount, 2); // 使用次数保留
});

test('SkillStore: listAll sorted by use_count desc', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'a',
    description: 'a',
    triggerKeywords: [],
    actionTemplate: '',
  });
  skills.createSkill({
    name: 'b',
    description: 'b',
    triggerKeywords: [],
    actionTemplate: '',
  });
  skills.createSkill({
    name: 'c',
    description: 'c',
    triggerKeywords: [],
    actionTemplate: '',
  });

  skills.incrementUseCount('b');
  skills.incrementUseCount('b');
  skills.incrementUseCount('c');

  const all = skills.listAll();
  assert.equal(all[0].name, 'b');
  assert.equal(all[1].name, 'c');
  assert.equal(all[2].name, 'a');
});

// ── SessionReflector 测试 ──────────────────────────────────────────────

test('SessionReflector: extract skills from session', async () => {
  const { skills, actions, raw } = openMemoryDb(':memory:');

  const session = raw.startSession();
  raw.appendMessage({
    sessionId: session.id,
    role: 'user',
    content: '帮我部署这个 Rust 项目',
  });
  raw.appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '好的，我运行 cargo build 和 cargo test 然后 scp',
  });

  actions.log({
    sessionId: session.id,
    trigger: '部署',
    toolName: 'shell',
    params: { command: 'cargo build --release' },
    success: true,
  });

  const mockLlm = new MockLlm(
    JSON.stringify([
      {
        name: 'deploy-rust',
        description: '编译并部署 Rust 项目到远程服务器',
        trigger_keywords: ['deploy', '部署', 'rust'],
        action_template: '# 步骤\n1. cargo build --release\n2. cargo test\n3. scp binary',
      },
    ]),
  );

  const reflector = new SessionReflector(mockLlm, skills, actions, raw);
  const result = await reflector.reflectFromSession(session.id);

  assert.equal(result.skillsCreated, 1);
  assert.equal(result.skillsUpdated, 0);
  assert.ok(skills.getByName('deploy-rust'));
});

test('SessionReflector: update existing skill, preserve use_count', async () => {
  const { skills, actions, raw } = openMemoryDb(':memory:');

  // 先创建一个技能并用过几次
  skills.createSkill({
    name: 'existing-skill',
    description: 'original desc',
    triggerKeywords: ['original'],
    actionTemplate: 'original template',
  });
  skills.incrementUseCount('existing-skill');
  skills.incrementUseCount('existing-skill');

  // 新会话反思返回同名技能（描述已改进）
  const session = raw.startSession();
  raw.appendMessage({ sessionId: session.id, role: 'user', content: 'x' });

  const mockLlm = new MockLlm(
    JSON.stringify([
      {
        name: 'existing-skill',
        description: 'improved desc',
        trigger_keywords: ['improved', 'new'],
        action_template: 'improved template',
      },
    ]),
  );

  const reflector = new SessionReflector(mockLlm, skills, actions, raw);
  const result = await reflector.reflectFromSession(session.id);

  assert.equal(result.skillsCreated, 0);
  assert.equal(result.skillsUpdated, 1);

  const updated = skills.getByName('existing-skill');
  assert.equal(updated?.description, 'improved desc');
  assert.equal(updated?.useCount, 2); // 保留使用次数
});

test('SessionReflector: skip invalid skill specs', async () => {
  const { skills, actions, raw } = openMemoryDb(':memory:');

  const session = raw.startSession();
  raw.appendMessage({ sessionId: session.id, role: 'user', content: 'x' });

  const mockLlm = new MockLlm(
    JSON.stringify([
      {
        name: 'valid-skill',
        description: 'desc',
        trigger_keywords: ['k'],
        action_template: 't',
      },
      {
        // 缺少 name
        description: 'bad',
        trigger_keywords: ['k'],
        action_template: 't',
      },
      {
        name: 'Invalid Name With Spaces',
        description: 'bad',
        trigger_keywords: ['k'],
        action_template: 't',
      },
    ]),
  );

  const reflector = new SessionReflector(mockLlm, skills, actions, raw);
  const result = await reflector.reflectFromSession(session.id);

  assert.equal(result.skillsCreated, 1);
  assert.ok(skills.getByName('valid-skill'));
});

test('SessionReflector: empty session returns empty result', async () => {
  const { skills, actions, raw } = openMemoryDb(':memory:');
  const session = raw.startSession();

  const mockLlm = new MockLlm('[]');
  const reflector = new SessionReflector(mockLlm, skills, actions, raw);
  const result = await reflector.reflectFromSession(session.id);

  assert.equal(result.skillsCreated, 0);
  assert.equal(result.llmCostTokens, 0); // 短路：未调用 LLM
});

// ── 技能工具测试 ───────────────────────────────────────────────────────

test('search_skills tool returns results', async () => {
  const { facts, notes, skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'deploy-rust',
    description: '编译并部署 Rust 项目',
    triggerKeywords: ['deploy', 'rust'],
    actionTemplate: '...',
  });

  const tools = createMemoryTools(facts, notes, skills);
  const searchSkills = tools.find((t) => t.name === 'search_skills')!;

  const r = await searchSkills.execute({ query: 'rust' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('deploy-rust'));
});

test('use_skill tool returns template and increments use_count', async () => {
  const { facts, notes, skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'my-skill',
    description: 'desc',
    triggerKeywords: ['k'],
    actionTemplate: '# Do\n1. step one\n2. step two',
  });

  const tools = createMemoryTools(facts, notes, skills);
  const useSkill = tools.find((t) => t.name === 'use_skill')!;

  const r = await useSkill.execute({ name: 'my-skill' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('step one'));

  // 使用计数应 +1
  const after = skills.getByName('my-skill');
  assert.equal(after?.useCount, 1);
});

test('use_skill returns error for missing skill', async () => {
  const { facts, notes, skills } = openMemoryDb(':memory:');
  const tools = createMemoryTools(facts, notes, skills);
  const useSkill = tools.find((t) => t.name === 'use_skill')!;

  const r = await useSkill.execute({ name: 'ghost' });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('does not exist'));
});

test('skill tools only present when SkillStore provided', () => {
  const { facts, notes } = openMemoryDb(':memory:');

  // 不传 skills
  const noSkillTools = createMemoryTools(facts, notes);
  const hasSearch = noSkillTools.some((t) => t.name === 'search_skills');
  assert.equal(hasSearch, false);

  // 传 skills
  const { skills } = openMemoryDb(':memory:');
  const withSkillTools = createMemoryTools(facts, notes, skills);
  const hasSearchNow = withSkillTools.some((t) => t.name === 'search_skills');
  assert.equal(hasSearchNow, true);
});

// ── Phase 3: 反馈环测试 ────────────────────────────────────────────────

test('recordSkillOutcome: success vs failure counted separately', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'deploy',
    description: '部署流程',
    triggerKeywords: [],
    actionTemplate: '',
  });

  skills.recordSkillOutcome('deploy', true);
  skills.recordSkillOutcome('deploy', true);
  skills.recordSkillOutcome('deploy', false);

  const s = skills.getByName('deploy');
  assert.equal(s?.useCount, 3);
  assert.equal(s?.successCount, 2);
  assert.equal(s?.failureCount, 1);
  assert.ok(s?.lastFailureAt, 'last_failure_at 应记录');
});

test('scoreSkill: frequent success > rare success > frequent failure', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const recent = now - 86_400_000; // 昨天用过

  const winner = {
    id: '1', name: 'winner', description: '', triggerKeywords: [], actionTemplate: '',
    useCount: 10, lastUsedAt: recent, createdAt: 0,
    successCount: 10, failureCount: 0, lastFailureAt: null, lastSuccessAt: recent,
    consecutiveFailures: 0, whenToUse: '', maturity: 'stable' as const, kind: 'positive' as const, source: null,
  };
  const rare = {
    id: '2', name: 'rare', description: '', triggerKeywords: [], actionTemplate: '',
    useCount: 1, lastUsedAt: recent, createdAt: 0,
    successCount: 1, failureCount: 0, lastFailureAt: null, lastSuccessAt: recent,
    consecutiveFailures: 0, whenToUse: '', maturity: 'draft' as const, kind: 'positive' as const, source: null,
  };
  const loser = {
    id: '3', name: 'loser', description: '', triggerKeywords: [], actionTemplate: '',
    useCount: 10, lastUsedAt: recent, createdAt: 0,
    successCount: 2, failureCount: 8, lastFailureAt: recent, lastSuccessAt: recent,
    consecutiveFailures: 0, whenToUse: '', maturity: 'deprecated' as const, kind: 'positive' as const, source: null,
  };

  const scores = [winner, rare, loser].map((s) => scoreSkill(s, now));
  assert.ok(scores[0] > scores[1], 'winner > rare');
  assert.ok(scores[1] > scores[2], 'rare > loser');
});

test('scoreSkill: recency decay discounts long-unused skills', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const old = {
    id: '1', name: 'old', description: '', triggerKeywords: [], actionTemplate: '',
    useCount: 5, lastUsedAt: now - 90 * 86_400_000, createdAt: 0,
    successCount: 5, failureCount: 0, lastFailureAt: null, lastSuccessAt: now - 90 * 86_400_000,
    consecutiveFailures: 0, whenToUse: '', maturity: 'stable' as const, kind: 'positive' as const, source: null,
  };
  const fresh = {
    id: '2', name: 'fresh', description: '', triggerKeywords: [], actionTemplate: '',
    useCount: 2, lastUsedAt: now, createdAt: 0,
    successCount: 2, failureCount: 0, lastFailureAt: null, lastSuccessAt: now,
    consecutiveFailures: 0, whenToUse: '', maturity: 'confirmed' as const, kind: 'positive' as const, source: null,
  };

  assert.ok(scoreSkill(fresh, now) > scoreSkill(old, now), '最近用的 > 90 天前用的');
});

test('listAll: rankByScore puts high-success skill above high-failure skill', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'reliable', description: '', triggerKeywords: [], actionTemplate: '',
  });
  skills.createSkill({
    name: 'flaky', description: '', triggerKeywords: [], actionTemplate: '',
  });

  // reliable 用过 3 次全成功
  skills.recordSkillOutcome('reliable', true);
  skills.recordSkillOutcome('reliable', true);
  skills.recordSkillOutcome('reliable', true);
  // flaky 用过 4 次,2 成 2 败(避免连续 3 失败触发 auto-deprecated:
  // listAll 过滤 deprecated 后会消失,不是本测试想测的)
  skills.recordSkillOutcome('flaky', true);
  skills.recordSkillOutcome('flaky', false);
  skills.recordSkillOutcome('flaky', true);
  skills.recordSkillOutcome('flaky', false);

  const ranked = skills.listAll();
  assert.equal(ranked[0].name, 'reliable');
  assert.equal(ranked[1].name, 'flaky');
});

test('recordLinkedSkillOutcomes: reflector回灌会话中的linked_skill动作', () => {
  const { skills, actions, raw } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'git-flow', description: '', triggerKeywords: [], actionTemplate: '',
  });

  const session = raw.startSession();
  // 两条属于 git-flow 的动作,一成一败
  actions.log({
    sessionId: session.id,
    toolName: 'shell',
    params: { cmd: 'git status' },
    success: true,
    linkedSkill: 'git-flow',
  });
  actions.log({
    sessionId: session.id,
    toolName: 'shell',
    params: { cmd: 'git push' },
    success: false,
    linkedSkill: 'git-flow',
  });
  // 一条无 linked_skill 的动作,应被忽略
  actions.log({
    sessionId: session.id,
    toolName: 'read',
    params: {},
    success: true,
  });

  const result = recordLinkedSkillOutcomes(
    actions.getBySession(session.id),
    skills
  );
  assert.equal(result.failures, 1);
  assert.equal(result.successes, 0); // 保守策略:任一失败即整体失败

  const s = skills.getByName('git-flow');
  assert.equal(s?.failureCount, 1);
  assert.equal(s?.successCount, 0);
});

// ── Phase 4: 热加载事件测试 ────────────────────────────────────────────

test('SkillStore emits changed on createSkill', () => {
  const { skills } = openMemoryDb(':memory:');
  const events: Array<{ type: string; name: string }> = [];
  skills.on('changed', (e) => events.push(e));

  skills.createSkill({
    name: 'hot1',
    description: '',
    triggerKeywords: [],
    actionTemplate: '',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'created');
  assert.equal(events[0].name, 'hot1');
});

test('SkillStore emits changed on update and delete', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'hot2', description: '', triggerKeywords: [], actionTemplate: '',
  });

  const events: Array<{ type: string; name: string }> = [];
  skills.on('changed', (e) => events.push(e));

  skills.updateSkill('hot2', { description: 'new' });
  skills.deleteSkill('hot2');

  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'updated');
  assert.equal(events[1].type, 'deleted');
});

test('SkillStore does NOT emit on recordSkillOutcome (high frequency)', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'hot3', description: '', triggerKeywords: [], actionTemplate: '',
  });

  let fires = 0;
  skills.on('changed', () => fires++);

  skills.recordSkillOutcome('hot3', true);
  skills.recordSkillOutcome('hot3', false);
  skills.recordSkillOutcome('hot3', true);

  assert.equal(fires, 0, 'recordSkillOutcome 不应触发 changed 事件');
});

test('recordLinkedSkillOutcomes: 全成功时每条动作独立计成功', () => {
  const { skills, actions, raw } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'review', description: '', triggerKeywords: [], actionTemplate: '',
  });

  const session = raw.startSession();
  actions.log({
    sessionId: session.id,
    toolName: 'shell',
    params: {},
    success: true,
    linkedSkill: 'review',
  });
  actions.log({
    sessionId: session.id,
    toolName: 'read',
    params: {},
    success: true,
    linkedSkill: 'review',
  });

  const result = recordLinkedSkillOutcomes(
    actions.getBySession(session.id),
    skills
  );
  assert.equal(result.successes, 2);
  assert.equal(result.failures, 0);

  const s = skills.getByName('review');
  assert.equal(s?.successCount, 2);
  assert.equal(s?.failureCount, 0);
  assert.equal(s?.useCount, 2);
});

// ── v5: kind (positive / negative) 相关 ───────────────────────────────

test('Skill kind: createSkill 不传 kind 默认 positive', () => {
  const { skills } = openMemoryDb(':memory:');
  const s = skills.createSkill({
    name: 'plain',
    description: 'x',
    triggerKeywords: [],
    actionTemplate: '',
  });
  assert.equal(s.kind, 'positive');
  assert.equal(skills.getByName('plain')?.kind, 'positive');
});

test('Skill kind: createSkill 传 negative 持久化且可读回', () => {
  const { skills } = openMemoryDb(':memory:');
  const s = skills.createSkill({
    name: 'avoid-immediate-report',
    description: '用户说明天要报告时不要立即给出',
    triggerKeywords: ['明天', '下周', '后天'],
    actionTemplate: '## 触发\n相对时间词\n## 避免\n立刻给出报告\n## 改做\n调 schedule_reminder',
    kind: 'negative',
  });
  assert.equal(s.kind, 'negative');
  const loaded = skills.getByName('avoid-immediate-report');
  assert.equal(loaded?.kind, 'negative');
});

test('Skill kind: updateSkill 可把 positive 改成 negative', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({ name: 'x', description: 'x', triggerKeywords: [], actionTemplate: '' });
  const updated = skills.updateSkill('x', { kind: 'negative' });
  assert.equal(updated?.kind, 'negative');
});

test('scoreSkill: negative 比 positive 衰减更慢(同参数下分数更高)', () => {
  const now = Date.parse('2026-04-22T12:00:00Z');
  const daysAgo60 = now - 60 * 86_400_000;
  const positive = {
    id: '1', name: 'p', description: '', triggerKeywords: [], actionTemplate: '',
    useCount: 3, lastUsedAt: daysAgo60, createdAt: 0,
    successCount: 3, failureCount: 0, lastFailureAt: null, lastSuccessAt: daysAgo60,
    consecutiveFailures: 0, whenToUse: '', maturity: 'confirmed' as const, kind: 'positive' as const, source: null,
  };
  const negative = { ...positive, id: '2', name: 'n', kind: 'negative' as const };
  // positive half-life 30d → 60d 前用过衰减成 0.25;negative half-life 90d → 0.63
  assert.ok(
    scoreSkill(negative, now) > scoreSkill(positive, now),
    'negative 衰减更慢 → 分数应更高',
  );
});

test('listNegative: 只返回 kind=negative 的 Skill', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({ name: 'pos-a', description: '', triggerKeywords: [], actionTemplate: '' });
  skills.createSkill({
    name: 'neg-a',
    description: '',
    triggerKeywords: [],
    actionTemplate: '## 触发\nx\n## 避免\ny\n## 改做\nz',
    kind: 'negative',
  });
  skills.createSkill({
    name: 'neg-b',
    description: '',
    triggerKeywords: [],
    actionTemplate: '## 触发\nx\n## 避免\ny\n## 改做\nz',
    kind: 'negative',
  });

  const negs = skills.listNegative();
  assert.equal(negs.length, 2);
  assert.ok(negs.every((s) => s.kind === 'negative'));
  const names = negs.map((s) => s.name).sort();
  assert.deepEqual(names, ['neg-a', 'neg-b']);
});

// ── Reflector: negative Skill 识别 ────────────────────────────────────

test('Reflector: 产出 negative 时 actionTemplate 必须含三段式否则被过滤', async () => {
  const { raw, actions, skills } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({ sessionId: session.id, role: 'user', content: '明天给我出个报告' });
  raw.appendMessage({ sessionId: session.id, role: 'assistant', content: '好的这是报告' });
  raw.appendMessage({ sessionId: session.id, role: 'user', content: '不是让你现在写，是明天' });

  // Mock LLM 给两条:一条合规三段式 negative,一条缺段应被拒
  const llm = new MockLlm(JSON.stringify([
    {
      name: 'avoid-immediate-report',
      description: '遇到相对时间词时避免立即给出产出',
      trigger_keywords: ['明天', '下周'],
      action_template: '## Trigger\n相对时间词\n## Avoid\n立即产出\n## Instead\n调 schedule_reminder',
      kind: 'negative',
    },
    {
      name: 'avoid-broken',
      description: '三段式不全',
      trigger_keywords: ['x'],
      action_template: '## Trigger\n只有这一段',
      kind: 'negative',
    },
  ]));

  const reflector = new SessionReflector(llm, skills, actions, raw);
  const result = await reflector.reflectFromSession(session.id);

  // 只有第一条应通过
  assert.equal(result.skillsCreated, 1);
  const saved = skills.getByName('avoid-immediate-report');
  assert.equal(saved?.kind, 'negative');
  assert.equal(skills.getByName('avoid-broken'), null, '三段式不全应被过滤');
});

test('Reflector: kind 缺省时默认 positive(向后兼容)', async () => {
  const { raw, actions, skills } = openMemoryDb(':memory:');
  const session = raw.startSession();
  raw.appendMessage({ sessionId: session.id, role: 'user', content: '部署' });

  const llm = new MockLlm(JSON.stringify([
    {
      name: 'legacy-positive',
      description: 'x',
      trigger_keywords: ['部署'],
      action_template: '步骤 1\n步骤 2',
      // 不带 kind
    },
  ]));

  const reflector = new SessionReflector(llm, skills, actions, raw);
  await reflector.reflectFromSession(session.id);
  assert.equal(skills.getByName('legacy-positive')?.kind, 'positive');
});

// ── search_skills 工具: include_negative 过滤 ─────────────────────────

test('search_skills tool: include_negative=false 过滤掉反模式', async () => {
  const { facts, notes, skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'deploy-rust',
    description: '部署 Rust 项目',
    triggerKeywords: ['deploy', '部署'],
    actionTemplate: '步骤',
  });
  skills.createSkill({
    name: 'avoid-immediate-deploy',
    description: '不要立即部署,等 CI 绿',
    triggerKeywords: ['deploy', '部署'],
    actionTemplate: '## 触发\nx\n## 避免\ny\n## 改做\nz',
    kind: 'negative',
  });

  const tools = createMemoryTools(facts, notes, skills);
  const searchTool = tools.find((t) => t.name === 'search_skills')!;

  const withNeg = await searchTool.execute({ query: '部署' });
  assert.equal(withNeg.success, true);
  assert.ok(withNeg.output?.includes('⚠️ [avoid]'), 'include_negative=true(默认)应含反模式标签');

  const withoutNeg = await searchTool.execute({ query: '部署', include_negative: false });
  assert.equal(withoutNeg.success, true);
  assert.ok(!withoutNeg.output?.includes('avoid-immediate-deploy'), '过滤掉 negative');
  assert.ok(withoutNeg.output?.includes('deploy-rust'));
});

// ── source 字段持久化(v10) ──────────────────────────────────────────

test('SkillStore: source 字段在 create / read 圆环', () => {
  const { skills } = openMemoryDb(':memory:');

  const created = skills.createSkill({
    name: 'ext',
    description: 'from clawhub',
    triggerKeywords: ['x'],
    actionTemplate: 'do x',
    source: 'clawhub:ext@1.2.3',
  });

  assert.equal(created.source, 'clawhub:ext@1.2.3');
  assert.equal(skills.getByName('ext')?.source, 'clawhub:ext@1.2.3');
});

test('SkillStore: 不传 source → 默认 null', () => {
  const { skills } = openMemoryDb(':memory:');

  const local = skills.createSkill({
    name: 'local',
    description: 'reflective',
    triggerKeywords: ['l'],
    actionTemplate: 'l',
  });

  assert.equal(local.source, null);
  assert.equal(skills.getByName('local')?.source, null);
});

test('SkillStore: updateSkill 显式 null 清空 source;省略保留原值', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'foo',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: 't',
    source: 'clawhub:foo@1.0',
  });

  // 省略 source → 保留原值
  skills.updateSkill('foo', { description: 'd2' });
  assert.equal(skills.getByName('foo')?.source, 'clawhub:foo@1.0');

  // 显式 null → 清空(skill 从外部转为本地)
  skills.updateSkill('foo', { source: null });
  assert.equal(skills.getByName('foo')?.source, null);
});

// ── listExternalSkills + prune diff 模式(给 chat-handler 用) ────────

test('listExternalSkills: 只返回 source IS NOT NULL 的行', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'local-a',
    description: 'reflective',
    triggerKeywords: [],
    actionTemplate: 't',
  });
  skills.createSkill({
    name: 'ext-b',
    description: 'from clawhub',
    triggerKeywords: [],
    actionTemplate: 't',
    source: 'clawhub:b@1',
  });
  skills.createSkill({
    name: 'ext-c',
    description: 'from github',
    triggerKeywords: [],
    actionTemplate: 't',
    source: 'github:owner/c@abc',
  });

  const externals = skills.listExternalSkills();
  const names = externals.map((s) => s.name).sort();
  assert.deepEqual(names, ['ext-b', 'ext-c']);
  // 本地手写永远不出现 — prune 安全保证
  assert.ok(!names.includes('local-a'));
});

test('listExternalSkills + prune 差集模式:磁盘消失的外部 skill 应被识别', () => {
  // 模拟 chat-handler.reloadSkillsFromDisk 的 prune 逻辑
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'kept',
    description: 'still on disk',
    triggerKeywords: [],
    actionTemplate: 't',
    source: 'clawhub:kept@1',
  });
  skills.createSkill({
    name: 'removed',
    description: 'rm by user',
    triggerKeywords: [],
    actionTemplate: 't',
    source: 'clawhub:removed@1',
  });
  skills.createSkill({
    name: 'local-untouched',
    description: 'reflective',
    triggerKeywords: [],
    actionTemplate: 't',
    // source: null (本地手写)
  });

  // 模拟 reload:磁盘上现在只剩 'kept' 和 'local-untouched','removed' 被 rm 了
  const parsedNames = new Set(['kept', 'local-untouched']);
  const orphans = skills.listExternalSkills().filter((s) => !parsedNames.has(s.name));

  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].name, 'removed');

  // 执行 prune
  for (const o of orphans) skills.deleteSkill(o.name);

  assert.equal(skills.getByName('removed'), null, 'removed 已 prune');
  assert.ok(skills.getByName('kept'), 'kept 保留');
  assert.ok(skills.getByName('local-untouched'), '本地手写永远不动');
});

test('listByMaturity: 仅返回指定 maturity 的 skill,按 created_at DESC', async () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'pb-1',
    description: 'old playbook',
    triggerKeywords: [],
    actionTemplate: 'a',
    maturity: 'playbook',
  });
  // 必须等下一 ms,否则同 ms 插入 created_at 相同
  await new Promise((r) => setTimeout(r, 2));
  skills.createSkill({
    name: 'pb-2',
    description: 'new playbook',
    triggerKeywords: [],
    actionTemplate: 'a',
    maturity: 'playbook',
  });
  skills.createSkill({
    name: 'draft-x',
    description: 'a draft',
    triggerKeywords: [],
    actionTemplate: 'a',
    maturity: 'draft',
  });

  const playbooks = skills.listByMaturity('playbook');
  assert.equal(playbooks.length, 2);
  assert.equal(playbooks[0].name, 'pb-2', '最新先(created_at DESC)');
  assert.equal(playbooks[1].name, 'pb-1');

  const drafts = skills.listByMaturity('draft');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].name, 'draft-x');
});

test('listByMaturity: limit 截断', () => {
  const { skills } = openMemoryDb(':memory:');
  for (let i = 0; i < 8; i++) {
    skills.createSkill({
      name: `pb-${i}`,
      description: `lesson ${i}`,
      triggerKeywords: [],
      actionTemplate: 'a',
      maturity: 'playbook',
    });
  }
  const top3 = skills.listByMaturity('playbook', 3);
  assert.equal(top3.length, 3);
});

test('listByMaturity: 不存在 maturity → 空数组', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 's1',
    description: '',
    triggerKeywords: [],
    actionTemplate: 'a',
    maturity: 'stable',
  });
  const playbooks = skills.listByMaturity('playbook');
  assert.equal(playbooks.length, 0);
});

test('listBySourcePrefix: 按 registry 前缀筛选', () => {
  const { skills } = openMemoryDb(':memory:');

  skills.createSkill({
    name: 'cl-1',
    description: '',
    triggerKeywords: [],
    actionTemplate: 't',
    source: 'clawhub:cl-1@1.0',
  });
  skills.createSkill({
    name: 'cl-2',
    description: '',
    triggerKeywords: [],
    actionTemplate: 't',
    source: 'clawhub:cl-2@2.0',
  });
  skills.createSkill({
    name: 'gh-1',
    description: '',
    triggerKeywords: [],
    actionTemplate: 't',
    source: 'github:owner/gh-1@abc',
  });

  const cls = skills.listBySourcePrefix('clawhub:').map((s) => s.name).sort();
  assert.deepEqual(cls, ['cl-1', 'cl-2']);

  const ghs = skills.listBySourcePrefix('github:').map((s) => s.name);
  assert.deepEqual(ghs, ['gh-1']);
});
