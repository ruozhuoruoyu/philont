/**
 * ProviderProfile layer.
 *
 * 2026-06-07: a declarative per-provider abstraction (modeled on hermes's
 * providers/base.py). Each model family's reasoning/thinking wire-shape and
 * quirks live in one place instead of being smeared across the adapters as
 * ad-hoc `if (model.startsWith('deepseek'))` branches.
 *
 * Design split: a profile contributes request fields keyed by **wire format**
 * (Anthropic-protocol vs OpenAI-compat), because the same model is reachable
 * through both (e.g. DeepSeek's gateway speaks the Anthropic protocol, while
 * its native endpoint speaks OpenAI-compat). The adapter merges only the slice
 * that matches its own wire format. See `ReasoningWire` below.
 */

import type { ReasoningConfig } from '@agent/tools';
export type { ReasoningConfig };

/** Fields a profile contributes to a request, split by wire format. */
export interface ReasoningWire {
  /** Merge into Anthropic SDK messages.create() params (thinking, output_config, …). */
  anthropicParams?: Record<string, unknown>;
  /** Merge into OpenAI-compat request body top-level (reasoning_effort, …). */
  openaiTopLevel?: Record<string, unknown>;
  /** Merge into OpenAI-compat request body.extra_body (thinking, …). */
  openaiExtraBody?: Record<string, unknown>;
}

export interface ProviderProfile {
  readonly name: string;
  /** True if `model` supports a thinking/reasoning mode. */
  supportsThinking(model: string): boolean;
  /**
   * Translate desired reasoning into wire fields. MUST set the thinking field
   * explicitly when `supportsThinking` (the reasoning_content echo-400 fix:
   * DeepSeek V4 defaults thinking ON and then demands `reasoning_content` be
   * echoed every turn; pinning the field dodges that trap).
   */
  buildReasoningWire(model: string, reasoning: ReasoningConfig | undefined): ReasoningWire;
  /** Effective max_tokens given reasoning. `base` = the configured PHILONT_LLM_MAX_TOKENS. */
  resolveMaxTokens(model: string, reasoning: ReasoningConfig | undefined, base: number): number;
}

/**
 * Default no-op profile. Concrete profiles extend this and override only the
 * hooks they need. Out of the box: no thinking, empty wire, max_tokens = base.
 */
export class BaseProfile implements ProviderProfile {
  constructor(public readonly name: string = 'base') {}

  supportsThinking(_model: string): boolean {
    return false;
  }

  buildReasoningWire(_model: string, _reasoning: ReasoningConfig | undefined): ReasoningWire {
    return {};
  }

  resolveMaxTokens(_model: string, _reasoning: ReasoningConfig | undefined, base: number): number {
    return base;
  }
}

// ── Shared helpers for concrete profiles ────────────────────────────────────

/**
 * Effort mapping common to the DeepSeek-style wire shapes:
 *   'max' | 'xhigh' → 'max'; 'low' | 'medium' | 'high' → passthrough;
 *   undefined / unknown → undefined (omit → let the server apply its default).
 */
export function mapEffort(effort: ReasoningConfig['effort'] | string | undefined): string | undefined {
  const e = (effort || '').toString().trim().toLowerCase();
  if (e === 'max' || e === 'xhigh') return 'max';
  if (e === 'low' || e === 'medium' || e === 'high') return e;
  return undefined;
}

/** Read a positive-integer env var with a fallback. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
