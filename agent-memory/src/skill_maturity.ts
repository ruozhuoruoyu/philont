/**
 * Skill maturity state machine (pure functions)
 *
 * Problem: agent self-learning outputs (reflection-generated skills / clawhub-loaded skills) need
 * a maturity marker and promotion/demotion mechanism to reflect "how many times has this been
 * validated in use". State machine driven: after each use_skill call, recordSkillOutcome calls
 * this module's nextMaturity to compute the next tier.
 *
 * 5 tiers:
 *   playbook  — experience notes / lessons. Cannot use_skill, only used as hint injection. Terminal state
 *               (unless explicitly promoted by setMaturity).
 *   draft     — written after the first success, can use_skill, labelled "not fully validated".
 *   confirmed — success ≥ 2 and failure = 0. Normal injection, can use_skill.
 *   stable    — success ≥ 5 and failure/success < 0.1. Highest trust tier.
 *   deprecated— consecutive failure ≥ 3 or (success ≥ 5 and failure/success > 0.3).
 *               No longer a use_skill candidate; description can still serve as counter-example hint.
 *
 * Promotion: only on success (and only when current tier is below the target tier), auto-promoted.
 * Demotion: any failure triggers evaluation; if deprecated threshold is met, → deprecated directly;
 *           otherwise demote one tier (stable→confirmed, confirmed→draft, draft→draft, playbook→playbook).
 *
 * Invariants:
 *   - playbook is a terminal state (the automatic state machine does not enter or exit it), only controlled explicitly by setMaturity
 *   - deprecated is a terminal state (for automatic transitions), unless explicitly revived by setMaturity;
 *     design intent: a skill verified as unreliable should not regain trust through "luck"
 */

import type { SkillMaturity } from './types.js';

/** Promotion threshold constants, corresponding to the plan / comments above */
export const CONFIRMED_MIN_SUCCESS = 2;
export const STABLE_MIN_SUCCESS = 5;
export const STABLE_MAX_FAILURE_RATIO = 0.1;
export const DEPRECATED_CONSECUTIVE_FAILURES = 3;
export const DEPRECATED_RATIO_MIN_SUCCESS = 5;
export const DEPRECATED_FAILURE_RATIO = 0.3;

export interface MaturityComputeInput {
  /** Current tier before computation */
  current: SkillMaturity;
  /** Cumulative success count (including this outcome) */
  successCount: number;
  /** Cumulative failure count (including this outcome) */
  failureCount: number;
  /** Consecutive failure count (including this outcome); reset to 0 on success */
  consecutiveFailures: number;
  /** This outcome */
  lastOutcome: 'success' | 'failure';
}

/**
 * Compute the next tier. **Pure function** — reads counts + current tier, returns the next tier.
 *
 * The caller should already have updated successCount / failureCount / consecutiveFailures
 * to reflect this outcome's accumulated values before calling this function. This function does not modify input.
 */
export function nextMaturity(input: MaturityComputeInput): SkillMaturity {
  const { current, successCount, failureCount, consecutiveFailures, lastOutcome } = input;

  // playbook terminal state: automatic state machine does not enter or exit
  if (current === 'playbook') return 'playbook';

  // deprecated terminal state: no revival
  if (current === 'deprecated') return 'deprecated';

  if (lastOutcome === 'success') {
    // Promotion path: strictly by threshold, no tier-skipping
    if (current === 'draft' && successCount >= CONFIRMED_MIN_SUCCESS && failureCount === 0) {
      return 'confirmed';
    }
    if (
      current === 'confirmed' &&
      successCount >= STABLE_MIN_SUCCESS &&
      failureCount / Math.max(1, successCount) < STABLE_MAX_FAILURE_RATIO
    ) {
      return 'stable';
    }
    return current;
  }

  // failure path: first check whether deprecated is triggered, otherwise demote one tier
  if (consecutiveFailures >= DEPRECATED_CONSECUTIVE_FAILURES) {
    return 'deprecated';
  }
  if (
    successCount >= DEPRECATED_RATIO_MIN_SUCCESS &&
    failureCount / Math.max(1, successCount) > DEPRECATED_FAILURE_RATIO
  ) {
    return 'deprecated';
  }

  // Demote one tier (will not demote to playbook — that is an explicit lessons-only channel, not an automatic product)
  if (current === 'stable') return 'confirmed';
  if (current === 'confirmed') return 'draft';
  // draft failed but deprecated threshold not triggered → stay at draft (allow retry)
  return current;
}

/**
 * Whether a skill can be called via use_skill.
 *
 *   playbook / deprecated → false (playbook is lesson-only, deprecated is disabled)
 *   draft / confirmed / stable → true
 */
export function isCallableMaturity(m: SkillMaturity): boolean {
  return m === 'draft' || m === 'confirmed' || m === 'stable';
}

/**
 * "Tier hint" shown to LLM when injected into system prompt. Caller prepends to description.
 */
export function maturityCaveat(m: SkillMaturity): string {
  switch (m) {
    case 'playbook':
      return '[lesson-only, no use_skill]';
    case 'draft':
      return '[draft · not fully validated, verify before use]';
    case 'confirmed':
      return '[confirmed]';
    case 'stable':
      return '[stable]';
    case 'deprecated':
      return '[deprecated · verified unreliable, use as a counter-example]';
  }
}

/**
 * Validate whether a string is a valid maturity value (used as fallback for deserialization / DB row parsing).
 */
export function parseMaturity(s: unknown, fallback: SkillMaturity = 'draft'): SkillMaturity {
  if (
    s === 'playbook' ||
    s === 'draft' ||
    s === 'confirmed' ||
    s === 'stable' ||
    s === 'deprecated'
  ) {
    return s;
  }
  return fallback;
}
