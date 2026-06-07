/**
 * Provider profile registry + resolver.
 *
 * 2026-06-07: resolveProfile(model) picks the right ProviderProfile from the
 * model id alone. Selection is by model-id heuristic (not by configured
 * LLM_PROVIDER) because the AnthropicAdapter is also used as a generic
 * Anthropic-protocol gateway for non-Claude models (e.g. deepseek-v4-* via a
 * proxy), so the model string is the only reliable signal of the wire quirks.
 *
 * Order matters: deepseek first (most specific), then claude, then kimi, then
 * the plain OpenAI-compat / Base fallback.
 */

import { BaseProfile, type ProviderProfile } from './base.js';
import { DeepSeekProfile, deepseekSupportsThinking } from './deepseek.js';
import { AnthropicNativeProfile, isClaudeModel } from './anthropic-native.js';
import { KimiProfile, OpenAICompatProfile, isKimiModel } from './openai-compat.js';

export * from './base.js';
export { DeepSeekProfile, deepseekSupportsThinking } from './deepseek.js';
export { AnthropicNativeProfile, isClaudeModel } from './anthropic-native.js';
export { KimiProfile, OpenAICompatProfile, isKimiModel } from './openai-compat.js';

// Singletons — profiles are stateless/declarative, safe to share.
const DEEPSEEK = new DeepSeekProfile();
const ANTHROPIC_NATIVE = new AnthropicNativeProfile();
const KIMI = new KimiProfile();
const OPENAI_COMPAT = new OpenAICompatProfile();
const BASE = new BaseProfile();

export function resolveProfile(model: string): ProviderProfile {
  const m = (model || '').trim().toLowerCase();
  // deepseek-* (covers v4 thinking-capable and v3 non-thinking; the profile
  // itself decides supportsThinking per model).
  if (m.startsWith('deepseek') || deepseekSupportsThinking(m)) return DEEPSEEK;
  if (isClaudeModel(m)) return ANTHROPIC_NATIVE;
  if (isKimiModel(m)) return KIMI;
  // openai / glm / gemini / minimax and anything else → no thinking wire.
  if (m) return OPENAI_COMPAT;
  return BASE;
}
