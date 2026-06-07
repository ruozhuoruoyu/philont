/**
 * OpenAI-compatible provider profiles.
 *
 * 2026-06-07: covers the providers wired through OpenAICompatAdapter
 * (openai / minimax / glm / kimi / gemini). Most have no thinking mode and fall
 * back to BaseProfile behaviour. Kimi / Moonshot DO support a thinking toggle in
 * the same DeepSeek-OpenAI wire shape (extra_body.thinking + top-level
 * reasoning_effort), so we model just that family here.
 *
 * Keyed by model-id substring (the OpenAI-compat adapter passes a concrete model
 * string such as "moonshot-v1-128k" or "kimi-k2").
 *
 * Env vars (shared): PHILONT_LLM_REASONING_MAX_TOKENS default 32000.
 */

import { BaseProfile, mapEffort, envInt, type ReasoningConfig, type ReasoningWire } from './base.js';

export function isKimiModel(model: string): boolean {
  const m = (model || '').trim().toLowerCase();
  return m.includes('kimi') || m.includes('moonshot');
}

/**
 * Kimi / Moonshot — extra_body.thinking + top-level reasoning_effort, mirroring
 * the DeepSeek OpenAI-format shape. No Anthropic-format wire (Kimi is only ever
 * reached through the OpenAI-compat adapter here).
 */
export class KimiProfile extends BaseProfile {
  constructor() {
    super('kimi');
  }

  supportsThinking(model: string): boolean {
    return isKimiModel(model);
  }

  buildReasoningWire(model: string, reasoning: ReasoningConfig | undefined): ReasoningWire {
    if (!this.supportsThinking(model)) return {};
    const enabled = reasoning?.enabled !== false;
    if (!enabled) {
      return { openaiExtraBody: { thinking: { type: 'disabled' } } };
    }
    const effort = mapEffort(reasoning?.effort);
    const openaiTopLevel: Record<string, unknown> = {};
    if (effort) openaiTopLevel.reasoning_effort = effort;
    return { openaiExtraBody: { thinking: { type: 'enabled' } }, openaiTopLevel };
  }

  resolveMaxTokens(model: string, reasoning: ReasoningConfig | undefined, base: number): number {
    if (!this.supportsThinking(model)) return base;
    const enabled = reasoning?.enabled !== false;
    const effort = mapEffort(reasoning?.effort);
    if (enabled && (effort === 'high' || effort === 'max')) {
      return Math.max(base, envInt('PHILONT_LLM_REASONING_MAX_TOKENS', 32000));
    }
    return base;
  }
}

/**
 * Plain OpenAI-compat profile for openai / glm / gemini / minimax — no thinking
 * wire fields, max_tokens = base. Identical to BaseProfile but named for clarity
 * in logs/selection.
 */
export class OpenAICompatProfile extends BaseProfile {
  constructor() {
    super('openai-compat');
  }
}
