/**
 * barrierCheck — curated meta-mathematical no-go library + goal/method matcher.
 * The point of the library is to flag a doomed goal/method pairing (the parity-problem case that made
 * deep_explore grind binary Goldbach with a sieve for 10 rounds) BEFORE rounds are spent on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  barrierCheckTool,
  KNOWN_BARRIERS,
  matchBarriers,
  renderBarrierAdvisory,
} from '../src/runtime/barriers.js';

test('empty query lists the whole barrier library', async () => {
  const out = await barrierCheckTool.execute({ query: '' });
  assert.equal(out.success, true);
  assert.match(out.output, new RegExp(`${KNOWN_BARRIERS.length} no-go results`));
  for (const b of KNOWN_BARRIERS) assert.ok(out.output.includes(b.id), `index should list ${b.id}`);
});

test('the canonical case: binary Goldbach via the Maynard sieve → parity barrier APPLIES', () => {
  const matches = matchBarriers(
    'Adapt the Maynard-Tao multidimensional Selberg sieve to binary Goldbach: prove every even N is a sum of two primes.',
  );
  const parity = matches.find((m) => m.barrier.id === 'parity-problem');
  assert.ok(parity, 'parity-problem should match');
  assert.equal(parity!.severity, 'applies', 'goal AND method both present → applies');
  assert.ok(parity!.matchedGoal.length > 0 && parity!.matchedMethod.length > 0);
});

test('parity advisory names the obstruction, the crux, and the circumvention', async () => {
  const out = await barrierCheckTool.execute({ query: 'binary goldbach via selberg sieve' });
  assert.match(out.output, /KNOWN BARRIER/);
  assert.match(out.output, /parity/i);
  assert.match(out.output, /Chen|bilinear|Type-II|circle method/i); // a named circumvention
  assert.match(out.output, /dead_end|do NOT record/i); // the honest-recording directive
});

test('goal without the blocked method → goal-hard, not applies', () => {
  // Goldbach mentioned, but with an unrelated method (no sieve / circle-method keywords).
  const matches = matchBarriers('Attack Goldbach by a brand-new elementary combinatorial identity.');
  const parity = matches.find((m) => m.barrier.id === 'parity-problem');
  assert.ok(parity, 'goal still matches the parity card');
  assert.equal(parity!.severity, 'goal-hard', 'method not detected → softer severity');
});

test('method-agnostic barriers (undecidability) fire on the goal alone', () => {
  const matches = matchBarriers('Design a general algorithm to decide whether an arbitrary program halts.');
  const halt = matches.find((m) => m.barrier.id === 'undecidability');
  assert.ok(halt, 'undecidability should match');
  assert.equal(halt!.severity, 'applies', 'method-agnostic barrier applies on goal alone');
});

test('P vs NP by diagonalization → relativization barrier applies', () => {
  const matches = matchBarriers('Separate P vs NP by a clever diagonalization argument.');
  assert.ok(matches.find((m) => m.barrier.id === 'relativization' && m.severity === 'applies'));
});

test('an unrelated goal trips nothing — no false positives', async () => {
  assert.equal(matchBarriers('Compute the first 1000 primes and tabulate their gaps.').length, 0);
  const out = await barrierCheckTool.execute({ query: 'sort an array in n log n time' });
  assert.match(out.output, /No known barrier|not a guarantee/);
});

test('applies is sorted ahead of goal-hard', () => {
  // Goldbach + sieve (parity: applies) + circle method (binary-circle-method-gap: applies). Both applies.
  const matches = matchBarriers('binary goldbach via the circle method and a selberg sieve');
  assert.ok(matches.length >= 2);
  // every "applies" must come before any "goal-hard"
  const firstGoalHard = matches.findIndex((m) => m.severity === 'goal-hard');
  const lastApplies = matches.map((m) => m.severity).lastIndexOf('applies');
  if (firstGoalHard !== -1) assert.ok(lastApplies < firstGoalHard);
});

test('renderBarrierAdvisory is empty for no matches and non-empty otherwise', () => {
  assert.equal(renderBarrierAdvisory([]), '');
  assert.match(renderBarrierAdvisory(matchBarriers('twin primes via sieve')), /KNOWN BARRIERS/);
});

test('every barrier card is well-formed (ids unique, required fields present)', () => {
  const ids = new Set<string>();
  for (const b of KNOWN_BARRIERS) {
    assert.ok(b.id && !ids.has(b.id), `duplicate or empty id: ${b.id}`);
    ids.add(b.id);
    assert.ok(b.goalTags.length > 0, `${b.id} needs goalTags`);
    assert.ok(b.blocks && b.circumvention && b.source, `${b.id} needs blocks/circumvention/source`);
    // tags must be lowercase (matcher lowercases the haystack, so uppercase tags would never hit)
    for (const t of [...b.goalTags, ...b.methodTags]) {
      assert.equal(t, t.toLowerCase(), `${b.id} tag not lowercase: ${t}`);
    }
  }
});
