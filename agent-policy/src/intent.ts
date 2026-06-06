/**
 * intent.ts: determine whether a user reply expresses an authorisation intent
 *
 * Uses LLM semantic judgement rather than hard keyword matching.
 * Supports three outcomes: grant / deny / unclear.
 */

export type GrantIntent = 'grant' | 'deny' | 'unclear';

export interface IntentClassifier {
  classify(userReply: string, context: string): Promise<GrantIntent>;
}

/**
 * LLM-based intent classifier
 * The caller provides an ask function (calls the LLM and returns text),
 * keeping intent.ts decoupled from any specific SDK.
 */
export class LLMIntentClassifier implements IntentClassifier {
  constructor(
    private readonly ask: (prompt: string) => Promise<string>,
  ) {}

  async classify(userReply: string, context: string): Promise<GrantIntent> {
    const prompt = `You are an intent classifier.

Context: An AI Agent is requesting to perform an operation that requires user authorisation.
Operation description: ${context}
User reply: ${userReply}

Determine the user's intent. Reply with exactly one of the following three words:
- grant  (user agrees, allows, or authorises)
- deny   (user refuses, disallows, or forbids)
- unclear (cannot determine)

Reply with one word only, nothing else.`;

    const result = (await this.ask(prompt)).trim().toLowerCase();

    if (result === 'grant') return 'grant';
    if (result === 'deny') return 'deny';
    return 'unclear';
  }
}

/**
 * Keyword classifier (fallback when no LLM is available).
 *
 * Two-level strategy:
 *   1. Short replies (≤4 non-punctuation characters) → exact allowlist match,
 *      avoids false positives like Chinese negation phrases being caught mid-word.
 *   2. Longer replies → prioritise explicit deny words, then check allow words.
 */
export class KeywordIntentClassifier implements IntentClassifier {
  private readonly exactGrant = new Set([
    // Chinese
    '是', '对', '行', '可', '好', '好的', '可以', '允许', '同意', '授权', '确认',
    '嗯', '恩', '没问题', '去吧', '去做', '执行',
    // English
    'ok', 'okay', 'yes', 'y', 'yep', 'yeah', 'sure', 'go', 'confirm', 'fine',
  ]);

  private readonly exactDeny = new Set([
    // Chinese
    '不', '否', '不行', '不可', '不可以', '不允许', '不同意', '不要',
    '拒绝', '禁止', '取消', '停止', '别', '算了',
    // English
    'no', 'n', 'nope', 'nah', 'stop', 'cancel', 'reject', 'abort',
  ]);

  async classify(userReply: string): Promise<GrantIntent> {
    const trimmed = userReply.trim().toLowerCase();
    if (!trimmed) return 'unclear';

    // Normalised form (punctuation and whitespace stripped), used for short-reply exact match and CJK substring search
    const normalized = trimmed.replace(/[。！？，,!?.\s]+/g, '');

    // 1) Short reply exact match (covers CJK single-char answers, yes/ok/no etc.)
    if (normalized.length <= 4) {
      if (this.exactGrant.has(normalized)) return 'grant';
      if (this.exactDeny.has(normalized)) return 'deny';
    }

    // 2) English longer sentences (word boundary \b; deny takes priority to avoid "don't agree" matching "agree")
    //    Uses trimmed (preserving spaces/apostrophes) to leverage \b
    if (/\b(don'?t|do not|cannot|can'?t|not\s+(agree|allow|ok|okay)|refuse|reject|deny|denied|cancel|disagree|disallow|forbid|abort)\b/.test(trimmed)) {
      return 'deny';
    }
    if (/\b(yes|yeah|yep|okay|sure|agree|agreed|allow|allowed|approve|approved|confirm|confirmed|permit|permitted|proceed|go\s*ahead|alright|all\s*right|fine)\b/.test(trimmed)) {
      return 'grant';
    }

    // 3) CJK longer sentences (no word-boundary concept; use substring match; deny takes priority)
    if (/(拒绝|禁止|不允许|不同意|不可以|不可|不行|不要)/.test(normalized)) return 'deny';
    if (/(允许|同意|授权|可以|没问题|确认|去吧|去做)/.test(normalized)) return 'grant';

    return 'unclear';
  }
}
