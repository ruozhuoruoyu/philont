import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, importSkills } from '../src/index.js';

describe('importSkills', () => {
  it('creates skills from parsed input', () => {
    const db = openMemoryDb(':memory:');
    const result = importSkills(db.skills, [
      {
        name: 'test-skill',
        description: 'Test',
        triggerKeywords: ['t1', 't2'],
        actionTemplate: 'Do X',
      },
    ]);

    assert.deepEqual(result.created, ['test-skill']);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.errors.length, 0);

    const stored = db.skills.getByName('test-skill');
    assert.ok(stored);
    assert.equal(stored.description, 'Test');
    assert.deepEqual(stored.triggerKeywords, ['t1', 't2']);
    db.db.close();
  });

  it('skips existing by default', () => {
    const db = openMemoryDb(':memory:');
    db.skills.createSkill({
      name: 'existing',
      description: 'original',
      triggerKeywords: ['a'],
      actionTemplate: 'orig',
    });

    const result = importSkills(db.skills, [
      {
        name: 'existing',
        description: 'new',
        triggerKeywords: ['b'],
        actionTemplate: 'new',
      },
    ]);

    assert.deepEqual(result.skipped, ['existing']);
    const stored = db.skills.getByName('existing')!;
    assert.equal(stored.description, 'original');
    db.db.close();
  });

  it('replaces on conflict when onConflict=replace', () => {
    const db = openMemoryDb(':memory:');
    db.skills.createSkill({
      name: 'r',
      description: 'old',
      triggerKeywords: ['x'],
      actionTemplate: 'old',
    });

    importSkills(
      db.skills,
      [
        {
          name: 'r',
          description: 'new',
          triggerKeywords: ['y'],
          actionTemplate: 'new',
        },
      ],
      { onConflict: 'replace' },
    );

    const stored = db.skills.getByName('r')!;
    assert.equal(stored.description, 'new');
    assert.deepEqual(stored.triggerKeywords, ['y']);
    db.db.close();
  });

  it('merges keywords on conflict when onConflict=merge', () => {
    const db = openMemoryDb(':memory:');
    db.skills.createSkill({
      name: 'm',
      description: 'd',
      triggerKeywords: ['a', 'b'],
      actionTemplate: 'tpl',
    });

    importSkills(
      db.skills,
      [
        {
          name: 'm',
          description: 'd',
          triggerKeywords: ['b', 'c'],
          actionTemplate: 'other',
        },
      ],
      { onConflict: 'merge' },
    );

    const stored = db.skills.getByName('m')!;
    const sorted = [...stored.triggerKeywords].sort();
    assert.deepEqual(sorted, ['a', 'b', 'c']);
    // actionTemplate should NOT be overwritten in merge mode
    assert.equal(stored.actionTemplate, 'tpl');
    db.db.close();
  });

  it('reports errors for invalid input', () => {
    const db = openMemoryDb(':memory:');
    const result = importSkills(db.skills, [
      // missing actionTemplate
      {
        name: 'bad',
        description: 'x',
        triggerKeywords: [],
        actionTemplate: '',
      } as any,
    ]);

    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].error.includes('missing'));
    db.db.close();
  });

  it('handles mixed batch (create + skip + error)', () => {
    const db = openMemoryDb(':memory:');
    db.skills.createSkill({
      name: 'existing',
      description: 'd',
      triggerKeywords: [],
      actionTemplate: 'x',
    });

    const result = importSkills(db.skills, [
      {
        name: 'new-one',
        description: 'a',
        triggerKeywords: [],
        actionTemplate: 'x',
      },
      {
        name: 'existing',
        description: 'a',
        triggerKeywords: [],
        actionTemplate: 'x',
      },
      {
        name: 'bad',
        description: '',
        triggerKeywords: [],
        actionTemplate: '',
      } as any,
    ]);

    assert.deepEqual(result.created, ['new-one']);
    assert.deepEqual(result.skipped, ['existing']);
    assert.equal(result.errors.length, 1);
    db.db.close();
  });
});
