/**
 * PursuitDriver — advances **engaged but stalled** active pursuits.
 *
 * Strictly complementary to CuriosityDriver's dormant-pursuit branch:
 *   - CuriosityDriver: evidenceRefs.length === 0 (commitment made but never touched)
 *   - PursuitDriver:   evidenceRefs.length > 0 (touched before but now stalled)
 *
 * Two advancement paths (at most 1 initiative produced per pursuit per tick):
 *   - advance-question: openQuestions[status='open'] is non-empty; pick the earliest one to research
 *   - check-resolution: no open questions but resolutionCriteria exists; check whether it has been met
 *
 * Skip conditions:
 *   - status !== 'active' (already guaranteed by listActive)
 *   - isEvergreen === true (root pursuit is the agent's identity itself; not "advanced")
 *   - lastTouchedAt is within the stalledDays threshold (still active, no push needed)
 *   - Already in the 24h dedup set (targetRef hit)
 *
 * When deadline is within 24h, utility is boosted by 0.1, capped at 0.95.
 */

import type {
  Driver,
  InitiativePlanStep,
  InitiativeProposal,
  MemorySnapshot,
} from '../types.js';

export interface PursuitDriverConfig {
  /** Number of days after which a pursuit is considered stalled; default 7 */
  stalledDays: number;
  /** Window (ms) for an upcoming deadline to be considered "soon"; default 24 hours */
  deadlineSoonMs: number;
  /** Maximum candidates to produce per tick; default 3 */
  maxProposals: number;
}

export const DEFAULT_PURSUIT_CONFIG: PursuitDriverConfig = {
  stalledDays: 7,
  deadlineSoonMs: 24 * 60 * 60 * 1000,
  maxProposals: 3,
};

const DRIVER_NAME = 'pursuit';

export class PursuitDriver implements Driver {
  readonly name = DRIVER_NAME;

  /**
   * @param cfg       Configuration parameters
   * @param isGranted Active research "request permission": callback to check whether a gated tool
   *                  is currently authorized by the user. Passed as a function to avoid
   *                  agent-memory reverse-depending on agent-policy/GrantStore. Default =
   *                  always unauthorized (replay never triggers; same behavior as old version).
   */
  constructor(
    private readonly cfg: PursuitDriverConfig = DEFAULT_PURSUIT_CONFIG,
    private readonly isGranted?: (tool: string) => boolean,
  ) {}

  propose(snap: MemorySnapshot): InitiativeProposal[] {
    const proposals: InitiativeProposal[] = [];
    const stalledThreshold = snap.now - this.cfg.stalledDays * 86_400_000;

    for (const p of snap.activePursuits) {
      // Skip root identity (evergreen)
      if (p.isEvergreen) continue;

      const lastTouched = p.lastTouchedAt ?? p.updatedAt;

      // v24 active research: a pursuit where the user has asked for "ongoing research".
      // **Does not wait for staleness or require evidence** — advances the earliest open question
      // every tick (24h dedup prevents re-poking the same question); high utility ensures priority;
      // once all questions are answered, transitions to check-resolution.
      // Convergence (closing questions / hitting the iteration cap) is handled by PursuitProgressWriter.
      if (p.isActiveResearch) {
        const aq = p.openQuestions
          .filter((q) => q.status === 'open')
          .sort((a, b) => a.createdTurn - b.createdTurn);
        if (aq.length > 0) {
          const proposal = this.buildAdvanceQuestion(p, aq[0], lastTouched, snap, true);
          if (proposal) proposals.push(proposal);
        } else if (p.resolutionCriteria && p.resolutionCriteria.trim().length > 0) {
          const proposal = this.buildCheckResolution(p, lastTouched, snap, true);
          if (proposal) proposals.push(proposal);
        }
        continue;
      }

      // Still active within the stalled threshold; skip
      if (lastTouched > stalledThreshold) continue;

      // Must have been engaged before (otherwise hand off to CuriosityDriver)
      if (p.evidenceRefs.length === 0) continue;

      // Select advancement path
      const openQuestions = p.openQuestions
        .filter((q) => q.status === 'open')
        .sort((a, b) => a.createdTurn - b.createdTurn);

      if (openQuestions.length > 0) {
        const proposal = this.buildAdvanceQuestion(p, openQuestions[0], lastTouched, snap);
        if (proposal) proposals.push(proposal);
        continue;
      }

      if (p.resolutionCriteria && p.resolutionCriteria.trim().length > 0) {
        const proposal = this.buildCheckResolution(p, lastTouched, snap);
        if (proposal) proposals.push(proposal);
        continue;
      }

      // No open questions and no resolutionCriteria — cannot advance in read-only mode.
      // The pursuit itself first needs an LLM-side goal definition to be added; that is the
      // reflector's job, not PursuitDriver's.
    }

    proposals.sort((a, b) => b.utility - a.utility);
    return proposals.slice(0, this.cfg.maxProposals);
  }

  private buildAdvanceQuestion(
    p: MemorySnapshot['activePursuits'][number],
    q: {
      id: string;
      text: string;
      createdTurn: number;
      updatedTurn: number;
      status: string;
      pendingTool?: { tool: string; why: string } | null;
    },
    lastTouched: number,
    snap: MemorySnapshot,
    activeResearch = false,
  ): InitiativeProposal | null {
    const targetRef = `pursuit:${p.id}:q:${q.id}`;

    // Active research "request permission" replay: this question has a pending tool that the user
    // has now authorized → this is a replay; **skip dedup** (otherwise the previous needs-grant
    // round's done status would have put targetRef into the 24h dedup window, preventing a replay
    // from being issued within 24h of authorization). Normal dedup applies when not authorized or
    // no pendingTool.
    const grantedTool =
      activeResearch && q.pendingTool && this.isGranted?.(q.pendingTool.tool) === true
        ? q.pendingTool.tool
        : null;
    if (!grantedTool && snap.recentDoneTargetRefs.has(targetRef)) return null;

    const ageDays = Math.max(0, Math.floor((snap.now - lastTouched) / 86_400_000));
    // Active research: fixed high utility (0.9) ensures priority over gap/curiosity; otherwise computed from stake/age.
    const utility = activeResearch
      ? 0.9
      : scoreUtility(p.stakeWeight, ageDays, p.deadline, snap.now, this.cfg, 'q');

    // Base read-only plan; if the tool is now authorized, append the gated tool step at the end.
    // Note: params can only be constructed from the question text as a best effort (the driver
    // cannot write formal inputs for Lean/Z3 on behalf of the LLM) — proper on-demand parameter
    // construction belongs to "deep reasoning" future work; see roadmap. Research-type MCP tools
    // that accept a natural-language goal can be used directly; formal tools will receive the
    // query text and the executor evaluates output/errors afterward.
    const plan: InitiativePlanStep[] = [
      { tool: 'searchNotes', params: { query: q.text } },
      { tool: 'searchSkills', params: { query: q.text } },
      { tool: 'webSearch', params: { query: q.text } },
    ];
    if (grantedTool) {
      plan.push({ tool: grantedTool, params: { query: q.text, goal: q.text } });
    }

    return {
      kind: 'pursuit:advance-question',
      driver: DRIVER_NAME,
      targetRef,
      rationale: grantedTool
        ? `Active research "${p.title}": authorization granted, advancing open question "${truncate(q.text, 80)}" using ${grantedTool}.`
        : activeResearch
          ? `Active research "${p.title}": advancing open question "${truncate(q.text, 80)}", research and produce fact/note.`
          : `pursuit "${p.title}" stake=${p.stakeWeight}/10 has not been touched for ${ageDays} days (evidence=${p.evidenceRefs.length}), ` +
            `has unresolved open question "${truncate(q.text, 80)}". Research and produce fact/note to advance it.`,
      utility,
      budgetEstimate: 1800,
      plan,
    };
  }

  private buildCheckResolution(
    p: MemorySnapshot['activePursuits'][number],
    lastTouched: number,
    snap: MemorySnapshot,
    activeResearch = false,
  ): InitiativeProposal | null {
    const targetRef = `pursuit:${p.id}:resolve`;
    if (snap.recentDoneTargetRefs.has(targetRef)) return null;

    const ageDays = Math.max(0, Math.floor((snap.now - lastTouched) / 86_400_000));
    const utility = activeResearch
      ? 0.85
      : scoreUtility(p.stakeWeight, ageDays, p.deadline, snap.now, this.cfg, 'r');

    return {
      kind: 'pursuit:check-resolution',
      driver: DRIVER_NAME,
      targetRef,
      rationale:
        `pursuit "${p.title}" stake=${p.stakeWeight}/10 has not been touched for ${ageDays} days, ` +
        `has ${p.evidenceRefs.length} evidence entries. Check whether resolutionCriteria ` +
        `"${truncate(p.resolutionCriteria ?? '', 80)}" has been met, and produce an audit note.`,
      utility,
      budgetEstimate: 1500,
      plan: [
        { tool: 'searchNotes', params: { query: p.title } },
        { tool: 'listFacts', params: { namespace: 'project' } },
      ],
    };
  }
}

/**
 * Utility calculation:
 *   advance-question path:  base 0.55 + 0.05*(stake-5) + min(0.15, 0.005*ageDays)
 *   check-resolution path:  base 0.55 + 0.05*(stake-5) + min(0.10, 0.003*ageDays)
 * deadline < 24h adds 0.10.
 *
 * Capped at 0.95 (avoids pushing too far above K7-bridge's 0.9), floor at 0.5.
 */
function scoreUtility(
  stakeWeight: number,
  ageDays: number,
  deadline: number | null,
  now: number,
  cfg: PursuitDriverConfig,
  kind: 'q' | 'r',
): number {
  const base = 0.55 + 0.05 * (stakeWeight - 5);
  const ageBonus =
    kind === 'q'
      ? Math.min(0.15, 0.005 * ageDays)
      : Math.min(0.1, 0.003 * ageDays);
  const deadlineBonus =
    deadline !== null && deadline > now && deadline - now < cfg.deadlineSoonMs ? 0.1 : 0;
  return Math.max(0.5, Math.min(0.95, base + ageBonus + deadlineBonus));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}
