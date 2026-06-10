/**
 * lemmaLookup — curated analytic-estimates library + keyword retrieval.
 * The cards exist to correct the exact slips observed: weight (Λ vs indicator), major/minor measure swap,
 * decoupling-on-a-linear-phase category error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lemmaLookupTool, ANALYTIC_LEMMAS } from '../src/runtime/lemma_library.js';

test('empty query lists the index of all cards', async () => {
  const out = await lemmaLookupTool.execute({ query: '' });
  assert.equal(out.success, true);
  assert.match(out.output, new RegExp(`${ANALYTIC_LEMMAS.length} cards`));
  for (const l of ANALYTIC_LEMMAS) assert.ok(out.output.includes(l.id), `index should list ${l.id}`);
});

test('keyword query returns the most relevant card with its misuse', async () => {
  const out = await lemmaLookupTool.execute({ query: 'minor arc sup bound', limit: 1 });
  assert.equal(out.success, true);
  assert.match(out.output, /Vinogradov/);
  assert.match(out.output, /common misuse/);
});

test('decoupling card warns about the linear-phase category error', async () => {
  const out = await lemmaLookupTool.execute({ query: 'decoupling linear phase', limit: 1 });
  assert.match(out.output, /BDG|decoupling/i);
  assert.match(out.output, /category error|no curvature|linear/i);
});

test('weight trap card surfaces the Λ vs indicator log factor', async () => {
  const out = await lemmaLookupTool.execute({ query: 'parseval weight', limit: 2 });
  assert.match(out.output, /N·log N|N\/log N|weight/i);
});

test('magnitude fields are present and use magnitude-tool syntax (compose-ready)', () => {
  const withMag = ANALYTIC_LEMMAS.filter((l) => l.magnitude);
  assert.ok(withMag.length >= 4, 'several cards should carry a magnitude shape');
  // every magnitude string should mention N (the asymptotic variable)
  for (const l of withMag) assert.match(l.magnitude!, /N/, `${l.id} magnitude should be in N,L syntax`);
});

test('no match → honest "not in this curated seed" message, not a fake card', async () => {
  const out = await lemmaLookupTool.execute({ query: 'navier stokes turbulence', limit: 3 });
  assert.equal(out.success, true);
  assert.match(out.output, /No card matched|curated seed/);
});
