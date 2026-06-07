/**
 * LLM adapter
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition } from '@agent/policy';
import type { ReasoningConfig } from '@agent/tools';
import { resolveProfile, type ProviderProfile } from './providers/index.js';

// Anthropic native message format
export type NativeMessage = Anthropic.MessageParam;

export type LLMResponse =
  | { type: 'text'; content: string }
  | { type: 'toolCalls'; calls: Array<{ id: string; name: string; input: Record<string, unknown> }>; assistantMessage: NativeMessage };

/**
 * Options for send.
 *  - signal: mid-turn user stop (UserHardStop) — passed to the underlying HTTP
 *    call to cancel in-flight requests.
 *  - reasoning: selects thinking mode + effort for THIS call. The active
 *    ProviderProfile (resolved from the model id) translates it into the right
 *    per-provider wire fields. Callers pass e.g. {enabled:true, effort:'max'}
 *    for deep_explore; omit to use the profile's per-scenario default.
 */
export interface LLMSendOpts {
  signal?: AbortSignal;
  reasoning?: ReasoningConfig;
}

export interface LLMAdapter {
  send(messages: NativeMessage[], tools?: ToolDefinition[], opts?: LLMSendOpts): Promise<LLMResponse>;
}

/** Redact an API key to `****<last4>` — only for startup logging to confirm which key is in use, without leaking the full value. */
function maskKey(key: string | undefined): string {
  if (!key) return '(not set!)';
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

/**
 * 2026-05-27: Defensive tool_use ↔ tool_result pairing repair.
 *
 * Anthropic API hard constraint: every tool_use block in an assistant message must have a
 * corresponding tool_result in the immediately following user message (matched by
 * tool_use_id), otherwise 400 ("tool_use ids were found without tool_result blocks
 * immediately after").
 *
 * Trigger scenarios (confirmed with deepseek-v4-pro and similar reasoning models):
 *   - Model emits **multiple** tool_use blocks in one response (readFile×2 + writeFile×2)
 *   - philont auth-pause / gate-block halts at an intermediate tool → remaining tool_use
 *     blocks stay in the assistant message with no matching tool_result
 *   - On resume, the full messages array is sent to the API → missing pairs → 400
 *
 * Claude typically emits one tool_use at a time and does not hit this; deepseek with
 * multiple tool_use per response triggers it.
 *
 * Fix: scan before each request; any tool_use missing a tool_result → insert a placeholder
 * tool_result. Catches gaps regardless of origin (auth / gate / truncation). Returns a new
 * array; does not mutate the input.
 */
const TOOL_RESULT_PLACEHOLDER =
  '(tool call not executed — interrupted by authorization/gate or superseded; treat as no-op)';

export function repairToolResultPairing(messages: NativeMessage[]): NativeMessage[] {
  // Rebuild-guarantee (2026-05-31 upgrade): the old version only inserted missing tool_results
  // when none existed at all in the full array, and did **not relocate misplaced ones** (resume
  // repeatedly splicing messages produces misplacements → still 400). New version re-anchors
  // by tool_use, ensuring that after each assistant message with tool_use blocks, there is
  // **exactly one immediately following user message** containing all matching results:
  //   - Missing → insert placeholder; misplaced (exists elsewhere) → relocate to the adjacent message;
  //   - Pure tool_result carrier messages are discarded (their results have been relocated);
  //   - Orphan results with no corresponding tool_use are discarded (otherwise "tool_result
  //     without tool_use" is also a 400);
  //   - Regular text user messages are passed through unchanged.
  // Does not mutate input; returns a new array.

  // 1) Index each tool_result id → {block, fromIndex} (first occurrence wins; fromIndex is
  //    used to determine "was it already in the immediately following message" — the normal
  //    case is not counted as a repair; only truly misplaced / missing / orphan entries are).
  const resultById = new Map<string, { block: Anthropic.ToolResultBlockParam; fromIndex: number }>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if ((b as { type?: string }).type === 'tool_result') {
        const id = (b as { tool_use_id?: string }).tool_use_id;
        if (id && !resultById.has(id)) {
          resultById.set(id, { block: b as Anthropic.ToolResultBlockParam, fromIndex: i });
        }
      }
    }
  }

  // 2) Rebuild. Track actual repairs: missing inserted as placeholder / misplaced relocated / orphans discarded.
  const out: NativeMessage[] = [];
  const consumed = new Set<string>();
  let missing = 0;
  let relocated = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      out.push({ ...m });
      if (!Array.isArray(m.content)) continue;
      const useIds = m.content
        .filter((b): b is Anthropic.ToolUseBlockParam => (b as { type?: string }).type === 'tool_use')
        .map((b) => b.id);
      if (useIds.length === 0) continue;
      // Immediately following user message, containing all results for the tool_use blocks
      // (in tool_use order; missing ones get a placeholder)
      const results: Anthropic.ToolResultBlockParam[] = useIds.map((id) => {
        const found = resultById.get(id);
        if (!found) {
          missing++;
          return { type: 'tool_result', tool_use_id: id, content: TOOL_RESULT_PLACEHOLDER };
        }
        consumed.add(id);
        if (found.fromIndex !== i + 1) relocated++; // was not in the immediately following message → true relocation
        return found.block;
      });
      out.push({ role: 'user', content: results });
      continue;
    }

    // user (or other): strip tool_result blocks (already relocated by tool_use); keep the rest (text etc.)
    if (Array.isArray(m.content)) {
      const nonResult = m.content.filter((b) => (b as { type?: string }).type !== 'tool_result');
      if (nonResult.length > 0) out.push({ ...m, content: nonResult });
      // Pure tool_result messages (stripped empty) → discard
    } else {
      out.push({ ...m }); // string content
    }
  }

  // Orphans: tool_results whose id was never consumed by any tool_use → already discarded
  let orphans = 0;
  for (const id of resultById.keys()) if (!consumed.has(id)) orphans++;

  // Only warn when **a real repair actually happened** (normal turns are silent); include details.
  if (missing > 0 || relocated > 0 || orphans > 0) {
    console.warn(
      `[llm-adapter] tool_result pairing repair: missing=${missing} relocated=${relocated} orphans-dropped=${orphans} (prevents 400)`,
    );
  }
  return out;
}

/**
 * Defensive parsing: some LLM providers (open-source ChatML-style models / older
 * Hermes/Qwen / long-context degraded mode) output tool_use as **`<tool_call>` tags
 * embedded in text** rather than native tool_use blocks. The adapter needs to detect
 * and recover this form as real tool calls.
 *
 * Recognised formats (in order of attempt):
 *   1. `<tool_call>{"name":"X","arguments":{...}}</tool_call>` (Hermes/Nous)
 *   2. ` ```tool_call\n{...}\n``` ` (some code models)
 *   3. `<function_call>{...}</function_call>` (old Gemini-style)
 *   4. Entire content is a raw `{"name":"X","arguments":{...}}` single JSON block
 *
 * Returns null if no embedded tool call is found (treat as normal text). Otherwise
 * returns the list of recognised calls.
 *
 * **Conservative by design**: only matches if JSON.parse succeeds AND the result
 * contains name + arguments (or parameters / input) fields. Parse failure → treat as text.
 */
export interface EmbeddedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export function parseTextEmbeddedToolCalls(text: string): EmbeddedToolCall[] | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const calls: EmbeddedToolCall[] = [];

  // 1. <tool_call>...</tool_call> (supports multiple)
  const toolCallRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = toolCallRe.exec(text)) !== null) {
    const c = parseToolCallJson(m[1]);
    if (c) calls.push(c);
  }
  if (calls.length > 0) return calls;

  // 2. ```tool_call\n...\n``` (fenced)
  const fencedRe = /```(?:tool_call|tool|function_call)\s*\n([\s\S]*?)\n```/g;
  while ((m = fencedRe.exec(text)) !== null) {
    const c = parseToolCallJson(m[1]);
    if (c) calls.push(c);
  }
  if (calls.length > 0) return calls;

  // 3. <function_call>...</function_call>
  const funcCallRe = /<function_call>\s*([\s\S]*?)\s*<\/function_call>/g;
  while ((m = funcCallRe.exec(text)) !== null) {
    const c = parseToolCallJson(m[1]);
    if (c) calls.push(c);
  }
  if (calls.length > 0) return calls;

  // 4. Entire content is a raw JSON block (stop reason without tool_use but content is a single JSON block)
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const c = parseToolCallJson(trimmed);
    if (c) return [c];
  }

  return null;
}

function parseToolCallJson(raw: string): EmbeddedToolCall | null {
  try {
    const parsed = JSON.parse(raw.trim());
    if (!parsed || typeof parsed !== 'object') return null;
    const name = (parsed as Record<string, unknown>).name;
    if (typeof name !== 'string' || name.length === 0) return null;
    const argsRaw =
      (parsed as Record<string, unknown>).arguments ??
      (parsed as Record<string, unknown>).parameters ??
      (parsed as Record<string, unknown>).input ??
      {};
    let input: Record<string, unknown>;
    if (typeof argsRaw === 'string') {
      try {
        input = JSON.parse(argsRaw) as Record<string, unknown>;
      } catch {
        input = { _raw: argsRaw };
      }
    } else if (argsRaw && typeof argsRaw === 'object') {
      input = argsRaw as Record<string, unknown>;
    } else {
      input = {};
    }
    return {
      id: typeof (parsed as Record<string, unknown>).id === 'string'
        ? (parsed as { id: string }).id
        : `text-tool-${Math.random().toString(36).slice(2, 10)}`,
      name,
      input,
    };
  } catch {
    return null;
  }
}

/**
 * Context window exceeded / request body too large error.
 * chat-handler identifies this error and triggers emergency eviction + one retry.
 */
export class ContextTooLargeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ContextTooLargeError';
  }
}

/**
 * Recognise common "context too large" error signals (cross-provider):
 *   - "request body too large" (upstream gateway)
 *   - "context_length_exceeded" (OpenAI / old Anthropic field)
 *   - "prompt is too long" (Anthropic formal field)
 *   - "exceeds the maximum" (vendor-specific variants)
 */
function isContextTooLargeMessage(s: string): boolean {
  const low = s.toLowerCase();
  return (
    low.includes('request body too large') ||
    low.includes('context_length_exceeded') ||
    low.includes('context length') ||
    low.includes('prompt is too long') ||
    low.includes('prompt too long') ||
    low.includes('exceeds the maximum') ||
    low.includes('maximum context length') ||
    low.includes('token limit')
  );
}

/**
 * Above this max_tokens the Anthropic SDK refuses a non-streaming request (it would imply a
 * >10-min completion: max_tokens > 128000 × 10/60 ≈ 21333 trips the local "Streaming is required"
 * guard). Requests above it are sent via the streaming helper instead. 21000 keeps a safe margin.
 */
const NONSTREAMING_MAX_TOKENS = 21000;

class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic;
  private readonly model: string;
  // 2026-06-07: per-model ProviderProfile owns the reasoning/thinking wire-shape
  // and max_tokens quirks. Resolved once from the model id (see providers/).
  private readonly profile: ProviderProfile;

  constructor(apiKey: string) {
    const baseURL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    // 2026-05-30: explicitly set authToken=null to lock in apiKey-only (X-Api-Key) auth.
    // Otherwise the SDK reads ANTHROPIC_AUTH_TOKEN from the environment on construction and
    // sends it **additionally** as `Authorization: Bearer <token>` (SDK authHeaders sends
    // both X-Api-Key and Authorization simultaneously). Known footgun: a stale
    // ANTHROPIC_AUTH_TOKEN hijacks auth — we pass the correct apiKey, but gateways like
    // DeepSeek that read Authorization get the stale token and report "api key invalid".
    this.client = new Anthropic({ apiKey, baseURL, authToken: null });
    // 2026-05-09: support ANTHROPIC_MODEL env override. The hard-coded claude-sonnet-4-6
    // would hit token permission errors on third-party gateways (neolink / openrouter etc.).
    // Users setting ANTHROPIC_MODEL=deepseek-v4-flash etc. can also use AnthropicAdapter
    // (these gateways proxy multiple models using the Anthropic protocol).
    this.model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';
    this.profile = resolveProfile(this.model);
    // 2026-05-30: print main LLM actual config at startup (key shows only last 4 digits) —
    // instant confirmation of which endpoint / key is in use; helps debug "env not applied /
    // wrong key" class issues.
    console.log(`[llm] main: anthropic baseURL=${baseURL} model=${this.model} key=${maskKey(apiKey)}`);
  }

  async send(messages: NativeMessage[], tools?: ToolDefinition[], opts?: LLMSendOpts): Promise<LLMResponse> {
    const anthropicTools = tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: JSON.parse(t.parameters) as Anthropic.Tool['input_schema']
    }));

    let response: Anthropic.Message;
    try {
      // 2026-05-27: make max_tokens configurable via env.
      // **Reasoning models must set this high**: deepseek-v4-pro / R1 etc. count
      // extended-thinking reasoning tokens against max_tokens; 4096 gets entirely consumed
      // by thinking (stop_reason=max_tokens, content only has [thinking], no text /
      // tool_use → agent receives empty → write=0).
      // Default 16000 (thinking 8k + answer/tools 8k). Upper clamp 65536. This is the
      // **base**; the profile may raise it further when reasoning is on (see below).
      const baseMaxTokens = (() => {
        const raw = process.env.PHILONT_LLM_MAX_TOKENS;
        if (!raw) return 16000;
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 256 && n <= 65536) return n;
        return 16000;
      })();
      // 2026-06-07: ProviderProfile drives the thinking/reasoning wire-shape and the
      // effective max_tokens for this call. buildReasoningWire ALWAYS pins the thinking
      // field on thinking-capable models (the reasoning_content echo-400 fix), and
      // resolveMaxTokens raises the ceiling for high/max effort so thinking tokens don't
      // starve the answer (the empty-text bug).
      const wire = this.profile.buildReasoningWire(this.model, opts?.reasoning);
      const maxTokens = this.profile.resolveMaxTokens(this.model, opts?.reasoning, baseMaxTokens);
      // Repair tool_use ↔ tool_result pairing before sending the request (deepseek
      // multi-tool_use + auth-pause leaves dangling tool_use → 400).
      const safeMessages = repairToolResultPairing(messages);
      // Build params as a Record then cast to the SDK param type at the boundary:
      // `output_config` and `thinking:{type:'disabled'}` (DeepSeek extension) are not in
      // the Anthropic SDK's typed surface, so a typed literal would not compile. The shape
      // is correct on the wire; we keep the cast localized with this comment.
      const createParams: Record<string, unknown> = {
        model: this.model,
        max_tokens: maxTokens,
        messages: safeMessages,
        ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
        ...(wire.anthropicParams ?? {}),
      };
      // 2026-06-07: the SDK refuses a NON-streaming request whose max_tokens implies a
      // >10-min completion: it throws "Streaming is required …" locally (before sending) when
      //   (60*60*1000 * max_tokens) / 128000 > 600000ms  ⇔  max_tokens > 21333.
      // Raising max_tokens to 32000 for high/max reasoning (the empty-text fix) trips this on
      // every turn. Above the threshold, stream and reassemble via finalMessage() — same
      // Anthropic.Message shape, so all downstream handling (content blocks, stop_reason,
      // usage, thinking-block echo) is unchanged. Small requests keep the non-streaming path.
      if (maxTokens > NONSTREAMING_MAX_TOKENS) {
        response = await this.client.messages
          .stream(createParams as unknown as Anthropic.MessageStreamParams, { signal: opts?.signal })
          .finalMessage();
      } else {
        response = await this.client.messages.create(
          createParams as unknown as Anthropic.MessageCreateParamsNonStreaming,
          { signal: opts?.signal },
        );
      }
    } catch (e: unknown) {
      // 400 + "too large" / "context length exceeded" → normalise to ContextTooLargeError
      // so the upper layer can trigger emergency eviction + retry
      const err = e as { status?: number; message?: string };
      if (err?.status === 400 && typeof err.message === 'string' && isContextTooLargeMessage(err.message)) {
        throw new ContextTooLargeError(err.message, e);
      }
      throw e;
    }

    // 2026-05-27: do not gate tool_use extraction on stop_reason === 'tool_use'.
    // deepseek and other Anthropic-compatible endpoints often return tool_use blocks but
    // set stop_reason to 'end_turn' / 'stop' / null (unlike real Anthropic). Original code
    // only extracted on stop_reason==='tool_use' → those endpoints' tool_use was discarded,
    // falling through to the else branch returning empty text → the real cause of agent
    // "reading data and returning nothing" (write=0).
    // Fix: extract tool_use from content regardless of stop_reason.
    const toolUseBlocks = response.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use',
    );
    if (toolUseBlocks.length > 0) {
      if (response.stop_reason !== 'tool_use') {
        console.warn(
          `[llm-adapter] content contains ${toolUseBlocks.length} tool_use block(s) but stop_reason=${response.stop_reason}` +
            ` (non-standard, common with compatible endpoints) — still treating as tool calls`,
        );
      }
      const calls = toolUseBlocks.map(c => ({
        id: c.id,
        name: c.name,
        input: c.input as Record<string, unknown>,
      }));
      // 2026-06-07: return the FULL response.content (including any thinking/reasoning
      // blocks) unchanged. On replay these blocks must be echoed back verbatim — with
      // DeepSeek V4 thinking, dropping reasoning_content is exactly what triggers the
      // HTTP 400 ("reasoning_content must be passed back"). Pinning the thinking field
      // (above) plus echoing full content keeps that contract satisfied.
      return {
        type: 'toolCalls',
        calls,
        assistantMessage: { role: 'assistant', content: response.content }
      };
    }

    const textBlock = response.content.find((c): c is Anthropic.TextBlock => c.type === 'text');
    const text = textBlock?.text ?? '';

    // 2026-05-27 diagnostic: stop_reason is not tool_use and text is empty → log the raw
    // response structure to locate the root cause of deepseek and similar Anthropic-compatible
    // endpoints returning empty after a tool_result.
    // Distinguishes: (a) model truly returned empty (stop_reason=end_turn, output_tokens≈0)
    //               (b) content is in a non-text/tool_use block type (parse miss)
    //               (c) output_tokens > 0 but text is empty (extraction bug)
    if (!text || text.trim().length === 0) {
      const blockTypes = response.content.map((c) => c.type).join(',') || '(none)';
      const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      console.warn(
        `[llm-adapter] empty text response diagnostic: stop_reason=${response.stop_reason} ` +
          `content_blocks=[${blockTypes}] block_count=${response.content.length} ` +
          `usage(in/out)=${usage?.input_tokens ?? '?'}/${usage?.output_tokens ?? '?'}`,
      );
      // If there is a non-text/tool_use block (e.g. deepseek may insert 'thinking' / 'reasoning'),
      // dump the first such block's keys to find where the content is hiding.
      const nonStd = response.content.find((c) => c.type !== 'text' && c.type !== 'tool_use');
      if (nonStd) {
        console.warn(
          `[llm-adapter] non-standard block found: type=${(nonStd as { type: string }).type} ` +
            `keys=[${Object.keys(nonStd).join(',')}]`,
        );
      }
    }

    // Defence: some models output tool_use as <tool_call>{...}</tool_call> embedded in text —
    // rescue these as real tool calls to prevent "LLM thinks it called a tool but only sent text".
    const embedded = parseTextEmbeddedToolCalls(text);
    if (embedded && embedded.length > 0) {
      const blocks: Anthropic.ContentBlock[] = embedded.map((c) => ({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.input,
      } as Anthropic.ToolUseBlock));
      console.warn(
        `[llm-adapter] anthropic returned text but found embedded <tool_call> pattern; rescued ${embedded.length} tool call(s) (${embedded.map(c => c.name).join(',')})`,
      );
      return {
        type: 'toolCalls',
        calls: embedded.map((c) => ({ id: c.id, name: c.name, input: c.input })),
        assistantMessage: { role: 'assistant', content: blocks },
      };
    }

    return { type: 'text', content: text };
  }
}

class MockAdapter implements LLMAdapter {
  async send(messages: NativeMessage[], _tools?: ToolDefinition[], _opts?: LLMSendOpts): Promise<LLMResponse> {
    const last = messages[messages.length - 1];
    const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    return { type: 'text', content: `Mock response to: ${content}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MinimaxAdapter: uses the OpenAI-compatible endpoint (/v1/text/chatcompletion_v2)
// Handles bidirectional translation between Anthropic and OpenAI message formats
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function safeJsonParse(s: string): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

/** Anthropic NativeMessage[] → OpenAI messages[] */
function anthropicToOpenAI(msgs: NativeMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of msgs) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as unknown as Array<Record<string, unknown>>;
    if (m.role === 'assistant') {
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text))
        .join('\n');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolUses.length
          ? {
              tool_calls: toolUses.map((t) => ({
                id: String(t.id),
                type: 'function' as const,
                function: {
                  name: String(t.name),
                  arguments: JSON.stringify(t.input ?? {}),
                },
              })),
            }
          : {}),
      });
    } else {
      // user messages may contain a mix of text / tool_result blocks
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const rawContent = b.content;
          out.push({
            role: 'tool',
            tool_call_id: String(b.tool_use_id),
            content:
              typeof rawContent === 'string'
                ? rawContent
                : JSON.stringify(rawContent),
          });
        } else if (b.type === 'text') {
          out.push({ role: 'user', content: String(b.text) });
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic OpenAI-compatible adapter
// Supports: OpenAI / MiniMax / GLM (Zhipu) / Kimi (Moonshot) / Gemini (OpenAI-compat)
// Any endpoint that follows {model, messages, tools} request +
// choices[0].message{.content,.tool_calls} response
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderConfig {
  /** Human-readable name, used in error messages */
  name: string;
  /** Default base URL (domain only, no trailing slash) */
  baseUrl: string;
  /** Chat completions path (starts with /) */
  path: string;
  /** API key environment variable name */
  apiKeyEnv: string;
  /** Model environment variable name */
  modelEnv: string;
  /** Default value when MODEL env is not set */
  defaultModel: string;
  /** Environment variable for overriding baseUrl */
  baseUrlEnv: string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    path: '/v1/chat/completions',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o',
    baseUrlEnv: 'OPENAI_BASE_URL',
  },
  minimax: {
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat',
    path: '/v1/text/chatcompletion_v2',
    apiKeyEnv: 'MINIMAX_API_KEY',
    modelEnv: 'MINIMAX_MODEL',
    defaultModel: 'MiniMax-Text-01',
    baseUrlEnv: 'MINIMAX_BASE_URL',
  },
  glm: {
    name: 'GLM (Zhipu)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    path: '/chat/completions',
    apiKeyEnv: 'GLM_API_KEY',
    modelEnv: 'GLM_MODEL',
    defaultModel: 'glm-4-plus',
    baseUrlEnv: 'GLM_BASE_URL',
  },
  kimi: {
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn',
    path: '/v1/chat/completions',
    apiKeyEnv: 'KIMI_API_KEY',
    modelEnv: 'KIMI_MODEL',
    defaultModel: 'moonshot-v1-128k',
    baseUrlEnv: 'KIMI_BASE_URL',
  },
  gemini: {
    name: 'Gemini',
    // Google official OpenAI-compatible endpoint (available since 2024)
    baseUrl: 'https://generativelanguage.googleapis.com',
    path: '/v1beta/openai/chat/completions',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.0-flash',
    baseUrlEnv: 'GEMINI_BASE_URL',
  },
};

class OpenAICompatAdapter implements LLMAdapter {
  // 2026-06-07: per-model ProviderProfile (deepseek-native / kimi / plain compat).
  private readonly profile: ProviderProfile;

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
  ) {
    this.profile = resolveProfile(model);
    console.log(`[llm] main: ${cfg.name} baseURL=${baseUrl}${cfg.path} model=${model} key=${maskKey(apiKey)}`);
  }

  async send(messages: NativeMessage[], tools?: ToolDefinition[], opts?: LLMSendOpts): Promise<LLMResponse> {
    // Repair tool_use ↔ tool_result pairing before sending (deepseek multi-tool_use +
    // auth-pause leaves dangling tool_use → 400). Consistent with AnthropicAdapter:
    // the OpenAI-compat path previously missed this; anthropicToOpenAI would translate
    // dangling tool_use into tool_calls with no subsequent role:'tool' message.
    const openaiMsgs = anthropicToOpenAI(repairToolResultPairing(messages));
    const openaiTools = tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: JSON.parse(t.parameters),
      },
    }));

    // 2026-06-07: replace the hardcoded max_tokens=4096 with the profile-resolved
    // ceiling. Base honours PHILONT_LLM_MAX_TOKENS (default 16000) so reasoning models
    // reached over the OpenAI-compat path (deepseek-native endpoint, kimi) don't have
    // thinking tokens starve the answer.
    const baseMaxTokens = (() => {
      const raw = process.env.PHILONT_LLM_MAX_TOKENS;
      if (!raw) return 16000;
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 256 && n <= 65536) return n;
      return 16000;
    })();
    const wire = this.profile.buildReasoningWire(this.model, opts?.reasoning);
    const maxTokens = this.profile.resolveMaxTokens(this.model, opts?.reasoning, baseMaxTokens);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: openaiMsgs,
      max_tokens: maxTokens,
      // Merge profile top-level reasoning fields (e.g. reasoning_effort).
      ...(wire.openaiTopLevel ?? {}),
    };
    if (openaiTools?.length) body.tools = openaiTools;
    // Merge profile "extra_body" reasoning fields (e.g. thinking:{type:...}) at the **top level**.
    // 2026-06-07: `extra_body` is an OpenAI *Python SDK* concept — the SDK flattens its keys into
    // the top-level request JSON. This adapter posts raw JSON via fetch, so the fields must go
    // top-level directly; nesting them under an "extra_body" key would send a literal {"extra_body":…}
    // the gateway does not understand. (Only kimi/deepseek emit these; plain openai/glm/gemini are empty.)
    if (wire.openaiExtraBody) {
      for (const [k, v] of Object.entries(wire.openaiExtraBody)) body[k] = v;
    }

    const url = `${this.baseUrl}${this.cfg.path}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const msg = `${this.cfg.name} API ${resp.status}: ${errText.slice(0, 500)}`;
      // OpenAI-compatible endpoint: 413 (payload too large) or 400 + "too large" → ContextTooLargeError
      if (
        resp.status === 413 ||
        (resp.status === 400 && isContextTooLargeMessage(errText))
      ) {
        throw new ContextTooLargeError(msg);
      }
      throw new Error(msg);
    }

    const data = (await resp.json()) as {
      choices?: Array<{
        message: {
          role: string;
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      error?: { message?: string; code?: string | number; type?: string };
      // MiniMax business-level error
      base_resp?: { status_code: number; status_msg: string };
    };

    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(
        `${this.cfg.name} error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`,
      );
    }
    if (data.error) {
      throw new Error(
        `${this.cfg.name} error: ${data.error.message ?? JSON.stringify(data.error)}`,
      );
    }

    const msg = data.choices?.[0]?.message;
    if (!msg) {
      throw new Error(`${this.cfg.name}: invalid response shape (no choices)`);
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Backfill as Anthropic blocks so chat-handler history stays in a single format
      const anthropicBlocks: Anthropic.ContentBlock[] = [];
      if (msg.content) {
        anthropicBlocks.push({
          type: 'text',
          text: msg.content,
          citations: [],
        } as Anthropic.TextBlock);
      }
      for (const tc of msg.tool_calls) {
        anthropicBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeJsonParse(tc.function.arguments),
        } as Anthropic.ToolUseBlock);
      }

      const calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: safeJsonParse(tc.function.arguments),
      }));

      return {
        type: 'toolCalls',
        calls,
        assistantMessage: { role: 'assistant', content: anthropicBlocks },
      };
    }

    // Same defence as AnthropicAdapter: rescue <tool_call> embedded in text.
    const text = msg.content ?? '';
    const embedded = parseTextEmbeddedToolCalls(text);
    if (embedded && embedded.length > 0) {
      const blocks: Anthropic.ContentBlock[] = embedded.map((c) => ({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.input,
      } as Anthropic.ToolUseBlock));
      console.warn(
        `[llm-adapter] ${this.cfg.name} returned text but found embedded <tool_call> pattern; rescued ${embedded.length} tool call(s) (${embedded.map(c => c.name).join(',')})`,
      );
      return {
        type: 'toolCalls',
        calls: embedded.map((c) => ({ id: c.id, name: c.name, input: c.input })),
        assistantMessage: { role: 'assistant', content: blocks },
      };
    }

    return { type: 'text', content: text };
  }
}

export function createLLMAdapter(): LLMAdapter {
  const provider = (process.env.LLM_PROVIDER || 'mock').toLowerCase();

  if (provider === 'mock') return new MockAdapter();

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    return new AnthropicAdapter(apiKey);
  }

  // Common aliases for providers
  const alias: Record<string, string> = {
    moonshot: 'kimi',
    zhipu: 'glm',
    google: 'gemini',
  };
  const key = alias[provider] ?? provider;
  const cfg = PROVIDERS[key];
  if (!cfg) {
    throw new Error(
      `Unknown LLM_PROVIDER '${provider}'. ` +
      `Supported: mock, anthropic, ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) throw new Error(`${cfg.apiKeyEnv} not set`);
  const baseUrl = process.env[cfg.baseUrlEnv] || cfg.baseUrl;
  const model = process.env[cfg.modelEnv] || cfg.defaultModel;
  return new OpenAICompatAdapter(cfg, apiKey, baseUrl, model);
}
