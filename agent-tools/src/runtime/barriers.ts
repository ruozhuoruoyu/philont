/**
 * barrierCheck tool — a curated reference of KNOWN META-MATHEMATICAL NO-GO RESULTS ("barriers"):
 * theorems that say a whole CLASS of method provably CANNOT settle a whole class of goal.
 *
 * WHY: deep_explore's worst failure mode is not running out of compute — it is pouring rounds into a
 * goal/method pairing that is KNOWN to be impossible, and misreporting the wall as "a compute-resource
 * problem". The canonical case: attacking binary Goldbach (or twin primes) with a pure sieve. A
 * knowledgeable mathematician flags the PARITY PROBLEM at round 0; an LLM without this knowledge
 * decomposes an endless sub-tree, proves trivial lemmas, and leaves the one barrier-blocked step
 * permanently "open" — burning rounds on a wall that no amount of time can break.
 *
 * This library gives deep_explore the missing "is this approach known to be impossible?" gate. Unlike
 * lemma_library (which supplies POSITIVE estimates to USE), each barrier card supplies a NEGATIVE
 * result: what it BLOCKS, which method TRIGGERS it, WHY it bites here, and the only known CIRCUMVENTIONS.
 * It is matched against a goal (and any stated method) by `matchBarriers`, and surfaced two ways:
 *   1. automatically — deep_explore injects an applicable barrier into the round prompt and warns the
 *      user at session start (so the blocked step is named up front, not discovered at round 10);
 *   2. on demand — the `barrierCheck` tool lets the reasoning sub-LLM ask "is my plan blocked?".
 *
 * Curated, conservative SEED. A barrier firing is ADVISORY, never a hard block: a card says "this
 * method cannot reach this goal", which is exactly the information needed to either route through the
 * named circumvention or honestly record the blocked node as a structural dead end. Pure, no I/O.
 */

import type { Tool } from '@agent/policy';

export interface Barrier {
  id: string;
  title: string;
  tags: string[];
  /** Lowercase substrings identifying the TARGET this barrier blocks (the goal side). */
  goalTags: string[];
  /**
   * Lowercase substrings identifying the blocked APPROACH. Empty = method-agnostic: the barrier blocks
   * the goal for ANY method inside the system (independence / undecidability), so it fires on goal alone.
   */
  methodTags: string[];
  /** What, precisely, this result proves cannot be done. */
  blocks: string;
  /** Why it bites for this kind of goal/method (the crux a reasoner walks past). */
  whyHere?: string;
  /** The only known ways through — a different (non-blocked) input, or a weaker provable target. */
  circumvention: string;
  source: string;
}

export const KNOWN_BARRIERS: readonly Barrier[] = [
  {
    id: 'parity-problem',
    title: 'Parity problem (Selberg) — sieves cannot prove binary Goldbach / twin primes',
    tags: ['parity', 'sieve', 'selberg', 'goldbach', 'twin-prime', 'no-go'],
    goalTags: [
      'goldbach', 'twin prime', 'twin primes', 'prime gap', 'bounded gap', 'prime gaps',
      'sum of two primes', 'two primes', 'p1+p2', 'p₁+p₂', 'p+2', 'de polignac', 'polignac',
      'prime k-tuple', 'k-tuple', 'hardy-littlewood', 'p and p+2',
    ],
    methodTags: [
      'sieve', 'selberg', 'maynard', 'tao', 'gpy', 'goldston', 'pintz', 'yıldırım', 'yildirim',
      'brun', 'combinatorial sieve', 'legendre sieve', 'sieve weight', 'lambda', 'λ', 'weight function',
    ],
    blocks:
      'Pure sieve methods cannot distinguish integers with an EVEN vs ODD number of prime factors, so they ' +
      'cannot deliver a positive LOWER bound for a target that pins TWO quantities to be exactly prime — ' +
      'binary Goldbach (n and N−n both prime) or twin primes (p and p+2 both prime). The sieve hands you an ' +
      'upper bound; the parity obstruction forces its lower bound for the 2-prime target down to 0.',
    whyHere:
      'Maynard–Tao succeeds at BOUNDED GAPS (≥2 of k linear forms prime, over a FREE range of n) precisely ' +
      'because "some m of k are prime" dodges parity. Collapsing to the single sum constraint n₁+n₂=N (a ' +
      '1-dimensional affine slice — only one free variable) reinstates the exactly-two-primes lower-bound ' +
      'problem parity kills. The "prove positivity of the Selberg weight Σ over n≤N" step IS the wall — it ' +
      'cannot be closed by tuning λ.',
    circumvention:
      'Either WEAKEN the target — Chen: every large even N = p + P₂ (P₂ a product of ≤2 primes), provable by ' +
      'sieve + a switching trick — or INJECT a non-sieve arithmetic input the parity argument cannot see: ' +
      'bilinear / Type-II sum estimates (Vinogradov; Zhang / Polymath8; Bombieri–Friedlander–Iwaniec), the ' +
      'circle method, or automorphic input. A sieve ALONE provably will not do it; name where the non-sieve ' +
      'input enters or the plan is dead.',
    source: 'Selberg, the parity problem; Friedlander–Iwaniec, Opera de Cribro.',
  },
  {
    id: 'binary-circle-method-gap',
    title: 'Circle method — binary minor-arc L² has no spare factor (binary Goldbach gap)',
    tags: ['circle-method', 'binary', 'goldbach', 'minor-arc', 'hardy-littlewood', 'no-go'],
    goalTags: [
      'goldbach', 'sum of two primes', 'two primes', 'binary goldbach', 'p1+p2', 'p₁+p₂',
    ],
    methodTags: [
      'circle method', 'hardy-littlewood', 'hardy–littlewood', 'exponential sum', 'minor arc',
      'minor-arc', 'fourier', 'major arc', 'farey',
    ],
    blocks:
      'For the BINARY problem the minor-arc contribution is ∫_m |S(α)|² dα, which has NO spare sup factor to ' +
      'spend: it is ~ ‖S‖₂² ≈ N·log N — the SAME order as the main term. So the circle method on its own ' +
      'cannot show the minor arcs are negligible for a 2-prime additive problem.',
    whyHere:
      'Ternary Goldbach works because ∫_m|S|³ ≤ sup_m|S| · ‖S‖₂² carries a spare sup factor (≪ N·L⁴/√P) that ' +
      'makes it o(N²). The binary k=2 integral has no such factor — checking it with `magnitude closes` will ' +
      'correctly REFUSE to close. This is a genuine structural gap, not a parameter-tuning failure.',
    circumvention:
      'Needs extra square / cancellation structure on the minor arcs (Pintz-style), or a different decomposition ' +
      '— not a sharper choice of major/minor cutoff. Treat the minor-arc bound as the open structural node, not ' +
      'a step to assert. (See the lemmaLookup card "arc-integral-holder" for the precise magnitudes.)',
    source: 'Hardy–Littlewood; Vinogradov; Pintz on the binary problem.',
  },
  {
    id: 'relativization',
    title: 'Relativization (Baker–Gill–Solovay) — diagonalization cannot separate P vs NP',
    tags: ['relativization', 'oracle', 'p-vs-np', 'complexity', 'diagonalization', 'no-go'],
    goalTags: [
      'p vs np', 'p versus np', 'p=np', 'p≠np', 'p != np', 'separate p and np', 'p and np',
      'complexity class separation', 'pspace vs', 'np-complete lower bound',
    ],
    methodTags: [
      'diagonalization', 'simulation', 'relativiz', 'oracle', 'universal machine', 'time hierarchy',
    ],
    blocks:
      'Any proof technique that RELATIVIZES (carries over to all oracle worlds — diagonalization / universal ' +
      'simulation are the prototypes) cannot resolve P vs NP: there are oracles A,B with P^A=NP^A and P^B≠NP^B. ' +
      'A relativizing argument would have to give the same answer in both, so it cannot give either.',
    whyHere:
      'If your plan is "build a machine that diagonalizes against all poly-time machines", it relativizes and is ' +
      'therefore dead on arrival for the separation. The argument must use a NON-relativizing property of ' +
      'computation (the circuit / algebraic structure of specific machines).',
    circumvention:
      'Use non-relativizing techniques: circuit lower bounds, arithmetization / interactive proofs (IP=PSPACE ' +
      'is non-relativizing), or other structure-specific arguments — but then also clear the natural-proofs and ' +
      'algebrization barriers below.',
    source: 'Baker, Gill & Solovay 1975.',
  },
  {
    id: 'natural-proofs',
    title: 'Natural proofs (Razborov–Rudich) — "natural" circuit lower bounds are blocked',
    tags: ['natural-proofs', 'circuit-lower-bound', 'p-vs-np', 'cryptography', 'no-go'],
    goalTags: [
      'circuit lower bound', 'circuit complexity lower bound', 'p vs np', 'p versus np',
      'super-polynomial circuit', 'np lower bound', 'boolean circuit lower bound',
    ],
    methodTags: [
      'natural proof', 'natural property', 'largeness', 'constructivity', 'random function',
      'combinatorial property of the truth table',
    ],
    blocks:
      'A lower-bound argument that is "natural" (its hard-property is CONSTRUCTIVE and holds for a LARGE ' +
      'fraction of all functions) cannot prove strong circuit lower bounds — if it could, it would break the ' +
      'pseudorandom generators / one-way functions widely believed to exist.',
    whyHere:
      'Most combinatorial "this function is too complex because its truth table looks random" arguments are ' +
      'natural, hence self-defeating. The hardness property must be non-natural (fail largeness or ' +
      'constructivity).',
    circumvention:
      'Use a non-natural property (e.g. arguments that exploit a specific function and do not generalize to ' +
      'random functions), or accept the result is conditional. Still must avoid relativization & algebrization.',
    source: 'Razborov & Rudich 1997 (Natural Proofs).',
  },
  {
    id: 'algebrization',
    title: 'Algebrization (Aaronson–Wigderson) — arithmetization alone is not enough',
    tags: ['algebrization', 'arithmetization', 'p-vs-np', 'complexity', 'no-go'],
    goalTags: ['p vs np', 'p versus np', 'complexity class separation', 'circuit lower bound', 'nexp vs'],
    methodTags: ['algebriz', 'arithmetiz', 'low-degree extension', 'polynomial extension', 'sum-check', 'ip=pspace style'],
    blocks:
      'Techniques that "algebrize" (relativize even when one side is given a LOW-DEGREE polynomial extension ' +
      'of the oracle — this captures arithmetization / interactive-proof methods) still cannot resolve P vs NP ' +
      'and similar separations.',
    whyHere:
      'Arithmetization was the non-relativizing tool that gave IP=PSPACE, so it is tempting for separations — ' +
      'but Aaronson–Wigderson show it too has algebraic oracles on both sides. A proof must be non-algebrizing.',
    circumvention:
      'A genuinely new, non-algebrizing ingredient is required; no general recipe is known. Treat a separation ' +
      'plan resting only on arithmetization as blocked.',
    source: 'Aaronson & Wigderson 2009 (Algebrization).',
  },
  {
    id: 'undecidability',
    title: 'Undecidability — no algorithm decides all instances (Halting / Hilbert 10th / word problem)',
    tags: ['undecidable', 'halting', 'hilbert-tenth', 'mrdp', 'word-problem', 'no-go'],
    goalTags: [
      'halting problem', 'decide whether', 'decide if', 'decide all', 'algorithm to decide',
      'general algorithm for', 'hilbert tenth', "hilbert's tenth", 'diophantine solvability',
      'word problem for groups', 'decision procedure for', 'entscheidungsproblem', 'always terminates',
    ],
    methodTags: [],
    blocks:
      'No algorithm can decide the problem on ALL inputs: the Halting problem is undecidable (Turing); ' +
      'Diophantine solvability over ℤ has no decision procedure (Matiyasevich / MRDP, settling Hilbert 10th); ' +
      'the word problem for general groups is undecidable (Novikov–Boone). A goal of the form "an algorithm / ' +
      'decision procedure for every instance" is impossible.',
    whyHere:
      'No matter how clever the procedure, a single algorithm cannot exist. Effort should go to a DECIDABLE ' +
      'subclass, a semi-decision procedure, or a non-uniform / case-by-case result — not a universal decider.',
    circumvention:
      'Restrict to a decidable fragment (bounded degree / special structure), accept semi-decidability (halts on ' +
      'YES only), or aim for a relative / conditional statement instead of a total decision procedure.',
    source: 'Turing 1936; Matiyasevich 1970 (MRDP); Novikov–Boone.',
  },
  {
    id: 'independence-zfc',
    title: 'Independence from ZFC — some statements are neither provable nor refutable',
    tags: ['independence', 'zfc', 'continuum-hypothesis', 'forcing', 'godel', 'cohen', 'no-go'],
    goalTags: [
      'continuum hypothesis', ' ch ', 'whitehead problem', 'suslin hypothesis', 'suslin problem',
      'aleph', 'cardinality of the reals', 'is independent of zfc', 'borel conjecture',
    ],
    methodTags: [],
    blocks:
      'Certain statements are INDEPENDENT of ZFC — provably neither provable nor disprovable from the standard ' +
      'axioms (Gödel: Con(ZFC)→Con(ZFC+CH); Cohen: Con(ZFC)→Con(ZFC+¬CH)). No ZFC proof of such a statement ' +
      '(or its negation) can exist.',
    whyHere:
      'Trying to "prove CH" (or its negation) within ZFC is impossible by design. The only meaningful outputs ' +
      'are relative-consistency / independence results, or work under an explicitly stronger axiom.',
    circumvention:
      'Prove a relative-consistency / independence result (forcing, inner models), or assume an additional ' +
      'axiom (large cardinals, V=L, PD) and state the dependence — do not claim an outright ZFC proof.',
    source: 'Gödel 1940; Cohen 1963 (forcing).',
  },
  {
    id: 'incompleteness-consistency',
    title: 'Gödel 2nd incompleteness — a system cannot prove its own consistency',
    tags: ['incompleteness', 'godel', 'consistency', 'self-reference', 'no-go'],
    goalTags: [
      'consistency of', 'prove pa is consistent', 'prove zfc is consistent', 'con(pa)', 'con(zfc)',
      'prove its own consistency', 'self-consistency', 'goodstein in pa', 'paris-harrington in pa',
    ],
    methodTags: [],
    blocks:
      'A consistent, sufficiently strong, recursively axiomatized system cannot prove its OWN consistency ' +
      '(Gödel 2nd). Some true arithmetic statements (Goodstein, Paris–Harrington) are unprovable IN PA though ' +
      'provable in a stronger system.',
    whyHere:
      'A goal "prove Con(S) inside S" (or "prove Goodstein within PA") is blocked. It needs genuinely stronger ' +
      'means than the system in which you are trying to argue.',
    circumvention:
      'Prove it in a strictly stronger meta-theory (e.g. transfinite induction up to ε₀ for Con(PA), à la ' +
      'Gentzen), and state the meta-theory explicitly.',
    source: 'Gödel 1931; Gentzen; Paris–Harrington 1977.',
  },
  {
    id: 'abel-ruffini',
    title: 'Abel–Ruffini / Galois — no radical formula for the general quintic',
    tags: ['abel-ruffini', 'galois', 'quintic', 'radicals', 'solvable-group', 'no-go'],
    goalTags: [
      'quintic formula', 'solve the general quintic', 'solve the quintic by radicals', 'radical formula',
      'general degree 5', 'solve degree 5 by radicals', 'formula in radicals for', 'solvable by radicals',
    ],
    methodTags: [],
    blocks:
      'There is no general solution in radicals for polynomial equations of degree ≥ 5: the general quintic has ' +
      'Galois group S₅, which is not solvable, so its roots are not expressible by radicals.',
    whyHere:
      'Any search for a closed-form radical formula for the general quintic is searching for something that ' +
      'provably does not exist. Specific solvable quintics are fine; the GENERAL one is not.',
    circumvention:
      'Use non-radical solutions (elliptic / theta functions, Bring radicals), solve only the SOLVABLE-Galois ' +
      'special cases, or compute roots numerically.',
    source: 'Abel 1824; Ruffini; Galois.',
  },
];

// ── matching ────────────────────────────────────────────────────────────────────────────────────

export type BarrierSeverity =
  /** goal matches AND (the barrier is method-agnostic OR the blocked method is named) — high confidence the plan is blocked. */
  | 'applies'
  /** goal matches a famously-hard target but the named blocked method is not detected — proceed with care, the target is hard. */
  | 'goal-hard';

export interface BarrierMatch {
  barrier: Barrier;
  severity: BarrierSeverity;
  /** Which goalTags / methodTags were found in the text (for transparency). */
  matchedGoal: string[];
  matchedMethod: string[];
}

/**
 * Match the given text (a goal, optionally concatenated with assumptions / a stated method) against the
 * barrier library. A barrier is a candidate only if at least one of its goalTags appears in the text —
 * so an unrelated goal never trips it. Severity is 'applies' when the barrier is method-agnostic or a
 * blocked-method tag is also present; otherwise 'goal-hard'. Pure: lowercases + substring-matches, no I/O.
 * Sorted strongest first (applies before goal-hard, then by total tag hits).
 */
export function matchBarriers(text: string): BarrierMatch[] {
  const hay = (text || '').toLowerCase();
  if (!hay.trim()) return [];
  const out: BarrierMatch[] = [];
  for (const b of KNOWN_BARRIERS) {
    const matchedGoal = b.goalTags.filter((t) => hay.includes(t));
    if (matchedGoal.length === 0) continue;
    const matchedMethod = b.methodTags.filter((t) => hay.includes(t));
    const severity: BarrierSeverity =
      b.methodTags.length === 0 || matchedMethod.length > 0 ? 'applies' : 'goal-hard';
    out.push({ barrier: b, severity, matchedGoal, matchedMethod });
  }
  out.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'applies' ? -1 : 1;
    return (
      b.matchedGoal.length + b.matchedMethod.length - (a.matchedGoal.length + a.matchedMethod.length)
    );
  });
  return out;
}

/** Full human/LLM-facing card for one barrier. */
export function formatBarrier(b: Barrier): string {
  const lines = [`### ${b.title}  [${b.id}]`, `BLOCKS: ${b.blocks}`];
  if (b.whyHere) lines.push(`WHY IT APPLIES: ${b.whyHere}`);
  lines.push(`CIRCUMVENTION: ${b.circumvention}`);
  lines.push(`source: ${b.source}`);
  return lines.join('\n');
}

/**
 * Render matched barriers as a prompt-ready advisory block for deep_explore (injected into the round
 * prompt + shown to the user at session start). Empty array → empty string. Only 'applies' matches get
 * the strong "do not assert the blocked step" directive; 'goal-hard' matches get a lighter heads-up.
 */
export function renderBarrierAdvisory(matches: BarrierMatch[]): string {
  if (matches.length === 0) return '';
  const lines: string[] = ['## ⚠ KNOWN BARRIERS for this goal/method — read before proceeding'];
  for (const m of matches) {
    const tag = m.severity === 'applies' ? '⛔ APPLIES' : '⚠ hard target';
    lines.push('');
    lines.push(`### ${tag} — ${m.barrier.title}  [${m.barrier.id}]`);
    lines.push(`BLOCKS: ${m.barrier.blocks}`);
    if (m.barrier.whyHere) lines.push(`WHY HERE: ${m.barrier.whyHere}`);
    lines.push(`CIRCUMVENTION: ${m.barrier.circumvention}`);
    lines.push(`source: ${m.barrier.source}`);
  }
  lines.push('');
  lines.push(
    'DIRECTIVE: do NOT record the barrier-blocked step as "proved" by the blocked method. Either (a) route ' +
      'EXPLICITLY through a named circumvention — and state where the non-blocked input enters — or (b) ' +
      'reason_record the blocked node as a dead_end naming the barrier. A pile of trivial sub-lemmas around ' +
      'the wall is not progress; the wall is the problem.',
  );
  return lines.join('\n');
}

export const barrierCheckTool: Tool = {
  name: 'barrierCheck',
  description:
    'Check a goal/approach against a curated library of KNOWN META-MATHEMATICAL NO-GO RESULTS (barriers): ' +
    'results proving that a whole class of method CANNOT settle a class of problem. Covers the parity problem ' +
    '(sieves cannot prove binary Goldbach / twin primes), the binary circle-method minor-arc gap, ' +
    'relativization / natural-proofs / algebrization (P vs NP), undecidability (halting / Hilbert 10th / word ' +
    'problem), independence from ZFC (CH), Gödel 2nd incompleteness, and Abel–Ruffini (general quintic). ' +
    'Call this BEFORE committing rounds to a hard conjecture: if your method is blocked, the tool names the ' +
    'obstruction and the only known circumventions, so you can switch method or record the wall honestly ' +
    'instead of grinding it. Query with the goal + intended method (e.g. "prove binary goldbach with the ' +
    'maynard sieve"); empty query lists the library.',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The goal + intended method, e.g. "binary goldbach via selberg sieve". Empty → list all barriers.',
      },
    },
    required: [],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const query = String(params.query ?? '').trim();
    if (!query) {
      const idx = KNOWN_BARRIERS.map((b) => `- [${b.id}] ${b.title}`).join('\n');
      return {
        success: true,
        output: `Known-barriers library (${KNOWN_BARRIERS.length} no-go results). Query with your goal + method to check if it is blocked.\n${idx}`,
      };
    }
    const matches = matchBarriers(query);
    if (matches.length === 0) {
      return {
        success: true,
        output:
          `No known barrier in this curated seed matches "${query}". That is NOT a guarantee the approach works — ` +
          `it only means none of the ${KNOWN_BARRIERS.length} catalogued no-go results obviously apply. Proceed, but ` +
          `stay alert for an obstruction the library does not cover.`,
      };
    }
    const head =
      matches.some((m) => m.severity === 'applies')
        ? '⛔ This goal/method appears to hit a KNOWN BARRIER:'
        : '⚠ This is a known-hard target (no blocked method clearly detected, but tread carefully):';
    return { success: true, output: `${head}\n\n${renderBarrierAdvisory(matches)}` };
  },
};
