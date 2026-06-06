/**
 * v15 when_to_use 列 + skillImport 透传 + routing_bundled 集成测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, importSkills, AUTO_BUNDLED_PREFIX } from '../src/index.js';

// ── createSkill / updateSkill 读写 when_to_use ─────────────────────────

test('createSkill: 写入 + 读出 whenToUse', () => {
  const { skills } = openMemoryDb(':memory:');
  const s = skills.createSkill({
    name: 'foo',
    description: 'desc',
    triggerKeywords: ['k'],
    actionTemplate: '...',
    whenToUse: '用户问 X 时',
  });
  assert.equal(s.whenToUse, '用户问 X 时');
  const fetched = skills.getByName('foo');
  assert.equal(fetched?.whenToUse, '用户问 X 时');
});

test('createSkill: 不传 whenToUse → 空串', () => {
  const { skills } = openMemoryDb(':memory:');
  const s = skills.createSkill({
    name: 'foo',
    description: 'desc',
    triggerKeywords: [],
    actionTemplate: '...',
  });
  assert.equal(s.whenToUse, '');
});

test('updateSkill: 显式更新 whenToUse', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'foo',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: '...',
    whenToUse: 'old',
  });
  const updated = skills.updateSkill('foo', { whenToUse: 'new scenario' });
  assert.equal(updated?.whenToUse, 'new scenario');
});

test('updateSkill: 不传 whenToUse → 保留原值', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'foo',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: '...',
    whenToUse: 'keep me',
  });
  const updated = skills.updateSkill('foo', { description: 'new desc' });
  assert.equal(updated?.whenToUse, 'keep me');
});

// ── importSkills 透传 ──────────────────────────────────────────────────

test('importSkills: 透传 whenToUse', () => {
  const { skills } = openMemoryDb(':memory:');
  importSkills(skills, [
    {
      name: 'imported-skill',
      description: 'd',
      triggerKeywords: [],
      actionTemplate: '...',
      whenToUse: 'when from imported',
    },
  ]);
  const s = skills.getByName('imported-skill');
  assert.equal(s?.whenToUse, 'when from imported');
});

test('importSkills replace conflict: whenToUse 更新', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'k',
    description: 'd',
    triggerKeywords: [],
    actionTemplate: '...',
    whenToUse: 'old scenario',
  });
  importSkills(skills, [
    {
      name: 'k',
      description: 'd2',
      triggerKeywords: [],
      actionTemplate: '...',
      whenToUse: 'new scenario',
    },
  ], { onConflict: 'replace' });
  assert.equal(skills.getByName('k')?.whenToUse, 'new scenario');
});

test('importSkills merge: whenToUse 新值非空覆盖,空则保留', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill({
    name: 'k',
    description: 'd',
    triggerKeywords: ['a'],
    actionTemplate: '...',
    whenToUse: 'kept',
  });
  // 新值空 → 保留
  importSkills(skills, [
    { name: 'k', description: 'd2', triggerKeywords: ['b'], actionTemplate: '...', whenToUse: '' },
  ], { onConflict: 'merge' });
  assert.equal(skills.getByName('k')?.whenToUse, 'kept');

  // 新值非空 → 覆盖
  importSkills(skills, [
    { name: 'k', description: 'd3', triggerKeywords: ['c'], actionTemplate: '...', whenToUse: 'new merge val' },
  ], { onConflict: 'merge' });
  assert.equal(skills.getByName('k')?.whenToUse, 'new merge val');
});

// ── routingRules 自动写入(集成) ────────────────────────────────────

test('importSkills + routingRules: bundled skill 装入自动写 routing rule', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  importSkills(
    skills,
    [
      {
        name: 'bundled-x',
        description: 'd',
        triggerKeywords: ['x', 'y'],
        actionTemplate: '...',
        whenToUse: 'user asks for x or y stuff',
        source: null, // 本地 / bundled
      },
    ],
    { routingRules },
  );
  const rules = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}bundled-x`);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].preferSkill, 'bundled-x');
  assert.equal(rules[0].confidence, 'tentative');
  assert.match(rules[0].triggerCondition, /user asks for x/);
});

test('importSkills + routingRules: reflection-emitted skill 不写 routing rule', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  importSkills(
    skills,
    [
      {
        name: 'reflect-skill',
        description: 'd',
        triggerKeywords: ['x'],
        actionTemplate: '...',
        whenToUse: 'whatever',
        source: 'self:reflect-abc',
      },
    ],
    { routingRules },
  );
  const rules = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}reflect-skill`);
  assert.equal(rules.length, 0, 'self:reflect-* skill 不该自动写 routing rule');
});

test('importSkills + routingRules: doc-to-skill 自学 skill 不写 routing rule', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  importSkills(
    skills,
    [
      {
        name: 'doc-learned',
        description: 'd',
        triggerKeywords: ['x'],
        actionTemplate: '...',
        whenToUse: 'learned from doc',
        source: 'self:doc-to-skill:abc123',
      },
    ],
    { routingRules },
  );
  const rules = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}doc-learned`);
  assert.equal(rules.length, 0);
});

test('importSkills + routingRules: whenToUse 空 → 不写 routing rule', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  importSkills(
    skills,
    [
      {
        name: 'no-when',
        description: 'd',
        triggerKeywords: ['x'],
        actionTemplate: '...',
        // whenToUse omitted
      },
    ],
    { routingRules },
  );
  const rules = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}no-when`);
  assert.equal(rules.length, 0);
});

test('importSkills + routingRules: 不传 routingRules → 不写(向后兼容)', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  importSkills(skills, [
    {
      name: 'bundled-x',
      description: 'd',
      triggerKeywords: ['x'],
      actionTemplate: '...',
      whenToUse: 'when X',
    },
  ]);
  const rules = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}bundled-x`);
  assert.equal(rules.length, 0);
});

test('importSkills + routingRules: 重复装入同 skill → routing rule 不重复', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  const opts = { onConflict: 'replace' as const, routingRules };
  importSkills(skills, [
    { name: 'b', description: 'd', triggerKeywords: ['x'], actionTemplate: '...', whenToUse: 'w' },
  ], opts);
  importSkills(skills, [
    { name: 'b', description: 'd2', triggerKeywords: ['x'], actionTemplate: '...', whenToUse: 'w' },
  ], opts);
  const rules = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}b`);
  assert.equal(rules.length, 1, '重复装入只该有 1 条 routing rule');
});

test('importSkills + routingRules: kind=negative skill 不写 routing rule', () => {
  const { skills, routingRules } = openMemoryDb(':memory:');
  importSkills(skills, [
    {
      name: 'bad-pattern',
      description: 'avoid',
      triggerKeywords: ['x'],
      actionTemplate: '...',
      whenToUse: 'should never recommend',
      kind: 'negative',
    },
  ], { routingRules });
  const rules = routingRules.listBySignature(`${AUTO_BUNDLED_PREFIX}bad-pattern`);
  assert.equal(rules.length, 0);
});
