/**
 * deep_explore — isolated deep-reasoning subsystem (in-turn resumable / reasoning state persisted).
 *
 * User says "let's attack this conjecture together" → main turn LLM calls deep_explore once →
 * internally runs one round of a multi-step mini-loop advancing a "reasoning tree"
 * (sub-problem tree + proved lemmas + dead ends) → tree is written to DB → returns a progress
 * summary to the main turn. Next turn (even days later) user says "continue" → deep_explore(continue)
 * reads back the tree and keeps going.
 *
 * Fully isolated from the existing framework: new tools, new tables (reasoning_sessions/nodes),
 * reuses the mini-loop engine, does not touch research_focus / pursuit / autonomous loop / grant.
 * env flag PHILONT_DEEP_EXPLORE defaults to off.
 *
 * Core orchestration decisions (from design review):
 *   - Reasoning actions = tools the sub-LLM can call within the mini-loop (reason_decompose /
 *     reason_record); tree is written to DB in real-time.
 *   - mini-loop systemPrompt is fixed for the whole round, not re-rendered → reason_decompose
 *     **MUST echo newly created node ids in tool_result**, otherwise the decompose→record chain
 *     breaks after the first expansion.
 *   - reason_record on wrong nodeId echoes the current list of valid open ids so the sub-LLM
 *     can self-correct (prevents hallucinated ids hitting a wall).
 *   - Convergence via **post-loop judgment** (root proved→solved / empty frontier→stuck); the
 *     sub-LLM is not given reason_close (prevents false "done" claims).
 *   - Budget: maxIters is a per-round LLM-call gate; reasoning_sessions.budget_spent is the
 *     cross-turn cumulative token account.
 *
 * Experimental-math explore mode (inspired by FunSearch / AlphaEvolve "generate-validate" loop):
 * action="discover" runs a round driven by buildDiscoverPrompt — use pariGp to compute data in
 * bulk → find patterns and propose conjectures → search for counterexamples with pariGp →
 * surviving conjectures are hung on the tree via reason_decompose as kind='conjecture' nodes
 * (claim includes experimental evidence) to be proved later. Novelty comes from patterns exposed
 * by computation, not training memory; conjecture freely, rely on pariGp counterexample search
 * as a safety net. Reuses the same mini-loop / tools / verification hooks as prove, only swaps
 * the prompt + closing statistics; no value-guided node selection; no stuck judgment.
 *
 * Value-guided node selection (A prototype, inspired by LATS arXiv:2310.04406 / rStar-Math /
 * ReST-MCTS* "LLM value function + tree search"): before each round render, an independent aux-LLM
 * scores each open frontier leaf with a 0-1 value (persisted to reasoning_nodes.value); at render
 * time nodes are ranked by UCB = value + c·sqrt(ln(1+N)/(1+visits)) and the top one is
 * "recommended to attack first" — an independent value signal + exploration term replaces
 * "the same LLM picking frontier by feeling"; nodes stuck for many rounds accumulate visits →
 * exploration term decays → automatically yields to others. Disable with env
 * PHILONT_DEEP_EXPLORE_VALUE_GUIDED=0.
 * ② novelty + diversity archive (inspired by novelty search / quality-diversity / MAP-Elites):
 * the scorer also tags each node with a technique label (persisted); priority += noveltyW·novelty
 * (rare / untried techniques get a bonus), then nodes are bucketed by technique and interleaved
 * across buckets → the recommendation head covers diverse techniques, rare-bucket champions
 * surface near the top, avoids collapsing to a single mainstream path.
 * env PHILONT_DEEP_EXPLORE_NOVELTY_W (default 0.3).
 *
 * Adversarial verification (C prototype, inspired by Self-Consistency + this repo's
 * deep-research/Workflow adversarial pattern):
 *   Before reason_record(proved) is committed, dispatch SKEPTIC_COUNT independent skeptic
 *   sub-LLMs (read-only researchDefs, do not modify the tree) to specifically **attempt to
 *   refute** the claim; majority (including ties) refuting → do not record as proved, leave
 *   the node open, write the strongest objection into approaches_tried (backtracking memory).
 *   Prevents "LLM verbal assertion = proved". Verification tokens are counted against the
 *   session budget. Disable with env PHILONT_DEEP_EXPLORE_SKEPTICS=0 (reverts to old behaviour).
 */

import type { Tool, ToolDefinition, ToolResult } from '@agent/policy';
import {
  runMiniAgentLoop,
  type MiniLoopLLMClient,
  type MiniLoopToolRunResult,
} from '@agent/tools';
import {
  ReasoningNodeNotFoundError,
  type ReasoningStore,
  type ReasoningSession,
  type ReasoningNode,
  type ReasoningNodeKind,
  type ReasoningSessionStatus,
} from '@agent/memory';

const VALID_KINDS: ReadonlySet<string> = new Set([
  'subgoal',
  'lemma',
  'construction',
  'counterexample',
  'conjecture',
]);
const RECORD_STATUSES: ReadonlySet<string> = new Set(['proved', 'refuted', 'dead_end']);

/**
 * Per-round mini-loop LLM↔tool iteration cap.
 * Deep reasoning needs many decompose / record / recall round trips; 12 is too tight —
 * hard problems often get truncated before any real expansion happens.
 * Default raised to 40 (same as slow-mode tool-loop); override with env
 * PHILONT_DEEP_EXPLORE_MAX_ITERS (allowed 5–100).
 */
function resolveDeepExploreMaxIters(): number {
  const fallback = 40;
  const raw = process.env.PHILONT_DEEP_EXPLORE_MAX_ITERS;
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 5 && n <= 100) return n;
  console.warn(`[config] PHILONT_DEEP_EXPLORE_MAX_ITERS="${raw}" out of range (allowed 5-100), using default ${fallback}`);
  return fallback;
}
const DEFAULT_MAX_ITERS = resolveDeepExploreMaxIters();

/**
 * Cross-turn cumulative session token budget; once exceeded, continue no longer runs and
 * only shows a notice. Raising per-round iters can increase per-round token cost, so this
 * is also adjustable (env PHILONT_DEEP_EXPLORE_TOKEN_BUDGET, default 300k, min 50k).
 */
const SESSION_TOKEN_BUDGET = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_TOKEN_BUDGET);
  return Number.isInteger(n) && n >= 50_000 ? n : 300_000;
})();

/**
 * Per-round wall-clock time limit (default 12 min; env PHILONT_DEEP_EXPLORE_ROUND_DEADLINE_MS,
 * min 30s).
 *
 * Background (2026-06-03): turns have a 20-min hard deadline implemented as withTimeout
 * (Promise.race) — when it fires it only rejects the outer promise, **not the inner one**.
 * deep_explore running 40 iters per round can exceed 20 min, leading to:
 *   ① TurnDeadlineError being thrown and killing the turn;
 *   ② worse: the mini-loop has no abort signal, so after the deadline it keeps running
 *      (iter 31/32/33…) → orphaned loop burning tokens.
 * Fix: give each round its own wall-clock budget (safely below the 20-min turn deadline) +
 * an AbortController; when the budget expires, abort. The mini-loop checks abortSignal before
 * each iteration → graceful stop; the tree is written incrementally, so runRound's aborted
 * branch returns "resumable". This kills orphans without hitting the hard deadline; maxIters
 * degrades to a soft upper bound that only takes effect when time allows.
 */
const ROUND_DEADLINE_MS = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_ROUND_DEADLINE_MS);
  return Number.isInteger(n) && n >= 30_000 ? n : 720_000;
})();

/**
 * Value-guided node selection (LATS/rStar style) master switch. On by default;
 * set env PHILONT_DEEP_EXPLORE_VALUE_GUIDED=0 to disable → reverts to old behaviour
 * (frontier ordered by depth/creation time; "LLM picks the most promising one").
 */
const VALUE_GUIDED = process.env.PHILONT_DEEP_EXPLORE_VALUE_GUIDED !== '0';

/** UCB exploration coefficient: higher → more exploration of untried nodes. env PHILONT_DEEP_EXPLORE_UCB_C, default 0.7, range [0,5]. */
const UCB_C = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_UCB_C);
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : 0.7;
})();

/**
 * Novelty weight (②): bonus for frontier nodes with "rare / untried" techniques, preventing
 * exploration from collapsing to a single mainstream approach.
 * Inspired by novelty search (Lehman & Stanley) / quality-diversity.
 * env PHILONT_DEEP_EXPLORE_NOVELTY_W, default 0.3, range [0,2].
 */
const NOVELTY_W = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_NOVELTY_W);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : 0.3;
})();

/**
 * Technique taxonomy (MAP-Elites behaviour descriptor + novelty bucket key). The scorer
 * tags each node with one; persisted to reasoning_nodes.technique and reused across turns.
 * Unknown values are normalised to 'other'.
 */
export const TECHNIQUE_TAXONOMY: readonly string[] = [
  'induction', 'contradiction', 'construction', 'algebraic',
  'analytic', 'probabilistic', 'combinatorial', 'computational', 'other',
];
const TECHNIQUE_SET = new Set(TECHNIQUE_TAXONOMY);

/** Normalise a technique label: lowercase + trim; return it if it is in the taxonomy, otherwise 'other'; empty/non-string → null (unclassified). */
export function normalizeTechnique(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  return TECHNIQUE_SET.has(t) ? t : 'other';
}

// ── Reasoning action tool definitions (hand-crafted ToolDefinition, **NOT registered in the global registry**) ──────────────
// Not registered in the registry — otherwise the main-turn LLM could bypass the deep_explore
// orchestration and call these actions directly.

export const REASON_TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'reason_decompose',
    description:
      'Decompose a node in the reasoning tree into smaller subgoals/lemmas. Use when a claim is too big ' +
      'and you need to prove a few subclaims first. Returns the real ids of the new child nodes — later ' +
      'reason_record calls MUST use these returned ids.',
    parameters: JSON.stringify({
      type: 'object',
      properties: {
        parentNodeId: { type: 'string', description: 'Id of the parent node to decompose (from the current tree / a previous decompose result)' },
        subClaims: {
          type: 'array',
          description: 'List of child nodes',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string', description: 'Subclaim text' },
              kind: {
                type: 'string',
                enum: ['subgoal', 'lemma', 'construction', 'counterexample', 'conjecture'],
                description: 'subgoal=goal to prove / lemma=lemma / construction=construction / counterexample=counterexample attempt / conjecture=data-backed conjecture to prove (produced by experimental-math mode)',
              },
            },
            required: ['claim', 'kind'],
          },
        },
      },
      required: ['parentNodeId', 'subClaims'],
    }),
  },
  {
    name: 'reason_record',
    description:
      'Settle a node in the reasoning tree: proved / refuted (killed by a counterexample) / dead_end (this path is stuck, backtrack). ' +
      'For proved you MUST write the full argument in `result` — it is adversarially checked by several independent reviewers; ' +
      'a missing argument or a gap gets refuted, the proof is not recorded, and the node returns to open. ' +
      'For dead_end, always write in `approach` what method you tried (backtracking memory, so you don\'t re-hit it), then go back to the frontier and take another path.',
    parameters: JSON.stringify({
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Id of the node to settle (must really exist in the tree)' },
        status: { type: 'string', enum: ['proved', 'refuted', 'dead_end'] },
        result: { type: 'string', description: 'Conclusion / counterexample / why it is stuck (brief)' },
        approach: { type: 'string', description: 'For dead_end: the method you tried (backtracking memory)' },
      },
      required: ['nodeId', 'status'],
    }),
  },
];

const REASON_TOOL_NAMES: ReadonlySet<string> = new Set(REASON_TOOL_DEFS.map((d) => d.name));

/**
 * Whitelist of auxiliary tools allowed inside deep_explore — two categories:
 *   1. **Local memory / file recall** (searchNotes/getFact/readFile…): recall the agent's own
 *      earlier conclusions / computations.
 *   2. **Verification teeth**: z3Verify (SMT solver, can decide/bounded arithmetic, verify
 *      lemmas, find counterexamples) + pariGp (PARI/GP number-theory CAS, covers z3's blind
 *      spots: factoring / primality certificates / elliptic curves / counterexample search /
 *      concrete values).
 * **Deliberately excluded**: web browsing (webSearch/webFetch/fetchUrl) and directory browsing
 * (listDir/inspectPath) — in practice sub-LLMs use them to avoid real reasoning, degrading the
 * reasoning loop to browsing. Literature survey / broad research is the job of research_focus
 * (active research mode), not deep_explore.
 * z3Verify / pariGp both use capability=execute but go through registry.execute bypassing the
 * policy matrix, gated by this tool set; each tool is sandboxed internally (z3 only solves
 * SMT-LIB, does not eval; gp runs with -D secure=1 disabling system/extern to prevent shell
 * escape) → safe; and only available inside deep_explore (not in DEFAULT_TOOL_WHITELIST, so
 * background autonomous cannot reach them).
 */
export const DEEP_EXPLORE_RESEARCH_ALLOW: ReadonlySet<string> = new Set([
  'searchNotes',
  'searchSkills',
  'searchKB',
  'getFact',
  'listFacts',
  'readFile',
  'z3Verify',
  'pariGp',
]);

// ── Pure functions (independently testable) ─────────────────────────────────────────────────────

/** frontier = open nodes with no children (the active frontier yet to be attacked). */
export function computeFrontier(nodes: ReasoningNode[]): ReasoningNode[] {
  const hasChild = new Set<string>();
  for (const n of nodes) if (n.parentId) hasChild.add(n.parentId);
  return nodes.filter((n) => n.status === 'open' && !hasChild.has(n.id));
}

/** List of currently valid open node ids (echoed to the LLM when reason_record gets a wrong id, enabling self-correction). */
export function formatOpenIds(nodes: ReasoningNode[]): string {
  const ids = nodes.filter((n) => n.status === 'open').map((n) => n.id);
  return ids.length ? ids.join(', ') : '(no open nodes)';
}

/**
 * UCB1-style priority: value (exploit; unscored defaults to 0.5) + c·sqrt(ln(1+N)/(1+visits)) (explore).
 * N = total visits across the current frontier batch. Higher visits → smaller exploration term →
 * nodes stuck for many rounds automatically yield to others.
 */
export function computeUCB(value: number | null, visits: number, totalVisits: number, c: number): number {
  const v = value ?? 0.5;
  return v + c * Math.sqrt(Math.log(1 + totalVisits) / (1 + visits));
}

/**
 * novelty (②): the rarer the technique of a node, the higher its novelty score.
 * Unclassified (technique=null) → 0 (unknown, no bias).
 * Otherwise = 1/(1 + number of same-technique nodes already tried), where "tried" means
 * closed (proved/refuted/dead_end) or visits > 0.
 * New technique → 1; tried once → 0.5; heavily used mainstream technique → approaches 0.
 * Encourages off-beat / aggressive paths to not be crowded out by high-scoring mainstream ones.
 */
export function computeNovelty(node: ReasoningNode, allNodes: ReasoningNode[]): number {
  if (!node.technique) return 0;
  const triedSame = allNodes.filter(
    (n) =>
      n.id !== node.id &&
      n.technique === node.technique &&
      (n.status === 'proved' || n.status === 'refuted' || n.status === 'dead_end' || n.visits > 0),
  ).length;
  return 1 / (1 + triedSame);
}

/**
 * Rank the frontier: priority = UCB(value exploit + visits explore) + noveltyW·novelty.
 * Then applies **MAP-Elites-lite diversity archive**: bucket nodes by technique, sort within
 * each bucket by priority, then **interleave across buckets** in round-robin fashion —
 * the recommendation head covers diverse techniques rather than collapsing to one bucket
 * (rare-bucket champions surface near the top). Degrades to pure priority sort when there is
 * only one bucket / no technique tags. Does not mutate inputs. allNodes is used for novelty
 * (counts how many same-technique nodes have been tried historically).
 */
export function rankFrontier(
  frontier: ReasoningNode[],
  allNodes: ReasoningNode[],
  c: number,
  noveltyW: number,
): ReasoningNode[] {
  const totalVisits = frontier.reduce((s, n) => s + n.visits, 0);
  const scored = frontier.map((n, i) => ({
    n,
    i,
    score: computeUCB(n.value, n.visits, totalVisits, c) + noveltyW * computeNovelty(n, allNodes),
  }));
  // Bucket by technique (null technique goes into a '∅' bucket).
  const buckets = new Map<string, typeof scored>();
  for (const it of scored) {
    const key = it.n.technique ?? '∅';
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }
  // Sort within each bucket by priority descending (stable tiebreak by original index).
  for (const arr of buckets.values()) arr.sort((a, b) => b.score - a.score || a.i - b.i);
  // Bucket order = descending by each bucket's best score.
  const bucketList = [...buckets.values()].sort((a, b) => b[0].score - a[0].score || a[0].i - b[0].i);
  // Round-robin interleave across buckets: round r takes the r-th element from each bucket.
  const out: ReasoningNode[] = [];
  const maxLen = Math.max(...bucketList.map((b) => b.length));
  for (let r = 0; r < maxLen; r++) {
    for (const b of bucketList) if (b[r]) out.push(b[r].n);
  }
  return out;
}

const KIND_LABEL: Record<ReasoningNodeKind, string> = {
  subgoal: 'subgoal',
  lemma: 'lemma',
  construction: 'construction',
  counterexample: 'counterexample',
  conjecture: 'conjecture',
};

/** Render the current reasoning tree into the systemPrompt (a snapshot anchor at loop start; in-loop deltas flow via tool_result). */
export function renderTreePrompt(session: ReasoningSession, nodes: ReasoningNode[]): string {
  const lines: string[] = [];
  lines.push('You are a deep-exploreing engine advancing a reasoning tree to crack a root proposition. Record progress into the tree at every step.');
  lines.push('');
  lines.push('## Root proposition');
  lines.push(session.goal);
  if (session.assumptions.length) {
    lines.push('');
    lines.push('## Known assumptions');
    for (const a of session.assumptions) lines.push(`- ${a}`);
  }

  const rawFrontier = computeFrontier(nodes);
  const frontier = VALUE_GUIDED ? rankFrontier(rawFrontier, nodes, UCB_C, NOVELTY_W) : rawFrontier;
  const proved = nodes.filter((n) => n.status === 'proved');
  const deadEnds = nodes.filter((n) => n.status === 'dead_end');

  lines.push('');
  lines.push(`## Current frontier (open leaf nodes to attack, ${frontier.length} total)`);
  if (frontier.length === 0) {
    lines.push('(empty — no open leaf nodes to attack)');
  } else {
    if (VALUE_GUIDED && frontier.length >= 2) {
      lines.push(`(ranked by "value × tractability + exploration + technique novelty" and interleaved across technique buckets; **prefer attacking the top one [${frontier[0].id}]** unless you have a stronger reason. Off-beat techniques are deliberately kept near the top — don't only chase the mainstream path.)`);
    }
    for (const n of frontier.slice(0, 20)) {
      const ann = VALUE_GUIDED
        ? ` — value ${n.value === null ? '?' : n.value.toFixed(2)} / ${n.visits} rounds spent${n.technique ? ` / technique ${n.technique}` : ''}`
        : '';
      lines.push(`- [${n.id}] (${KIND_LABEL[n.kind]}) ${n.claim}${ann}`);
    }
  }

  if (proved.length) {
    lines.push('');
    lines.push(`## Proved (reusable as lemmas, ${proved.length} total)`);
    for (const n of proved.slice(0, 15)) {
      lines.push(`- [${n.id}] ${n.claim}${n.result ? ` → ${n.result}` : ''}`);
    }
  }

  if (deadEnds.length) {
    lines.push('');
    lines.push(`## Dead ends (don't re-hit these, ${deadEnds.length} total)`);
    for (const n of deadEnds.slice(0, 15)) {
      const tried = n.approachesTried.length ? `; tried: ${n.approachesTried.join(' / ')}` : '';
      lines.push(`- [${n.id}] ${n.claim}${tried}`);
    }
  }

  lines.push('');
  lines.push('## Your actions (tools)');
  lines.push('- reason_decompose(parentNodeId, subClaims[]): split a node into subgoals/lemmas; returns new child ids. **Primary action.**');
  lines.push('- reason_record(nodeId, status, result, approach?): settle a node as proved/refuted/dead_end. **Primary action.**');
  lines.push('- z3Verify(smtlib): **external check** — use the Z3 solver to rigorously verify a decidable/bounded/arithmetic subclaim or find a counterexample.');
  lines.push('- pariGp(script): **external computation** — use PARI/GP for number-theory/algebra computation and counterexample search (factoring, primality certificates, elliptic curves, enumeration, concrete values). Prefer it over z3 for number theory. Use print() to output your conclusion.');
  lines.push('- memory-recall tools (searchNotes/getFact/readFile, etc.): **auxiliary only** — to recall your own earlier conclusions/computations, not a substitute for reasoning.');
  lines.push('');
  lines.push('## How to reason (discipline)');
  lines.push('1. You are **doing a proof**, not gathering references. **Every round should advance the tree** — either reason_decompose an open node, or reason_record a verdict on one.');
  lines.push('2. From the frontier pick the most promising open node: think it through → if you can settle it, reason_record (proved/refuted); if it is too big, reason_decompose into subgoals/lemmas.');
  lines.push('3. **If a machine can verify/compute it, don\'t just assert it** — pick the right tool by subclaim type:');
  lines.push('   · **decidable/bounded/arithmetic** (linear or bounded-nonlinear int/real, bit-vectors, propositional logic) → z3Verify: to prove ∀x.P(x), encode ∃x.¬P(x) as SMT-LIB, unsat means P holds; sat means the model is a counterexample.');
  lines.push('   · **number-theory/algebra computation** (factoring, primality, modular arithmetic, elliptic curves, enumerating a range for counterexamples, concrete instances) → pariGp: e.g. print(factor(N)) to show N is composite, print(isprime(p)) for a certified primality test, for(...) to enumerate for counterexamples.');
  lines.push('   · After checking, take the result to reason_record (proved/refuted, with the tool\'s verdict/factorization/counterexample in `result`). **Don\'t expect z3/gp to settle a big conjecture itself** — they compute instances, find counterexamples, give strong evidence, but a general statement still needs human-style reasoning.');
  lines.push('4. Use recall tools only **once** when you need to recall a specific fact / a result you computed earlier, then return to decompose/record. **Do not run multiple rounds of only search/read without updating the tree.**');
  lines.push('5. When a path is stuck → reason_record(dead_end, approach=what you tried) to backtrack, then take another frontier path.');
  lines.push('6. **Only use real node ids from the tree / returned by decompose**; never invent ids.');
  lines.push('7. When truly stuck (no new ideas) → wrap up with a short text summary; the next turn can continue. **Do not pad rounds with repeated searches.**');
  return lines.join('\n');
}

/**
 * systemPrompt for experimental-math (explore) mode: instead of proving directly, **compute
 * first, then conjecture** — use pariGp to compute data in bulk → find patterns / invariants
 * in the data → propose evidence-backed conjectures → search for counterexamples with pariGp
 * → survivors are hung on the tree via reason_decompose as kind='conjecture' nodes (claim
 * includes the conjecture statement + experimental evidence); those killed by counterexamples
 * are recorded via reason_record(refuted).
 * Inspired by FunSearch / AlphaEvolve "generate-validate" loop: novelty comes from patterns
 * exposed by computation, not training memory; conjecture freely, rely on pariGp counterexample
 * search as a safety net.
 */
export function buildDiscoverPrompt(
  session: ReasoningSession,
  nodes: ReasoningNode[],
  seed: string,
): string {
  const lines: string[] = [];
  lines.push('You are an **experimental-mathematics engine**. The goal is not to prove directly, but to use computation to discover patterns and propose new, data-backed conjectures.');
  lines.push('');
  lines.push('## Exploration topic');
  lines.push(seed.trim() || session.goal);
  if (session.assumptions.length) {
    lines.push('');
    lines.push('## Known assumptions');
    for (const a of session.assumptions) lines.push(`- ${a}`);
  }
  const root = nodes.find((n) => n.parentId === null);
  if (root) {
    lines.push('');
    lines.push(`## Attach point`);
    lines.push(`Hang surviving new conjectures on the root node [${root.id}] via reason_decompose (parentNodeId=${root.id}).`);
  }
  const conjectures = nodes.filter((n) => n.kind === 'conjecture' && n.status === 'open');
  if (conjectures.length) {
    lines.push('');
    lines.push(`## Conjectures already on the tree (don't repeat; you may keep hunting counterexamples or strengthen them)`);
    for (const n of conjectures.slice(0, 15)) lines.push(`- [${n.id}] ${n.claim}`);
  }
  lines.push('');
  lines.push('## Method (experimental-math discipline)');
  lines.push('1. **Compute data first**: use pariGp to enumerate/tabulate the relevant quantities over a range (e.g. for(n=1,2000, print(n, " ", somefn(n)))), and observe patterns.');
  lines.push('2. **Find a pattern in the data**: invariants, divisibility, growth rate, anomalies, matches with known sequences — this is where new conjectures come from. **Do not recite a textbook theorem from memory.**');
  lines.push('3. **As soon as you form a conjecture, search for counterexamples with pariGp**: widen the enumeration, randomly sample large numbers, try special/boundary points.');
  lines.push('   · Found a counterexample → this one is dead; record it with reason_record(nodeId, refuted, result=counterexample) (if it is not yet on the tree, just skip it, don\'t hang it);');
  lines.push('   · No counterexample over a (preferably large) range → use reason_decompose to hang it as a **kind=\'conjecture\'** child under the root,');
  lines.push('     **writing the claim clearly: the conjecture statement + the experimental evidence (what range was tested, no counterexample)**, to be proved later.');
  lines.push('4. Prefer **strong, concrete, falsifiable** conjectures (expressible in a form pariGp can test); avoid vague, untestable ones. A few evidence-backed candidates per round is enough.');
  lines.push('5. Be bold: better to propose an aggressive conjecture that a counterexample can kill than to restate something obvious — the counterexample search is your safety net.');
  lines.push('6. Use pariGp/recall tools only for computation and recall; reason_decompose/record write to the tree. **Only use real node ids.**');
  lines.push('');
  lines.push('## Your actions (tools)');
  lines.push('- pariGp(script): **primary** — compute data, find patterns, search counterexamples. Output with print().');
  lines.push('- reason_decompose(parentNodeId, subClaims[]): hang a surviving conjecture (kind=\'conjecture\') on the tree.');
  lines.push('- reason_record(nodeId, status, result): mark a conjecture node refuted (counterexample found) / dead_end.');
  lines.push('- memory recall (searchNotes/getFact, etc.): recall results you computed/recorded earlier.');
  return lines.join('\n');
}

export interface ProgressSummary {
  newlyProved: string[];
  newlyRefuted: string[];
  newDeadEnds: string[];
  stillOpen: number;
  decomposedInto: number;
}

/** Diff DB state before and after the loop (does not rely on result.finalText, which is empty on hitCap/abort). */
export function summarizeProgress(
  before: ReasoningNode[],
  after: ReasoningNode[],
): ProgressSummary {
  const beforeById = new Map(before.map((n) => [n.id, n]));
  const newlyProved: string[] = [];
  const newlyRefuted: string[] = [];
  const newDeadEnds: string[] = [];
  for (const n of after) {
    const prev = beforeById.get(n.id);
    if (prev && prev.status === n.status) continue;
    if (n.status === 'proved') newlyProved.push(n.claim);
    else if (n.status === 'refuted') newlyRefuted.push(n.claim);
    else if (n.status === 'dead_end') newDeadEnds.push(n.claim);
  }
  return {
    newlyProved,
    newlyRefuted,
    newDeadEnds,
    stillOpen: after.filter((n) => n.status === 'open').length,
    decomposedInto: after.length - before.length,
  };
}

/** Post-loop convergence judgment: root proved→solved; empty frontier but root unproved→stuck; otherwise remain active. */
export function judgeConvergence(
  nodes: ReasoningNode[],
): ReasoningSessionStatus {
  const root = nodes.find((n) => n.parentId === null);
  if (root && root.status === 'proved') return 'solved';
  if (computeFrontier(nodes).length === 0) return 'stuck';
  return 'active';
}

function renderProgressText(s: ProgressSummary, hitCap: boolean, status: ReasoningSessionStatus): string {
  const parts: string[] = [];
  if (s.decomposedInto > 0) parts.push(`+${s.decomposedInto} child nodes`);
  if (s.newlyProved.length) parts.push(`proved ${s.newlyProved.length}: ${s.newlyProved.slice(0, 3).join(' / ')}`);
  if (s.newlyRefuted.length) parts.push(`refuted ${s.newlyRefuted.length}`);
  if (s.newDeadEnds.length) parts.push(`+${s.newDeadEnds.length} dead ends`);
  parts.push(`${s.stillOpen} still open`);
  if (hitCap) parts.push('(hit this round\'s iteration cap; you can continue)');
  const head =
    status === 'solved'
      ? '✓ Root proposition proved; reasoning session solved.'
      : status === 'stuck'
        ? '⚠ Frontier is empty but the root is unproved; session stuck (add ideas and continue).'
        : 'Reasoning advanced; session still active.';
  return `${head}\nThis round: ${parts.join('; ')}`;
}

/**
 * Build a human-facing wrap-up report from the current tree, regardless of whether the root is
 * proved. Deterministic (no LLM call → no timeout risk): lists established lemmas, refuted/
 * dead-end branches, and the most promising open directions. This is the "finalize / 收尾" a
 * user asks for on an open-ended problem (e.g. Goldbach) that never converges to solved/stuck on
 * its own — without it, every round only says "session still active" and the run ends with no
 * conclusion. Session is left active so the user can still continue afterwards.
 */
function renderFinalReport(session: ReasoningSession, nodes: ReasoningNode[]): string {
  const oneLine = (s: string, max: number): string => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  };
  const status = judgeConvergence(nodes);
  const proved = nodes.filter((n) => n.status === 'proved');
  const refuted = nodes.filter((n) => n.status === 'refuted');
  const dead = nodes.filter((n) => n.status === 'dead_end');
  const frontier = computeFrontier(nodes);
  // Rank open directions by value (unscored → 0.5), then prefer shallower (closer to the root).
  const topOpen = [...frontier]
    .sort((a, b) => (b.value ?? 0.5) - (a.value ?? 0.5) || a.depth - b.depth)
    .slice(0, 8);

  const head = status === 'solved' ? '✓ SOLVED' : status === 'stuck' ? '⚠ STUCK' : '◐ IN PROGRESS';
  const lines: string[] = [];
  lines.push(`# Deep-explore report — ${head}`);
  lines.push(`Goal: ${session.goal}`);
  lines.push(
    `Tree: ${nodes.length} nodes — proved ${proved.length} / open ${frontier.length} / ` +
      `refuted ${refuted.length} / dead ends ${dead.length}. ` +
      `Budget spent: ${session.budgetSpent}/${SESSION_TOKEN_BUDGET} tokens.`,
  );

  if (proved.length) {
    lines.push('\n## ✓ Established (proved lemmas / sub-results)');
    for (const n of proved) lines.push(`- ${oneLine(n.claim, 200)}${n.result ? ` — ${oneLine(n.result, 240)}` : ''}`);
  }
  if (refuted.length || dead.length) {
    lines.push('\n## ✗ Refuted / dead ends');
    for (const n of [...refuted, ...dead]) {
      const why = n.result || n.approachesTried[n.approachesTried.length - 1] || '';
      lines.push(`- ${oneLine(n.claim, 160)}${why ? ` — ${oneLine(why, 180)}` : ''}`);
    }
  }
  if (topOpen.length) {
    lines.push('\n## ◯ Most promising open directions');
    for (const n of topOpen) {
      const tag = n.technique ? ` [${n.technique}]` : '';
      const v = n.value != null ? ` (value ${n.value.toFixed(2)})` : '';
      lines.push(`- ${oneLine(n.claim, 200)}${tag}${v}`);
    }
  }
  lines.push(
    status === 'solved'
      ? '\nRoot proposition proved — session complete.'
      : '\nReply "continue" to keep advancing the open directions above.',
  );
  lines.push(`session id: ${session.id}`);
  return lines.join('\n');
}

// ── Adversarial verification (adversarial self-consistency) ─────────────────────────────────────
// Before reason_record(proved) is committed, dispatch N independent skeptic sub-LLMs to
// specifically "try to refute" the claim:
// majority (including ties) refuting → do not accept proved, leave the node open, and write
// the strongest objection into approaches_tried (backtracking memory), so the main reasoning
// loop strengthens the argument or switches to a different frontier path on the next round.
// Inspired by Self-Consistency (Wang et al. 2022, arXiv:2203.11171) and the "adversarial
// verification" pattern already used in this repo's deep-research / Workflow:
// independent perspectives prevent "LLM verbal assertion = proved".
// Skeptics are read-only (researchDefs: memory recall + z3Verify), **not given reason_***,
// and do not modify the reasoning tree.

export interface SkepticVerdict {
  refuted: boolean;
  /** Core objection when refuting (empty string when the verdict is HOLDS) */
  reason: string;
}

export interface VerificationTally {
  /** Whether the proved claim is accepted (true = passed verification, may be committed to DB) */
  confirmed: boolean;
  refutedCount: number;
  /** Number of reviewers who gave a parseable verdict (abstentions / parse failures are not counted) */
  validVotes: number;
  topObjection: string | null;
  /** Cumulative LLM tokens spent on this verification run (counted against the session budget to prevent silent token burn) */
  tokensSpent: number;
}

/** Skeptic count: 0 disables adversarial verification (reverts to old behaviour). env PHILONT_DEEP_EXPLORE_SKEPTICS, default 3, range 0-7. */
function resolveSkepticCount(): number {
  const raw = process.env.PHILONT_DEEP_EXPLORE_SKEPTICS;
  if (raw === undefined) return 3;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 7) return n;
  console.warn(`[config] PHILONT_DEEP_EXPLORE_SKEPTICS="${raw}" out of range (0-7), using default 3`);
  return 3;
}
const SKEPTIC_COUNT = resolveSkepticCount();

/** Per-skeptic mini-loop iteration cap (leaves room for a few z3 verification calls). env PHILONT_DEEP_EXPLORE_SKEPTIC_ITERS, default 6, range 1-20. */
const SKEPTIC_MAX_ITERS = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_SKEPTIC_ITERS);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 6;
})();

/** Build the skeptic's systemPrompt: the claim under review + the argument + context; discipline = try hard to refute, when in doubt refute. */
export function buildSkepticSystemPrompt(
  claim: string,
  argument: string | null,
  goal: string,
  assumptions: string[],
  provedClaims: string[],
): string {
  const lines: string[] = [];
  lines.push('You are a strict mathematical reviewer (skeptic). Someone claims the proposition below has been proved.');
  lines.push('Your only task: **try hard to find a flaw, a gap, a hidden unproven assumption, or a counterexample** in this proof — do not just agree.');
  lines.push('');
  lines.push(`## Claim under review\n${claim}`);
  lines.push('');
  lines.push(`## The argument given\n${argument && argument.trim() ? argument : '(no argument was given, only a bare claim of "proved" — which is itself highly suspicious)'}`);
  lines.push('');
  lines.push(`## Context: root proposition\n${goal}`);
  if (assumptions.length) lines.push(`\n## Available assumptions\n${assumptions.map((a) => `- ${a}`).join('\n')}`);
  if (provedClaims.length) {
    lines.push(`\n## Already proved in this session, reusable as lemmas\n${provedClaims.slice(0, 15).map((c) => `- ${c}`).join('\n')}`);
  }
  lines.push('');
  lines.push('## Review discipline');
  lines.push('- You may call z3Verify to rigorously refute a decidable/bounded/arithmetic subclaim (encode as SMT-LIB; a sat model is a counterexample → refuted); you may also use recall tools for known facts.');
  lines.push('- If the argument has any unproven leap, circular reasoning (assuming what is to be proved), or a counterexample → verdict REFUTED.');
  lines.push('- **If you are unsure, or cannot verify its rigor yourself → verdict REFUTED** (the bar for a proof is certainty; any doubt fails).');
  lines.push('- Only when you are confident every step is rigorous and gap-free → verdict HOLDS.');
  lines.push('');
  lines.push('## Output format');
  lines.push('First briefly state your reasons (if refuting, point out the specific flaw/counterexample/missing step), then on a **single final line** output one of:');
  lines.push('VERDICT: REFUTED');
  lines.push('VERDICT: HOLDS');
  return lines.join('\n');
}

/** Parse a skeptic's closing text into a verdict. The canonical verdict line takes priority (searched from the end); returns null (abstain, not counted) if unparseable. */
export function parseSkepticVerdict(text: string): SkepticVerdict | null {
  if (!text || !text.trim()) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const isVerdictLine = (l: string) => /判定|裁定|结论|verdict/i.test(l);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!isVerdictLine(l)) continue;
    if (/证伪|推翻|refut|reject/i.test(l)) return { refuted: true, reason: extractObjection(text) };
    if (/维持|通过|成立|hold|uphold|accept/i.test(l)) return { refuted: false, reason: '' };
  }
  return null;
}

/** Extract the objection body: strip verdict lines, collapse whitespace, truncate to 300 chars. */
function extractObjection(text: string): string {
  const body = text
    .split('\n')
    .filter((l) => !/^\s*(判定|裁定|结论|verdict)[\s:：]/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length > 300 ? body.slice(0, 300) + '…' : body;
}

/**
 * Tally verdicts (pure function, no tokens). Ties count as "refuted" (proof threshold is
 * certainty; any doubt fails); all abstentions (validVotes=0) → no one could refute it →
 * accept (avoid degrading everything on infrastructure failures).
 */
export function tallyVerdicts(verdicts: Array<SkepticVerdict | null>): VerificationTally {
  const valid = verdicts.filter((v): v is SkepticVerdict => v !== null);
  const refuted = valid.filter((v) => v.refuted);
  const validVotes = valid.length;
  const refutedCount = refuted.length;
  const confirmed = validVotes === 0 ? true : refutedCount * 2 < validVotes;
  return {
    confirmed,
    refutedCount,
    validVotes,
    topObjection: refuted[0]?.reason ?? null,
    tokensSpent: 0,
  };
}

/** Run `count` independent skeptics concurrently, parse each verdict, and tally. count<=0 immediately accepts (verification disabled). */
export async function runAdversarialVerification(opts: {
  llm: MiniLoopLLMClient;
  systemPrompt: string;
  count: number;
  toolDefs: ToolDefinition[];
  toolRunner: (name: string, input: Record<string, unknown>) => Promise<MiniLoopToolRunResult>;
  whitelist: ReadonlySet<string>;
  maxIters?: number;
  onStatus?: (text: string) => void;
  abortSignal?: AbortSignal;
}): Promise<VerificationTally> {
  if (opts.count <= 0) return { confirmed: true, refutedCount: 0, validVotes: 0, topObjection: null, tokensSpent: 0 };
  const runs = Array.from({ length: opts.count }, (_, i) =>
    runMiniAgentLoop({
      systemPrompt: opts.systemPrompt,
      // Slightly differentiate userMessage per reviewer index to maintain perspective diversity
      // (prevent N skeptics from being completely identical in prompt).
      userMessage: `You are independent reviewer #${i + 1}. Review the proof of the proposition above independently and try hard to refute it; give your reasons, then output the verdict in the required format.`,
      llm: opts.llm,
      toolDefs: opts.toolDefs,
      toolRunner: opts.toolRunner,
      maxIters: opts.maxIters ?? SKEPTIC_MAX_ITERS,
      toolWhitelist: opts.whitelist,
      onStatus: opts.onStatus,
      abortSignal: opts.abortSignal,
    }).then(
      (r) => ({ verdict: parseSkepticVerdict(r.finalText), tokens: r.llmTokensSpent }),
      () => ({ verdict: null, tokens: 0 }), // single skeptic error = abstain, does not drag down the whole run
    ),
  );
  const settled = await Promise.all(runs);
  const tally = tallyVerdicts(settled.map((s) => s.verdict));
  tally.tokensSpent = settled.reduce((sum, s) => sum + s.tokens, 0);
  return tally;
}

// ── value-guided node selection: frontier scoring (LATS/rStar inspired) ─────────────────────────
// An independent aux-LLM (can be the same model as the main LLM, but with a dedicated
// "evaluator" prompt + structured output) scores each open frontier leaf with a 0-1 value,
// used as the UCB value (exploit) term. Inspired by LATS (Zhou et al. 2023, arXiv:2310.04406)
// and rStar-Math / ReST-MCTS* "LLM value function + tree search": replaces "the same LLM
// picking frontier by feeling" with an independent value signal + exploration term.
// Scores are persisted to nodes and visible across turns.

/** Build the scorer's prompt: ask the LLM to score each frontier subgoal on "importance × tractability" and output only a JSON array. */
export function buildScorerPrompt(
  goal: string,
  assumptions: string[],
  frontier: ReasoningNode[],
): string {
  const lines: string[] = [];
  lines.push('You are the "value estimator" for a reasoning-tree search. Below are the open subgoals on the tree while cracking a root proposition.');
  lines.push('Give each subgoal a score in 0~1 measuring the payoff of "attacking it right now":');
  lines.push('  score ≈ importance to the root proposition (how much proving it advances the root) × current tractability (is there a ready idea/tool to make progress now).');
  lines.push('High = both pivotal and currently workable; low = either irrelevant to the root, or no foothold right now.');
  lines.push('');
  lines.push(`## Root proposition\n${goal}`);
  if (assumptions.length) lines.push(`## Known assumptions\n${assumptions.map((a) => `- ${a}`).join('\n')}`);
  lines.push('');
  lines.push('## Subgoals to score');
  for (const n of frontier) lines.push(`- [${n.id}] (${KIND_LABEL[n.kind]}) ${n.claim}`);
  lines.push('');
  lines.push('## Also tag each subgoal with a "technique" (the main method most likely to attack it), choosing one of:');
  lines.push(`  ${TECHNIQUE_TAXONOMY.join(' / ')}`);
  lines.push('  (induction / contradiction / construction / algebraic = algebraic & number-theoretic manipulation /');
  lines.push('   analytic = analysis & inequality estimates / probabilistic = probabilistic method / combinatorial = counting /');
  lines.push('   computational = compute & enumerate to verify / other)');
  lines.push('');
  lines.push('## Output (strict)');
  lines.push('Output only a JSON array, each item shaped like {"id":"<a node id above>","value":<decimal 0..1>,"technique":"<one of the above>"}. No extra text, no explanation.');
  return lines.join('\n');
}

/** Parse scorer output: prefer a JSON array; fall back to per-line "id ... 0.x" parsing. Only keep ids in validIds; clamp values to [0,1]. */
export function parseScores(text: string, validIds: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  if (!text || !text.trim()) return out;
  const m = text.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]) as unknown;
      if (Array.isArray(arr)) {
        for (const it of arr) {
          const rec = it as Record<string, unknown>;
          const id = typeof rec?.id === 'string' ? rec.id : '';
          const val = Number(rec?.value);
          if (id && validIds.has(id) && Number.isFinite(val)) {
            out.set(id, Math.max(0, Math.min(1, val)));
          }
        }
        if (out.size) return out;
      }
    } catch {
      /* JSON parse failed → fall through to line-by-line fallback */
    }
  }
  for (const line of text.split('\n')) {
    const lm = line.match(/([0-9a-fA-F-]{8,})\D+(0?\.\d+|[01](?:\.\d+)?)/);
    if (lm && validIds.has(lm[1])) out.set(lm[1], Math.max(0, Math.min(1, Number(lm[2]))));
  }
  return out;
}

export interface NodeAssessment {
  value: number;
  technique: string | null;
}

/**
 * Parse scorer output into {value, technique} (②). Only reads {id,value,technique} from a
 * JSON array; missing technique is tolerated (normalised to null). Only keeps ids in validIds;
 * value clamped to [0,1]; technique normalised to taxonomy.
 * Falls back to parseScores (value-only line parsing, technique=null) if JSON parsing fails.
 */
export function parseAssessments(
  text: string,
  validIds: ReadonlySet<string>,
): Map<string, NodeAssessment> {
  const out = new Map<string, NodeAssessment>();
  if (!text || !text.trim()) return out;
  const m = text.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]) as unknown;
      if (Array.isArray(arr)) {
        for (const it of arr) {
          const rec = it as Record<string, unknown>;
          const id = typeof rec?.id === 'string' ? rec.id : '';
          const val = Number(rec?.value);
          if (id && validIds.has(id) && Number.isFinite(val)) {
            out.set(id, { value: Math.max(0, Math.min(1, val)), technique: normalizeTechnique(rec.technique) });
          }
        }
        if (out.size) return out;
      }
    } catch {
      /* Fall through to parseScores fallback */
    }
  }
  for (const [id, value] of parseScores(text, validIds)) out.set(id, { value, technique: null });
  return out;
}

/** Run one scorer pass (single LLM call, no tools). Failure / abort / empty → return empty Map (gracefully degrades to unscored). */
export async function scoreFrontierValues(opts: {
  llm: MiniLoopLLMClient;
  goal: string;
  assumptions: string[];
  frontier: ReasoningNode[];
  abortSignal?: AbortSignal;
}): Promise<{ assessments: Map<string, NodeAssessment>; tokensSpent: number }> {
  if (opts.frontier.length === 0 || opts.abortSignal?.aborted) {
    return { assessments: new Map(), tokensSpent: 0 };
  }
  const sys = buildScorerPrompt(opts.goal, opts.assumptions, opts.frontier);
  const validIds = new Set(opts.frontier.map((n) => n.id));
  try {
    const resp = await opts.llm.send(
      sys,
      [{ role: 'user', content: 'Score the subgoals above and tag each technique; output only the JSON array.' }],
      [],
    );
    const text = resp.type === 'text' ? resp.content : '';
    return { assessments: parseAssessments(text, validIds), tokensSpent: resp.tokensUsed ?? 0 };
  } catch {
    return { assessments: new Map(), tokensSpent: 0 };
  }
}

// ── sessionId-bound toolRunner ───────────────────────────────────────────────

/**
 * Build a sessionId-bound toolRunner: reason_* routes to ReasoningStore (using the sessionId
 * from the closure, not passed by the sub-LLM); everything else (read-only research tools)
 * delegates to `delegate` (subTurnToolRunner).
 *
 * verifyProved (optional): adversarial verification hook called before reason_record(proved)
 * is committed. When provided, proved claims must pass the refutation review; on failure the
 * node stays open and the strongest objection is written into approaches_tried. When omitted,
 * reverts to old behaviour (proved is committed directly).
 */
export function makeReasoningToolRunner(
  reasoning: ReasoningStore,
  sessionId: string,
  delegate: (name: string, input: Record<string, unknown>) => Promise<MiniLoopToolRunResult>,
  verifyProved?: (node: ReasoningNode, argument: string | null) => Promise<VerificationTally | null>,
): (name: string, input: Record<string, unknown>) => Promise<MiniLoopToolRunResult> {
  return async (name, input) => {
    if (name === 'reason_decompose') {
      const parentNodeId = typeof input.parentNodeId === 'string' ? input.parentNodeId : '';
      const rawSub = Array.isArray(input.subClaims) ? input.subClaims : [];
      const subClaims = rawSub
        .map((c) => c as Record<string, unknown>)
        .filter((c) => typeof c?.claim === 'string' && (c.claim as string).trim())
        .map((c) => ({
          claim: c.claim as string,
          kind: (VALID_KINDS.has(c.kind as string) ? c.kind : 'subgoal') as ReasoningNodeKind,
        }));
      if (!parentNodeId || subClaims.length === 0) {
        const nodes = reasoning.getNodes(sessionId);
        return {
          ok: false,
          output: '',
          error: `Need parentNodeId + a non-empty subClaims. Current open nodes: [${formatOpenIds(nodes)}]`,
        };
      }
      try {
        const created = reasoning.addNodes(sessionId, parentNodeId, subClaims);
        // Critical: echo newly created node ids; without this the sub-LLM has no ids to
        // reference in subsequent reason_record calls (systemPrompt is not re-rendered in-loop).
        const listed = created.map((n) => `[${n.id}] ${n.claim}`).join(' ; ');
        return { ok: true, output: `Expanded ${created.length} child node(s) under ${parentNodeId}: ${listed}` };
      } catch (e) {
        if (e instanceof ReasoningNodeNotFoundError) {
          const nodes = reasoning.getNodes(sessionId);
          return {
            ok: false,
            output: '',
            error: `Parent node ${parentNodeId} does not exist. Current open nodes: [${formatOpenIds(nodes)}]; use a real id.`,
          };
        }
        return { ok: false, output: '', error: String(e) };
      }
    }

    if (name === 'reason_record') {
      const nodeId = typeof input.nodeId === 'string' ? input.nodeId : '';
      const status = input.status as string;
      const result = typeof input.result === 'string' ? input.result : null;
      const approach = typeof input.approach === 'string' ? input.approach : undefined;
      if (!RECORD_STATUSES.has(status)) {
        return { ok: false, output: '', error: `status must be proved/refuted/dead_end, got ${String(status)}` };
      }

      // proved + adversarial verification enabled → run refutation review before committing to DB.
      if (status === 'proved' && verifyProved) {
        const target = reasoning.getNode(sessionId, nodeId);
        if (!target) {
          const nodes = reasoning.getNodes(sessionId);
          return {
            ok: false,
            output: '',
            error: `Node ${nodeId} does not exist in this session. Current open nodes: [${formatOpenIds(nodes)}]; retry with a real id.`,
          };
        }
        const tally = await verifyProved(target, result);
        if (tally && !tally.confirmed) {
          const objection = tally.topObjection ? `: ${tally.topObjection}` : '';
          // Do not accept proved: keep the node as-is (open) and write the strongest objection into
          // backtracking memory (appendApproach is decoupled from status).
          reasoning.updateNode(sessionId, nodeId, {
            appendApproach: `proof refuted by ${tally.refutedCount}/${tally.validVotes} reviewers${objection}`,
          });
          return {
            ok: true,
            output:
              `Node [${nodeId}]'s "proved" did not pass adversarial verification (${tally.refutedCount}/${tally.validVotes} reviewers refuted it); not recorded, node stays open. ` +
              `The objection has been saved to backtracking memory. Fix the flaw and re-prove, or take another frontier path.` +
              (tally.topObjection ? `\nMain objection: ${tally.topObjection}` : ''),
          };
        }
        // Passed (or all abstained): record proved as usual, with a verification mark.
        reasoning.updateNode(sessionId, nodeId, { status: 'proved', result });
        const vmark =
          tally && tally.validVotes > 0 ? ` (passed adversarial verification by ${tally.validVotes} reviewers)` : '';
        return { ok: true, output: `Recorded [${nodeId}] = proved${result ? `: ${result}` : ''}${vmark}` };
      }

      const updated = reasoning.updateNode(sessionId, nodeId, {
        status: status as ReasoningNode['status'],
        result,
        appendApproach: status === 'dead_end' ? approach ?? '(method not stated)' : undefined,
      });
      if (!updated) {
        const nodes = reasoning.getNodes(sessionId);
        // nodeId hallucination guard: echo the valid open ids so the LLM can self-correct.
        return {
          ok: false,
          output: '',
          error: `Node ${nodeId} does not exist in this session. Current open nodes: [${formatOpenIds(nodes)}]; retry with a real id.`,
        };
      }
      return { ok: true, output: `Recorded [${nodeId}] = ${status}${result ? `: ${result}` : ''}` };
    }

    // Delegate everything else (read-only research tools + verify teeth z3Verify/pariGp).
    const result = await delegate(name, input);
    // Surface verify-tool failures to the operator log — otherwise a broken pariGp (gp missing,
    // spawn error, timeout, bad script) is silent except for a "⚠ pariGp" status ping, and the
    // computational verification quietly never works. The full error stays in the sub-LLM's tool_result.
    if (!result.ok && (name === 'pariGp' || name === 'z3Verify')) {
      console.warn(`[deep-explore] ${name} failed: ${(result.error ?? '(no error message)').slice(0, 400)}`);
    }
    return result;
  };
}

// ── deep_explore composite tool ───────────────────────────────────────────────

export interface DeepExploreDeps {
  reasoning: ReasoningStore;
  /** Main LLM adapter wrapped as a mini-loop client (reuses chat-handler's miniLoopLLM) */
  miniLoopLLM: MiniLoopLLMClient;
  /** Executor for read-only research tools (reuses chat-handler's subTurnToolRunner) */
  subTurnToolRunner: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<MiniLoopToolRunResult>;
  /** Read-only tool def subset (filtered from tools.list by the read-only whitelist; passed in by chat-handler) */
  readOnlyToolDefs: ToolDefinition[];
  maxIters?: number;
  onStatus?: (text: string) => void;
  /** Per-round progress summary sink. Unlike onStatus (per-iteration pings, console-only), this
   *  carries the round's milestone summary (nodes expanded / lemmas proved) to the user-facing
   *  status stream so multi-minute rounds are not silent. */
  onMilestone?: (text: string) => void;
}

export function createDeepExploreTool(deps: DeepExploreDeps): Tool {
  const { reasoning, miniLoopLLM, subTurnToolRunner, readOnlyToolDefs } = deps;
  const maxIters = deps.maxIters ?? DEFAULT_MAX_ITERS;
  // Tighten: deep_explore is a **reasoning** loop, not a browsing loop. Research tools are
  // restricted to local-only "recall your own earlier conclusions / computations" lookups;
  // **web browsing (webSearch/webFetch/fetchUrl) and directory browsing (listDir/inspectPath)
  // are excluded** — in practice sub-LLMs use them to avoid real reasoning.
  const researchDefs = readOnlyToolDefs.filter((d) => DEEP_EXPLORE_RESEARCH_ALLOW.has(d.name));
  const toolDefs: ToolDefinition[] = [...REASON_TOOL_DEFS, ...researchDefs];
  // Independent whitelist: reason_* must be explicitly included, otherwise the mini-loop's
  // gateToolCall intercepts them.
  const whitelist: ReadonlySet<string> = new Set([
    ...REASON_TOOL_NAMES,
    ...researchDefs.map((d) => d.name),
  ]);

  // Adversarial verification hook factory: before reason_record(proved) is committed, dispatch
  // skeptic sub-LLMs (read-only researchDefs, do not touch the tree) to attempt refutation.
  // Verification tokens are counted against the session budget. SKEPTIC_COUNT=0 disables this,
  // reverting to old behaviour. Shared by both prove and explore round types.
  function buildVerifyProved(session: ReasoningSession, abortSignal: AbortSignal) {
    if (SKEPTIC_COUNT <= 0) return undefined;
    return async (node: ReasoningNode, argument: string | null): Promise<VerificationTally> => {
      const all = reasoning.getNodes(session.id);
      const provedClaims = all
        .filter((n) => n.status === 'proved' && n.id !== node.id)
        .map((n) => n.claim);
      const sys = buildSkepticSystemPrompt(node.claim, argument, session.goal, session.assumptions, provedClaims);
      const tally = await runAdversarialVerification({
        llm: miniLoopLLM,
        systemPrompt: sys,
        count: SKEPTIC_COUNT,
        toolDefs: researchDefs, // read-only research + z3/gp, no reason_*
        toolRunner: subTurnToolRunner, // delegate directly; skeptics do not modify the tree
        whitelist: new Set(researchDefs.map((d) => d.name)),
        maxIters: SKEPTIC_MAX_ITERS,
        onStatus: deps.onStatus,
        abortSignal,
      });
      reasoning.addBudgetSpent(session.id, tally.tokensSpent);
      return tally;
    };
  }

  async function runRound(session: ReasoningSession): Promise<ToolResult> {
    if (session.budgetSpent >= SESSION_TOKEN_BUDGET) {
      return {
        success: true,
        output: `This reasoning session has used ${session.budgetSpent} tokens, hitting the budget cap (${SESSION_TOKEN_BUDGET}); paused. Continue later with a fresh angle, or treat it as stuck.`,
      };
    }
    // Value-guided node selection (LATS / rStar style): an independent aux-LLM scores
    // frontier nodes on "value × tractability", persisted to nodes; at render time nodes are
    // ranked by UCB (value exploit + visits exploration) with the top one recommended.
    // VALUE_GUIDED=0 disables (reverts to depth/creation order + "LLM picks for itself").
    // frontier < 2 is not worth scoring. Single lightweight call, runs before the wall-clock
    // timer (the timer only covers the heavier mini-loop); failure gracefully degrades to unscored.
    const before0 = reasoning.getNodes(session.id);
    if (VALUE_GUIDED) {
      const frontier0 = computeFrontier(before0);
      if (frontier0.length >= 2) {
        const { assessments, tokensSpent } = await scoreFrontierValues({
          llm: miniLoopLLM,
          goal: session.goal,
          assumptions: session.assumptions,
          frontier: frontier0,
        });
        if (assessments.size) {
          reasoning.setNodeValues(
            session.id,
            [...assessments].map(([id, a]) => ({ id, value: a.value, technique: a.technique })),
          );
        }
        if (tokensSpent) reasoning.addBudgetSpent(session.id, tokensSpent);
      }
    }

    // Re-fetch (includes just-written values) as the snapshot for this round's render;
    // record the starting frontier ids for UCB visit accounting.
    const before = reasoning.getNodes(session.id);
    const frontierStartIds = new Set(computeFrontier(before).map((n) => n.id));
    const systemPrompt = renderTreePrompt(session, before);
    const userMessage =
      before.length <= 1
        ? session.goal
        : 'Continue advancing the current reasoning tree; prefer the most promising open node on the frontier.';

    // Wall-clock budget: abort at deadline; mini-loop stops gracefully (avoids hitting the
    // 20-min turn hard deadline and leaving orphaned loops).
    const ctrl = new AbortController();
    let timedOut = false;
    const deadlineTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ROUND_DEADLINE_MS);
    // Proactive heads-up partway through the round so a long round does not end "silently":
    // tell the user it is approaching the per-round time cap and will wrap up & save soon.
    const warnAtMs = Math.round(ROUND_DEADLINE_MS * 0.75);
    const warnTimer = setTimeout(() => {
      deps.onMilestone?.(
        `⏳ This round is approaching the ${Math.round(ROUND_DEADLINE_MS / 60_000)}-minute time cap; ` +
        `it will pause and save the tree shortly — reply "continue" to keep going.`,
      );
    }, warnAtMs);

    const boundRunner = makeReasoningToolRunner(
      reasoning,
      session.id,
      subTurnToolRunner,
      buildVerifyProved(session, ctrl.signal),
    );
    let result;
    try {
      result = await runMiniAgentLoop({
        systemPrompt,
        userMessage,
        llm: miniLoopLLM,
        toolDefs,
        toolRunner: boundRunner,
        maxIters,
        toolWhitelist: whitelist,
        onStatus: deps.onStatus,
        abortSignal: ctrl.signal,
      });
    } finally {
      clearTimeout(deadlineTimer);
      clearTimeout(warnTimer);
    }

    // Accumulate cross-turn budget (mini-loop only gives the total on return; batch-commit).
    reasoning.addBudgetSpent(session.id, result.llmTokensSpent);

    const after = reasoning.getNodes(session.id);
    // UCB visit accounting: increment visits for nodes that were in the starting frontier
    // but were not closed/decomposed this round (they were worked on but not resolved →
    // exploration term decays next round, yielding to other paths; nodes that were closed or
    // decomposed are no longer on the frontier and are not counted).
    if (VALUE_GUIDED) {
      const stillOpen = computeFrontier(after)
        .filter((n) => frontierStartIds.has(n.id))
        .map((n) => n.id);
      reasoning.incrementVisits(session.id, stillOpen);
    }
    const summary = summarizeProgress(before, after);
    // Post-loop convergence judgment (sub-LLM is not given reason_close).
    const status = judgeConvergence(after);
    if (status !== 'active') reasoning.setSessionStatus(session.id, status);

    const text = renderProgressText(summary, result.hitCap, status);
    deps.onMilestone?.(text);
    const tail =
      result.error === 'aborted'
        ? timedOut
          ? `\n(this round hit the ${Math.round(ROUND_DEADLINE_MS / 60_000)}-minute time cap; tree saved — reply "continue" to keep going)`
          : '\n(this round was aborted; tree saved, you can continue)'
        : '';
    return { success: true, output: `${text}${tail}\nsession id: ${session.id}` };
  }

  // Experimental-math (explore) round: compute first, then conjecture. Reuses the same
  // mini-loop / tools / verification hooks; only swaps prompt + closing stats.
  // No value-guided node selection (explore is generative, not selecting from a frontier);
  // no stuck judgment (discovery mode — "getting stuck" is not applicable).
  async function runDiscoverRound(session: ReasoningSession, seed: string): Promise<ToolResult> {
    if (session.budgetSpent >= SESSION_TOKEN_BUDGET) {
      return {
        success: true,
        output: `This session has used ${session.budgetSpent} tokens, hitting the budget cap (${SESSION_TOKEN_BUDGET}); paused.`,
      };
    }
    const before = reasoning.getNodes(session.id);
    const beforeConjectures = before.filter((n) => n.kind === 'conjecture').length;
    const systemPrompt = buildDiscoverPrompt(session, before, seed);
    const userMessage =
      `Do experimental-math exploration around "${seed.trim() || session.goal}": first use pariGp to compute data and find patterns, ` +
      `then hang conjectures that have pariGp evidence (counterexamples already searched) on the tree via reason_decompose (kind='conjecture'); record any killed by a counterexample as refuted.`;

    const ctrl = new AbortController();
    let timedOut = false;
    const deadlineTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ROUND_DEADLINE_MS);
    const warnTimer = setTimeout(() => {
      deps.onMilestone?.(
        `⏳ This round is approaching the ${Math.round(ROUND_DEADLINE_MS / 60_000)}-minute time cap; ` +
        `it will pause and save the tree shortly — reply "continue" to keep going.`,
      );
    }, Math.round(ROUND_DEADLINE_MS * 0.75));
    const boundRunner = makeReasoningToolRunner(
      reasoning,
      session.id,
      subTurnToolRunner,
      buildVerifyProved(session, ctrl.signal),
    );
    let result;
    try {
      result = await runMiniAgentLoop({
        systemPrompt,
        userMessage,
        llm: miniLoopLLM,
        toolDefs,
        toolRunner: boundRunner,
        maxIters,
        toolWhitelist: whitelist,
        onStatus: deps.onStatus,
        abortSignal: ctrl.signal,
      });
    } finally {
      clearTimeout(deadlineTimer);
      clearTimeout(warnTimer);
    }
    reasoning.addBudgetSpent(session.id, result.llmTokensSpent);

    const after = reasoning.getNodes(session.id);
    const summary = summarizeProgress(before, after);
    const newConjectures = after.filter((n) => n.kind === 'conjecture').length - beforeConjectures;
    const refuted = summary.newlyRefuted.length + summary.newDeadEnds.length;
    const survivors = after.filter((n) => n.kind === 'conjecture' && n.status === 'open');
    const parts: string[] = [];
    parts.push(`${newConjectures} new data-backed conjecture(s) proposed (hung on the tree to prove later)`);
    if (refuted > 0) parts.push(`${refuted} killed by counterexample`);
    parts.push(`${survivors.length} conjecture(s) currently alive`);
    const list = survivors.slice(0, 5).map((n) => `- [${n.id}] ${n.claim}`).join('\n');
    const tail =
      result.error === 'aborted'
        ? timedOut
          ? `\n(hit the time cap; saved — you can keep exploring)`
          : '\n(this round was aborted; saved)'
        : result.hitCap
          ? '\n(hit the iteration cap; you can explore again)'
          : '';
    deps.onMilestone?.(`Experimental-math round: ${parts.join('; ')}.`);
    return {
      success: true,
      output:
        `One round of experimental-math exploration: ${parts.join('; ')}.${tail}` +
        (list ? `\nAlive conjectures (run action=continue to prove one):\n${list}` : '') +
        `\nsession id: ${session.id}`,
    };
  }

  return {
    name: 'deep_explore',
    description:
      'Deep-reasoning engine: persistent reasoning over a hard problem/conjecture via "decompose a subproblem tree → advance over many steps → prove/counterexample/backtrack", ' +
      'with state accumulating across turns (you can resume days later). Only call it when the user clearly wants to "deeply attack a hard problem/conjecture/proof"; not for ordinary Q&A.\n' +
      'action="start": open a new reasoning session (goal = the root proposition to attack, assumptions optional) and advance one round.\n' +
      'action="continue": keep advancing the most recent in-progress session (no id needed).\n' +
      'action="discover": **experimental-math mode** — use pariGp to compute data and find patterns, propose evidence-backed new conjectures and prune them by counterexample search, ' +
      'hanging survivors on the tree to prove later. Good when you don\'t yet know what to prove and want to discover patterns/conjectures first. Takes an optional seed (topic) or goal (creates a session if none is active).\n' +
      'action="status": just view the current tree\'s progress, without advancing.\n' +
      'action="finalize": produce a wrap-up report of the whole tree so far (established lemmas, refuted/dead-end branches, most promising open directions), without advancing. ' +
      'Use this to give the user a conclusion when they ask to wrap up / for results, or for an open-ended problem that will not converge to a clean "solved" on its own.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'continue', 'discover', 'status', 'finalize'] },
        goal: { type: 'string', description: 'action=start: the root proposition to attack; action=explore with no active session: the exploration domain as the root' },
        seed: { type: 'string', description: 'action=explore optional: the topic/object to focus this round on (e.g. a family of polynomials, a sequence)' },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=start optional: known assumptions',
        },
      },
      required: ['action'],
    },
    capability: 'execute',
    domain: 'self',
    async execute(params): Promise<ToolResult> {
      const action = params.action as string;

      if (action === 'start') {
        const goal = typeof params.goal === 'string' ? params.goal.trim() : '';
        if (!goal) return { success: false, output: '', error: 'action=start needs a non-empty goal (the root proposition to attack)' };
        const assumptions = Array.isArray(params.assumptions)
          ? params.assumptions.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
          : [];
        const { session } = reasoning.createSession({ goal, assumptions });
        return runRound(session);
      }

      if (action === 'continue') {
        const session = reasoning.getMostRecentActiveSession();
        if (!session) {
          return {
            success: false,
            output: '',
            error: 'No in-progress deep-exploreing session. Start one with action=start first.',
          };
        }
        return runRound(session);
      }

      if (action === 'discover') {
        const seed = typeof params.seed === 'string' ? params.seed.trim() : '';
        let session = reasoning.getMostRecentActiveSession();
        if (!session) {
          // No active session: create one using goal or seed as the exploration domain.
          const goal = (typeof params.goal === 'string' ? params.goal.trim() : '') || seed;
          if (!goal) {
            return {
              success: false,
              output: '',
              error: 'action=explore needs a goal or seed (exploration topic), or an already in-progress session.',
            };
          }
          const assumptions = Array.isArray(params.assumptions)
            ? params.assumptions.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
            : [];
          session = reasoning.createSession({ goal, assumptions }).session;
        }
        return runDiscoverRound(session, seed);
      }

      if (action === 'status') {
        const session = reasoning.getMostRecentActiveSession();
        if (!session) return { success: true, output: 'No deep-exploreing session is in progress right now.' };
        const nodes = reasoning.getNodes(session.id);
        const frontier = computeFrontier(nodes);
        const proved = nodes.filter((n) => n.status === 'proved').length;
        const dead = nodes.filter((n) => n.status === 'dead_end').length;
        return {
          success: true,
          output:
            `Reasoning session "${session.goal}" (${session.id}): proved ${proved} / open ${frontier.length} / dead ends ${dead}.` +
            (frontier.length ? `\nCurrent frontier: ${frontier.slice(0, 5).map((n) => n.claim).join(' / ')}` : ''),
        };
      }

      if (action === 'finalize') {
        const session = reasoning.getMostRecentActiveSession();
        if (!session) return { success: true, output: 'No deep-explore session to finalize.' };
        const report = renderFinalReport(session, reasoning.getNodes(session.id));
        deps.onMilestone?.(report); // persist as a chat bubble so the conclusion is not lost
        return { success: true, output: report };
      }

      return { success: false, output: '', error: `Unknown action: ${String(action)}` };
    },
  };
}
