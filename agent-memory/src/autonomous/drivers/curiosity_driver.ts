/**
 * CuriosityDriver — the "curiosity" component of the initiative architecture.
 *
 * Key difference from the old TsCuriosityDrive:
 *   - Old: scans **user messages** for tokens and nudges the LLM "you should look this up"
 *   - New: scans **its own memory state** (tokens extracted from timeline minus already-queried
 *          history, plus high-stake aging pursuits that have never been advanced),
 *          and lets the executor **actually do the lookup**
 *
 * Trigger sources:
 *   A. token-gap   — specific tokens that appear repeatedly in the past 7-day timeline but
 *                    have never appeared in facts.sourceRefs or any done initiative
 *   B. dormant-pursuit — active pursuit with last_touched_ts > 14 days and stake_weight ≥ 7,
 *                    with empty evidenceRefs (never produced any fact/note)
 *
 * At most top-3 candidates are produced per tick (self-capped inside the driver);
 * the loop sorts and truncates again globally.
 */

import type {
  Driver,
  InitiativeProposal,
  MemorySnapshot,
} from '../types.js';

// ── extractSpecificTokens (ported from kernel_drives.ts) ─────────────────────
//
// Extracts "worth looking up" tokens from a piece of text:
//   1. Academic/standard IDs (arxiv/CVE/RFC/PEP/ISO/IETF) — strong signal
//   2. lib@version
//   3. URL
//   4. Acronyms of 3+ uppercase letters (common words excluded)
//   5. Content inside quotation marks — **must contain a structural signal** (digits/ASCII letters/hyphens/dots etc.);
//      pure Chinese phrases are filtered out (e.g. "tool calls" / "context", common meta-concept words)
//   6. Content inside 《》 book-title brackets — by convention these are book/work names; structural signal not required
//
// Pure heuristic, no LLM calls; can be ported 1:1 to the Rust side.

const ACRONYM_BLACKLIST = new Set([
  'I', 'OK', 'AI', 'AGI', 'CPU', 'GPU', 'IO', 'API', 'URL', 'HTTP',
  'JSON', 'YAML', 'CSV', 'PDF', 'DOC', 'TODO', 'FIXME', 'OS', 'PC',
  'MAC', 'PHP', 'SQL', 'CSS', 'HTML', 'JS', 'TS', 'GO', 'C', 'WIFI',
]);

/**
 * Returns true if the string contains a structural signal (used to filter pure-Chinese quoted content).
 *
 * Any of the following counts as "concrete":
 *   - ASCII letters (English / Latin characters)
 *   - Digits
 *   - Structural separators: - _ . / @ : =
 *
 * Pure Chinese + Chinese punctuation → returns false. This prevents CuriosityDriver from
 * mistakenly grabbing common LLM meta-concept words like "tool calls" / "context" / "agent".
 * Content inside 《》 book-title brackets bypasses this filter.
 */
function hasStructuralSignal(s: string): boolean {
  return /[A-Za-z0-9_\-./@:=]/.test(s);
}

export function extractSpecificTokens(text: string): string[] {
  const found = new Set<string>();

  const idPatterns: RegExp[] = [
    /\barxiv[:\s]*(\d+\.\d+(?:v\d+)?)/gi,
    /\bcve-\d+-\d+/gi,
    /\brfc[:\s]*\d+/gi,
    /\bpep[:\s]*\d+/gi,
    /\biso[:\s]*\d+/gi,
    /\bietf[-\s]+[a-z0-9]+(?:-[a-z0-9]+)*/gi,
  ];
  for (const re of idPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.add(m[0].trim());
  }

  const verPattern = /\b([a-z][a-z0-9_-]{2,})@(\d+(?:\.\d+){0,2})/gi;
  let vm: RegExpExecArray | null;
  while ((vm = verPattern.exec(text)) !== null) found.add(vm[0].trim());

  const urlPattern = /\bhttps?:\/\/[^\s<>"'）)】\]]+/gi;
  let um: RegExpExecArray | null;
  while ((um = urlPattern.exec(text)) !== null) found.add(um[0].trim());

  const acronymPattern = /\b[A-Z]{3,}(?:[A-Z0-9-]*[A-Z0-9])?\b/g;
  let am: RegExpExecArray | null;
  while ((am = acronymPattern.exec(text)) !== null) {
    const t = am[0];
    if (!ACRONYM_BLACKLIST.has(t)) found.add(t);
  }

  // Quoted content: must contain a structural signal (filters pure-Chinese phrases)
  const strictQuotedPatterns: RegExp[] = [
    /"([^"]{2,40})"/g,
    /"([^"]{2,40})"/g,
    /「([^」]{2,40})」/g,
  ];
  for (const re of strictQuotedPatterns) {
    let qm: RegExpExecArray | null;
    while ((qm = re.exec(text)) !== null) {
      const inner = qm[1].trim();
      if (inner.length >= 2 && hasStructuralSignal(inner)) found.add(inner);
    }
  }

  // 《》 book-title brackets: by convention these are book/work names; structural signal not required
  const bookPattern = /《([^》]{2,40})》/g;
  let bm: RegExpExecArray | null;
  while ((bm = bookPattern.exec(text)) !== null) {
    const inner = bm[1].trim();
    if (inner.length >= 2) found.add(inner);
  }

  return Array.from(found);
}

// ── Driver ───────────────────────────────────────────────────────────────

export interface CuriosityDriverConfig {
  /** Minimum number of times a token must appear to be considered "recurring"; default 1. Snap is already deduplicated, so 1 suffices */
  minTokenMentions: number;
  /** Pursuit aging threshold (days); default 14 */
  pursuitAgingDays: number;
  /** Minimum stake_weight threshold for pursuits; default 7 */
  pursuitMinStakeWeight: number;
  /** Maximum candidates to produce per tick; default 3 */
  maxProposals: number;
}

export const DEFAULT_CURIOSITY_CONFIG: CuriosityDriverConfig = {
  minTokenMentions: 1,
  pursuitAgingDays: 14,
  pursuitMinStakeWeight: 7,
  maxProposals: 3,
};

const DRIVER_NAME = 'curiosity';

export class CuriosityDriver implements Driver {
  readonly name = DRIVER_NAME;

  constructor(private readonly cfg: CuriosityDriverConfig = DEFAULT_CURIOSITY_CONFIG) {}

  propose(snap: MemorySnapshot): InitiativeProposal[] {
    const proposals: InitiativeProposal[] = [];

    // (A) Token-gap: timeline tokens minus those already referenced by fact sourceRefs or done initiatives
    const facts = snap.facts;
    const knownTokens = new Set<string>();
    for (const f of facts) {
      // Use strings appearing in sourceRefs as "already looked up" markers; sourceRefs are
      // usually URLs or note IDs — matching may not be exact, but coarse-grain is sufficient
      const v = f.value as unknown;
      if (v && typeof v === 'object' && 'sourceRefs' in v) {
        const refs = (v as { sourceRefs?: unknown }).sourceRefs;
        if (Array.isArray(refs)) {
          for (const r of refs) {
            if (typeof r === 'string') knownTokens.add(r);
          }
        }
      }
      // The fact key itself also counts as known
      knownTokens.add(f.key);
    }

    for (const tok of snap.recentTimelineTokens) {
      const targetRef = `token:${tok}`;
      if (snap.recentDoneTargetRefs.has(targetRef)) continue;
      // Already referenced by any fact → not considered "unchecked"
      if (knownTokens.has(tok)) continue;
      // Literal substring match also counts as covered (URL concatenated into a sourceRef)
      let covered = false;
      for (const k of knownTokens) {
        if (k.includes(tok)) {
          covered = true;
          break;
        }
      }
      if (covered) continue;

      proposals.push({
        kind: 'curiosity_token',
        driver: DRIVER_NAME,
        targetRef,
        rationale: `"${tok}" repeatedly appears in the timeline but has never been referenced in local facts; worth a one-time lookup`,
        utility: scoreTokenUtility(tok),
        budgetEstimate: 1500,
        plan: [
          {
            tool: 'webSearch',
            params: { query: tok },
          },
        ],
      });
    }

    // (B) Dormant high-stake pursuit: commitment made but never touched
    const agingMs = this.cfg.pursuitAgingDays * 86_400_000;
    const cutoff = snap.now - agingMs;
    for (const p of snap.activePursuits) {
      if (p.stakeWeight < this.cfg.pursuitMinStakeWeight) continue;
      const lastTouched = p.lastTouchedAt ?? p.updatedAt;
      if (lastTouched > cutoff) continue;
      // If there have been any outputs it doesn't count as "never touched" — evidenceRefs are the pursuit's output references
      if (p.evidenceRefs.length > 0) continue;
      const targetRef = `pursuit:${p.id}`;
      if (snap.recentDoneTargetRefs.has(targetRef)) continue;

      const ageDays = Math.floor((snap.now - lastTouched) / 86_400_000);
      proposals.push({
        kind: 'curiosity_dormant_pursuit',
        driver: DRIVER_NAME,
        targetRef,
        rationale:
          `pursuit "${p.title}" stake=${p.stakeWeight}/10 has not been touched for ${ageDays} days ` +
          `and has no evidenceRefs; should actively advance or re-evaluate`,
        utility: scoreDormancyUtility(p.stakeWeight, ageDays),
        budgetEstimate: 1800,
        plan: [
          {
            tool: 'searchNotes',
            params: { query: p.title },
          },
        ],
      });
    }

    // Sort by utility and truncate to top-N (driver self-limits)
    proposals.sort((a, b) => b.utility - a.utility);
    return proposals.slice(0, this.cfg.maxProposals);
  }
}

/**
 * Token type determines the utility baseline:
 *   - Academic/standard IDs (arxiv/CVE/RFC) → 0.75 (strongly worth verifying)
 *   - URL → 0.6 (may be a reference but not necessarily a core unknown)
 *   - lib@version → 0.65
 *   - Other (acronym/quoted) → 0.55
 */
function scoreTokenUtility(token: string): number {
  if (/^(arxiv|cve|rfc|pep|iso|ietf)/i.test(token)) return 0.75;
  if (/^https?:\/\//i.test(token)) return 0.6;
  if (/@\d/.test(token)) return 0.65;
  return 0.55;
}

/**
 * Pursuit dormancy score:
 *   utility = 0.5 + 0.04 * (stake_weight - 7) + min(0.15, 0.005 * ageDays)
 *   Range approximately 0.5..0.85
 */
function scoreDormancyUtility(stakeWeight: number, ageDays: number): number {
  const base = 0.5 + 0.04 * (stakeWeight - 7);
  const ageBonus = Math.min(0.15, 0.005 * ageDays);
  return Math.max(0.5, Math.min(0.85, base + ageBonus));
}
