/**
 * DeepSeek provider profile.
 *
 * 2026-06-07: mirrors hermes plugins/model-providers/deepseek. DeepSeek's V4
 * family (deepseek-v4-pro / deepseek-v4-flash / any future deepseek-v4+*) and
 * the legacy deepseek-reasoner (R1) support a parameter-toggled thinking mode.
 * Thinking is NOT a separate model name — it is a request parameter on the same
 * model. V3 (deepseek-chat / deepseek-v3*) has no thinking mode.
 *
 * Two traps this profile defuses:
 *   1. reasoning_content echo-400: with thinking left UNSET (default ON) the API
 *      returns `reasoning_content`, then 400s the first tool call unless it is
 *      echoed back. Fix: ALWAYS emit the thinking field explicitly (enabled or
 *      disabled) so the default-on path never engages.
 *   2. empty-text: thinking tokens count against max_tokens; high/max effort can
 *      eat the whole budget → stop_reason=max_tokens, no text. resolveMaxTokens
 *      raises the ceiling when reasoning is on at high/max effort.
 *
 * Wire shapes (emit BOTH so it works whether the adapter is Anthropic-protocol
 * or OpenAI-compat; each adapter consumes only its own slice):
 *   - OpenAI format: top-level reasoning_effort + extra_body.thinking{type}.
 *   - Anthropic format: thinking{type:'enabled',budget_tokens} to enable
 *     (Anthropic-native shape) / thinking{type:'disabled'} to disable (DeepSeek
 *     extension passed through), plus output_config{effort} for effort.
 *
 * Env vars introduced here:
 *   PHILONT_DEEPSEEK_THINKING_BUDGET  default 12000  — budget_tokens for the
 *       Anthropic-format thinking block when enabled.
 *   PHILONT_LLM_REASONING_MAX_TOKENS  default 32000  — max_tokens ceiling raised
 *       to (used here and by AnthropicNativeProfile) when reasoning is enabled at
 *       high/max effort so the answer has headroom past the thinking tokens.
 */

import { BaseProfile, mapEffort, envInt, type ReasoningConfig, type ReasoningWire } from './base.js';

export function deepseekSupportsThinking(model: string): boolean {
  const m = (model || '').trim().toLowerCase();
  if (!m) return false;
  // deepseek-v4-*, deepseek-v5-*, … every V4+ generation has thinking; v3 excluded.
  if (m.startsWith('deepseek-v') && !m.startsWith('deepseek-v3')) return true;
  if (m === 'deepseek-reasoner') return true;
  return false;
}

export class DeepSeekProfile extends BaseProfile {
  constructor() {
    super('deepseek');
  }

  supportsThinking(model: string): boolean {
    return deepseekSupportsThinking(model);
  }

  buildReasoningWire(model: string, reasoning: ReasoningConfig | undefined): ReasoningWire {
    if (!this.supportsThinking(model)) {
      // V3 / unknown — leave the wire format untouched (current behaviour).
      return {};
    }

    // Default enabled to match DeepSeek's API default; must be set explicitly to
    // avoid the reasoning_content echo-400 trap on subsequent turns.
    const enabled = reasoning?.enabled !== false;

    if (!enabled) {
      return {
        anthropicParams: { thinking: { type: 'disabled' } },
        openaiExtraBody: { thinking: { type: 'disabled' } },
      };
    }

    const budget = envInt('PHILONT_DEEPSEEK_THINKING_BUDGET', 12000);
    const effort = mapEffort(reasoning?.effort);

    const anthropicParams: Record<string, unknown> = {
      thinking: { type: 'enabled', budget_tokens: budget },
    };
    const openaiTopLevel: Record<string, unknown> = {};
    const openaiExtraBody: Record<string, unknown> = { thinking: { type: 'enabled' } };

    // effort omitted → let the server apply its default (currently high).
    if (effort) {
      anthropicParams.output_config = { effort };
      openaiTopLevel.reasoning_effort = effort;
    }

    return { anthropicParams, openaiTopLevel, openaiExtraBody };
  }

  resolveMaxTokens(model: string, reasoning: ReasoningConfig | undefined, base: number): number {
    if (!this.supportsThinking(model)) return base;
    const enabled = reasoning?.enabled !== false;
    const effort = mapEffort(reasoning?.effort);
    // Only raise the ceiling for the budget-hungry efforts (high/max), so thinking
    // tokens don't consume the whole answer budget (the empty-text bug).
    if (enabled && (effort === 'high' || effort === 'max')) {
      return Math.max(base, envInt('PHILONT_LLM_REASONING_MAX_TOKENS', 32000));
    }
    return base;
  }
}
