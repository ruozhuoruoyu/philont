/**
 * HalfFinishedGate (Phase 15, 2026-05-18): detector for slow-task "stop halfway" behavior.
 *
 * ── Background ──────────────────────────────────────────────────────────────
 *
 * Observed repeatedly in production (e.g. onboarding flows): in slow mode, the LLM
 * makes a few tool calls, then outputs a commitment-style text to end the turn,
 * without actually advancing the plan — the task hangs waiting for "next turn". But
 * channels (WeChat/IM/email) are fire-and-forget — the user sends and walks away, no next turn.
 *
 * Typical final text example:
 *   "OK, I've seen these communities. I need to first understand the current discussion,
 *    then write a quality post. Let me check the trending posts…"
 *
 * Existing detectors all miss this:
 *   - HonestyGate: LLM has no "completion claim", does not fire when fail < ok
 *   - EmptyConclusionGate: final text is > 100 chars, not considered empty
 *   - TaskCommitmentDrive: catches HANDOFF pattern, not "let me look first" style
 *   - spec-coverage: only checked at plan_close, turn ending naturally doesn't go through close
 *
 * ── Detection logic (fully generic, no project-specific keywords) ──────────────────────────────────
 *
 * Trigger conditions (all must be satisfied):
 *   1. mode = 'slow'
 *   2. There is a placeholder plan in draft state (LLM stopped before converting plan to active)
 *   3. final text contains a commitment-style phrase (bilingual regex, purely structural, no project keywords)
 *   4. 0 successful plan_update_step calls this turn (no substantive progress)
 *   5. No completion claim (reuses findCompletionClaim; if there is one, honesty handles it)
 *
 * ── Relationship with HonestyGate ──────────────────────────────────────────────
 *
 * Complementary, non-overlapping:
 *   - HonestyGate: **claimed completion but insufficient evidence** → actual lying or fabrication
 *   - HalfFinishedGate: **no completion claim, but also stopped without actually doing anything** → evasion
 *
 * Call order: HonestyGate first (if claim present, go to honesty); only if honesty doesn't fire, go to half-finished.
 */

import { findCompletionClaim } from './honesty_gate.js';

// ── Commitment-style phrase regex (purely generic, bilingual Chinese/English) ──────────────────────────────────
//
// Trigger principle: final text contains a statement like "I will do X next" (implying waiting for next turn).
// Counter-examples (should NOT match):
//   - "Completed X, next the user should Y" (instructing the user, not a self-commitment)
//   - "I just had fetch run" (past tense, not a future commitment)
//
// Regex constraints:
//   1. First person (I / 我) + future tense (先 / 接下来 / 下次 / 待会)
//   2. Or: imperative (让我 / let me) + exploratory action (看 / 试 / 了解 / look / try / check)
const COMMITMENT_PATTERNS: ReadonlyArray<RegExp> = [
  // Chinese — "让我先 X / 让我看看 / 让我了解一下"
  /让我(?:先|来)?(?:看(?:看|一下)?|试|了解|研究|查|检查|确认)/,
  // Chinese — "我先 X 再 Y / 我先 X" (X is an exploratory action)
  // Prefix: start of line / punctuation (Chinese or English) / whitespace
  /(?:^|[，。、!?,.\s])我先[^。!?\n]{0,15}(?:看|读|了解|查|试|学|研究|想)/,
  // Chinese — "我需要先 X / 我需要先了解"
  /我需要先[^。!?\n]{0,12}(?:了解|看|读|查|确认|学|研究)/,
  // Chinese — "接下来我会 / 之后我要 / 下一步我打算"
  /(?:接下来|之后|下一步)[^。!?\n]{0,4}(?:我会|我要|我将|我打算)/,
  // Chinese — "下次再 / 改天 / 稍后 / 待会儿 / 过会儿"
  /(?:下次|改天|稍后|待会|过会|等会|一会儿)(?:再|就|会|的)?[^。!?\n]{0,8}(?:做|看|跑|执行|处理|完成|搞|来|去)/,
  // English — "let me look/check/try/see..."
  /\blet me\s+(?:look|check|try|see|explore|investigate|understand|read|review|consider)\b/i,
  // English — "I'll/I will [arbitrary non-sentence-ending words] first/next/later"
  // Using [^.!?\n]{1,40} to cover middle words, broader than \w{1,15}\s+
  /\bI(?:'ll| will)\s+[^.!?\n]{1,40}\s+(?:first|next|later|in a (?:bit|moment|second))\b/i,
  // English — "I need to (verb) first" (exploratory verb)
  /\bI need to\s+(?:look|check|read|review|understand|investigate|explore)(?:\s+(?:first|more))?/i,
];

/** Detect whether text contains a commitment-style phrase */
export function findCommitmentPhrase(text: string): string | null {
  for (const re of COMMITMENT_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────

export interface HalfFinishedDetection {
  /** The matched commitment-style phrase text */
  matchedPhrase: string;
  /** Trigger reason — for audit / regen prompt use */
  reason: 'commitment_without_progress';
  /** For chat-handler to compose regen prompt */
  evidence: string;
}

export interface DetectHalfFinishedOptions {
  /** Current task mode (detection only in 'slow'; 'fast' returns null immediately) */
  mode: 'fast' | 'slow';
  /** Whether there is a placeholder plan in draft (LLM stopped before plan_revise converted it) */
  hasPlaceholderPlanInDraft: boolean;
  /** Whether any plan_update_step tool call succeeded this turn */
  hasPlanUpdateStepCallInTurn: boolean;
}

/**
 * Detect whether the final text represents a "stop halfway" turn.
 *
 * Returns null = do not trigger. Returns HalfFinishedDetection = caller should trigger cap=1 regen,
 * injecting a reminder to "avoid commitment phrases / make substantive plan progress" into the next prompt.
 */
export function detectHalfFinishedTurn(
  assistantText: string,
  opts: DetectHalfFinishedOptions,
): HalfFinishedDetection | null {
  // Only check in slow tasks
  if (opts.mode !== 'slow') return null;
  // Must have a placeholder plan still in draft (LLM stopped before splitting deliverables)
  if (!opts.hasPlaceholderPlanInDraft) return null;
  // This turn already has plan_update_step → LLM is making progress, not halfway
  if (opts.hasPlanUpdateStepCallInTurn) return null;
  // If there is a completion claim, HonestyGate handles it — don't double-fire
  if (findCompletionClaim(assistantText)) return null;
  // Check for commitment-style phrase
  const phrase = findCommitmentPhrase(assistantText);
  if (!phrase) return null;

  return {
    matchedPhrase: phrase,
    reason: 'commitment_without_progress',
    evidence:
      `Final text contains commitment phrase "${phrase}", but the slow-task placeholder plan is still in draft ` +
      `with 0 plan_update_step calls this turn and no completion claim — this is a "stop-halfway" pattern ` +
      `(LLM assumes it can continue across turns, but the channel is fire-and-forget).`,
  };
}
