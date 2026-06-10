/**
 * lemmaLookup tool — a curated reference library of standard analytic estimates, with their PRECISE
 * hypotheses, magnitudes, and (crucially) common MISUSES.
 *
 * WHY: the second half of an LLM's analytic-number-theory weakness (after raw magnitude arithmetic,
 * which `magnitude` handles) is mis-remembering the standard tools — the exact constant in a sup bound,
 * the moduli range where Siegel–Walfisz applies, whether decoupling applies to a linear prime phase.
 * Retrieval beats recall: the model looks the estimate up here (precise statement + the trap to avoid)
 * instead of half-remembering it. Each card's `magnitude` field is written in the `magnitude` tool's
 * syntax so the two compose: look the bound up, then feed its shape straight into `magnitude closes`.
 *
 * This is a SEED for the formal/number-theory domain (where deep_explore is strongest today). It is a
 * static, curated set — not exhaustive, and deliberately conservative (qualitative where exact constants
 * are convention-dependent). The agent's own verified results / a human's additions live in the KB
 * (searchKB / notes); this library is the always-available canonical core. Pure, deterministic, no I/O.
 */

import type { Tool } from '@agent/policy';

export interface Lemma {
  id: string;
  title: string;
  tags: string[];
  statement: string;
  /** Order of growth in the `magnitude` tool's syntax (N, L=log N, …), when cleanly expressible. */
  magnitude?: string;
  hypotheses: string;
  commonMisuse?: string;
  source: string;
}

export const ANALYTIC_LEMMAS: readonly Lemma[] = [
  {
    id: 'pnt-weights',
    title: 'PNT / Chebyshev / Mertens — and the weight trap',
    tags: ['pnt', 'prime-counting', 'chebyshev', 'mertens', 'psi', 'theta', 'weight', 'log'],
    statement:
      'π(N) ~ N/log N;  Σ_{p≤N} log p ~ N  (Chebyshev θ);  Σ_{n≤N} Λ(n) ~ N  (ψ);  Σ_{p≤N} 1/p ~ log log N.',
    magnitude: 'N/L',
    hypotheses: 'Prime number theorem.',
    commonMisuse:
      'Pick the right WEIGHT. A sum over primes with NO weight is ~ N/log N; weighted by log p or Λ(n) it is ~ N. ' +
      'That stray factor of log N is the single most common magnitude slip — e.g. the L² norm of the prime ' +
      'exponential sum is N·log N for the Λ-weight but N/log N for the indicator.',
    source: 'Prime number theorem; Mertens.',
  },
  {
    id: 'parseval-exp-sum',
    title: 'Parseval / Plancherel for exponential sums (mean square)',
    tags: ['parseval', 'plancherel', 'l2', 'mean-square', 'exponential-sum', 'circle-method', 'norm'],
    statement:
      '∫_0^1 |Σ_{n≤N} a_n e(nα)|² dα = Σ_{n≤N} |a_n|².  For the von Mangoldt weight a_n=Λ(n): = Σ Λ(n)² ~ N·log N.  ' +
      'For the prime indicator a_n=1_{n prime}: ~ N/log N (= π(N)).',
    magnitude: 'N*L',
    hypotheses: 'Exact identity for any coefficients; the asymptotics use PNT (weight-dependent).',
    commonMisuse:
      'This is the FULL-circle L² norm — it does NOT shrink to the minor arcs for free. And it is weight-dependent ' +
      '(Λ → N·logN, indicator → N/logN): do not mix the two normalisations mid-proof.',
    source: 'Parseval; Iwaniec–Kowalski, Analytic Number Theory.',
  },
  {
    id: 'vinogradov-minor-sup',
    title: 'Vinogradov minor-arc bound (sup of the prime exponential sum)',
    tags: ['vinogradov', 'minor-arc', 'sup', 'exponential-sum', 'prime', 'von-mangoldt', 'circle-method', 'l-infinity'],
    statement:
      'For |α − a/q| ≤ 1/q² with (a,q)=1:  |Σ_{n≤N} Λ(n) e(nα)| ≪ (N/√q + N^{4/5} + √(N q)) (log N)^4.  ' +
      'On the minor arcs (P ≤ q ≤ N/P) this is ≪ N (log N)^4 / √P.',
    magnitude: 'N*L^4 / q^(1/2)',
    hypotheses: 'Minor-arc α with a rational approximation a/q of middling denominator q.',
    commonMisuse:
      'It is only a SUP (L^∞) bound. To bound an arc INTEGRAL you still multiply it by an L¹/L² factor (Parseval) — ' +
      'the sup alone is NOT the integral.',
    source: 'Vinogradov; Vaughan, The Hardy–Littlewood Method.',
  },
  {
    id: 'arc-integral-holder',
    title: 'Arc-integral bound: sup × mean-square — and the ternary-vs-binary Goldbach gap',
    tags: ['holder', 'cauchy-schwarz', 'minor-arc', 'integral', 'ternary', 'binary', 'goldbach', 'circle-method', 'gap'],
    statement:
      '∫_m |S(α)|^k dα ≤ (sup_{α∈m}|S|)^{k-2} · ∫_0^1 |S|² dα.  ' +
      'Ternary (k=3): ∫_m|S|³ ≤ sup_m|S| · ‖S‖₂², and the spare sup factor (≪ N·L^4/√P) makes it o(N²) for P=(log N)^B, B large.  ' +
      'Binary (k=2): ∫_m|S|² has NO spare sup factor — it is ~ ‖S‖₂² ≈ N·log N, the SAME order as the main term.',
    hypotheses: 'Circle-method dissection; S(α) the (Λ-weighted) prime exponential sum.',
    commonMisuse:
      'Binary Goldbach: do NOT expect ∫_m|S|² = o(N) from sup×L² — there is no spare factor, so the minor-arc ' +
      'contribution is the same order as the main term. This is the genuine OPEN gap (it needs the square structure ' +
      'on the minor arcs, à la Pintz), not a parameter-tuning failure. Use `magnitude closes` to see it refuse to close.',
    source: 'Hardy–Littlewood; Vinogradov; Pintz on the binary problem.',
  },
  {
    id: 'arc-measure',
    title: 'Major vs minor arc measure — do not swap them',
    tags: ['major-arc', 'minor-arc', 'measure', 'farey', 'dissection', 'circle-method'],
    statement:
      'In the Farey dissection at level Q (major arcs = small neighbourhoods of a/q, q ≤ Q), the MAJOR arcs occupy ' +
      'a SMALL fraction of [0,1] (a power of Q/N); the MINOR arcs m occupy almost the whole circle (measure ≈ 1).',
    hypotheses: 'Standard circle-method major/minor dissection.',
    commonMisuse:
      'Do not label the small major-arc measure (∝ a power of Q/N) as the minor-arc measure. The minor arcs are the ' +
      'BULK of [0,1] — measure ≈ 1. (This exact swap is a recurring slip.)',
    source: 'Circle method; Vaughan.',
  },
  {
    id: 'siegel-walfisz',
    title: 'Siegel–Walfisz (primes in arithmetic progressions, small moduli)',
    tags: ['siegel-walfisz', 'primes-in-ap', 'major-arc', 'main-term', 'psi', 'moduli'],
    statement:
      'ψ(x; q, a) = x/φ(q) + O(x · exp(−c√(log x))) uniformly for q ≤ (log x)^A (any fixed A), (a,q)=1. ' +
      'The error is smaller than any fixed power of log x.',
    hypotheses: 'ONLY small moduli q ≤ (log x)^A. The constant c and the implied constant are ineffective (Siegel).',
    commonMisuse:
      'It fails for large q — which is exactly WHY the major/minor cutoff sits at Q ≈ (log N)^B: Siegel–Walfisz handles ' +
      'q ≤ Q on the major arcs; large-q frequencies are pushed to the minor arcs (handled by Vinogradov, not SW).',
    source: 'Siegel–Walfisz theorem.',
  },
  {
    id: 'decoupling-applicability',
    title: 'ℓ²-decoupling / BDG — applicability needs curvature',
    tags: ['decoupling', 'bdg', 'bourgain-demeter-guth', 'vinogradov-mean-value', 'curvature', 'polynomial-phase', 'moment-curve'],
    statement:
      'ℓ²-decoupling (Bourgain–Demeter–Guth) bounds exponential sums/integrals with a CURVED phase — e.g. Vinogradov’s ' +
      'mean value ∫|Σ_{n≤N} e(n x₁ + n² x₂ + … + n^k x_k)|^{2s} over the moment curve. It exploits curvature.',
    hypotheses: 'A genuinely curved / higher-degree polynomial phase (≥ 2 frequencies with curvature).',
    commonMisuse:
      'It does NOT apply to a single LINEAR phase Σ_p e(pα): a 1-parameter linear exponent has no curvature, so decoupling ' +
      'gives nothing for binary Goldbach’s S(α). Pointing BDG at the linear prime sum is a category error (a known dead end).',
    source: 'Bourgain–Demeter–Guth 2016 (Vinogradov mean value via decoupling).',
  },
  {
    id: 'divisor-bound',
    title: 'Divisor bound',
    tags: ['divisor', 'd(n)', 'tau', 'epsilon', 'error-term'],
    statement: 'd(n) = Σ_{d|n} 1 ≪_ε n^ε for every ε>0;  and on average Σ_{n≤N} d(n) ~ N log N.',
    magnitude: 'N^e',
    hypotheses: 'Pointwise n^ε holds for any ε>0 (implied constant depends on ε).',
    commonMisuse:
      'n^ε beats any power of log pointwise, but is still a positive power of n in the worst case. Use the AVERAGE bound ' +
      '(N log N over n ≤ N) when summing, not the pointwise n^ε times N.',
    source: 'Standard divisor estimates.',
  },
  {
    id: 'large-sieve',
    title: 'Large sieve inequality',
    tags: ['large-sieve', 'sieve', 'exponential-sum', 'moduli', 'mean-value'],
    statement:
      'Σ_{q≤Q} Σ_{a mod q, (a,q)=1} |Σ_{n≤N} a_n e(n a/q)|² ≤ (N + Q²) Σ_{n≤N} |a_n|².',
    magnitude: '(N + Q^2)',
    hypotheses: 'Any coefficients a_n; the bound is sharp in the N + Q² factor.',
    commonMisuse:
      'The factor is N + Q², not N·Q²: for Q ≤ √N the sieve is "free" (the N term dominates). Do not over-count by ' +
      'multiplying when you should add.',
    source: 'Montgomery–Vaughan large sieve.',
  },
];

/** keyword score: count of query terms that appear in the card's searchable text. */
function scoreLemma(l: Lemma, terms: string[]): number {
  const hay = `${l.id} ${l.title} ${l.tags.join(' ')} ${l.statement} ${l.commonMisuse ?? ''}`.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (!t) continue;
    if (l.tags.some((tag) => tag.toLowerCase() === t)) s += 3; // exact tag hit weighs most
    else if (hay.includes(t)) s += 1;
  }
  return s;
}

function formatLemma(l: Lemma): string {
  const lines = [`### ${l.title}  [${l.id}]`, l.statement];
  if (l.magnitude) lines.push(`magnitude: ${l.magnitude}   (feed this shape to the \`magnitude\` tool)`);
  lines.push(`hypotheses: ${l.hypotheses}`);
  if (l.commonMisuse) lines.push(`⚠ common misuse: ${l.commonMisuse}`);
  lines.push(`source: ${l.source}`);
  return lines.join('\n');
}

export const lemmaLookupTool: Tool = {
  name: 'lemmaLookup',
  description:
    'Look up standard analytic / number-theory estimates with their PRECISE hypotheses, magnitudes, and common ' +
    'misuses — retrieve the exact tool instead of half-remembering it. Covers PNT/Mertens weights, Parseval for ' +
    'exponential sums, the Vinogradov minor-arc sup bound, sup×mean-square arc integrals (and the binary-vs-ternary ' +
    'Goldbach gap), major/minor arc measure, Siegel–Walfisz, ℓ²-decoupling/BDG applicability, the divisor bound, and ' +
    'the large sieve. Each card’s magnitude is in `magnitude`-tool syntax so you can feed it straight into a closure ' +
    'check. Query with keywords (e.g. "minor arc sup", "decoupling linear phase", "siegel walfisz moduli"); empty query lists the index.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, e.g. "minor arc sup bound" or "parseval weight". Empty → list all cards.' },
      limit: { type: 'number', description: 'Max cards to return (default 3, max 9).' },
    },
    required: [],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const query = String(params.query ?? '').trim();
    const limit = Math.max(1, Math.min(9, Number.isFinite(params.limit) ? Math.floor(Number(params.limit)) : 3));
    if (!query) {
      const idx = ANALYTIC_LEMMAS.map((l) => `- [${l.id}] ${l.title}  (tags: ${l.tags.slice(0, 5).join(', ')})`).join('\n');
      return { success: true, output: `Analytic-estimates library (${ANALYTIC_LEMMAS.length} cards). Query by keyword for details.\n${idx}` };
    }
    const terms = query.toLowerCase().split(/[^a-z0-9()/]+/).filter(Boolean);
    const ranked = ANALYTIC_LEMMAS.map((l) => ({ l, s: scoreLemma(l, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);
    if (!ranked.length) {
      return {
        success: true,
        output: `No card matched "${query}". The library is a curated seed (${ANALYTIC_LEMMAS.length} cards) — try broader keywords, or reason it out / use pariGp / searchKB for results outside it.`,
      };
    }
    return { success: true, output: ranked.map((x) => formatLemma(x.l)).join('\n\n') };
  },
};
