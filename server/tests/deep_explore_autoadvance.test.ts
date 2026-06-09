/**
 * Auto-advance loop decision logic (Part 2). The round runner / push / ALS are mocked — this verifies
 * the loop's branching: gate off → no-op; stuck → pause + escalate; progress → milestone; solved → stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoAdvanceLoop, autoAdvanceEnabled } from '../src/deep_explore_autoadvance.js';
import type { ReasoningStore, ReasoningSession } from '@agent/memory';

function sess(over: Partial<ReasoningSession>): ReasoningSession {
  return {
    id: 's', goal: 'G', assumptions: [], status: 'active', ownerSessionId: 'u',
    rootNodeId: null, budgetSpent: 0, noProgressRounds: 0, autoAdvance: true,
    createdAt: 0, updatedAt: 0, ...over,
  };
}

function fakeStore(opts: { active: ReasoningSession[]; afterRound?: (id: string) => ReasoningSession | null }) {
  const calls = { setAutoAdvance: [] as Array<[string, boolean]> };
  const store = {
    listAutoAdvanceSessions: () => opts.active,
    setAutoAdvance: (id: string, on: boolean) => { calls.setAutoAdvance.push([id, on]); },
    getSession: (id: string) => (opts.afterRound ? opts.afterRound(id) : sess({ id })),
  } as unknown as ReasoningStore;
  return { store, calls };
}

const passthroughCtx = async <T>(_sid: string, fn: () => Promise<T>): Promise<T> => fn();

test('auto-advance: 开关关 → 不推进', async () => {
  delete process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE;
  assert.equal(autoAdvanceEnabled(), false);
  let advanced = 0;
  const { store } = fakeStore({ active: [sess({ id: 'a' })] });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    runInContext: passthroughCtx,
    notify: () => {},
  });
  await loop.tickOnce();
  assert.equal(advanced, 0);
});

test('auto-advance: 卡住(noProgressRounds≥3)→ 暂停 + important 升级,不推进', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  let advanced = 0;
  const notes: Array<{ text: string; important?: boolean }> = [];
  const { store, calls } = fakeStore({ active: [sess({ id: 'a', noProgressRounds: 3 })] });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    runInContext: passthroughCtx,
    notify: (text, opts) => notes.push({ text, important: opts?.important }),
  });
  await loop.tickOnce();
  assert.equal(advanced, 0);
  assert.deepEqual(calls.setAutoAdvance, [['a', false]]);
  assert.equal(notes[0].important, true);
  assert.match(notes[0].text, /卡住|暂停/);
});

test('auto-advance: 有进展(counter 归零)→ 推进 + 里程碑(非 important)', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  let advanced = 0;
  const notes: Array<{ important?: boolean }> = [];
  const { store } = fakeStore({
    active: [sess({ id: 'a', noProgressRounds: 0 })],
    afterRound: (id) => sess({ id, status: 'active', noProgressRounds: 0 }),
  });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: 'proved 1' }; },
    runInContext: passthroughCtx,
    notify: (_t, opts) => notes.push({ important: opts?.important }),
  });
  await loop.tickOnce();
  assert.equal(advanced, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].important, undefined);
});

test('auto-advance: 解出/闭合 → 停止 + important 通知', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  const notes: Array<{ important?: boolean }> = [];
  const { store, calls } = fakeStore({
    active: [sess({ id: 'a' })],
    afterRound: (id) => sess({ id, status: 'solved' }),
  });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => ({ success: true, output: 'solved' }),
    runInContext: passthroughCtx,
    notify: (_t, opts) => notes.push({ important: opts?.important }),
  });
  await loop.tickOnce();
  assert.deepEqual(calls.setAutoAdvance, [['a', false]]);
  assert.equal(notes[0].important, true);
});
