/**
 * GapDriver — proactive research trigger source for scanning "knowledge gaps".
 *
 * Three sources:
 *   1. memory_facts: confidence < threshold or sourceRefs empty, and created_at < N days ago
 *      → verify or supplement sources
 *   2. routing_rules: confidence='disputed' and consecutive_failures >= N
 *      → review history / docs to re-evaluate
 *   3. memory_skills: maturity='draft' and consecutive_failures >= N (not yet deprecated)
 *      → self-audit skill content to identify what is failing
 *
 * Does not write DB, does not call LLM — pure propose. Loop takes candidates, passes budget gate → executor runs plan.
 */

import type {
  Driver,
  InitiativeProposal,
  MemorySnapshot,
} from '../types.js';

export interface GapDriverConfig {
  /** Facts with confidence below this value are considered "gaps"; default 0.3 */
  factConfidenceThreshold: number;
  /** Window (days) within which a fact is considered "recently written"; default 7 — old facts are not actively verified (managed by the aging mechanism) */
  factRecentDays: number;
  /** Routing rule trigger threshold: disputed + consecutive_failures >= N; default 2 */
  routingMinConsecutiveFailures: number;
  /** Skill trigger threshold: draft + consecutive_failures >= N; default 2 */
  skillMinConsecutiveFailures: number;
  /** Maximum candidates to produce per tick; default 5 */
  maxProposals: number;
}

export const DEFAULT_GAP_CONFIG: GapDriverConfig = {
  factConfidenceThreshold: 0.3,
  factRecentDays: 7,
  routingMinConsecutiveFailures: 2,
  skillMinConsecutiveFailures: 2,
  maxProposals: 5,
};

const DRIVER_NAME = 'gap';

export class GapDriver implements Driver {
  readonly name = DRIVER_NAME;

  constructor(private readonly cfg: GapDriverConfig = DEFAULT_GAP_CONFIG) {}

  propose(snap: MemorySnapshot): InitiativeProposal[] {
    const proposals: InitiativeProposal[] = [];
    const recentCutoff = snap.now - this.cfg.factRecentDays * 86_400_000;

    // (1) Fact gap
    for (const f of snap.facts) {
      // Exclude self.* — managed by SelfReflector, not in the gap path
      if (f.namespace === 'self') continue;
      if (f.namespace === 'system') continue;
      if (f.createdAt < recentCutoff) continue;

      const v = f.value as unknown;
      const sourceRefsEmpty =
        !v ||
        typeof v !== 'object' ||
        !('sourceRefs' in v) ||
        !Array.isArray((v as { sourceRefs?: unknown }).sourceRefs) ||
        ((v as { sourceRefs: unknown[] }).sourceRefs.length ?? 0) === 0;
      const lowConfidence = f.confidence < this.cfg.factConfidenceThreshold;
      if (!lowConfidence && !sourceRefsEmpty) continue;

      const targetRef = `fact:${f.id}`;
      if (snap.recentDoneTargetRefs.has(targetRef)) continue;

      const reasons: string[] = [];
      if (lowConfidence) reasons.push(`confidence=${f.confidence.toFixed(2)} too low`);
      if (sourceRefsEmpty) reasons.push('no sourceRefs');
      const utility = 0.6 + 0.2 * (1 - f.confidence);
      proposals.push({
        kind: 'fact_gap',
        driver: DRIVER_NAME,
        targetRef,
        rationale:
          `fact ${f.namespace}.${f.key} ${reasons.join(' + ')}; needs online lookup or note search to verify`,
        utility: Math.min(0.85, utility),
        budgetEstimate: 1500,
        plan: [
          {
            tool: 'webSearch',
            params: { query: `${f.namespace} ${f.key}` },
          },
        ],
      });
    }

    // (2) Routing dispute
    for (const r of snap.routingRules) {
      if (r.confidence !== 'disputed') continue;
      if (r.consecutiveFailures < this.cfg.routingMinConsecutiveFailures) continue;
      const targetRef = `routing:${r.id}`;
      if (snap.recentDoneTargetRefs.has(targetRef)) continue;

      proposals.push({
        kind: 'routing_dispute',
        driver: DRIVER_NAME,
        targetRef,
        rationale:
          `routing rule "${r.taskSignature}" is disputed with ${r.consecutiveFailures} consecutive failures; ` +
          `should review docs/notes to determine if the carveout condition is too broad`,
        utility: 0.7,
        budgetEstimate: 1800,
        plan: [
          {
            tool: 'searchNotes',
            params: { query: r.taskSignature },
          },
        ],
      });
    }

    // (3) Failing draft skill
    for (const s of snap.skills) {
      if (s.maturity !== 'draft') continue;
      if (s.consecutiveFailures < this.cfg.skillMinConsecutiveFailures) continue;
      const targetRef = `skill:${s.name}`;
      if (snap.recentDoneTargetRefs.has(targetRef)) continue;

      proposals.push({
        kind: 'skill_failing',
        driver: DRIVER_NAME,
        targetRef,
        rationale:
          `skill "${s.name}" is in draft state with ${s.consecutiveFailures} consecutive failures; ` +
          `should review the template to find the failing step, add a carveout, or demote to playbook`,
        utility: 0.65,
        budgetEstimate: 1500,
        plan: [
          {
            tool: 'searchSkills',
            params: { query: s.name },
          },
        ],
      });
    }

    proposals.sort((a, b) => b.utility - a.utility);
    return proposals.slice(0, this.cfg.maxProposals);
  }
}
