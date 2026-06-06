/**
 * Memory decay scoring and active forgetting
 *
 * Core formula:
 *   score = confidence × exp(-age_days / tau)
 *
 * Where:
 *   - age_days = (now - (last_accessed_at ?? created_at)) / 86_400_000
 *     last_accessed_at is refreshed on each access, equivalent to LRU: frequently used memories never age
 *   - tau (decay constant, days): given a default per namespace; can be overridden by fact.decay_tau_days
 *   - pinned (decay_tau_days = PIN_SENTINEL): never decays; score = confidence
 *
 * Namespace τ defaults:
 *   user.*     → ∞    (preferences and identity information are long-term stable)
 *   project.*  → 60   (mid-project lifecycle)
 *   context.*  → 1    (session-level short-term context)
 *   session.*  → 1
 *   other      → 365  (conservative default)
 */

/** Pin sentinel: decay_tau_days < 0 is treated as pinned */
export const PIN_SENTINEL = -1;

/** Default decay constant (days) when no namespace matches */
export const DEFAULT_TAU_DAYS = 365;

/** Default score threshold for the candidate forgetting pool */
export const DEFAULT_FORGET_THRESHOLD = 0.05;

/**
 * Returns the default decay constant for a namespace.
 * Supports exact match and `ns.*` prefix match.
 */
export function namespaceTauDays(namespace: string): number {
  const root = namespace.split('.')[0];
  switch (root) {
    case 'user':
      return Infinity;
    case 'project':
      return 60;
    case 'context':
    case 'session':
      return 1;
    default:
      return DEFAULT_TAU_DAYS;
  }
}

export interface ScorableMemory {
  namespace: string;
  confidence: number;
  createdAt: number;
  lastAccessedAt: number | null;
  decayTauDays: number | null;
}

/**
 * Calculates the memory score. Returns a value in the [0, confidence] range.
 *
 * - pinned (decay_tau_days < 0) → confidence (no decay)
 * - tau = Infinity → confidence (no decay)
 * - otherwise: confidence × exp(-age/tau)
 */
export function scoreMemory(mem: ScorableMemory, now: number = Date.now()): number {
  if (mem.decayTauDays !== null && mem.decayTauDays < 0) {
    return mem.confidence;
  }
  const tau = mem.decayTauDays ?? namespaceTauDays(mem.namespace);
  if (!Number.isFinite(tau)) {
    return mem.confidence;
  }
  const anchor = mem.lastAccessedAt ?? mem.createdAt;
  const ageDays = Math.max(0, (now - anchor) / 86_400_000);
  return mem.confidence * Math.exp(-ageDays / tau);
}

/** Returns whether the memory is pinned (decay_tau_days is the negative sentinel) */
export function isPinned(mem: Pick<ScorableMemory, 'decayTauDays'>): boolean {
  return mem.decayTauDays !== null && mem.decayTauDays < 0;
}
