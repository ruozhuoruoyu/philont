/**
 * recall_trigger — detects whether a user message is referencing a past conversation (P0.2).
 *
 * Use cases: user says "I just said forget it if it doesn't work" / "do you remember we talked about X" / "the Y we discussed before",
 * etc. The agent should **proactively** call `recall_sessions` to look up history rather than
 * saying "I have no context" and pushing the burden back to the user.
 *
 * This is the detection layer (pure function, no IO). chat-handler uses the hit result to decide
 * whether to inject a forced reminder into the system segment.
 *
 * Design principles:
 *   - Prefer false negatives over false positives. False positives cause the agent to query history
 *     on every ordinary message, wasting tokens.
 *   - Strong signals: **recall verb** + past-tense adverb combination; weak signals (just "previously") are not enough.
 */

const RETROSPECTIVE_PATTERNS_ZH: ReadonlyArray<RegExp> = [
  // "I/you/we + said/chatted/told/discussed/promised/agreed/mentioned"
  /(?:我|你|我们|咱们|大家)?\s*(?:刚才|之前|上次|上回|前面|先前|早些时候|上面|曾经|那时)?\s*(?:说过|聊过|讲过|讨论过|答应过|约定过|告诉过|提过|提到过|商量过)/,
  // "do you remember / remember or not / remember X?"
  /(?:还|你)?(?:记得|记不记得|记不得|忘了吗|忘了没)/,
  // "I/you + just + said" / "a few messages ago"
  /(?:我|你|我们)\s*(?:刚才|刚刚|刚)\s*(?:说|聊|提|讲|问|讨论)/,
  // "before/last time + said/did/discussed/dealt with" — more general
  /(?:之前|上次|上回|上回儿|前面|先前)[^。！？\n]{0,15}(?:说|做|讨论|搞|弄|聊|提|发|答|想|讲)/,
  // "say it again / discuss again / continue from last time"
  /(?:接着|继续)(?:上次|之前|刚才)/,
  // directly asking about history: "what was it just now / before / last time"
  /(?:刚才|之前|上次)[^。！？\n]{0,15}(?:是什么|是啥|说的啥|聊的啥|做的啥)/,
];

const RETROSPECTIVE_PATTERNS_EN: ReadonlyArray<RegExp> = [
  // "remember when / what we ... / earlier / previously"
  /\bremember\s+(?:when|what|how|that|our)/i,
  /\b(?:we|you|I)\s+(?:talked|discussed|mentioned|agreed|said|told|chatted)\s+(?:about|earlier|before|previously|last time)\b/i,
  /\b(?:earlier|previously|before)(?:\s+(?:you|we|I))?\s+(?:said|told|mentioned|asked|wrote|did)/i,
  /\bas\s+(?:you|we|I)\s+(?:said|mentioned|discussed)\s+(?:earlier|before|last time|previously)\b/i,
  // "do you remember / 还记得 ... ? "
  /\bdo\s+you\s+(?:still\s+)?remember\b/i,
  // "from our last conversation / chat"
  /\b(?:from|in)\s+our\s+(?:last|previous|earlier)\s+(?:chat|conversation|talk|discussion|session)/i,
];

/**
 * Detect whether a user message is referencing a past conversation (returns the matched snippet on any pattern hit).
 * Short messages (< 4 chars) pass through directly to avoid false positives on "OK/yes/sure".
 */
export function detectTimeRetrospectiveQuery(userMessage: string): { hit: true; snippet: string } | null {
  const trimmed = userMessage.trim();
  if (trimmed.length < 4) return null;

  for (const re of RETROSPECTIVE_PATTERNS_ZH) {
    const m = re.exec(trimmed);
    if (m && m[0].trim().length > 0) {
      return { hit: true, snippet: m[0] };
    }
  }
  for (const re of RETROSPECTIVE_PATTERNS_EN) {
    const m = re.exec(trimmed);
    if (m) {
      return { hit: true, snippet: m[0] };
    }
  }
  return null;
}
