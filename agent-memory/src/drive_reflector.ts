/**
 * SessionDriveReflector: scans drive_outcomes to back-fill effectiveness and tune drive_config parameters.
 *
 * Closing phase of the closed loop (Phase D.2 + D.3 combined):
 *   1. List outcomes with effectiveness_score = NULL (NULL by default when appended)
 *   2. Heuristically score each outcome (see scoreOutcome), back-fill
 *   3. Aggregate by drive_id, update DriveConfig.effectiveness (EWMA α=0.3)
 *   4. If EWMA deviates significantly + accumulated samples ≥ MIN_SAMPLES, propose param adjustment:
 *        - Chronically ineffective → relax (e.g. double cooldown)
 *        - Chronically effective → tighten (e.g. halve cooldown)
 *      New value must fall within constitution.driveBounds [min, max]; skip if out of bounds.
 *
 * Heuristic scoring (v1, MVP):
 *   +0.5 — outcome.memoryDelta.pursuitProgressMarkers is non-empty (drive advanced a pursuit)
 *   +0.3 — outcome.memoryDelta.factIds is non-empty (drive trigger led to new fact crystallization)
 *   +0.2 — outcome.subsequentToolCalls is non-empty and all succeeded (drive-guided actions all succeeded)
 *   -0.3 — outcome.servedPursuitId is null and subsequent is empty (idling)
 *   -0.4 — success=false ratio in subsequentToolCalls > 50% (triggered cascading failures)
 *   base 0 → clamped to [-1, 1]
 *
 * These are "structural signals"; no LLM calls. Semantic signals like "user pushback" are left for future iterations.
 *
 * Write-back principles:
 *   - effectiveness_score is stored on the outcome row (via DriveOutcomeStore.setEffectivenessScore)
 *   - EWMA is aggregated to DriveConfig.effectiveness (via updateEffectiveness)
 *   - On param adjustment, if out of bounds, current version only skips and logs to audit; future
 *     iterations will connect to the constitution_proposals table
 *   - All writes go through auditHook as 'self_domain_write' with origin='Internal', source='drive_reflector'
 */

import type { DriveConfigStore } from './drive_config.js';
import type { DriveOutcomeStore } from './drive_outcome.js';
import type { PursuitStore } from './pursuit.js';
import type {
  ConstitutionFields,
  DriveConfig,
  DriveOutcome,
} from './types.js';
import type { MemoryAuditHook } from './audit.js';
import { BOOTSTRAP_ROOT_PURSUIT_ID } from './schema.js';

const EWMA_ALPHA = 0.3;
const MIN_SAMPLES_BEFORE_TUNING = 5;
const LOW_EWMA_THRESHOLD = -0.3;
const HIGH_EWMA_THRESHOLD = 0.5;

/** Structural scoring of an outcome → ∈ [-1, 1] */
export function scoreOutcome(outcome: DriveOutcome): number {
  let score = 0;

  const md = outcome.memoryDelta;
  if ((md.pursuitProgressMarkers?.length ?? 0) > 0) score += 0.5;
  if ((md.factIds?.length ?? 0) > 0) score += 0.3;

  const calls = outcome.subsequentToolCalls as Array<{ ok?: boolean; success?: boolean }>;
  const flatSuccess = (c: { ok?: boolean; success?: boolean }) =>
    c.ok ?? c.success;

  if (calls.length > 0) {
    const successCount = calls.filter((c) => flatSuccess(c) === true).length;
    const failCount = calls.filter((c) => flatSuccess(c) === false).length;
    if (successCount > 0 && failCount === 0) {
      score += 0.2;
    }
    if (failCount * 2 > calls.length) {
      score -= 0.4;
    }
  } else if (!outcome.servedPursuitId) {
    // Served no pursuit + triggered no tools → idling
    score -= 0.3;
  }

  if (score > 1) score = 1;
  if (score < -1) score = -1;
  return score;
}

export interface DriveReflectResult {
  /** Number of outcomes whose effectiveness score was back-filled this run */
  outcomesScored: number;
  /** Number of drives whose EWMA was updated this run */
  driveEwmaUpdated: number;
  /** Number of drives whose parameters were automatically tuned this run */
  driveParamsTuned: number;
  /** Number of adjustments skipped because they exceeded constitution.driveBounds */
  tuneSkippedOutOfBounds: number;
}

export interface SessionDriveReflectorOptions {
  auditHook?: MemoryAuditHook;
  rootPursuitId?: string;
  /** Maximum batch size per run, to avoid a large backlog after N rounds */
  batchLimit?: number;
}

export class SessionDriveReflector {
  private readonly auditHook: MemoryAuditHook | undefined;
  private readonly rootId: string;
  private readonly batchLimit: number;

  constructor(
    private readonly outcomes: DriveOutcomeStore,
    private readonly configs: DriveConfigStore,
    private readonly pursuits: PursuitStore,
    options: SessionDriveReflectorOptions = {}
  ) {
    this.auditHook = options.auditHook;
    this.rootId = options.rootPursuitId ?? BOOTSTRAP_ROOT_PURSUIT_ID;
    this.batchLimit = options.batchLimit ?? 100;
  }

  /**
   * Runs one reflection batch:
   *   1. Score unscored outcomes and back-fill
   *   2. Update EWMA for each drive
   *   3. Based on EWMA + sample count + bounds, decide whether to tune parameters
   */
  async reflect(): Promise<DriveReflectResult> {
    const result: DriveReflectResult = {
      outcomesScored: 0,
      driveEwmaUpdated: 0,
      driveParamsTuned: 0,
      tuneSkippedOutOfBounds: 0,
    };

    const unscored = this.outcomes.listUnscored(this.rootId, this.batchLimit);
    if (unscored.length === 0) return result;

    // 1. Score and back-fill
    const scoresByDrive = new Map<string, number[]>();
    for (const o of unscored) {
      const score = scoreOutcome(o);
      this.outcomes.setEffectivenessScore(o.id, score);
      this.auditHook?.append('self_domain_write', {
        source: 'drive_reflector',
        origin: 'Internal',
        toolName: 'score_outcome',
        outcomeId: o.id,
        driveId: o.driveId,
        score,
      });
      result.outcomesScored++;
      const arr = scoresByDrive.get(o.driveId) ?? [];
      arr.push(score);
      scoresByDrive.set(o.driveId, arr);
    }

    // 2. Aggregate EWMA for each drive
    //    Each outcome is fed independently to updateEffectiveness (preserves monotonically increasing sample count semantics)
    const constitution = this.pursuits.getConstitution(this.rootId);
    const bounds = constitution?.driveBounds ?? null;

    for (const [driveId, scores] of scoresByDrive.entries()) {
      const cfg = this.configs.get(driveId);
      if (!cfg) continue;
      const firedAt = Date.now();
      for (const s of scores) {
        this.configs.updateEffectiveness(driveId, s, EWMA_ALPHA, firedAt);
      }
      result.driveEwmaUpdated++;

      // 3. Parameter tuning decision
      const latest = this.configs.get(driveId)!;
      const tuned = this.maybeTuneParams(latest, bounds);
      if (tuned === 'tuned') result.driveParamsTuned++;
      if (tuned === 'out_of_bounds') result.tuneSkippedOutOfBounds++;
    }

    return result;
  }

  /**
   * Decides whether to tune parameters based on EWMA.
   *
   * Currently only auto-adjusts numeric cooldown parameters like "cooldownMs":
   *   - EWMA < LOW and samples ≥ MIN → relax (double)
   *   - EWMA > HIGH and samples ≥ MIN and > min → tighten (halve)
   *
   * Other parameters are left for a future LLM-based reflector.
   */
  private maybeTuneParams(
    cfg: DriveConfig,
    bounds: ConstitutionFields['driveBounds']
  ): 'tuned' | 'out_of_bounds' | 'skipped' {
    if (cfg.effectiveness.samples < MIN_SAMPLES_BEFORE_TUNING) return 'skipped';

    const cooldown = typeof cfg.params.cooldownMs === 'number'
      ? (cfg.params.cooldownMs as number)
      : null;
    if (cooldown === null) return 'skipped';

    let proposed: number | null = null;
    if (cfg.effectiveness.ewma <= LOW_EWMA_THRESHOLD) {
      proposed = cooldown * 2;
    } else if (cfg.effectiveness.ewma >= HIGH_EWMA_THRESHOLD) {
      proposed = Math.max(1000, Math.floor(cooldown / 2));
    }
    if (proposed === null || proposed === cooldown) return 'skipped';

    // Bounds check
    const kindBounds = bounds?.[cfg.kind];
    const range = kindBounds?.['cooldownMs'];
    if (range) {
      const [min, max] = range;
      if (proposed < min || proposed > max) {
        this.auditHook?.append('self_domain_write', {
          source: 'drive_reflector',
          origin: 'Internal',
          toolName: 'propose_param_out_of_bounds',
          driveId: cfg.id,
          kind: cfg.kind,
          param: 'cooldownMs',
          currentValue: cooldown,
          proposedValue: proposed,
          boundsMin: min,
          boundsMax: max,
          ewma: cfg.effectiveness.ewma,
        });
        return 'out_of_bounds';
      }
    }

    // Within bounds → write back directly
    const newParams = { ...cfg.params, cooldownMs: proposed };
    this.configs.updateParams(cfg.id, newParams);
    this.auditHook?.append('self_domain_write', {
      source: 'drive_reflector',
      origin: 'Internal',
      toolName: 'tune_drive_param',
      driveId: cfg.id,
      kind: cfg.kind,
      param: 'cooldownMs',
      oldValue: cooldown,
      newValue: proposed,
      ewma: cfg.effectiveness.ewma,
      samples: cfg.effectiveness.samples,
    });
    return 'tuned';
  }
}
