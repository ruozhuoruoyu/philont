/**
 * Anthropic-native (real Claude) provider profile.
 *
 * 2026-06-07: for genuine claude-* models reached over the Anthropic protocol.
 * Unlike DeepSeek, Claude uses ONLY the Anthropic-native extended-thinking shape:
 *   thinking: { type: 'enabled', budget_tokens: N }   to enable
 *   (field omitted)                                    to disable
 * There is no output_config / reasoning_effort and no OpenAI-format wire — Claude
 * is never driven through the OpenAI-compat adapter here.
 *
 * Env vars (shared with deepseek.ts):
 *   PHILONT_DEEPSEEK_THINKING_BUDGET  default 12000 — budget_tokens (reused as the
 *       thinking budget; named for DeepSeek but applies to any Anthropic-format
 *       thinking block).
 *   PHILONT_LLM_REASONING_MAX_TOKENS  default 32000 — raised ceiling for reasoning.
 *
 * Anthropic hard rule: max_tokens MUST be strictly greater than budget_tokens
 * (otherwise the answer has zero headroom). resolveMaxTokens enforces that.
 */

import { BaseProfile, mapEffort, envInt, type ReasoningConfig, type ReasoningWire } from './base.js';

const THINKING_BUDGET_ENV = 'PHILONT_DEEPSEEK_THINKING_BUDGET';
const THINKING_BUDGET_DEFAULT = 12000;

export function isClaudeModel(model: string): boolean {
  return (model || '').trim().toLowerCase().startsWith('claude');
}

export class AnthropicNativeProfile extends BaseProfile {
  constructor() {
    super('anthropic-native');
  }

  supportsThinking(model: string): boolean {
    return isClaudeModel(model);
  }

  buildReasoningWire(model: string, reasoning: ReasoningConfig | undefined): ReasoningWire {
    if (!this.supportsThinking(model)) return {};
    // Default OFF for Claude: extended thinking is opt-in and changes latency/cost,
    // and Claude has no reasoning_content echo trap to defend against. Only enable
    // when the caller explicitly asks (reasoning.enabled === true).
    const enabled = reasoning?.enabled === true;
    if (!enabled) {
      // Omit the thinking field → standard (non-thinking) Claude request.
      return {};
    }
    const budget = envInt(THINKING_BUDGET_ENV, THINKING_BUDGET_DEFAULT);
    // Claude has no output_config; effort is not a wire field here. We keep the
    // mapping for symmetry/logging but it does not alter the request.
    void mapEffort(reasoning?.effort);
    return { anthropicParams: { thinking: { type: 'enabled', budget_tokens: budget } } };
  }

  resolveMaxTokens(model: string, reasoning: ReasoningConfig | undefined, base: number): number {
    if (!this.supportsThinking(model)) return base;
    if (reasoning?.enabled !== true) return base;
    const budget = envInt(THINKING_BUDGET_ENV, THINKING_BUDGET_DEFAULT);
    const ceiling = envInt('PHILONT_LLM_REASONING_MAX_TOKENS', 32000);
    // Anthropic requires max_tokens > budget_tokens; guarantee headroom for the answer.
    return Math.max(base, ceiling, budget + 4096);
  }
}
