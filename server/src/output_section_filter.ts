/**
 * LLM output two-section filter (2026-05-07 fallback rewrite)
 *
 * The LLM is instructed to produce output in two sections:
 *
 *   ## For User
 *   <concise conclusion + essential progress, forwarded to user frontend>
 *
 *   ## Work Log
 *   <full reasoning / tables / tool results / self-review, recorded to timeline only, not forwarded>
 *
 * Three-tier strategy, from strict to lenient:
 *
 *   Strategy 1 (usedSection=true):  explicit `## For User` section with content → extract it
 *
 *   Strategy 2 (usedSection=false): `## Work Log` present but no `## For User` → take
 *     the text **before** `## Work Log` as the reply.
 *     Semantics: the LLM wrote a work log, meaning it **knew** it should separate internal
 *     reasoning — but the format was not followed correctly. The conversation text before
 *     the work log is what it intended to show the user.
 *
 *   Strategy 3 (usedSection=false): no ## headings at all → return the full text (pure conversational reply)
 *
 *   Edge case: `## For User` section is empty + followed by `## Work Log` → falls to strategy 2,
 *     which returns empty → falls to strategy 3, which returns full text (minus heading lines)
 *
 * Old fallback ("take the last paragraph") is deprecated — field observations showed it was
 * truncating 100+ character replies to 15-17 character broken sentences, which was worse UX
 * than forwarding the full text. We now prefer sending the full text (including LLM internal
 * reasoning) over a broken fragment.
 *
 * 2026-05-19 responsibility boundary (after three-stream separation): this function only
 * handles the **LLM's own two-section format** (`## For User` / `## Work Log`). Mechanism-layer
 * internal markers (`[internal-drive X]` / `[system:…]` / tool detail JSON) already go through the
 * onTrace third stream and are **no longer mixed into the onDelta buffer** — so this function
 * no longer needs to strip mechanism markers as a fallback. But it must not be removed:
 * the LLM still writes `## Work Log` sections that need to be cut here.
 */

// Bilingual headings (i18n open-source transition): accept both the English headings used by the
// English system prompt and the legacy Chinese headings, so the prompt can flip to
// English without breaking the WeChat reply split. Keep both indefinitely — harmless,
// and the model may emit either depending on the user-facing reply language.
const USER_SECTION_HEADING = /^##\s*(?:给用户|For User)\s*$/i;
const WORK_LOG_HEADING = /^##\s*(?:工作日志|Work Log)\s*$/i;
const ANY_H2_HEADING = /^##\s+/;

export interface FilterResult {
  /** Text to forward to the frontend */
  text: string;
  /** Whether `## For User` section was successfully matched (false = strategy 2 or 3 fallback) */
  usedSection: boolean;
}

/**
 * Extract the "for user" section from the full LLM output.
 * Three-tier strategy: see module-top comment.
 */
export function extractUserSection(fullText: string): FilterResult {
  if (typeof fullText !== 'string' || fullText.trim().length === 0) {
    return { text: '', usedSection: false };
  }

  // Strategy 1: explicit ## For User section with content
  const explicit = extractExplicitUserSection(fullText);
  if (explicit !== null) {
    // Guard against "answer placed in wrong section" (2026-06-03): `## For User` section
    // is just a brief opener (very short), while the real answer is in `## Work Log`
    // (an internal section that would be cut). LLM repeatedly does:
    //   `## For User\nSure, let me think.\n## Work Log\n<real long answer>`
    // Heuristic: user section < 80 chars AND full text (minus headings) is much longer
    // (>300 AND >3× the user section length) → LLM likely placed the answer in the wrong
    // section. Prefer sending the full text (including work log body, minus ## heading lines)
    // over having the user see only a one-liner opener.
    const stripped = stripHeadingLines(fullText);
    if (explicit.length < 80 && stripped.length > 300 && stripped.length > explicit.length * 3) {
      return { text: stripped, usedSection: false };
    }
    return { text: explicit, usedSection: true };
  }

  // Strategy 2: ## Work Log present but no explicit user section → take content before work log
  const beforeWorkLog = extractBeforeWorkLog(fullText);
  if (beforeWorkLog !== null) {
    return { text: beforeWorkLog, usedSection: false };
  }

  // Strategy 3: return full text — but Phase 11 (2026-05-14) adds truncation as a last resort.
  // No two-section format used + text exceeds cap → take tail N chars + note.
  // Sending the full 5000+ char text as WeChat fallback made for a poor UX.
  // OutputFormatGate only reaches here after the LLM fails twice; truncation is the last safety net.
  // Env PHILONT_OUTPUT_FALLBACK_TRUNCATE_AT sets threshold (default 800),
  //     PHILONT_OUTPUT_FALLBACK_TRUNCATE_KEEP sets how much to keep (default 500)
  const stripped = stripHeadingLines(fullText);
  const truncAt =
    Number(process.env.PHILONT_OUTPUT_FALLBACK_TRUNCATE_AT) || 800;
  const truncKeep =
    Number(process.env.PHILONT_OUTPUT_FALLBACK_TRUNCATE_KEEP) || 500;
  if (stripped.length > truncAt) {
    const tail = stripped.slice(-truncKeep);
    return {
      text:
        `[完整内容 ${stripped.length} 字已记录到 timeline。以下是结尾摘要]\n\n` +
        '...' +
        tail +
        `\n\n[如需详细请回复"细说"]`,
      usedSection: false,
    };
  }
  return { text: stripped, usedSection: false };
}

/**
 * Extract the content between `## For User` and `## Work Log` (or end of text).
 * Returns null if section is absent or empty.
 *
 * Key fix (2026-06-03): the boundary is **`## Work Log`**, not "any `## ` heading".
 * The protocol only designates Work Log as the internal section; the answer body commonly
 * uses sub-headings like `## One-liner Conclusion` / `## Layered Score` to organise structure.
 * The old code broke at the first arbitrary `## ` heading, discarding those sub-headings
 * and all following body text — leaving users with only the intro sentence under
 * `## For User` (prod observations: 100+ char answers truncated to 50-85 chars).
 */
function extractExplicitUserSection(text: string): string | null {
  const lines = text.split('\n');
  let inSection = false;
  const sectionLines: string[] = [];
  for (const line of lines) {
    if (USER_SECTION_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (WORK_LOG_HEADING.test(line)) break; // only close at work-log boundary; keep answer sub-headings
      sectionLines.push(line);
    }
  }
  if (!inSection) return null;
  const content = sectionLines.join('\n').trim();
  return content.length > 0 ? content : null;
}

/**
 * Take content before `## Work Log` (stripping other ## heading lines).
 * No work-log heading → null; content before it is empty → null (falls to strategy 3).
 */
function extractBeforeWorkLog(text: string): string | null {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => WORK_LOG_HEADING.test(l));
  if (idx < 0) return null;
  const before = lines
    .slice(0, idx)
    .filter((line) => !ANY_H2_HEADING.test(line))
    .join('\n')
    .trim();
  return before.length > 0 ? before : null;
}

/** Strip all `## ` heading lines; keep paragraph body */
function stripHeadingLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !ANY_H2_HEADING.test(line))
    .join('\n')
    .trim();
}

/**
 * Fallback hit counter (for metrics). Resets on restart — observation signal only, not persisted.
 */
let fallbackHits = 0;
let totalCalls = 0;

export function recordFilterCall(usedSection: boolean): void {
  totalCalls++;
  if (!usedSection) fallbackHits++;
}

export function getFallbackRate(): { hits: number; total: number; rate: number } {
  return {
    hits: fallbackHits,
    total: totalCalls,
    rate: totalCalls === 0 ? 0 : fallbackHits / totalCalls,
  };
}

export function _resetMetricsForTests(): void {
  fallbackHits = 0;
  totalCalls = 0;
}
