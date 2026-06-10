/**
 * magnitude tool — asymptotic magnitude algebra.
 *
 * The headline cases mirror the circle method, which is exactly where an LLM's epsilon-management slips:
 *   - ternary Goldbach: minor bound N^2 L^-A vs main N^2 L^-3 → CLOSES, witness A>3.
 *   - binary  Goldbach: minor bound N^(3/2) L^-A vs main N    → DOES NOT CLOSE for any A (the real gap).
 *   - a magnitude-slip catch: N·log N is NOT o(N) (the kind of confusion the tool removes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMagnitude, mStr, closes, fr, fStr } from '../src/runtime/magnitude.js';
import { magnitudeTool } from '../src/runtime/magnitude.js';

const SCALE = ['N', 'L'];
/** parse a witness value that may be a fraction string like "1/2". */
const num = (s: string): number => {
  const [a, b] = s.split('/');
  return b ? Number(a) / Number(b) : Number(a);
};

test('parse: log N aliases collapse to L; rationals + parametric exponents', () => {
  assert.equal(mStr(parseMagnitude('N^2 / (log N)^3', SCALE, []), SCALE), 'N^(2)·L^(-3)');
  assert.equal(mStr(parseMagnitude('N^(3/2) * L^-A', SCALE, ['A']), SCALE), 'N^(3/2)·L^(-A)');
  assert.equal(mStr(parseMagnitude('logN', SCALE, []), SCALE), 'L');
  assert.equal(mStr(parseMagnitude('N', SCALE, []), SCALE), 'N');
  // numeric constants are O(1) and drop out of the order of growth
  assert.equal(mStr(parseMagnitude('5 * N', SCALE, []), SCALE), 'N');
});

test('parse: product/quotient compose exponents; N^(1-B) affine', () => {
  assert.equal(mStr(parseMagnitude('N * N', SCALE, []), SCALE), 'N^(2)');
  assert.equal(mStr(parseMagnitude('N^2 / N', SCALE, []), SCALE), 'N');
  assert.equal(mStr(parseMagnitude('N^(1-B)', SCALE, ['B']), SCALE), 'N^(1 - B)');
});

test('closes: ternary Goldbach minor arc closes, with witness A>3', () => {
  const r = closes('N^2 * L^-3', ['N^2 * L^-A'], SCALE, { A: { gt: 0 } }, 'o');
  assert.equal(r.closes, true);
  assert.ok(r.witness && 'A' in r.witness);
  // witness must actually satisfy A>3 (the analytic requirement)
  assert.ok(num(r.witness!.A) > 3, `witness A=${r.witness!.A} should exceed 3`);
});

test('closes: binary Goldbach minor arc does NOT close for any A (the real obstruction)', () => {
  const r = closes('N', ['N^(3/2) * L^-A'], SCALE, { A: { gt: 0 } }, 'o');
  assert.equal(r.closes, false);
  assert.equal(r.witness, null);
  assert.match(r.obstruction ?? '', /dominant scale N|3\/2/);
});

test('closes: a sum of bounds — one good term, one bad term → does not close, names the culprit', () => {
  const r = closes('N^2', ['N^2 * L^-1', 'N^(5/2)'], SCALE, {}, 'o');
  assert.equal(r.closes, false);
  assert.match(r.obstruction ?? '', /N\^\(5\/2\)|larger/);
});

test('closes: all terms below target (numeric) → closes', () => {
  const r = closes('N^2', ['N^2 * L^-1', 'N^(3/2)'], SCALE, {}, 'o');
  assert.equal(r.closes, true);
});

test('compare action: N·log N is NOT o(N) (magnitude-slip catch)', async () => {
  const out = await magnitudeTool.execute({ action: 'compare', x: 'N * L', y: 'N', relation: 'o' });
  assert.equal(out.success, true);
  assert.match(out.output, /^NO:/);
});

test('compare action: N/log N IS o(N)', async () => {
  const out = await magnitudeTool.execute({ action: 'compare', x: 'N / L', y: 'N', relation: 'o' });
  assert.equal(out.success, true);
  assert.match(out.output, /^YES:/);
});

test('closes action (tool): ternary closes with a witness in the output', async () => {
  const out = await magnitudeTool.execute({
    action: 'closes',
    target: 'N^2 * L^-3',
    terms: ['N^2 * L^-A'],
    params: { A: { gt: 0 } },
    relation: 'o',
  });
  assert.equal(out.success, true);
  assert.match(out.output, /✅ CLOSES/);
  assert.match(out.output, /witness/);
});

test('closes action (tool): binary does not close, reports the obstruction', async () => {
  const out = await magnitudeTool.execute({
    action: 'closes',
    target: 'N',
    terms: ['N^(3/2) * L^-A'],
    params: { A: { gt: 0 } },
    relation: 'o',
  });
  assert.equal(out.success, true);
  assert.match(out.output, /❌ DOES NOT CLOSE/);
  assert.match(out.output, /obstruction/);
});

test('coupled parameters: Q-tradeoff feasibility (minor measure × sup bound)', () => {
  // toy coupled closure over scale [N, Q, L]: term1 grows with Q, term2 shrinks with Q.
  // term1 = Q^2 (minor measure-ish), term2 = N^2 / Q^2 (sup-ish). Need both o(N^2).
  // term1 o(N^2): 2 - 2q_e > 0 → q_e < 1 (where Q ~ N^q_e). term2: 2 - (2 - 2q_e) = 2q_e > 0 → q_e>0.
  // Model Q's scale by a param: Q = N^t, 0<t<1. Use scale [N,L] and write Q^2 = N^(2t).
  const r = closes('N^2', ['N^(2*t)', 'N^(2 - 2*t)'], ['N', 'L'], { t: { gt: 0, lt: 1 } }, 'o');
  assert.equal(r.closes, true);
  assert.ok(r.witness && num(r.witness.t) > 0 && num(r.witness.t) < 1);
});

test('simplify action surfaces the normalised exponent vector', async () => {
  const out = await magnitudeTool.execute({ action: 'simplify', expr: 'N^2 / (log N)^3' });
  assert.equal(out.success, true);
  assert.match(out.output, /N\^\(2\)·L\^\(-3\)/);
});

test('fr/fStr exact rationals', () => {
  assert.equal(fStr(fr(3, 6)), '1/2');
  assert.equal(fStr(fr(4, 2)), '2');
});
