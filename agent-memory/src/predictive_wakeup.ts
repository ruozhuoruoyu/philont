/**
 * Predictive pre-action · deadline pursuit → scheduled soft wakeup (2026-05-29)
 *
 * Direction (established in a full discussion): philont's intrinsic drive currently only takes effect
 * at the **perception layer** (fire signal → rendered into the next turn's prompt) — reactive and after-the-fact.
 * This module takes the first step toward "predictive behavior" — pre-acting based on a forward model
 * **before** demand manifests. Lives on the **scheduler side** (predict → soft wakeup);
 * **does not touch interrupts, does not touch the turn loop, adds no preemption**.
 *
 * First slice (this file) narrows to deadline-based pursuit: for an active pursuit with a deadline
 * and sufficient stake, schedule a one-shot `autonomous_turn` before the deadline bites (lead time)
 * to do read-only preparation, so the user is ready when they return near the deadline.
 *
 * Honest boundary: under deadline-only, "projection" degrades to `deadline − lead`, not solving the
 * commitment_pressure trajectory equation (that is for the deferred aggregated version). The value of
 * this slice is **running through the full predictive loop** (detect → schedule pre-action → fire →
 * pre-act → reconcile/cancel); this loop is the foundation reused by later aggregated trajectory
 * projection and "prediction-error-driven curiosity".
 *
 * Idempotency comes from `projectPursuitWakeup`'s `wake <= now → null` rule: once the wakeup fires
 * (disabled by ScheduleStore.markRun), now >= wake → desired becomes null → reconcile does not recreate.
 * No additional "already fired" guard is needed.
 */

import type { Pursuit } from './types.js';
import type { ScheduleStore } from './schedules.js';

export interface PredictiveWakeupOpts {
  /** How far before the deadline to pre-act. Default 30min */
  leadMs?: number;
  /** Only pre-act for pursuits with stakeWeight >= this value (do not waste an autonomous turn on trivia). Default 7 */
  minStake?: number;
  /** Do not pre-schedule if deadline is beyond this horizon (too far away; wait until closer). Default 7d */
  horizonMs?: number;
  /** Do not recreate if existing wakeup's nextRunAt deviates from desired by within this tolerance (prevents per-tick thrash). Default 60s */
  toleranceMs?: number;
}

const DEFAULTS: Required<PredictiveWakeupOpts> = {
  leadMs: 30 * 60_000,
  minStake: 7,
  horizonMs: 7 * 24 * 3600_000,
  toleranceMs: 60_000,
};

/**
 * Pure function: computes "when to pre-act" for a pursuit, or null (should not pre-act).
 *
 * Rules (any unsatisfied → null):
 *   - status === 'active' (non-active pursuits are not pre-acted)
 *   - !isEvergreen (root-identity pursuits are not pre-acted)
 *   - deadline != null (no deadline = cannot project)
 *   - stakeWeight >= minStake (trivia not worth an advance autonomous turn)
 *   - deadline - now <= horizonMs (too far away; wait until closer)
 *   - wake = deadline - leadMs > now (already in the lead window / already past →
 *     let existing commitment_pressure render handle urgency; scheduling a wakeup is pointless; also key to idempotency)
 */
export function projectPursuitWakeup(
  p: Pursuit,
  now: number,
  opts: PredictiveWakeupOpts = {},
): number | null {
  const o = { ...DEFAULTS, ...opts };
  if (p.status !== 'active') return null;
  if (p.isEvergreen) return null;
  if (p.deadline == null) return null;
  if (p.stakeWeight < o.minStake) return null;
  if (p.deadline - now > o.horizonMs) return null;
  const wake = p.deadline - o.leadMs;
  if (wake <= now) return null;
  return wake;
}

/**
 * Generate pre-action instructions (payload.prompt for autonomous_turn).
 * Read-only preparation + guard clause (if already complete / irrelevant / just advanced, note it and stop).
 */
export function buildPursuitPreactionPrompt(p: Pursuit): string {
  const lines: string[] = [];
  lines.push('[Predictive pre-action] You have a commitment (pursuit) with an approaching deadline. **Prepare for it in advance now,**');
  lines.push('so that when the deadline arrives you are ready — this is not execution, it is preparation.');
  lines.push('');
  lines.push('## Commitment');
  lines.push(`- Title: ${p.title}`);
  lines.push(`- Goal: ${p.intent}`);
  if (p.deadline != null) lines.push(`- deadline: ${new Date(p.deadline).toISOString()}`);
  if (p.resolutionCriteria) lines.push(`- Completion criteria: ${p.resolutionCriteria}`);
  const open = (p.openQuestions ?? []).filter((q) => q.status === 'open');
  if (open.length > 0) {
    lines.push('- Open questions:');
    for (const q of open.slice(0, 5)) lines.push(`  - ${q.text}`);
  }
  lines.push('');
  lines.push('## What to do now (read-only preparation)');
  lines.push('- Use read-only tools (search_notes / search_skills / web_search / list_facts / read_file)');
  lines.push('  to research the open questions / completion criteria above.');
  lines.push('- Write useful findings as facts / notes (with source), for direct retrieval when you return near the deadline.');
  lines.push('- **Do not** do anything with side effects (write files / send messages / change external state).');
  lines.push('');
  lines.push('## Guard');
  lines.push('- If this commitment is actually already complete / no longer relevant / was just advanced recently, **do not force it**:');
  lines.push('  note the current state in one sentence, then stop.');
  return lines.join('\n');
}

export interface ReconcileResult {
  created: number;
  updated: number;
  cancelled: number;
}

const PREDICT_NAME_PREFIX = 'predict:pursuit:';
function wakeupName(pursuitId: string): string {
  return `${PREDICT_NAME_PREFIX}${pursuitId}`;
}
function pursuitIdFromName(name: string): string | null {
  return name.startsWith(PREDICT_NAME_PREFIX)
    ? name.slice(PREDICT_NAME_PREFIX.length)
    : null;
}

function createWakeup(schedules: ScheduleStore, pursuit: Pursuit, wake: number): void {
  schedules.create({
    name: wakeupName(pursuit.id),
    cronExpr: null, // one-shot: markRun sets enabled=0 after fire
    nextRunAt: wake,
    actionType: 'autonomous_turn',
    payload: { prompt: buildPursuitPreactionPrompt(pursuit), replyChannel: 'silent' },
    createdBy: 'system', // → Internal origin (autonomous pre-action, not an external instruction)
  });
}

/**
 * Desired-state reconcile (idempotent, self-correcting). Called once per idle tick.
 *
 * For each active pursuit: compute desired wakeup time → ensure `predict:pursuit:<id>` wakeup matches it
 * (create if absent / reschedule if deviation exceeds tolerance / leave unchanged within tolerance / cancel if desired is null).
 * At the end: **orphan sweep** — enabled predict:pursuit:* wakeups whose pursuit is no longer in the active set
 * (closed/deleted) → cancel.
 *
 * Only touches enabled wakeups (findByName / list({enabledOnly:true}) both filter for enabled);
 * historical rows that have already fired (disabled) are left untouched for audit.
 */
export function reconcilePredictiveWakeups(args: {
  pursuits: Pursuit[];
  now: number;
  schedules: ScheduleStore;
  opts?: PredictiveWakeupOpts;
}): ReconcileResult {
  const { pursuits, now, schedules } = args;
  const o = { ...DEFAULTS, ...(args.opts ?? {}) };
  let created = 0;
  let updated = 0;
  let cancelled = 0;

  const activeIds = new Set(pursuits.map((p) => p.id));

  for (const p of pursuits) {
    const desired = projectPursuitWakeup(p, now, o);
    const existing = schedules.findByName(wakeupName(p.id)); // enabled-only, latest

    if (desired == null) {
      if (existing) {
        schedules.delete(existing.id);
        cancelled++;
      }
      continue;
    }

    if (existing) {
      if (Math.abs(existing.nextRunAt - desired) > o.toleranceMs) {
        schedules.delete(existing.id);
        createWakeup(schedules, p, desired);
        updated++;
      }
      // else within tolerance → no change (idempotent)
    } else {
      createWakeup(schedules, p, desired);
      created++;
    }
  }

  // Orphan sweep: enabled predict wakeups outside the active set (pursuit already closed/deleted).
  for (const s of schedules.list({ enabledOnly: true })) {
    const pid = pursuitIdFromName(s.name);
    if (pid !== null && !activeIds.has(pid)) {
      schedules.delete(s.id);
      cancelled++;
    }
  }

  return { created, updated, cancelled };
}
