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
  matchBarriers,
  renderBarrierAdvisory,
  type MiniLoopLLMClient,
  type MiniLoopToolRunResult,
  type ReasoningConfig,
  type BarrierMatch,
} from '@agent/tools';
import {
  ReasoningNodeNotFoundError,
  extractFailureSignature,
  findOrderClaim,
  type ReasoningStore,
  type ReasoningSession,
  type ReasoningSessionMode,
  type ReasoningNode,
  type ReasoningNodeKind,
  type ReasoningSessionStatus,
  type ActionLog,
  type SkillStore,
} from '@agent/memory';
import { currentSessionId } from './channels/turn_context.js';

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
 * Mirror of chat-handler's TURN_HARD_DEADLINE_MS (20 min). Kept as a local literal to avoid a
 * circular import (chat-handler imports this module to register deep_explore). **Must stay in
 * sync** with chat-handler.ts:TURN_HARD_DEADLINE_MS — the clamp below depends on it.
 */
const TURN_HARD_DEADLINE_MIRROR_MS = 20 * 60_000;
/**
 * Headroom reserved between a round's graceful self-abort and the turn's hard deadline. The round
 * must abort, then renderProgressText + onMilestone + the outer turn's reply formatting/send must
 * complete — all before the 20-min turn deadline throws. 5 min is generous (post-round work is
 * seconds) and also absorbs any turn time spent *before* the round started (auth / status calls).
 */
const ROUND_DEADLINE_TURN_HEADROOM_MS = 5 * 60_000;
/** Hard ceiling for a round so its graceful abort always wins the race against the turn deadline. */
const ROUND_DEADLINE_CEILING_MS = TURN_HARD_DEADLINE_MIRROR_MS - ROUND_DEADLINE_TURN_HEADROOM_MS; // 15 min

/**
 * Per-round wall-clock time limit (default 12 min; env PHILONT_DEEP_EXPLORE_ROUND_DEADLINE_MS,
 * min 30s, **hard-capped at 15 min** — see clamp below).
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
 *
 * 2026-06-07: enforce the "safely below the turn deadline" invariant **in code**. Previously the
 * env override (PHILONT_DEEP_EXPLORE_ROUND_DEADLINE_MS) had no upper bound — setting it to e.g.
 * 24 min (> the 20-min turn deadline) reintroduced exactly bug ①: the turn's withTimeout threw
 * TurnDeadlineError at 20 min, *before* the round's own graceful 24-min abort could fire, so every
 * multi-minute round ended as "抱歉，出错了" instead of the documented "tree saved — reply continue".
 * Clamp to ROUND_DEADLINE_CEILING_MS (15 min) so an over-large env value can never invert the order.
 */
const ROUND_DEADLINE_MS = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_ROUND_DEADLINE_MS);
  const requested = Number.isInteger(n) && n >= 30_000 ? n : 720_000;
  if (requested > ROUND_DEADLINE_CEILING_MS) {
    console.warn(
      `[deep-explore] PHILONT_DEEP_EXPLORE_ROUND_DEADLINE_MS=${requested}ms exceeds the safe ceiling ` +
        `${ROUND_DEADLINE_CEILING_MS}ms (turn hard deadline ${TURN_HARD_DEADLINE_MIRROR_MS}ms − ` +
        `${ROUND_DEADLINE_TURN_HEADROOM_MS}ms headroom); clamping so the round aborts gracefully ` +
        `before the turn deadline throws.`,
    );
  }
  return Math.min(requested, ROUND_DEADLINE_CEILING_MS);
})();

/**
 * Per-round deadline for an INTERACTIVE turn (a user is waiting on the reply). 2026-06-08: a round
 * runs to its full wall-clock cap every time (hard problems don't converge early), so with the
 * 15-min ROUND_DEADLINE_MS each user "continue" blocked ~16 min before replying. Use a shorter cap
 * when driven by a user turn for responsiveness; background/autonomous rounds keep the full budget
 * for depth. Default 6 min; env PHILONT_DEEP_EXPLORE_INTERACTIVE_ROUND_DEADLINE_MS (min 30s, clamped
 * to ≤ ROUND_DEADLINE_MS so "interactive" is never *longer* than the background cap).
 */
const INTERACTIVE_ROUND_DEADLINE_MS = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_INTERACTIVE_ROUND_DEADLINE_MS);
  const requested = Number.isInteger(n) && n >= 30_000 ? n : 360_000;
  return Math.min(requested, ROUND_DEADLINE_MS);
})();

/**
 * Pick the round deadline for the current invocation. currentSessionId() is the turn ALS session:
 * a `wechat:`/`user:` session means a person is waiting (interactive → short); `system:` (scheduled)
 * or null (autonomous background loop) means no one is blocked (→ full depth budget).
 */
function effectiveRoundDeadlineMs(): number {
  const sid = currentSessionId();
  const interactive = !!sid && !sid.startsWith('system:');
  return interactive ? INTERACTIVE_ROUND_DEADLINE_MS : ROUND_DEADLINE_MS;
}

/**
 * Cross-round stuck handling. A round that makes no net tree progress increments the session's
 * no_progress_rounds counter (reset on any progress). After STUCK_PIVOT_AFTER such rounds the round
 * prompt forces a different approach; after STUCK_ESCALATE_AFTER the reply tells the user the frontier
 * is stuck and suggests redirecting — instead of silently grinding the same wall round after round
 * (observed in production: rounds 12-14 left 14 open nodes unchanged before the user gave up).
 */
export const STUCK_PIVOT_AFTER = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_STUCK_PIVOT_AFTER);
  return Number.isInteger(n) && n >= 1 ? n : 2;
})();
export const STUCK_ESCALATE_AFTER = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_STUCK_ESCALATE_AFTER);
  return Number.isInteger(n) && n >= STUCK_PIVOT_AFTER ? n : 3;
})();

/** Forceful "you are stuck — change approach" directive for the round prompt. Empty until stuck. */
export function buildStuckDirective(noProgressRounds: number): string {
  if (noProgressRounds < STUCK_PIVOT_AFTER) return '';
  return (
    `\n\n⚠️ STUCK: the last ${noProgressRounds} round(s) made NO tree progress (no new proved / dead-end / ` +
    `decompose). Do NOT repeat the same approach or re-run the same computation. This round you MUST do one of: ` +
    `(a) attack a frontier node with a FUNDAMENTALLY different technique than already tried (check its ` +
    `approachesTried); (b) reason_decompose a stuck node into smaller, more tractable sub-lemmas; or (c) if a ` +
    `node is genuinely unreachable, reason_record it as a dead_end to prune the frontier. Make at least one ` +
    `concrete tree commit (reason_decompose or reason_record) this round.`
  );
}

/**
 * Strict progress (Tooth B): the stuck counter must not be reset by trivial churn. A round whose only
 * output is decomposing low-value nodes or "proving" deep low-value sub-lemmas is padding a wall, not a
 * breakthrough — yet the old `madeProgress` (any decompose/record) reset noProgressRounds every such
 * round, so the frontier could grind for 10 rounds (observed: the Goldbach run) without ever tripping the
 * pivot/escalate. With strict progress ON (default), only SUBSTANTIVE rounds reset the counter; trivial
 * churn accrues toward escalation, surfacing the stall honestly. env PHILONT_DEEP_EXPLORE_STRICT_PROGRESS=0
 * reverts to the old behaviour. Relies on the value-scorer; with VALUE_GUIDED off all nodes are unscored
 * → every commit counts → identical to legacy (safe no-op).
 */
const STRICT_PROGRESS = process.env.PHILONT_DEEP_EXPLORE_STRICT_PROGRESS !== '0';
/** Value at/above which a proved/decomposed node counts as substantive (not trivial). env PHILONT_DEEP_EXPLORE_SUBSTANTIVE_VALUE, default 0.35, range [0,1]. */
const SUBSTANTIVE_VALUE = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_SUBSTANTIVE_VALUE);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.35;
})();

/**
 * Did this round make SUBSTANTIVE progress, or just trivial churn around a wall? Substantive =
 *  (1) a node went open→refuted/dead_end (a real kill / backtrack), OR
 *  (2) a node near the root (depth ≤ 1) was settled (matters regardless of value), OR
 *  (3) a node that was settled or decomposed was rated ≥ threshold by the value-scorer (or is unscored →
 *      benefit of the doubt — fresh sessions / value-guidance-off never false-trip).
 * NOT substantive: only decomposing, or only "proving" deep low-value sub-lemmas — the trivial-lemma
 * padding signature (e.g. re-proving an elementary CRT counting lemma each round). Pure: diffs snapshots.
 */
export function roundWasSubstantive(
  before: ReasoningNode[],
  after: ReasoningNode[],
  threshold: number,
): boolean {
  const beforeById = new Map(before.map((n) => [n.id, n]));
  // 1+2. Any node that went open → settled this round.
  for (const n of after) {
    const prev = beforeById.get(n.id);
    if (!prev || prev.status !== 'open' || n.status === 'open') continue;
    if (n.status === 'refuted' || n.status === 'dead_end') return true; // kills / backtracks are real
    if (n.depth <= 1) return true; // settling something near the root matters regardless of value
    if (n.value === null || n.value >= threshold) return true; // a non-trivial proof
    // else: proved a deep, low-value node → incremental; keep checking
  }
  // 3. Decomposition counts only if it attacked an important (or unscored) node — not low-value busywork.
  const decomposedParents = new Set(
    after.filter((n) => !beforeById.has(n.id) && n.parentId).map((n) => n.parentId as string),
  );
  for (const pid of decomposedParents) {
    const p = beforeById.get(pid);
    if (!p || p.value === null || p.value >= threshold) return true;
  }
  return false;
}

/**
 * Feasibility / no-go gate (the "parity-problem" tooth). Before grinding rounds on a goal, match it
 * (+ the method it names, + assumptions) against the KNOWN_BARRIERS library — meta-mathematical no-go
 * results proving a class of method cannot reach a class of goal (parity problem → a sieve can't prove
 * binary Goldbach; relativization → diagonalization can't separate P vs NP; undecidability; ZFC
 * independence; …). When a barrier APPLIES we inject it into every round prompt (so the reasoning loop
 * names the blocked step instead of papering it with trivial sub-lemmas) and warn the user once at start.
 * Advisory, never a hard block. In-memory, process-scoped, RE-DERIVABLE from session.goal on demand (so it
 * also fires after a restart on a `continue`) — same pattern as sessionToolFailures, no schema change.
 * Disable with env PHILONT_DEEP_EXPLORE_BARRIERS=0.
 */
const BARRIERS_ENABLED = process.env.PHILONT_DEEP_EXPLORE_BARRIERS !== '0';
const sessionBarriers = new Map<string, BarrierMatch[]>();
function ensureBarriers(session: ReasoningSession): BarrierMatch[] {
  if (!BARRIERS_ENABLED) return [];
  const cached = sessionBarriers.get(session.id);
  if (cached) return cached;
  const matches = matchBarriers([session.goal, ...session.assumptions].join('\n'));
  sessionBarriers.set(session.id, matches);
  return matches;
}
/** Prompt lines surfacing the applicable barriers for this session (empty if none / disabled). */
function renderSessionBarriers(sessionId: string): string[] {
  const matches = sessionBarriers.get(sessionId);
  if (!matches || matches.length === 0) return [];
  const block = renderBarrierAdvisory(matches);
  return block ? ['', block] : [];
}

/**
 * Literature grounding (the deep-research half, wired in). deep_explore deliberately keeps web tools OUT
 * of the per-round reasoning loop (browsing-instead-of-reasoning failure mode). But the agent already HAS
 * web search (research_focus / the main agent) — it was just siloed away from a math attack. This bridges
 * the two: a ONE-SHOT, bounded, web-enabled pass at session start surveys what is ALREADY KNOWN about the
 * goal (standard approaches + status, known no-go BARRIERS, SOTA, the open frontier) and produces cited
 * cards. They are injected into every round prompt as established context (read-only — the reasoning loop
 * still cannot call web), turning the curated barriers.ts into a dynamically-retrieved, cited knowledge
 * layer and grounding the survey deliverable in the actual literature. Disable: PHILONT_DEEP_EXPLORE_LIT_GROUNDING=0.
 * In-memory, process-scoped, start-only (lost on restart; barriers still re-derive cheaply on continue).
 */
const LIT_GROUNDING_ENABLED = process.env.PHILONT_DEEP_EXPLORE_LIT_GROUNDING !== '0';
/** Web tools allowed ONLY in the one-shot grounding pass (never in the per-round reasoning whitelist). */
const WEB_TOOL_NAMES: ReadonlySet<string> = new Set(['webSearch', 'webFetch', 'fetchUrl']);
/** Iteration cap for the grounding mini-loop. env PHILONT_DEEP_EXPLORE_LIT_GROUNDING_ITERS, default 6, range 1-20. */
const LIT_GROUNDING_MAX_ITERS = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_LIT_GROUNDING_ITERS);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 6;
})();
/** Wall-clock cap for the grounding pass so it can't eat the turn deadline. env PHILONT_DEEP_EXPLORE_LIT_GROUNDING_TIMEOUT_MS, default 180s, min 30s. */
const LIT_GROUNDING_TIMEOUT_MS = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_LIT_GROUNDING_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 30_000 ? n : 180_000;
})();
const LIT_GROUNDING_MAX_CARDS = 15;

export interface LiteratureCard {
  claim: string;
  type: 'approach' | 'barrier' | 'sota' | 'open' | 'background';
  source: string;
}

export const LITERATURE_TYPES: readonly string[] = ['approach', 'barrier', 'sota', 'open', 'background'];
const LITERATURE_TYPE_SET = new Set(LITERATURE_TYPES);
function normalizeLiteratureType(raw: unknown): LiteratureCard['type'] {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (LITERATURE_TYPE_SET.has(t) ? t : 'background') as LiteratureCard['type'];
}

/** Parse the grounding pass's final text into cited cards. Tolerant: grabs the first JSON array, validates each item; non-JSON / no array → []. */
export function parseLiteratureCards(text: string, max = LIT_GROUNDING_MAX_CARDS): LiteratureCard[] {
  if (!text || !text.trim()) return [];
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: LiteratureCard[] = [];
  for (const it of arr) {
    const rec = it as Record<string, unknown>;
    const claim = typeof rec?.claim === 'string' ? rec.claim.trim() : '';
    if (!claim) continue;
    const source = typeof rec?.source === 'string' ? rec.source.trim() : '';
    out.push({ claim: claim.slice(0, 280), type: normalizeLiteratureType(rec?.type), source: source.slice(0, 160) });
    if (out.length >= max) break;
  }
  return out;
}

const LIT_TYPE_LABEL: Record<LiteratureCard['type'], string> = {
  approach: 'approach', barrier: 'barrier', sota: 'SOTA', open: 'open', background: 'background',
};
const LIT_TYPE_ORDER: LiteratureCard['type'][] = ['barrier', 'sota', 'approach', 'open', 'background'];

/** Render literature cards as a header + bullet list (barriers/SOTA first). Empty array → []. Shared by prompt + user milestone. */
export function renderLiteratureCards(cards: LiteratureCard[]): string[] {
  if (cards.length === 0) return [];
  const sorted = [...cards].sort((a, b) => LIT_TYPE_ORDER.indexOf(a.type) - LIT_TYPE_ORDER.indexOf(b.type));
  const lines = ['## Known from the literature (retrieved this session, cited)'];
  for (const c of sorted) lines.push(`- [${LIT_TYPE_LABEL[c.type]}] ${c.claim}${c.source ? ` (${c.source})` : ''}`);
  return lines;
}

/** Build the systemPrompt for the one-shot literature-grounding pass. */
export function buildLiteratureGroundingPrompt(goal: string, assumptions: string[]): string {
  const lines: string[] = [];
  lines.push('You are doing a one-shot LITERATURE-GROUNDING pass BEFORE a deep reasoning session on a hard problem. Your job is to find what is ALREADY KNOWN — NOT to solve the problem.');
  lines.push('');
  lines.push(`## Goal\n${goal}`);
  if (assumptions.length) lines.push(`\n## Assumptions\n${assumptions.map((a) => `- ${a}`).join('\n')}`);
  lines.push('');
  lines.push('## What to retrieve (use webSearch / webFetch)');
  lines.push('- standard approaches tried on this exact problem, and their status (worked / failed / partial)');
  lines.push('- KNOWN OBSTRUCTIONS / no-go results / barriers specific to it (e.g. the parity problem for sieve approaches to Goldbach)');
  lines.push('- the strongest known partial results (SOTA)');
  lines.push('- what is genuinely still open (the frontier)');
  lines.push('Prefer textbooks, surveys, papers, and well-known references; be skeptical of crank / low-quality sources.');
  lines.push('');
  lines.push('## Output (strict)');
  lines.push('Output ONLY a JSON array. Each item: {"claim":"<concise load-bearing statement>","type":"<approach|barrier|sota|open|background>","source":"<short citation or URL>"}.');
  lines.push('8-15 cards max, most load-bearing first. No prose outside the JSON array.');
  return lines.join('\n');
}

/**
 * Grounding prompt for DELIBERATE mode: survey what is already known that BEARS ON a hard decision/question —
 * key factors, hard tradeoffs it can't escape, reference points/base-rates, what's uncertain, common pitfalls.
 * Reuses the same card schema (type ∈ approach|barrier|sota|open|background) with deliberation meanings.
 */
export function buildDeliberateGroundingPrompt(goal: string, assumptions: string[]): string {
  const lines: string[] = [];
  lines.push('You are doing a one-shot GROUNDING pass BEFORE deliberating a hard, open-ended question. Your job is to surface what is ALREADY KNOWN that bears on it — NOT to answer it.');
  lines.push('');
  lines.push(`## The question\n${goal}`);
  if (assumptions.length) lines.push(`\n## Given context\n${assumptions.map((a) => `- ${a}`).join('\n')}`);
  lines.push('');
  lines.push('## What to retrieve (use webSearch / webFetch)');
  lines.push('- the KEY FACTORS that actually decide this kind of question → type="approach"');
  lines.push('- hard TRADEOFFS / constraints it cannot escape ("you cannot have all of X, Y, Z at once") → type="barrier"');
  lines.push('- strong REFERENCE POINTS: what comparable cases/people did, benchmarks, base rates → type="sota"');
  lines.push('- the points that are genuinely UNCERTAIN or contested → type="open"');
  lines.push('- common PITFALLS / mistakes people make on this exact decision → type="background"');
  lines.push('Prefer reputable, specific sources; be skeptical of marketing and anecdote.');
  lines.push('');
  lines.push('## Output (strict)');
  lines.push('Output ONLY a JSON array. Each item: {"claim":"<concise load-bearing point>","type":"<approach|barrier|sota|open|background>","source":"<short citation or URL>"}.');
  lines.push('8-15 cards max, most decision-relevant first. No prose outside the JSON array.');
  return lines.join('\n');
}

const sessionLiterature = new Map<string, LiteratureCard[]>();
/** Prompt lines injecting this session's retrieved literature as established context (empty if none). */
function renderSessionLiterature(sessionId: string): string[] {
  const cards = sessionLiterature.get(sessionId);
  if (!cards || cards.length === 0) return [];
  const lines = renderLiteratureCards(cards);
  lines.push(
    'DIRECTIVE: treat these as established context — build ON them, do not re-derive what is already settled; ' +
      'if a known barrier here blocks your plan, route around it (named circumvention) or reason_record the wall.',
  );
  return ['', ...lines];
}

/**
 * No-progress early-stop threshold. A round otherwise runs to its full wall-clock cap even when
 * spinning — the prompt pushes "always advance the tree", so the model rarely returns plain text
 * and the loop only ends on the deadline. A round that just fails pariGp / computes endlessly /
 * never commits a node burns the whole budget for nothing. env PHILONT_DEEP_EXPLORE_NO_PROGRESS_CAP,
 * default 10 (generous: a few pariGp computations before a record won't trip it), min 3.
 */
const NO_PROGRESS_CAP = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_NO_PROGRESS_CAP);
  return Number.isInteger(n) && n >= 3 ? n : 10;
})();

/**
 * Wrap a round's tool runner so the round aborts early once it has made NO tree progress for
 * NO_PROGRESS_CAP consecutive tool calls. "Progress" = a successful reason_decompose / reason_record
 * (any status — recording a dead_end IS progress, it's backtracking). pariGp/recall/failed calls do
 * NOT reset the counter. Steady progress keeps resetting it, so a genuinely productive round (which
 * is exactly the one that SHOULD use the full time budget) is never cut — only a stalled/spinning
 * round stops early. `stalled.value` lets the caller render a "no progress" tail instead of a timeout.
 */
export function withNoProgressStop(
  base: (name: string, input: Record<string, unknown>) => Promise<MiniLoopToolRunResult>,
  abort: () => void,
  opts: { noProgressTimeoutMs?: number; now?: () => number } = {},
): { runner: (name: string, input: Record<string, unknown>) => Promise<MiniLoopToolRunResult>; stalled: { value: boolean } } {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.noProgressTimeoutMs;
  let callsSinceProgress = 0;
  let lastProgressTs = now(); // round start; reset on every tree commit
  const stalled = { value: false };
  const runner = async (name: string, input: Record<string, unknown>) => {
    const r = await base(name, input);
    callsSinceProgress++;
    if (r.ok && (name === 'reason_decompose' || name === 'reason_record')) {
      callsSinceProgress = 0;
      lastProgressTs = now();
    }
    // Time-aware stop: a round that has not committed ANYTHING to the tree for too long is spinning
    // (e.g. all-pariGp, never decomposes). The call-count cap above misses this when iterations are
    // slow (max reasoning effort → only a few calls fit before the wall-clock cap), so also stop when
    // too much time has elapsed with no commit. `callsSinceProgress >= 2` avoids killing on one slow step.
    const stalledByTime =
      timeoutMs != null && callsSinceProgress >= 2 && now() - lastProgressTs > timeoutMs;
    if ((callsSinceProgress >= NO_PROGRESS_CAP || stalledByTime) && !stalled.value) {
      stalled.value = true;
      console.warn(
        `[deep-explore] no-progress early stop: ${callsSinceProgress} calls / ` +
          `${Math.round((now() - lastProgressTs) / 1000)}s without a tree commit`,
      );
      abort();
    }
    return r;
  };
  return { runner, stalled };
}

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
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sources / observations backing the conclusion (a citation, URL, fact key, or file). REQUIRED to settle a finding in deliberate (evidence-based) mode; optional in formal proof mode.',
        },
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
 *      concrete values) + magnitude (asymptotic order-of-growth algebra — the analytic/quantitative
 *      tooth: decides o/O/Θ and whether a pile of bounds composes to beat a target, incl. ∃-feasibility
 *      over free parameters; offloads the epsilon-management an LLM reliably slips on. Pure, no external
 *      binary — unlike z3/gp it needs nothing installed).
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
  'magnitude',
  'lemmaLookup',
  'barrierCheck',
]);

// ── Pure functions (independently testable) ─────────────────────────────────────────────────────

/**
 * frontier = open nodes with no OPEN child (the active frontier yet to be attacked).
 *
 * 2026-06-08: previously this excluded any open node that had *any* child, so an open node whose
 * children all became dead_end/refuted was neither on the frontier nor closed — the tree showed
 * "frontier empty but N still open" and the session was wrongly declared stuck while re-attackable
 * nodes existed. Keying on OPEN children instead lets the frontier bubble back up as subtrees die:
 * once all of a node's children are closed, the node itself returns to the frontier so the model can
 * re-decompose it (a different approach) or reason_record it as a dead_end. judgeConvergence only
 * declares "stuck" when there is genuinely nothing actionable left.
 */
export function computeFrontier(nodes: ReasoningNode[]): ReasoningNode[] {
  const hasOpenChild = new Set<string>();
  for (const n of nodes) if (n.parentId && n.status === 'open') hasOpenChild.add(n.parentId);
  return nodes.filter((n) => n.status === 'open' && !hasOpenChild.has(n.id));
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
/**
 * 2026-06-07: in-session "learn from failure" for the compute tools (pariGp / z3Verify).
 * Within a round the mini-loop already shows the error and the model retries — but each round
 * starts from a FRESH systemPrompt, so a PARI/GP syntax lesson is lost across rounds and the
 * same mistake recurs (observed in production: repeated `pariGp failed: syntax error`). We keep
 * a small per-session ring of recent compute-tool failures, deduped by the sharp signature
 * (extractFailureSignature → e.g. `pariGp:gp-syntax`), and surface them into the next round's
 * prompt so the model avoids repeating them. In-memory only — a session's exploration lives in
 * one process; durable cross-session distillation (reflector → playbook) is a separate follow-up.
 */
interface ToolFailureMemo { sig: string; snippet: string }
const RECENT_TOOL_FAILURES_MAX = 6;
const sessionToolFailures = new Map<string, ToolFailureMemo[]>();
function recordSessionToolFailure(sessionId: string, toolName: string, error: string | undefined): void {
  const sig = extractFailureSignature(toolName, error ?? '');
  const snippet = (error ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const buf = sessionToolFailures.get(sessionId) ?? [];
  // Dedup by signature: keep only the most recent example of each distinct failure class.
  const dup = buf.findIndex((m) => m.sig === sig);
  if (dup >= 0) buf.splice(dup, 1);
  buf.push({ sig, snippet });
  while (buf.length > RECENT_TOOL_FAILURES_MAX) buf.shift();
  sessionToolFailures.set(sessionId, buf);
}
/**
 * Estimate-honesty tracking: which sessions have actually run a VERIFICATION tool (magnitude / z3 / gp)
 * at least once. A reasoning session that records a node "proved" on an asymptotic/quantitative ESTIMATE
 * claim but has NEVER machine-checked anything is the analytic-proof fabrication pattern (the Goldbach
 * failure mode — asserting bounds it didn't earn). We don't hard-block (advisory, fail-open), but we
 * annotate the recorded result with a caveat so it can't masquerade as a verified lemma downstream.
 * In-memory, process-scoped; once a session verifies once we stop nagging it (low false-positive).
 */
const sessionVerifierUsed = new Set<string>();
const VERIFIER_TOOLS = new Set(['magnitude', 'z3Verify', 'pariGp']);
const ESTIMATE_CAVEAT =
  '  [⚠ unverified estimate — this order/bound claim was recorded without any machine check this session; ' +
  'confirm the composition with magnitude(action="closes") / z3Verify / pariGp before relying on it as a lemma]';

/** Prompt lines warning the model off its own recent pariGp/z3 mistakes this session (empty if none). */
function renderRecentToolFailures(sessionId: string): string[] {
  const buf = sessionToolFailures.get(sessionId);
  if (!buf || buf.length === 0) return [];
  const lines = ['', '## ⚠ Recent compute-tool errors this session — DO NOT repeat these patterns'];
  for (const m of buf) lines.push(`- [${m.sig}] ${m.snippet}`);
  lines.push('Inspect and fix the script before re-running; a malformed pariGp/z3 call wastes a round.');
  return lines;
}

/**
 * Durable cross-session "learned lessons" surfacing (the philont failure-learning loop closed for
 * compute tools). deep_explore records pariGp/z3 failures into the action ledger; the idle
 * consolidator's reflector distils them into skills (incl. negative `avoid-*` anti-patterns). Here
 * we pull the compute-relevant ones back into the round prompt so the model actually applies them.
 * Matched by a keyword regex over name+description; top few only, to bound prompt size.
 */
const COMPUTE_LESSON_RE = /\b(pari\/?gp|pari|gp-(syntax|type|varname|args|timeout)|z3|smt|computation)\b/i;
function collectComputeLessons(skills: SkillStore | undefined): string[] {
  if (!skills) return [];
  const seen = new Set<string>();
  const picks: { name: string; description: string }[] = [];
  for (const s of [...skills.listNegative(30), ...skills.listByMaturity('playbook', 30)]) {
    if (seen.has(s.name)) continue;
    if (COMPUTE_LESSON_RE.test(`${s.name} ${s.description}`)) {
      picks.push(s);
      seen.add(s.name);
    }
    if (picks.length >= 3) break;
  }
  if (picks.length === 0) return [];
  const lines = ['', '## 📘 Learned lessons from past explorations — apply these'];
  for (const s of picks) lines.push(`- ${s.description.split('\n')[0]}`);
  return lines;
}

/**
 * Short PARI/GP syntax primer. Complements the adaptive failure-learning (renderRecentToolFailures
 * / collectComputeLessons) by heading off the most common up-front mistakes seen in production
 * (function-vs-block scope, redefining built-in names, unbalanced for(...), forgetting print()).
 * Kept terse so it doesn't bloat the prompt.
 */
const PARI_GP_PRIMER: readonly string[] = [
  '## pariGp syntax reminders (avoid the common errors)',
  '- Define a function at top level as `f(x) = (...; expr)`. `my(...)` ONLY declares locals INSIDE a function/block body — `my(a=...)` at top level is a syntax error.',
  '- Do NOT reuse BUILT-IN names as variables. Reserved constants: `I` (√-1), `Pi`, `O`, `Euler`. Reserved FUNCTIONS: `primes`, `prime`, `factor`, `isprime`, `nextprime`, `divisors`, `sigma`, `eulerphi`, `moebius`, `gcd`, `lcm`, `sum`, `prod`, `eta`, `theta`, `zeta`, … — `primes=primes(N)` or `sigma=1.0` errors ("variable name expected"). Use a fresh name: `pp=primes(N)`, `s=1.0`.',
  '- To INDEX a result, store it in a variable first: `pp=primes(N); pp[i]`. You cannot index or assign a function — `primes[i]` gives "not a vector (t_CLOSURE)".',
  '- `sum`/`prod`/`for` iterate an INDEX over an integer RANGE — `sum(i=a, b, expr)` has THREE parts. To range over the elements of a vector `V`, index it: `sum(i=1, #V, f(V[i]))` — NOT `sum(x=V, f(x))`, which errors "too few arguments". Likewise `for(i=1, #V, … use V[i] …)`, not `for(x=V, …)`.',
  '- Every `for(...)` / `if(...)` / `while(...)` must be CLOSED with a matching `)`, even when written across lines — "unexpected end of file, expecting )" means a `)` is missing. Prefer a compact single-line body, e.g. `for(i=1,N, s=s+f(i))`; separate statements with `;`. Count your parentheses before running.',
  '- Anonymous function is `(x) -> expr`. A name used like `g(x)` where `g` is not a function gives "not a function in function call".',
  '- Always `print(...)` your conclusion — only printed text is returned to you.',
];

/**
 * Short primer for the magnitude (asymptotic order-of-growth) tool. The single biggest failure mode of
 * an LLM doing analytic/quantitative proofs is mis-tracking magnitudes and asserting an unjustified
 * parameter balance; this nudges the model to OFFLOAD that arithmetic instead of doing it in its head.
 */
const MAGNITUDE_PRIMER: readonly string[] = [
  '## magnitude tool (order-of-growth algebra — offload the epsilon arithmetic)',
  '- Write magnitudes as products of powers of growth variables: `N` and `L` (= log N) by default; rational exponents ok (`N^(3/2)`), and exponents may carry free parameters (`L^-A`, `N^(1-B)`). `^` binds tighter than `*`; multi-term exponents need parentheses (`N^(2*t)`).',
  '- compare: `magnitude(action="compare", x="N*L", y="N", relation="o")` → is x = o(y)? (catches slips like "N·log N is o(N)" — it is NOT).',
  '- closes: `magnitude(action="closes", target="N^2*L^-3", terms=["N^2*L^-A"], params={"A":{"gt":0}})` → do the bound(s) sum below the target, and does a parameter choice exist? Returns a witness (e.g. A=4) or, if impossible, the binding obstruction.',
  '- It reasons about ORDERS only, never hidden constants. A "closes" verdict means the orders compose — you still owe an analytic justification for each bound\'s SHAPE. A "does not close" with a dominant-scale obstruction is a real structural gap (a sharper idea is needed), not a tuning failure — record it honestly.',
];

export function renderTreePrompt(session: ReasoningSession, nodes: ReasoningNode[], lessons: string[] = []): string {
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

  // Feasibility / no-go gate: surface any KNOWN BARRIER for this goal/method up front, so the blocked
  // step is named before a node is picked (not discovered round 10 after padding the wall with lemmas).
  for (const l of renderSessionBarriers(session.id)) lines.push(l);
  // Literature grounding: inject what the start-of-session web pass found is already known (cited).
  for (const l of renderSessionLiterature(session.id)) lines.push(l);

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

  for (const l of lessons) lines.push(l);
  for (const l of renderRecentToolFailures(session.id)) lines.push(l);
  lines.push('');
  for (const l of PARI_GP_PRIMER) lines.push(l);
  lines.push('');
  for (const l of MAGNITUDE_PRIMER) lines.push(l);

  lines.push('');
  lines.push('## Your actions (tools)');
  lines.push('- reason_decompose(parentNodeId, subClaims[]): split a node into subgoals/lemmas; returns new child ids. **Primary action.**');
  lines.push('- reason_record(nodeId, status, result, approach?): settle a node as proved/refuted/dead_end. **Primary action.**');
  lines.push('- z3Verify(smtlib): **external check** — use the Z3 solver to rigorously verify a decidable/bounded/arithmetic subclaim or find a counterexample.');
  lines.push('- pariGp(script): **external computation** — use PARI/GP for number-theory/algebra computation and counterexample search (factoring, primality certificates, elliptic curves, enumeration, concrete values). Prefer it over z3 for number theory. Use print() to output your conclusion.');
  lines.push('- magnitude(action, …): **asymptotic order-of-growth algebra** — do NOT track magnitudes like N^(3/2)·(log N)^-A in your head (you WILL slip). action="compare" decides X=o(Y)/O(Y); action="closes" takes a target + a sum of bounds (terms[]) and decides whether they compose to beat it — and with free parameters {A,B,κ,…} whether a choice EXISTS that closes it (returns a witness, or the binding obstruction). This is how you settle an "estimates balance" / parameter-choice step rigorously instead of hand-waving.');
  lines.push('- lemmaLookup(query): **retrieve a standard estimate instead of mis-remembering it** — precise hypotheses + magnitude + the common MISUSE for the classic tools (PNT/Parseval weights, Vinogradov minor-arc sup, sup×mean-square arc integrals, Siegel–Walfisz moduli range, decoupling/BDG applicability, large sieve, …). Each card\'s magnitude is in `magnitude`-tool syntax, so look it up then feed the shape into a closure check. Empty query lists the index.');
  lines.push('- barrierCheck(query): **check for a known no-go BEFORE grinding a wall** — match your goal + intended method against catalogued meta-mathematical barriers (parity problem → sieves can\'t do binary Goldbach; relativization/natural-proofs/algebrization → P vs NP; undecidability + Rice; ZFC independence; Abel–Ruffini; ruler-and-compass; non-elementary antiderivatives; FLP/CAP; no-free-lunch; lossless-compression/Kolmogorov; no-cloning; perpetual motion; hairy-ball; Arrow). If blocked, it names the obstruction + the only circumventions, so you route through one explicitly or reason_record the node as a dead_end instead of padding the wall with trivial lemmas.');
  lines.push('- memory-recall tools (searchNotes/getFact/readFile, etc.): **auxiliary only** — to recall your own earlier conclusions/computations, not a substitute for reasoning.');
  lines.push('');
  lines.push('## How to reason (discipline)');
  lines.push('1. You are **doing a proof**, not gathering references. **Every round should advance the tree** — either reason_decompose an open node, or reason_record a verdict on one.');
  lines.push('2. From the frontier pick the most promising open node: think it through → if you can settle it, reason_record (proved/refuted); if it is too big, reason_decompose into subgoals/lemmas.');
  lines.push('3. **If a machine can verify/compute it, don\'t just assert it** — pick the right tool by subclaim type:');
  lines.push('   · **decidable/bounded/arithmetic** (linear or bounded-nonlinear int/real, bit-vectors, propositional logic) → z3Verify: to prove ∀x.P(x), encode ∃x.¬P(x) as SMT-LIB, unsat means P holds; sat means the model is a counterexample.');
  lines.push('   · **number-theory/algebra computation** (factoring, primality, modular arithmetic, elliptic curves, enumerating a range for counterexamples, concrete instances) → pariGp: e.g. print(factor(N)) to show N is composite, print(isprime(p)) for a certified primality test, for(...) to enumerate for counterexamples.');
  lines.push('   · **asymptotic / analytic estimates** (orders of growth, "do these bounds sum below the target?", "is there a parameter choice that makes the error terms balance?") → magnitude: never assert a magnitude comparison or a parameter-balancing step by eye — encode the bounds and let magnitude decide (it returns a witness if it closes, or the obstruction if no parameter choice can — the honest verdict for a real gap).');
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
  lessons: string[] = [],
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
  for (const l of lessons) lines.push(l);
  for (const l of renderRecentToolFailures(session.id)) lines.push(l);
  lines.push('');
  for (const l of PARI_GP_PRIMER) lines.push(l);
  lines.push('');
  for (const l of MAGNITUDE_PRIMER) lines.push(l);

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

function renderProgressText(s: ProgressSummary, hitCap: boolean, status: ReasoningSessionStatus, settledVerb = 'proved'): string {
  const parts: string[] = [];
  if (s.decomposedInto > 0) parts.push(`+${s.decomposedInto} child nodes`);
  if (s.newlyProved.length) parts.push(`${settledVerb} ${s.newlyProved.length}: ${s.newlyProved.slice(0, 3).join(' / ')}`);
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

// ── Reasoning profiles (domain shell): formal proof vs general evidence-based deliberation ──────────
// The engine (tree, persistence, skeptics, stuck/Tooth-B, value selection, honesty, #1 grounding) is
// domain-general. A ReasoningProfile owns the math-vs-general "shell": tool whitelist, round prompt,
// skeptic prompt, the meaning of "settled", and the report. Two profiles; selected per session.mode.
// FORMAL = the current math behaviour wrapped verbatim. DELIBERATE = general (decisions/diagnosis/
// due-diligence): claims are settled by CITED EVIDENCE (not machine proof), retrieval IS the substrate.

/** Evidence tools for DELIBERATE mode — the open web + the user's own data/memory (no z3/pari/magnitude). */
export const DELIBERATE_RESEARCH_ALLOW: ReadonlySet<string> = new Set([
  'webSearch',
  'webFetch',
  'fetchUrl',
  'searchNotes',
  'searchKB',
  'getFact',
  'listFacts',
  'readFile',
]);

/** Same node enum, deliberation vocabulary. */
const DELIBERATE_KIND_LABEL: Record<ReasoningNodeKind, string> = {
  subgoal: 'sub-question',
  lemma: 'finding',
  construction: 'option',
  counterexample: 'disconfirming evidence',
  conjecture: 'hypothesis',
};

/** Round prompt for DELIBERATE mode: decompose the question, gather evidence per node, settle only when cited. */
export function renderDeliberatePrompt(session: ReasoningSession, nodes: ReasoningNode[], lessons: string[] = []): string {
  const lines: string[] = [];
  lines.push('You are a careful deliberation engine working a hard, open-ended question over many rounds. You decompose it into sub-questions, gather EVIDENCE for each, and settle a sub-question ONLY when its conclusion is backed by cited sources or observations. You do not fool yourself.');
  lines.push('');
  lines.push('## The question');
  lines.push(session.goal);
  if (session.assumptions.length) {
    lines.push('');
    lines.push('## Given context');
    for (const a of session.assumptions) lines.push(`- ${a}`);
  }
  for (const l of renderSessionBarriers(session.id)) lines.push(l);
  for (const l of renderSessionLiterature(session.id)) lines.push(l);

  const rawFrontier = computeFrontier(nodes);
  const frontier = VALUE_GUIDED ? rankFrontier(rawFrontier, nodes, UCB_C, NOVELTY_W) : rawFrontier;
  const settled = nodes.filter((n) => n.status === 'proved');
  const ruledOut = nodes.filter((n) => n.status === 'refuted' || n.status === 'dead_end');

  lines.push('');
  lines.push(`## Open sub-questions to investigate (${frontier.length} total)`);
  if (frontier.length === 0) {
    lines.push('(none — decompose the question into sub-questions first)');
  } else {
    if (VALUE_GUIDED && frontier.length >= 2) {
      lines.push(`(ranked by importance × tractability; **prefer the top one [${frontier[0].id}]** unless you have a stronger reason)`);
    }
    for (const n of frontier.slice(0, 20)) {
      const ann = VALUE_GUIDED ? ` — value ${n.value === null ? '?' : n.value.toFixed(2)} / ${n.visits} rounds spent` : '';
      lines.push(`- [${n.id}] (${DELIBERATE_KIND_LABEL[n.kind]}) ${n.claim}${ann}`);
    }
  }

  if (settled.length) {
    lines.push('');
    lines.push(`## Established findings (evidence-backed, ${settled.length} total)`);
    for (const n of settled.slice(0, 15)) {
      const ev = n.evidenceRefs.length ? `  [sources: ${n.evidenceRefs.slice(0, 4).join('; ')}]` : '';
      lines.push(`- [${n.id}] ${n.claim}${n.result ? ` → ${n.result}` : ''}${ev}`);
    }
  }

  if (ruledOut.length) {
    lines.push('');
    lines.push(`## Ruled out / disconfirmed (${ruledOut.length} total)`);
    for (const n of ruledOut.slice(0, 15)) {
      const why = n.result || n.approachesTried[n.approachesTried.length - 1] || '';
      lines.push(`- [${n.id}] ${n.claim}${why ? ` — ${why}` : ''}`);
    }
  }

  for (const l of lessons) lines.push(l);
  for (const l of renderRecentToolFailures(session.id)) lines.push(l);

  lines.push('');
  lines.push('## Your actions (tools)');
  lines.push('- reason_decompose(parentNodeId, subClaims[]): split a question into concrete sub-questions (kind="subgoal") or candidate options (kind="construction"). **Primary action.**');
  lines.push('- reason_record(nodeId, status, result, evidence[], approach?): settle a sub-question. status=proved = "established"; refuted = "ruled out by evidence"; dead_end = "cannot be resolved with available evidence". **You MUST pass `evidence` (the sources/observations you relied on) to settle a finding — a conclusion with no cited evidence is NOT accepted.**');
  lines.push('- webSearch / webFetch / fetchUrl: gather external evidence; read the actual source, do not settle on a snippet alone.');
  lines.push('- searchNotes / searchKB / getFact / listFacts / readFile: the USER’s own data and your memory — often the most decisive evidence (their constraints, preferences, prior facts). Check these BEFORE the open web.');
  lines.push('');
  lines.push('## How to deliberate (discipline)');
  lines.push('1. **Decompose first.** Round 1 must split the question into 2–5 concrete, answerable sub-questions — do NOT browse before there is a tree.');
  lines.push('2. Pick the most important open sub-question; gather evidence for it (the user’s own data first, then the web). **A sub-question is SETTLED only when its conclusion is backed by cited evidence — attach it via `evidence`.**');
  lines.push('3. **Actively seek DISCONFIRMING evidence**, not just support. Record an option/hypothesis as refuted when the evidence is against it (cite the source).');
  lines.push('4. Do not let an assertion masquerade as a finding. If you cannot find evidence, say so and leave the sub-question open — an honest "unresolved" beats a fabricated conclusion.');
  lines.push('5. **Only use real node ids** from the tree / returned by decompose; never invent ids.');
  lines.push('6. When evidence is genuinely unavailable → reason_record(dead_end, approach="what you tried / what evidence is missing").');
  return lines.join('\n');
}

/** Skeptic prompt for DELIBERATE mode: an evidence reviewer (is the conclusion actually supported?). */
export function buildDeliberateSkepticPrompt(
  claim: string,
  argument: string | null,
  goal: string,
  context: string[],
  settledClaims: string[],
): string {
  const lines: string[] = [];
  lines.push('You are a strict evidence reviewer. Someone claims the sub-question below has been SETTLED.');
  lines.push('Your only task: decide whether the conclusion is ACTUALLY supported by the evidence given — try hard to find a hole, do not just agree.');
  lines.push('');
  lines.push(`## Sub-question / claim\n${claim}`);
  lines.push('');
  lines.push(`## The conclusion + cited evidence\n${argument && argument.trim() ? argument : '(no evidence cited — which is itself disqualifying)'}`);
  lines.push('');
  lines.push(`## Context: the overall question\n${goal}`);
  if (context.length) lines.push(`\n## Given context\n${context.map((a) => `- ${a}`).join('\n')}`);
  if (settledClaims.length) {
    lines.push(`\n## Already established this session\n${settledClaims.slice(0, 15).map((c) => `- ${c}`).join('\n')}`);
  }
  lines.push('');
  lines.push('## Review discipline');
  lines.push('- You may use webSearch / webFetch / readFile / memory recall to CHECK whether the cited evidence actually says what is claimed, and whether a contradicting source exists.');
  lines.push('- REFUTE if: the conclusion is not actually supported by the cited evidence; the evidence is missing, weak, or misread; a contradicting source exists; or the reasoning is motivated (cherry-picked) rather than balanced.');
  lines.push('- **If you are unsure it is genuinely evidence-backed → verdict REFUTED** (a finding requires real support; any doubt fails).');
  lines.push('- Only when the conclusion is clearly and fairly supported by the cited evidence → verdict HOLDS.');
  lines.push('');
  lines.push('## Output format');
  lines.push('First briefly state your reasons (if refuting, name the specific gap / missing or contradicting evidence), then on a **single final line** output one of:');
  lines.push('VERDICT: REFUTED');
  lines.push('VERDICT: HOLDS');
  return lines.join('\n');
}

/** Wrap-up report for DELIBERATE mode (evidence-backed findings / ruled out / open). */
function renderDeliberateReport(session: ReasoningSession, nodes: ReasoningNode[]): string {
  const oneLine = (s: string, max: number): string => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  };
  const settled = nodes.filter((n) => n.status === 'proved');
  const ruledOut = nodes.filter((n) => n.status === 'refuted' || n.status === 'dead_end');
  const frontier = computeFrontier(nodes);
  const topOpen = [...frontier]
    .sort((a, b) => (b.value ?? 0.5) - (a.value ?? 0.5) || a.depth - b.depth)
    .slice(0, 8);
  const status = judgeConvergence(nodes);
  const head = status === 'solved' ? '✓ RESOLVED' : status === 'stuck' ? '⚠ STUCK' : '◐ IN PROGRESS';
  const lines: string[] = [];
  lines.push(`# Deliberation report — ${head}`);
  lines.push(`Question: ${session.goal}`);
  lines.push(
    `Tree: ${nodes.length} nodes — established ${settled.length} / open ${frontier.length} / ` +
      `ruled out ${ruledOut.length}. Budget spent: ${session.budgetSpent}/${SESSION_TOKEN_BUDGET} tokens.`,
  );
  if (settled.length) {
    lines.push('\n## ✓ Established (evidence-backed)');
    for (const n of settled) {
      const ev = n.evidenceRefs.length ? ` [sources: ${oneLine(n.evidenceRefs.slice(0, 4).join('; '), 160)}]` : '';
      lines.push(`- ${oneLine(n.claim, 200)}${n.result ? ` — ${oneLine(n.result, 220)}` : ''}${ev}`);
    }
  }
  if (ruledOut.length) {
    lines.push('\n## ✗ Ruled out / disconfirmed');
    for (const n of ruledOut) {
      const why = n.result || n.approachesTried[n.approachesTried.length - 1] || '';
      lines.push(`- ${oneLine(n.claim, 160)}${why ? ` — ${oneLine(why, 180)}` : ''}`);
    }
  }
  if (topOpen.length) {
    lines.push('\n## ◯ Still open / unresolved');
    for (const n of topOpen) lines.push(`- ${oneLine(n.claim, 200)}${n.value != null ? ` (value ${n.value.toFixed(2)})` : ''}`);
  }
  lines.push(
    status === 'solved'
      ? '\nQuestion resolved — session complete.'
      : '\nReply "continue" to keep gathering evidence on the open sub-questions above.',
  );
  lines.push(`session id: ${session.id}`);
  return lines.join('\n');
}

/**
 * A reasoning profile bundles everything domain-specific. The engine parameterizes over it by session.mode.
 * settlePrecheck is a synchronous gate run before a `proved` is committed: ok=false returns the node to
 * open with `reason` (formal: always ok — skeptics do the gating; deliberate: require cited evidence).
 */
export interface ReasoningProfile {
  id: ReasoningSessionMode;
  toolAllow: ReadonlySet<string>;
  /** Verb used for a settled node in user/LLM messages ('proved' | 'settled'). */
  settledVerb: string;
  buildRoundPrompt(session: ReasoningSession, nodes: ReasoningNode[], lessons: string[]): string;
  buildUserMessage(session: ReasoningSession, isFresh: boolean): string;
  /** One-shot start-of-session grounding pass prompt (formal: literature/SOTA/no-go; deliberate: factors/tradeoffs/pitfalls). */
  buildGroundingPrompt(goal: string, assumptions: string[]): string;
  buildSkepticPrompt(
    claim: string,
    argument: string | null,
    goal: string,
    assumptions: string[],
    settledClaims: string[],
  ): string;
  settlePrecheck(node: ReasoningNode, result: string | null, incomingEvidence: string[]): { ok: boolean; reason?: string };
  renderReport(session: ReasoningSession, nodes: ReasoningNode[]): string;
}

export const FORMAL_PROFILE: ReasoningProfile = {
  id: 'formal',
  toolAllow: DEEP_EXPLORE_RESEARCH_ALLOW,
  settledVerb: 'proved',
  buildRoundPrompt: (session, nodes, lessons) => renderTreePrompt(session, nodes, lessons),
  buildUserMessage: (session, isFresh) =>
    isFresh
      ? `${session.goal}\n\n[FRESH session — only the root node exists.] Your FIRST action MUST be ` +
        `reason_decompose, splitting the root proposition into 2–5 concrete subgoals/lemmas. Do NOT run ` +
        `pariGp or any computation before the root is decomposed — a round that only computes without ` +
        `committing to the tree wastes the entire time budget and will be cut short.`
      : 'Continue advancing the current reasoning tree; prefer the most promising open node on the frontier.',
  buildGroundingPrompt: (goal, assumptions) => buildLiteratureGroundingPrompt(goal, assumptions),
  buildSkepticPrompt: (claim, argument, goal, assumptions, settledClaims) =>
    buildSkepticSystemPrompt(claim, argument, goal, assumptions, settledClaims),
  settlePrecheck: () => ({ ok: true }),
  renderReport: (session, nodes) => renderFinalReport(session, nodes),
};

export const DELIBERATE_PROFILE: ReasoningProfile = {
  id: 'deliberate',
  toolAllow: DELIBERATE_RESEARCH_ALLOW,
  settledVerb: 'settled',
  buildRoundPrompt: (session, nodes, lessons) => renderDeliberatePrompt(session, nodes, lessons),
  buildUserMessage: (session, isFresh) =>
    isFresh
      ? `${session.goal}\n\n[FRESH session — only the root node exists.] Your FIRST action MUST be ` +
        `reason_decompose, splitting the question into 2–5 concrete sub-questions. Do NOT gather evidence ` +
        `before the question is decomposed — a round that only browses without committing sub-questions to ` +
        `the tree wastes the budget and will be cut short.`
      : 'Continue: pick the most important open sub-question, gather evidence (the user’s memory & files first, then the web) for it, and settle it ONLY when the conclusion is backed by cited evidence.',
  buildGroundingPrompt: (goal, assumptions) => buildDeliberateGroundingPrompt(goal, assumptions),
  buildSkepticPrompt: (claim, argument, goal, assumptions, settledClaims) =>
    buildDeliberateSkepticPrompt(claim, argument, goal, assumptions, settledClaims),
  settlePrecheck: (node, _result, incomingEvidence) => {
    const have = node.evidenceRefs.length + incomingEvidence.length;
    return have > 0
      ? { ok: true }
      : {
          ok: false,
          reason:
            'a finding can only be settled when backed by at least one cited source or observation — ' +
            'gather evidence and pass it via the `evidence` field, then settle again',
        };
  },
  renderReport: (session, nodes) => renderDeliberateReport(session, nodes),
};

export const PROFILES: Record<ReasoningSessionMode, ReasoningProfile> = {
  formal: FORMAL_PROFILE,
  deliberate: DELIBERATE_PROFILE,
};

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

// 2026-06-07: per-scenario reasoning effort. Deep-reasoning rounds (proof search / discovery) are complex
// multi-step agents → default to `max` thinking effort per DeepSeek's "complex agent → max" guidance.
// Skeptics are independent verifiers → `high` is enough. Both tunable via env; invalid values fall back.
function resolveEffort(raw: string | undefined, fallback: 'low' | 'medium' | 'high' | 'max'): 'low' | 'medium' | 'high' | 'max' {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' || v === 'max' ? v : fallback;
}
/** Reasoning config for the deep_explore proof-search / discovery rounds. env PHILONT_DEEP_EXPLORE_EFFORT ∈ {low,medium,high,max}, default max. */
const DEEP_EXPLORE_REASONING: ReasoningConfig = {
  enabled: true,
  effort: resolveEffort(process.env.PHILONT_DEEP_EXPLORE_EFFORT, 'max'),
};
/** Reasoning config for the adversarial skeptic verifiers. env PHILONT_DEEP_EXPLORE_SKEPTIC_EFFORT ∈ {low,medium,high,max}, default high. */
const DEEP_EXPLORE_SKEPTIC_REASONING: ReasoningConfig = {
  enabled: true,
  effort: resolveEffort(process.env.PHILONT_DEEP_EXPLORE_SKEPTIC_EFFORT, 'high'),
};
/** Reasoning config for the one-shot literature-grounding pass (retrieval + synthesis, not deep proof → medium). env PHILONT_DEEP_EXPLORE_LIT_GROUNDING_EFFORT ∈ {low,medium,high,max}, default medium. */
const DEEP_EXPLORE_LIT_GROUNDING_REASONING: ReasoningConfig = {
  enabled: true,
  effort: resolveEffort(process.env.PHILONT_DEEP_EXPLORE_LIT_GROUNDING_EFFORT, 'medium'),
};

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
      // 2026-06-07: skeptics are independent verifiers → high reasoning effort (tunable via PHILONT_DEEP_EXPLORE_SKEPTIC_EFFORT).
      reasoning: DEEP_EXPLORE_SKEPTIC_REASONING,
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
      { signal: opts.abortSignal },
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
  actions?: ActionLog,
  profile: ReasoningProfile = FORMAL_PROFILE,
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
      let result = typeof input.result === 'string' ? input.result : null;
      const approach = typeof input.approach === 'string' ? input.approach : undefined;
      const evidence = Array.isArray(input.evidence)
        ? input.evidence.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map((e) => e.trim())
        : [];
      if (!RECORD_STATUSES.has(status)) {
        return { ok: false, output: '', error: `status must be proved/refuted/dead_end, got ${String(status)}` };
      }
      const writeEvidence = (nid: string) => {
        for (const e of evidence) reasoning.updateNode(sessionId, nid, { addEvidence: e });
      };

      // Estimate-honesty gate (FORMAL only, advisory): a node recorded "proved" on an asymptotic/quantitative
      // ESTIMATE in a session that never ran a verification tool is annotated as unverified. Fail-open.
      if (profile.id === 'formal' && status === 'proved' && result && !sessionVerifierUsed.has(sessionId) && findOrderClaim(result)) {
        result += ESTIMATE_CAVEAT;
      }

      if (status === 'proved') {
        const target = reasoning.getNode(sessionId, nodeId);
        if (!target) {
          const nodes = reasoning.getNodes(sessionId);
          return {
            ok: false,
            output: '',
            error: `Node ${nodeId} does not exist in this session. Current open nodes: [${formatOpenIds(nodes)}]; retry with a real id.`,
          };
        }
        // Profile settle-precheck (deliberate: require cited evidence). On reject keep any gathered evidence,
        // leave the node open, and tell the model what is missing.
        const pre = profile.settlePrecheck(target, result, evidence);
        if (!pre.ok) {
          writeEvidence(nodeId);
          reasoning.updateNode(sessionId, nodeId, { appendApproach: `not ${profile.settledVerb}: ${pre.reason ?? 'precheck failed'}` });
          return {
            ok: true,
            output: `Node [${nodeId}] not ${profile.settledVerb}: ${pre.reason ?? 'precheck failed'} Node stays open — address that and settle again.`,
          };
        }
        // Adversarial review (skeptics), when enabled.
        if (verifyProved) {
          const tally = await verifyProved(target, result);
          if (tally && !tally.confirmed) {
            const objection = tally.topObjection ? `: ${tally.topObjection}` : '';
            writeEvidence(nodeId); // keep the evidence the model gathered, even though it didn't pass
            reasoning.updateNode(sessionId, nodeId, {
              appendApproach: `refuted by ${tally.refutedCount}/${tally.validVotes} reviewers${objection}`,
            });
            return {
              ok: true,
              output:
                `Node [${nodeId}] did not pass adversarial verification (${tally.refutedCount}/${tally.validVotes} reviewers refuted it); not recorded, node stays open. ` +
                `The objection has been saved to backtracking memory. Strengthen it and settle again, or take another path.` +
                (tally.topObjection ? `\nMain objection: ${tally.topObjection}` : ''),
            };
          }
          reasoning.updateNode(sessionId, nodeId, { status: 'proved', result });
          writeEvidence(nodeId);
          const vmark =
            tally && tally.validVotes > 0 ? ` (passed adversarial verification by ${tally.validVotes} reviewers)` : '';
          return { ok: true, output: `Recorded [${nodeId}] = ${profile.settledVerb}${result ? `: ${result}` : ''}${vmark}` };
        }
        // No skeptics: commit directly.
        reasoning.updateNode(sessionId, nodeId, { status: 'proved', result });
        writeEvidence(nodeId);
        return { ok: true, output: `Recorded [${nodeId}] = ${profile.settledVerb}${result ? `: ${result}` : ''}` };
      }

      // refuted / dead_end
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
      writeEvidence(nodeId);
      return { ok: true, output: `Recorded [${nodeId}] = ${status}${result ? `: ${result}` : ''}` };
    }

    // Delegate everything else (read-only research tools + verify teeth z3Verify/pariGp/magnitude).
    const result = await delegate(name, input);
    // Estimate-honesty: a successful verification call clears the session's "never verified" flag.
    if (result.ok && VERIFIER_TOOLS.has(name)) sessionVerifierUsed.add(sessionId);
    // Surface verify-tool failures to the operator log — otherwise a broken pariGp (gp missing,
    // spawn error, timeout, bad script) is silent except for a "⚠ pariGp" status ping, and the
    // computational verification quietly never works. The full error stays in the sub-LLM's tool_result.
    if (!result.ok && (name === 'pariGp' || name === 'z3Verify' || name === 'magnitude')) {
      console.warn(`[deep-explore] ${name} failed: ${(result.error ?? '(no error message)').slice(0, 400)}`);
      // Learn from it: stash this failure (deduped by signature) so the next round's prompt warns
      // the model off repeating the same pariGp/z3 mistake (renderRecentToolFailures).
      recordSessionToolFailure(sessionId, name, result.error);
      // Durable path: also log into the action ledger under a DEDICATED session id (not the
      // global timeline) so it never skews the chat turn's success-ratio, yet the idle
      // consolidator's reflector (time-ranged, session-agnostic) still sees it and can distil a
      // cross-session lesson. pariGp/z3Verify are excluded from same-root-cause counting
      // (failure_signatures.ts), so this adds no reflection noise.
      actions?.log({
        sessionId: `deep-explore:${sessionId}`,
        trigger: 'deep_explore',
        toolName: name,
        params: input,
        result: result.error ?? null,
        success: false,
      });
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
  /** Action ledger — compute-tool (pariGp/z3) failures are logged here (under a dedicated session id) so the reflector can distil durable lessons. */
  actions?: ActionLog;
  /** Skill store — learned compute lessons (incl. negative anti-patterns) are surfaced back into the round prompt. */
  skills?: SkillStore;
  maxIters?: number;
  onStatus?: (text: string) => void;
  /** Per-round progress summary sink. Unlike onStatus (per-iteration pings, console-only), this
   *  carries the round's milestone summary (nodes expanded / lemmas proved) to the user-facing
   *  status stream so multi-minute rounds are not silent. */
  onMilestone?: (text: string) => void;
}

export function createDeepExploreTool(
  deps: DeepExploreDeps,
): { tool: Tool; advanceSession: (session: ReasoningSession) => Promise<ToolResult> } {
  const { reasoning, miniLoopLLM, subTurnToolRunner, readOnlyToolDefs, actions, skills } = deps;
  const maxIters = deps.maxIters ?? DEFAULT_MAX_ITERS;
  // Per-profile runtimes: the tool whitelist depends on the session's mode (FORMAL = math verify tools, no
  // web; DELIBERATE = web + the user's own data, evidence as substrate). Precompute both from the fixed
  // readOnlyToolDefs (which already includes web tools) and pick per round by session.mode.
  // reason_* must be explicitly whitelisted or the mini-loop's gateToolCall intercepts them.
  function buildProfileRuntime(profile: ReasoningProfile): {
    researchDefs: ToolDefinition[];
    toolDefs: ToolDefinition[];
    whitelist: ReadonlySet<string>;
  } {
    const researchDefs = readOnlyToolDefs.filter((d) => profile.toolAllow.has(d.name));
    return {
      researchDefs,
      toolDefs: [...REASON_TOOL_DEFS, ...researchDefs],
      whitelist: new Set([...REASON_TOOL_NAMES, ...researchDefs.map((d) => d.name)]),
    };
  }
  const PROFILE_RT: Record<ReasoningSessionMode, ReturnType<typeof buildProfileRuntime>> = {
    formal: buildProfileRuntime(FORMAL_PROFILE),
    deliberate: buildProfileRuntime(DELIBERATE_PROFILE),
  };

  // Adversarial verification hook factory: before a node is settled, dispatch skeptic sub-LLMs (read-only,
  // do not touch the tree) to attempt refutation, using the PROFILE's skeptic prompt + tool set (formal:
  // "find the proof gap" + z3/recall; deliberate: "is it evidence-backed?" + web/recall). Tokens count
  // against the session budget. SKEPTIC_COUNT=0 disables, reverting to old behaviour.
  function buildVerifyProved(session: ReasoningSession, abortSignal: AbortSignal, profile: ReasoningProfile) {
    if (SKEPTIC_COUNT <= 0) return undefined;
    return async (node: ReasoningNode, argument: string | null): Promise<VerificationTally> => {
      const all = reasoning.getNodes(session.id);
      const provedClaims = all
        .filter((n) => n.status === 'proved' && n.id !== node.id)
        .map((n) => n.claim);
      const sys = profile.buildSkepticPrompt(node.claim, argument, session.goal, session.assumptions, provedClaims);
      // Skeptics get the profile's research tools minus pariGp (formal: z3+recall; deliberate: web+recall).
      // 2026-06-08: pariGp is excluded — skeptics burned their whole budget retrying malformed PARI/GP
      // scripts instead of reviewing; z3 covers rigorous formal refutation, web covers evidence checks.
      const skepticToolDefs = PROFILE_RT[profile.id].researchDefs.filter((d) => d.name !== 'pariGp');
      const tally = await runAdversarialVerification({
        llm: miniLoopLLM,
        systemPrompt: sys,
        count: SKEPTIC_COUNT,
        toolDefs: skepticToolDefs, // read-only research + z3, no pariGp, no reason_*
        toolRunner: subTurnToolRunner, // delegate directly; skeptics do not modify the tree
        whitelist: new Set(skepticToolDefs.map((d) => d.name)),
        maxIters: SKEPTIC_MAX_ITERS,
        onStatus: deps.onStatus,
        abortSignal,
      });
      reasoning.addBudgetSpent(session.id, tally.tokensSpent);
      return tally;
    };
  }

  /**
   * One-shot literature-grounding pass (see the LIT_GROUNDING block above). Runs the EXISTING web tools
   * (from readOnlyToolDefs, normally filtered out of the reasoning loop) in a single bounded mini-loop,
   * parses cited cards, caches them for prompt injection, and returns them for the start milestone. Fully
   * graceful: no web tools / disabled / error / timeout → returns [] and the session proceeds without it.
   */
  async function groundFromLiterature(session: ReasoningSession): Promise<LiteratureCard[]> {
    if (!LIT_GROUNDING_ENABLED) return [];
    const webDefs = readOnlyToolDefs.filter((d) => WEB_TOOL_NAMES.has(d.name));
    if (webDefs.length === 0) {
      console.warn('[deep-explore] literature grounding skipped: no web tools available in readOnlyToolDefs');
      return [];
    }
    // Profile-aware grounding: formal surveys literature/SOTA/no-go; deliberate surveys factors/tradeoffs/pitfalls.
    const profile = PROFILES[session.mode] ?? FORMAL_PROFILE;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIT_GROUNDING_TIMEOUT_MS);
    let cards: LiteratureCard[] = [];
    try {
      const result = await runMiniAgentLoop({
        systemPrompt: profile.buildGroundingPrompt(session.goal, session.assumptions),
        userMessage: 'Run the grounding search for the goal/question above and output ONLY the JSON array of cards.',
        llm: miniLoopLLM,
        toolDefs: webDefs,
        toolRunner: subTurnToolRunner, // the general runner CAN reach web; the per-round reasoning whitelist still cannot
        maxIters: LIT_GROUNDING_MAX_ITERS,
        toolWhitelist: WEB_TOOL_NAMES,
        onStatus: deps.onStatus,
        abortSignal: ctrl.signal,
        reasoning: DEEP_EXPLORE_LIT_GROUNDING_REASONING,
      });
      reasoning.addBudgetSpent(session.id, result.llmTokensSpent);
      cards = parseLiteratureCards(result.finalText, LIT_GROUNDING_MAX_CARDS);
    } catch (e) {
      console.warn(`[deep-explore] literature grounding failed: ${String(e).slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }
    if (cards.length) sessionLiterature.set(session.id, cards);
    return cards;
  }

  async function runRound(session: ReasoningSession): Promise<ToolResult> {
    if (session.budgetSpent >= SESSION_TOKEN_BUDGET) {
      return {
        success: true,
        output: `This reasoning session has used ${session.budgetSpent} tokens, hitting the budget cap (${SESSION_TOKEN_BUDGET}); paused. Continue later with a fresh angle, or treat it as stuck.`,
      };
    }
    // Resolve the reasoning profile (formal proof vs general evidence-based deliberation) from the session.
    const profile = PROFILES[session.mode] ?? FORMAL_PROFILE;
    const rt = PROFILE_RT[profile.id];
    // Feasibility gate: populate (or re-derive after a restart) this session's known barriers so the
    // round prompt can inject them. Cheap, pure, cached per session.
    ensureBarriers(session);

    // Wall-clock budget for the WHOLE round (scoring + mini-loop). The timer starts HERE, before the
    // value-guided scoring, so the round's total wall-clock stays under the cap. Previously the timer
    // only covered the mini-loop, so a large-frontier scoring call (one LLM pass over all open nodes)
    // ran OUTSIDE the budget and overran the "6-minute" cap by ~60–80s. The scoring call is now passed
    // ctrl.signal so the deadline can also cut it short.
    const ctrl = new AbortController();
    let timedOut = false;
    const roundDeadlineMs = effectiveRoundDeadlineMs();
    const deadlineTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, roundDeadlineMs);

    // Value-guided node selection (LATS / rStar style): an independent aux-LLM scores
    // frontier nodes on "value × tractability", persisted to nodes; at render time nodes are
    // ranked by UCB (value exploit + visits exploration) with the top one recommended.
    // VALUE_GUIDED=0 disables (reverts to depth/creation order + "LLM picks for itself").
    // frontier < 2 is not worth scoring; the call is abortable so the deadline can cut it.
    const before0 = reasoning.getNodes(session.id);
    if (VALUE_GUIDED) {
      const frontier0 = computeFrontier(before0);
      if (frontier0.length >= 2) {
        const { assessments, tokensSpent } = await scoreFrontierValues({
          llm: miniLoopLLM,
          goal: session.goal,
          assumptions: session.assumptions,
          frontier: frontier0,
          abortSignal: ctrl.signal,
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
    const systemPrompt = profile.buildRoundPrompt(session, before, collectComputeLessons(skills));
    const userMessage =
      profile.buildUserMessage(session, before.length <= 1) + buildStuckDirective(session.noProgressRounds ?? 0);

    // Proactive heads-up partway through the round so a long round does not end "silently":
    // tell the user it is approaching the per-round time cap and will wrap up & save soon.
    const warnAtMs = Math.round(roundDeadlineMs * 0.75);
    const warnTimer = setTimeout(() => {
      deps.onMilestone?.(
        `⏳ This round is approaching the ${Math.round(roundDeadlineMs / 60_000)}-minute time cap; ` +
        `it will pause and save the tree shortly — reply "continue" to keep going.`,
      );
    }, warnAtMs);

    const { runner: boundRunner, stalled } = withNoProgressStop(
      makeReasoningToolRunner(
        reasoning,
        session.id,
        subTurnToolRunner,
        buildVerifyProved(session, ctrl.signal, profile),
        actions,
        profile,
      ),
      () => ctrl.abort(),
      // Stop a round that has made NO tree commit for half the round budget (the slow all-pariGp spin).
      { noProgressTimeoutMs: Math.round(roundDeadlineMs * 0.5) },
    );
    let result;
    try {
      result = await runMiniAgentLoop({
        systemPrompt,
        userMessage,
        llm: miniLoopLLM,
        toolDefs: rt.toolDefs,
        toolRunner: boundRunner,
        maxIters,
        toolWhitelist: rt.whitelist,
        onStatus: deps.onStatus,
        abortSignal: ctrl.signal,
        // 2026-06-07: proof-search round is a complex multi-step agent → max reasoning effort (tunable via PHILONT_DEEP_EXPLORE_EFFORT).
        reasoning: DEEP_EXPLORE_REASONING,
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
    // Cross-round stuck tracking: did this round make any net tree progress?
    const madeProgress =
      summary.newlyProved.length > 0 ||
      summary.newlyRefuted.length > 0 ||
      summary.newDeadEnds.length > 0 ||
      summary.decomposedInto > 0;
    // Tooth B: only SUBSTANTIVE progress resets the stuck counter — trivial churn (decomposing /
    // "proving" low-value sub-lemmas around a wall) accrues toward pivot/escalate instead of masking it.
    const substantive = STRICT_PROGRESS ? roundWasSubstantive(before, after, SUBSTANTIVE_VALUE) : madeProgress;
    const noProgressRounds = reasoning.recordRoundProgress(session.id, substantive);
    // Post-loop convergence judgment (sub-LLM is not given reason_close).
    const status = judgeConvergence(after);
    if (status !== 'active') reasoning.setSessionStatus(session.id, status);

    const text = renderProgressText(summary, result.hitCap, status, profile.settledVerb);
    deps.onMilestone?.(text);
    const tail =
      result.error === 'aborted'
        ? stalled.value
          ? '\n(no tree progress for a while this round — only failed/unproductive tool calls — so it stopped early; tree saved. Try a different angle / new idea, or reply "continue".)'
          : timedOut
            ? `\n(this round hit the ${Math.round(roundDeadlineMs / 60_000)}-minute time cap; tree saved — reply "continue" to keep going)`
            : '\n(this round was aborted; tree saved, you can continue)'
        : '';
    // Tooth B: when a round made nominal commits but no SUBSTANTIVE progress, say so — so a tree that
    // grows trivial lemmas around a wall reads as churn, not as a win.
    const churnNote =
      STRICT_PROGRESS && madeProgress && !substantive
        ? `\n(note: this round only expanded the tree / settled low-value nodes — the core frontier did ` +
          `not move, so it does not count as substantive progress.)`
        : '';
    // After enough stuck rounds, escalate to the user instead of grinding the same frontier silently.
    const stuckNote =
      status === 'active' && !substantive && noProgressRounds >= STUCK_ESCALATE_AFTER
        ? `\n⚠️ No substantive progress for ${noProgressRounds} consecutive rounds — this frontier looks stuck. ` +
          `Consider redirecting: start a fresh angle (a different framing of the problem), or tell me which sub-problem to focus on.`
        : '';
    return { success: true, output: `${text}${tail}${churnNote}${stuckNote}\nsession id: ${session.id}` };
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
    // Discover (experimental-math) is FORMAL-only for now — it is pariGp-driven conjecture generation.
    const profile = FORMAL_PROFILE;
    const rt = PROFILE_RT.formal;
    const before = reasoning.getNodes(session.id);
    const beforeConjectures = before.filter((n) => n.kind === 'conjecture').length;
    const systemPrompt = buildDiscoverPrompt(session, before, seed, collectComputeLessons(skills));
    const userMessage =
      `Do experimental-math exploration around "${seed.trim() || session.goal}": first use pariGp to compute data and find patterns, ` +
      `then hang conjectures that have pariGp evidence (counterexamples already searched) on the tree via reason_decompose (kind='conjecture'); record any killed by a counterexample as refuted.`;

    const ctrl = new AbortController();
    let timedOut = false;
    const roundDeadlineMs = effectiveRoundDeadlineMs();
    const deadlineTimer = setTimeout(() => { timedOut = true; ctrl.abort(); }, roundDeadlineMs);
    const warnTimer = setTimeout(() => {
      deps.onMilestone?.(
        `⏳ This round is approaching the ${Math.round(roundDeadlineMs / 60_000)}-minute time cap; ` +
        `it will pause and save the tree shortly — reply "continue" to keep going.`,
      );
    }, Math.round(roundDeadlineMs * 0.75));
    const { runner: boundRunner, stalled } = withNoProgressStop(
      makeReasoningToolRunner(
        reasoning,
        session.id,
        subTurnToolRunner,
        buildVerifyProved(session, ctrl.signal, profile),
        actions,
        profile,
      ),
      () => ctrl.abort(),
      // Stop a round that has made NO tree commit for half the round budget (the slow all-pariGp spin).
      { noProgressTimeoutMs: Math.round(roundDeadlineMs * 0.5) },
    );
    let result;
    try {
      result = await runMiniAgentLoop({
        systemPrompt,
        userMessage,
        llm: miniLoopLLM,
        toolDefs: rt.toolDefs,
        toolRunner: boundRunner,
        maxIters,
        toolWhitelist: rt.whitelist,
        onStatus: deps.onStatus,
        abortSignal: ctrl.signal,
        // 2026-06-07: discovery round is a complex multi-step search agent → max reasoning effort (tunable via PHILONT_DEEP_EXPLORE_EFFORT).
        reasoning: DEEP_EXPLORE_REASONING,
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
        ? stalled.value
          ? '\n(no new conjectures / progress for a while — stopped early; saved. Try a different angle, or continue.)'
          : timedOut
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

  /** Advance a specific session by one round (used by the background auto-advance loop). */
  const advanceSession = (session: ReasoningSession): Promise<ToolResult> => runRound(session);

  const tool: Tool = {
    name: 'deep_explore',
    description:
      'Deep-reasoning engine: persistent reasoning over a HARD, open-ended problem via "decompose into a ' +
      'tree → advance over many steps → settle / counter / backtrack", with state accumulating across turns ' +
      '(you can resume days later). Two modes:\n' +
      '• mode="formal" (default): a mathematical / formal PROOF — claims settled by machine-check + skeptic ' +
      '(z3/PARI-GP/asymptotics). Use for conjectures, theorems, proofs.\n' +
      '• mode="deliberate": a general open-ended JUDGMENT — decisions ("should I take this offer / pivot to ' +
      'B2B"), root-cause diagnosis ("why is retention dropping"), due diligence, untangling a multi-party ' +
      'situation. Claims are settled by CITED EVIDENCE (the user\'s own data + the web), not proof.\n' +
      'Call it when the user wants to think something hard through deeply over time — NOT for ordinary Q&A.\n' +
      'action="start": open a new reasoning session (goal = the proposition/question; pick mode; assumptions/context optional) and advance one round.\n' +
      'action="continue": keep advancing the most recent in-progress session (no id needed).\n' +
      'action="discover": **experimental-math mode** — use pariGp to compute data and find patterns, propose evidence-backed new conjectures and prune them by counterexample search, ' +
      'hanging survivors on the tree to prove later. Good when you don\'t yet know what to prove and want to discover patterns/conjectures first. Takes an optional seed (topic) or goal (creates a session if none is active).\n' +
      'action="status": just view the current tree\'s progress, without advancing. ' +
      '**Grounding rule: before you state ANY claim about exploration state — what is proved, what is still open, how many nodes, or whether a direction is "new/untried" — you MUST call action=status first and base the claim on what it returns. Never assert tree state, progress, or novelty from memory.** (status is read-only and needs no authorization.)\n' +
      'action="finalize": produce a wrap-up report of the whole tree so far (established lemmas, refuted/dead-end branches, most promising open directions), without advancing. ' +
      'Use this to give the user a conclusion when they ask to wrap up / for results, or for an open-ended problem that will not converge to a clean "solved" on its own.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'continue', 'discover', 'status', 'finalize', 'auto_on', 'auto_off'] },
        mode: { type: 'string', enum: ['formal', 'deliberate'], description: 'action=start: "formal" (default, math/proof) or "deliberate" (general evidence-based judgment — decisions/diagnosis/due-diligence).' },
        goal: { type: 'string', description: 'action=start: the proposition to prove (formal) or the question to think through (deliberate)' },
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
      // Owner = the chat session driving this turn. Scopes reasoning sessions so two concurrent
      // channels (e.g. WeChat + web-ui) cannot continue/hijack each other's most-recent-active session.
      const owner = currentSessionId();

      if (action === 'start') {
        const goal = typeof params.goal === 'string' ? params.goal.trim() : '';
        if (!goal) return { success: false, output: '', error: 'action=start needs a non-empty goal (the root proposition to attack)' };
        const assumptions = Array.isArray(params.assumptions)
          ? params.assumptions.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
          : [];
        const mode: ReasoningSessionMode = params.mode === 'deliberate' ? 'deliberate' : 'formal';
        const { session } = reasoning.createSession({ goal, assumptions, ownerSessionId: owner, mode });
        // Literature grounding: one-shot web pass surveying what is already known (cited cards), injected
        // into every round prompt + merged into the start milestone below. Runs before the first round.
        const litCards = await groundFromLiterature(session);
        // Feasibility gate: if this goal/method hits a KNOWN BARRIER, name it ONCE up front (before any
        // round burns time) — the parity-problem tooth. Advisory; exploration still proceeds.
        const applied = ensureBarriers(session).filter((m) => m.severity === 'applies');
        // Combined grounding milestone: feasibility barriers (curated) + what the literature pass found.
        const noteParts: string[] = [];
        if (applied.length) {
          noteParts.push(
            `⛔ Feasibility check — this goal/method hits a KNOWN BARRIER:\n${renderBarrierAdvisory(applied)}`,
          );
        }
        if (litCards.length) noteParts.push(renderLiteratureCards(litCards).join('\n'));
        if (noteParts.length) {
          deps.onMilestone?.(
            `📚 Grounding for "${goal.slice(0, 60)}${goal.length > 60 ? '…' : ''}":\n\n${noteParts.join('\n\n')}` +
              `\n\nAdvisory — I'll still explore, but build on what's known and route around any barrier above.`,
          );
        }
        return runRound(session);
      }

      if (action === 'continue') {
        const session = reasoning.getMostRecentActiveSession(owner);
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
        let session = reasoning.getMostRecentActiveSession(owner);
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
          session = reasoning.createSession({ goal, assumptions, ownerSessionId: owner }).session;
        }
        return runDiscoverRound(session, seed);
      }

      if (action === 'status') {
        const session = reasoning.getMostRecentActiveSession(owner);
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
        const session = reasoning.getMostRecentActiveSession(owner);
        if (!session) return { success: true, output: 'No deep-explore session to finalize.' };
        const report = (PROFILES[session.mode] ?? FORMAL_PROFILE).renderReport(session, reasoning.getNodes(session.id));
        deps.onMilestone?.(report); // persist as a chat bubble so the conclusion is not lost
        return { success: true, output: report };
      }

      if (action === 'auto_on' || action === 'auto_off') {
        const session = reasoning.getMostRecentActiveSession(owner);
        if (!session) {
          return { success: false, output: '', error: 'No in-progress reasoning session to toggle auto-advance on. Start one first.' };
        }
        reasoning.setAutoAdvance(session.id, action === 'auto_on');
        return {
          success: true,
          output:
            action === 'auto_on'
              ? `Background auto-advance ENABLED for "${session.goal.slice(0, 50)}". I'll advance it round by round on my own and report milestones; it stops automatically when solved or stuck (needs PHILONT_DEEP_EXPLORE_AUTO_ADVANCE=on on the server).`
              : `Background auto-advance DISABLED for "${session.goal.slice(0, 50)}".`,
        };
      }

      return { success: false, output: '', error: `Unknown action: ${String(action)}` };
    },
  };

  return { tool, advanceSession };
}
