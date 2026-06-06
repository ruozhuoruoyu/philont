/**
 * OutputFormatGate — detects when LLM final text is very long but does not use the `## 给用户` section format.
 *
 * Trigger scenario: LLM makes many tool calls then outputs 5000+ character text without sections
 * (no `## 给用户` heading); wechat output_filter fallback can only push the full text → user sees verbose, unfocused output.
 *
 * Analogous to EmptyConclusionGate (handles "did a lot but said nothing"), OutputFormatGate handles
 * "did a lot, said a lot, but no sections".
 *
 * Callers (chat-handler) that receive shouldRegenerate=true should:
 *   - Log to audit (`output_format_gate_fired`)
 *   - Inject a reminder message asking the LLM to rewrite using `## 给用户` + `## 工作日志` two-section format
 *   - Call LLM again once, cap=1 per turn
 *
 * Design invariants:
 *   - Pure synchronous function, no IO
 *   - Conservative threshold: finalText > 500 chars + no /## 给用户/ → trigger
 *   - Short replies (< 500 chars) pass through — simple queries don't need two-section format
 *   - Parallel to HonestyGate / EmptyConclusionGate (all three diagnose different problems)
 *
 * env switch: PHILONT_OUTPUT_FORMAT_GATE=0 disables the entire gate.
 */

export interface OutputFormatResult {
  shouldRegenerate: boolean;
  reason?: 'long_text_no_user_section';
  detail?: {
    finalTextLength: number;
    hasUserSection: boolean;
  };
}

export interface OutputFormatInput {
  /** LLM final text for this turn (raw text before trimming) */
  finalText: string;
  /** Threshold: exceeding this length + no ## 给用户 section → trigger. Default 500 */
  minLengthToTrigger?: number;
}

const USER_SECTION_PATTERN = /##\s*给用户/i;

export function evaluateOutputFormat(input: OutputFormatInput): OutputFormatResult {
  const trimmed = input.finalText.trim();
  const minLen = input.minLengthToTrigger ?? 500;
  const hasUserSection = USER_SECTION_PATTERN.test(trimmed);
  const detail = {
    finalTextLength: trimmed.length,
    hasUserSection,
  };

  // Long text + no `## 给用户` section → trigger
  if (trimmed.length > minLen && !hasUserSection) {
    return {
      shouldRegenerate: true,
      reason: 'long_text_no_user_section',
      detail,
    };
  }

  return { shouldRegenerate: false, detail };
}
