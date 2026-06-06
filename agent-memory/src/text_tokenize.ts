/**
 * text_tokenize: lightweight heuristic token splitting (v19, 2026-05-13)
 *
 * Shared by SkillStore MECE check and plan_review auto-gap-check. **Does not depend on any
 * LLM / real tokenizer**. Rules:
 *   - Lowercase
 *   - Split [a-z0-9]+ words and individual Chinese characters
 *   - Discard length=1 English tokens (too short to carry signal, e.g. 'a' 'i')
 *   - Retain single Chinese characters (individual Chinese characters often carry semantics)
 *
 * Suitable for: semantic alignment heuristics (keyword coverage rate), similarity estimation (Jaccard / simple overlap).
 * Not suitable for: complex NLP / cross-language deep matching / synonym normalization — those go through embedding paths.
 */

/**
 * Split text into a lowercase token set.
 *
 * - English/digits split by [a-z0-9]+, 1-char tokens discarded
 * - Chinese split per character (each Chinese character becomes one token)
 * - Returns Set<string>, deduplicated
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const lowered = text.toLowerCase();
  const tokens = lowered.match(/[a-z0-9]+|[一-龥]/g);
  if (!tokens) return out;
  for (const t of tokens) {
    if (t.length >= 2 || /[一-龥]/.test(t)) out.add(t);
  }
  return out;
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|
 * Returns 1 for two empty sets (equally empty).
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Coverage: |guide ∩ plan| / |guide|
 *
 * Used for plan_review auto-gap-check — answers "does the plan cover the key tokens in the guide".
 * Note this is **directional**, unlike jaccard: guide is the baseline; plan does not need to contain
 * tokens beyond the guide.
 *
 * - guide empty → return 1 (no requirements = satisfied)
 * - guide non-empty but plan empty → return 0
 */
export function coverage(guide: Set<string>, plan: Set<string>): number {
  if (guide.size === 0) return 1;
  if (plan.size === 0) return 0;
  let hit = 0;
  for (const t of guide) if (plan.has(t)) hit++;
  return hit / guide.size;
}

/**
 * Return the list of tokens in guide that **do not appear in plan** (sorted lexicographically), for gap description.
 *
 * - minLen filters out too-short tokens (default 2): English stopwords like "the" are already filtered once
 *   by tokenize, but single Chinese characters like "的"/"了" are retained — minLen=2 but single Chinese
 *   characters pass through (because Chinese single char length=1 < 2, so we use isCjk check instead)
 * - limit defaults to 10
 */
export function missingTokens(
  guide: Set<string>,
  plan: Set<string>,
  opts: { limit?: number; minLen?: number } = {},
): string[] {
  const limit = opts.limit ?? 10;
  const minLen = opts.minLen ?? 2;
  const out: string[] = [];
  for (const t of guide) {
    if (plan.has(t)) continue;
    // Retain single Chinese characters (single chars often carry semantics); English requires length >= minLen
    const isCjk = /[一-龥]/.test(t);
    if (!isCjk && t.length < minLen) continue;
    out.push(t);
  }
  out.sort();
  return out.slice(0, limit);
}
