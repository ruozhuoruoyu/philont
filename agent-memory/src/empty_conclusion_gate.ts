/**
 * EmptyConclusionGate — detects "agent made a bunch of tool calls but gave the user no summary at the end".
 *
 * Trigger scenario (exposed by PDF→Word case): after 3 shell tool calls, the LLM final text
 * returns only "." (a single character), leaving the user staring at a lone ".".
 * HonestyGate does not fire (there is no completion claim to compare against), and the user experience collapses.
 *
 * When the caller (chat-handler) receives shouldRegenerate=true, it should:
 *   - Log to audit (`empty_conclusion_gate_fired`)
 *   - Inject a reminder message asking the LLM to summarize this turn's calls + results + next steps in one sentence
 *   - Call LLM again once, capped at 1 re-invocation per turn
 *
 * Design invariants:
 *   - Pure synchronous function, no IO
 *   - Conservative thresholds: >= 3 tool calls + < 10 characters, or >= 1 tool call + completely empty
 *   - Standalone gate (not attached to HonestyGate) — the two diagnose different problems
 */

export type EmptyConclusionReason = 'empty_after_tools' | 'too_short_after_tools';

export interface EmptyConclusionResult {
  shouldRegenerate: boolean;
  reason?: EmptyConclusionReason;
  /** For caller logging use */
  detail?: {
    toolCallsThisTurn: number;
    finalTextLength: number;
  };
}

export interface EmptyConclusionInput {
  /** Total tool calls accumulated this turn (since the latest user message) */
  toolCallsThisTurn: number;
  /** LLM final text for this turn (raw text before trimming) */
  finalText: string;
}

/**
 * Evaluates whether the final text needs to be regenerated.
 *
 * Rules:
 *   - toolCallsThisTurn >= 3 and finalText.trim().length < 10 → too_short_after_tools
 *   - toolCallsThisTurn >= 1 and finalText.trim() === ''      → empty_after_tools
 *   - otherwise → pass
 *
 * Priority: empty takes precedence over too_short (completely empty is more definitively a bug;
 * too_short still allows for "OK"-style reasonable short responses, but combined with 3+ tool calls that is basically unreasonable).
 */
export function evaluateEmptyConclusion(input: EmptyConclusionInput): EmptyConclusionResult {
  const trimmed = input.finalText.trim();
  const detail = {
    toolCallsThisTurn: input.toolCallsThisTurn,
    finalTextLength: trimmed.length,
  };

  if (input.toolCallsThisTurn >= 1 && trimmed.length === 0) {
    return { shouldRegenerate: true, reason: 'empty_after_tools', detail };
  }
  if (input.toolCallsThisTurn >= 3 && trimmed.length < 10) {
    return { shouldRegenerate: true, reason: 'too_short_after_tools', detail };
  }
  return { shouldRegenerate: false };
}
