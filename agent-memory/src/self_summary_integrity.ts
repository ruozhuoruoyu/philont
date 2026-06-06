/**
 * SelfSummary integrity check — verifies whether skills / pursuits referenced in
 * sourceRefs of `self.summary` / `self.strengths` / `self.growth_edges` still exist.
 *
 * Why: `SelfReflector` attaches sourceRefs when writing self.* facts (to prevent fabricated "sources"),
 * but the referenced skills / pursuits may subsequently be deleted / renamed / forgotten. If the summary
 * is not updated, the agent will continuously inject "I am good at X (source: skill that no longer exists)"
 * into the LLM context — ghost references.
 *
 * Run once at startup; if the stale rate is high, async-trigger reflectSelf to regenerate.
 *
 * Design invariants:
 *   - Pure function, read-only memory, no writes
 *   - Fault-tolerant: missing sourceRefs field / parse failure / no self.* facts do not throw, return zero counts
 *   - ref format: `{kind}:{name|id}`, kind ∈ { 'skill', 'pursuit' } (unknown kinds are ignored, recorded as unknown)
 */

import type { MemoryStore } from './store.js';
import type { SkillStore } from './skills.js';
import type { PursuitStore } from './pursuit.js';
import type { SelfFactValue } from './store.js';

/** List of self namespace keys involved in the integrity check */
const SELF_KEYS: ReadonlyArray<string> = ['summary', 'strengths', 'growth_edges'];

export interface SelfSummaryIntegrity {
  /** Total ref count (deduplicated, accumulated across keys) */
  totalRefs: number;
  /** Number of refs that could be found in memory after parsing */
  validRefs: number;
  /** List of refs with no matching entity (raw strings) */
  staleRefs: string[];
  /** Number of refs with unrecognised format (not 'kind:name' form) */
  unknownRefs: string[];
  /** validRefs / totalRefs; 1.0 when totalRefs=0 (no refs → treated as complete) */
  integrityScore: number;
  /** For debugging: per-key ref counts for each self key */
  byKey: Array<{ key: string; total: number; valid: number; stale: number }>;
}

export interface IntegrityDeps {
  facts: MemoryStore;
  skills: SkillStore;
  pursuits: PursuitStore;
}

/** Parse a single ref string → { kind, target } or null (unrecognised format) */
function parseRef(ref: string): { kind: 'skill' | 'pursuit'; target: string } | null {
  const m = /^(skill|pursuit):(.+)$/.exec(ref);
  if (!m) return null;
  return { kind: m[1] as 'skill' | 'pursuit', target: m[2] };
}

/** Safely extract sourceRefs[] from a fact value (tolerates various corrupted forms) */
function extractSourceRefs(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const v = value as Partial<SelfFactValue>;
  if (!Array.isArray(v.sourceRefs)) return [];
  return v.sourceRefs.filter((x): x is string => typeof x === 'string');
}

/** Parse a single ref → whether it is valid */
function isRefValid(ref: string, deps: IntegrityDeps): boolean {
  const parsed = parseRef(ref);
  if (!parsed) return false;
  if (parsed.kind === 'skill') {
    return deps.skills.getByName(parsed.target) !== null;
  }
  if (parsed.kind === 'pursuit') {
    return deps.pursuits.get(parsed.target) !== null;
  }
  return false;
}

export function verifySelfSummaryIntegrity(deps: IntegrityDeps): SelfSummaryIntegrity {
  const seen = new Set<string>();
  let totalRefs = 0;
  let validRefs = 0;
  const staleRefs: string[] = [];
  const unknownRefs: string[] = [];
  const byKey: SelfSummaryIntegrity['byKey'] = [];

  for (const key of SELF_KEYS) {
    let kTotal = 0;
    let kValid = 0;
    let kStale = 0;
    const fact = deps.facts.getFact('self', key);
    if (!fact) {
      byKey.push({ key, total: 0, valid: 0, stale: 0 });
      continue;
    }
    const refs = extractSourceRefs(fact.value);
    for (const ref of refs) {
      // Deduplicate across keys — a skill appearing in both summary and strengths is only counted once
      if (seen.has(ref)) continue;
      seen.add(ref);
      kTotal++;
      totalRefs++;

      if (parseRef(ref) === null) {
        unknownRefs.push(ref);
        // unknown also counts as stale (cannot be verified if it cannot be parsed)
        staleRefs.push(ref);
        kStale++;
        continue;
      }
      if (isRefValid(ref, deps)) {
        validRefs++;
        kValid++;
      } else {
        staleRefs.push(ref);
        kStale++;
      }
    }
    byKey.push({ key, total: kTotal, valid: kValid, stale: kStale });
  }

  const integrityScore = totalRefs === 0 ? 1.0 : validRefs / totalRefs;

  return {
    totalRefs,
    validRefs,
    staleRefs,
    unknownRefs,
    integrityScore,
    byKey,
  };
}
