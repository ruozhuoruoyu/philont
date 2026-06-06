/**
 * PlanStore (v17, 2026-05-11): Complex task protocol persistence
 *
 * "Complex task" protocol (six-step closed-loop, modeled on OpenClaw's complex task protocol):
 *   1. LLM self-evaluates as slow mode
 *   2. plan_draft write → status='draft'
 *   3. plan_review(gaps=[], decision='pass') → status='reviewed'
 *      (chat-handler plan_protocol_gate unlocks other tools)
 *   4. Each step in execution phase calls plan_update_step to update progress; first step marked doing → status→'executing'
 *   5. Reflection triggers plan_revise → replaces steps + appends reviewHistory
 *   6. plan_close → status='completed' | 'failed' + outcome_summary
 *
 * This Store handles only storage and state transitions; chat-handler gate / reflection prompt assembly
 * is the caller's responsibility. All timestamps in ms.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  DeliverableStatus,
  Plan,
  PlanDeliverable,
  PlanInput,
  PlanReview,
  PlanStatus,
  PlanStep,
  PlanStepStatus,
} from './types.js';

interface PlanRow {
  id: string;
  session_id: string;
  task_signature: string | null;
  steps_json: string;
  status: string;
  review_history_json: string;
  guide_ref: string | null;
  outcome_summary: string | null;
  inner_iter: number;
  outer_iter: number;
  // v20 spec-coverage (2026-05-15, Phase 11)
  deliverables_json: string;
  deliverable_status_json: string | null;
  is_placeholder: number; // SQLite has no native boolean, 0/1
  // v22 Phase 13 (2026-05-17): project plan.md association
  persisted_to: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

// M5 (2026-05-15) deleted: dual-layer loop constants INNER_LOOP_MAX / OUTER_LOOP_MAX have no callers
// (plan_review tool + 5 close-time checks all deleted in M2/M4).
// env PHILONT_PLAN_INNER_LOOP_MAX / PHILONT_PLAN_OUTER_LOOP_MAX simultaneously deprecated.

const VALID_STATUS: ReadonlySet<PlanStatus> = new Set<PlanStatus>([
  // M3 / Phase 11 (2026-05-15): removed 'reviewed'. draft → executing directly.
  'draft',
  'executing',
  'completed',
  'failed',
]);

const VALID_STEP_STATUS: ReadonlySet<PlanStepStatus> = new Set<PlanStepStatus>([
  'pending',
  'doing',
  'done',
  'blocked',
]);

function rowToPlan(row: PlanRow): Plan {
  // v20 compat: old rows have deliverables_json defaulting to '[]', deliverable_status_json defaulting to NULL,
  // is_placeholder defaulting to 0; migration has already ALTER'd defaults, and fresh init via DDL also has defaults.
  let deliverables: PlanDeliverable[] = [];
  try {
    deliverables = JSON.parse(row.deliverables_json ?? '[]') as PlanDeliverable[];
  } catch {
    deliverables = [];
  }
  let deliverableStatus: Record<string, DeliverableStatus> | null = null;
  if (row.deliverable_status_json) {
    try {
      deliverableStatus = JSON.parse(row.deliverable_status_json) as Record<
        string,
        DeliverableStatus
      >;
    } catch {
      deliverableStatus = null;
    }
  }
  // Compat: raw step JSON missing covers field (v17/v19 historical rows)
  const rawSteps = JSON.parse(row.steps_json) as Array<Partial<PlanStep>>;
  const steps: PlanStep[] = rawSteps.map((s) => ({
    id: String(s.id ?? ''),
    description: String(s.description ?? ''),
    status: (s.status as PlanStepStatus) ?? 'pending',
    covers: Array.isArray(s.covers) ? s.covers : [],
    evidence: s.evidence ?? null,
    startedAt: s.startedAt ?? null,
    completedAt: s.completedAt ?? null,
  }));
  return {
    id: row.id,
    sessionId: row.session_id,
    taskSignature: row.task_signature,
    steps,
    deliverables,
    deliverableStatus,
    status: row.status as PlanStatus,
    reviewHistory: JSON.parse(row.review_history_json) as PlanReview[],
    isPlaceholder: (row.is_placeholder ?? 0) !== 0,
    persistedTo: row.persisted_to ?? null,
    guideRef: row.guide_ref,
    outcomeSummary: row.outcome_summary,
    innerIter: row.inner_iter ?? 0,
    outerIter: row.outer_iter ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** Normalize input.steps → PlanStep[], filling in 'step-N' in order when step.id is missing. */
function normalizeInputSteps(
  raw: PlanInput['steps'],
): PlanStep[] {
  return raw.map((s, i) => {
    const status = s.status && VALID_STEP_STATUS.has(s.status) ? s.status : 'pending';
    return {
      id: s.id && s.id.trim().length > 0 ? s.id.trim() : `step-${i + 1}`,
      description: s.description,
      status,
      covers: Array.isArray(s.covers) ? s.covers.slice() : [],
      evidence: null,
      startedAt: null,
      completedAt: null,
    };
  });
}

export class PlanStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a plan (status='draft').
   *
   * - steps are required and must be non-empty (empty plan is meaningless; the plan_draft tool layer should have already rejected)
   * - taskSignature is nullable (consistent with routing_rules / skills convention)
   */
  create(input: PlanInput): Plan {
    if (!input.steps || input.steps.length === 0) {
      throw new Error('PlanStore.create: steps must be non-empty');
    }
    if (!input.sessionId) {
      throw new Error('PlanStore.create: sessionId is required');
    }
    const id = randomUUID();
    const now = Date.now();
    const steps = normalizeInputSteps(input.steps);
    const stepsJson = JSON.stringify(steps);
    // v20 spec-coverage (M1 persist new fields; M4 add input structure validation)
    const deliverables: PlanDeliverable[] = Array.isArray(input.deliverables)
      ? input.deliverables.map((d) => ({
          id: String(d.id),
          description: String(d.description),
          ...(d.source !== undefined ? { source: String(d.source) } : {}),
        }))
      : [];
    const deliverablesJson = JSON.stringify(deliverables);
    const isPlaceholder = input.isPlaceholder === true ? 1 : 0;
    const persistedTo = input.persistedTo ?? null;
    this.db
      .prepare<
        [
          string,
          string,
          string | null,
          string,
          string | null,
          string,
          number,
          string | null,
          number,
          number,
        ]
      >(
        `INSERT INTO memory_plans
         (id, session_id, task_signature, steps_json, status, review_history_json,
          guide_ref, deliverables_json, is_placeholder, persisted_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.taskSignature ?? null,
        stepsJson,
        input.guideRef ?? null,
        deliverablesJson,
        isPlaceholder,
        persistedTo,
        now,
        now,
      );
    return {
      id,
      sessionId: input.sessionId,
      taskSignature: input.taskSignature ?? null,
      steps,
      deliverables,
      deliverableStatus: null,
      status: 'draft',
      reviewHistory: [],
      isPlaceholder: isPlaceholder === 1,
      persistedTo,
      guideRef: input.guideRef ?? null,
      outcomeSummary: null,
      innerIter: 0,
      outerIter: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
  }

  get(id: string): Plan | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_plans WHERE id = ? LIMIT 1`)
      .get(id) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  /** List all plans for this session, ordered by created_at DESC (newest first; chat-handler takes .at(0)). */
  listBySession(sessionId: string, opts: { limit?: number } = {}): Plan[] {
    const limit = opts.limit ?? 20;
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_plans
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as PlanRow[];
    return rows.map(rowToPlan);
  }

  /** List historical plans with the same task_signature (used by Phase 6.1 auto-slow). */
  listBySignature(taskSignature: string, opts: { limit?: number } = {}): Plan[] {
    const limit = opts.limit ?? 20;
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_plans
         WHERE task_signature = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(taskSignature, limit) as PlanRow[];
    return rows.map(rowToPlan);
  }

  /** List plans with the specified status (used during reflection to filter active plans). */
  listByStatus(status: PlanStatus, opts: { limit?: number } = {}): Plan[] {
    const limit = opts.limit ?? 50;
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_plans
         WHERE status = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(status, limit) as PlanRow[];
    return rows.map(rowToPlan);
  }

  /**
   * Directly set status. **Not normally called directly** — prefer appendReview / updateStep / close
   * (those methods automatically advance status internally). This method is for edge cases (tests / fixes / admin tool).
   */
  updateStatus(id: string, status: PlanStatus): Plan | null {
    if (!VALID_STATUS.has(status)) {
      throw new Error(`PlanStore.updateStatus: invalid status '${status}'`);
    }
    const now = Date.now();
    this.db
      .prepare<[string, number, string]>(
        `UPDATE memory_plans SET status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, now, id);
    return this.get(id);
  }

  /**
   * Update the status/evidence of a single step.
   *
   * Behavior:
   *   - stepId not found → return null (caller should check whether plan and step exist)
   *   - status='doing' and startedAt is null → automatically set startedAt = now
   *   - status='done' / 'blocked' → automatically set completedAt = now
   *   - plan.status='reviewed' and this call advances a step to 'doing' → plan.status advances to 'executing'
   */
  updateStep(
    id: string,
    stepId: string,
    status: PlanStepStatus,
    evidence?: string | null,
  ): Plan | null {
    if (!VALID_STEP_STATUS.has(status)) {
      throw new Error(`PlanStore.updateStep: invalid step status '${status}'`);
    }
    const current = this.get(id);
    if (!current) return null;
    const idx = current.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return null;

    const now = Date.now();
    const step = current.steps[idx];
    const updated: PlanStep = {
      ...step,
      status,
      evidence: evidence === undefined ? step.evidence : evidence,
      startedAt:
        status === 'doing' && step.startedAt === null ? now : step.startedAt,
      completedAt:
        status === 'done' || status === 'blocked' ? now : step.completedAt,
    };
    const newSteps = [...current.steps];
    newSteps[idx] = updated;

    // Automatic status advance: M3 / Phase 11 (2026-05-15) — draft jumps directly to executing
    // (original reviewed → executing path removed; 'reviewed' intermediate state deprecated)
    let newPlanStatus: PlanStatus = current.status;
    if (current.status === 'draft' && status === 'doing') {
      newPlanStatus = 'executing';
    }

    this.db
      .prepare<[string, string, number, string]>(
        `UPDATE memory_plans
         SET steps_json = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(newSteps), newPlanStatus, now, id);
    return this.get(id);
  }

  /**
   * Append a PlanReview entry.
   *
   * - decision='pass' AND gaps.length=0: plan.status='draft' → 'reviewed';
   *   **inner_iter reset to 0** (converged successfully, ready for the next outer execution round)
   * - decision='revise' OR gaps.length>0: remain 'draft'; **inner_iter +1**
   *   (LLM should continue revising via plan_revise → plan_review; caller decides escalation when threshold exceeded)
   *
   * Does not touch steps (step revisions go through the revise method with a reason).
   */
  appendReview(
    id: string,
    review: {
      gaps: string[];
      decision: 'pass' | 'revise';
      reason?: string | null;
    },
  ): Plan | null {
    const current = this.get(id);
    if (!current) return null;
    const now = Date.now();
    const fullReview: PlanReview = {
      at: now,
      gaps: review.gaps,
      decision: review.decision,
      reason: review.reason ?? null,
    };
    const newHistory = [...current.reviewHistory, fullReview];

    const isPass = review.decision === 'pass' && review.gaps.length === 0;
    // M3 / Phase 11 (2026-05-15): 'reviewed' state deprecated. appendReview API has no callers now
    // (plan_review tool deleted); M5 final state removes the function. Intermediate: pass goes directly to 'executing'.
    const newStatus: PlanStatus =
      isPass && current.status === 'draft' ? 'executing' : current.status;
    // inner_iter: reset to 0 on pass, +1 on review failure
    const newInnerIter = isPass ? 0 : current.innerIter + 1;

    this.db
      .prepare<[string, string, number, number, string]>(
        `UPDATE memory_plans
         SET review_history_json = ?, status = ?, inner_iter = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(newHistory), newStatus, newInnerIter, now, id);
    return this.get(id);
  }

  /**
   * Revise: replace steps + append a review entry with reason='revise'.
   *
   * Called by the plan_revise tool / applyReflection 'plan_revision' type.
   * After replacement plan.status reverts to 'draft' (forces re-review — any revision must be re-reviewed).
   *
   * Plans already in completed/failed state cannot be revised (terminal state); returns null.
   */
  /**
   * Revise: replace steps + optionally replace deliverables + append a revise record.
   * M4 (2026-05-15): added optional newDeliverables parameter — when provided, replaces entirely;
   * when omitted, retains original deliverables (for minor revisions that only change steps).
   * Placeholder plan (isPlaceholder=true) promotion path must provide newDeliverables (enforced by
   * plan_tools plan_revise execute layer); this method does not enforce it (admin / test can bypass).
   */
  revise(
    id: string,
    newSteps: PlanInput['steps'],
    newDeliverables: PlanDeliverable[] | null,
    reason: string,
  ): Plan | null {
    const current = this.get(id);
    if (!current) return null;
    if (current.status === 'completed' || current.status === 'failed') {
      return null;
    }
    if (!newSteps || newSteps.length === 0) {
      throw new Error('PlanStore.revise: newSteps must be non-empty');
    }
    const now = Date.now();
    const normalized = normalizeInputSteps(newSteps);
    const revisionReview: PlanReview = {
      at: now,
      gaps: [],
      decision: 'revise',
      reason,
    };
    const newHistory = [...current.reviewHistory, revisionReview];

    // M4 (2026-05-15): newDeliverables provided → full replacement; also promotes isPlaceholder
    const finalDeliverables: PlanDeliverable[] = newDeliverables
      ? newDeliverables.map((d) => ({
          id: String(d.id),
          description: String(d.description),
          ...(d.source !== undefined ? { source: String(d.source) } : {}),
        }))
      : current.deliverables;
    // Promote: if originally a placeholder and newDeliverables provided (non-empty) → mark as false
    const finalIsPlaceholder =
      current.isPlaceholder && newDeliverables && newDeliverables.length > 0
        ? 0
        : current.isPlaceholder
          ? 1
          : 0;

    this.db
      .prepare<[string, string, string, number, number, string]>(
        `UPDATE memory_plans
         SET steps_json = ?, review_history_json = ?, deliverables_json = ?,
             is_placeholder = ?, status = 'draft', updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(normalized),
        JSON.stringify(newHistory),
        JSON.stringify(finalDeliverables),
        finalIsPlaceholder,
        now,
        id,
      );
    return this.get(id);
  }

  /**
   * Close a plan: status='completed' (success) or 'failed' (failure) + outcome_summary.
   * completed_at is also recorded.
   *
   * Closing an already-closed plan a second time → returns null (prevents accidental double-close).
   */
  close(
    id: string,
    outcome: 'success' | 'failure',
    outcomeSummary: string,
    deliverableStatus?: Record<string, DeliverableStatus> | null,
  ): Plan | null {
    const current = this.get(id);
    if (!current) return null;
    if (current.status === 'completed' || current.status === 'failed') {
      return null;
    }
    const now = Date.now();
    const newStatus: PlanStatus = outcome === 'success' ? 'completed' : 'failed';
    // M4 (2026-05-15): persist deliverable_status JSON. null / omitted → retain original value (NULL).
    const statusJson =
      deliverableStatus === null || deliverableStatus === undefined
        ? null
        : JSON.stringify(deliverableStatus);
    this.db
      .prepare<[string, string, string | null, number, number, string]>(
        `UPDATE memory_plans
         SET status = ?, outcome_summary = ?, deliverable_status_json = ?,
             completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(newStatus, outcomeSummary, statusJson, now, now, id);
    return this.get(id);
  }

  /**
   * Explicitly increment inner_iter by 1 (v19, 2026-05-13).
   *
   * Normally auto-bumped by appendReview on the review-failure path; this method is for callers
   * to explicitly record a bump in special circumstances — e.g. when plan_protocol_gate detects
   * the LLM called plan_revise directly, skipping plan_review; or when the in-turn-reflection path
   * forces a "placeholder plan not yet reviewed" to count as one inner failure.
   *
   * Returns the new count after +1 (returns null if the plan does not exist).
   */
  bumpInnerIter(id: string): number | null {
    const current = this.get(id);
    if (!current) return null;
    const next = current.innerIter + 1;
    const now = Date.now();
    this.db
      .prepare<[number, number, string]>(
        `UPDATE memory_plans SET inner_iter = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next, now, id);
    return next;
  }

  /**
   * Explicitly increment outer_iter by 1 (v19, 2026-05-13).
   *
   * Called by the plan_close close-time strict-validation reject path: the LLM calls plan_close('success')
   * but any of the 5 mechanism-layer checks fails (step not done / evidence empty / honesty fired /
   * sameRootCause >= 2) → bump outer counter; when OUTER_LOOP_MAX is reached, the upper layer
   * automatically calls plan_close('failure') + distills a failure playbook.
   *
   * Returns the new count after +1 (returns null if the plan does not exist).
   */
  bumpOuterIter(id: string): number | null {
    const current = this.get(id);
    if (!current) return null;
    const next = current.outerIter + 1;
    const now = Date.now();
    this.db
      .prepare<[number, number, string]>(
        `UPDATE memory_plans SET outer_iter = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next, now, id);
    return next;
  }

  /**
   * Explicitly reset inner_iter to 0 (v19, 2026-05-13).
   *
   * appendReview pass already auto-resets; this method is for callers to explicitly reset
   * when the outer loop re-enters the inner loop (e.g. after a plan_close validation failure,
   * re-entering inner revision restarts the inner counter).
   */
  resetInnerIter(id: string): Plan | null {
    const now = Date.now();
    this.db
      .prepare<[number, string]>(
        `UPDATE memory_plans SET inner_iter = 0, updated_at = ? WHERE id = ?`,
      )
      .run(now, id);
    return this.get(id);
  }

  /**
   * Phase 13 (2026-05-17): update plan.persisted_to (triggered when LLM declares persist+project
   * during plan_revise promotion). null clears the association; non-null = project name (kebab-case
   * validated by caller).
   * Returns the updated Plan (null if plan does not exist).
   */
  setPersistedTo(id: string, persistedTo: string | null): Plan | null {
    const now = Date.now();
    this.db
      .prepare<[string | null, number, string]>(
        `UPDATE memory_plans SET persisted_to = ?, updated_at = ? WHERE id = ?`,
      )
      .run(persistedTo, now, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db
      .prepare<[string]>(`DELETE FROM memory_plans WHERE id = ?`)
      .run(id);
    return r.changes > 0;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memory_plans`)
      .get() as { n: number };
    return row.n;
  }
}
