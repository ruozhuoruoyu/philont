/**
 * General-purpose auxiliary LLM client
 *
 * Design goals:
 *   - Allow tools like WebFetch to call a small model on demand for content distillation
 *   - Shared by other features (commit-message generation, memory compression, page classification, etc.)
 *   - Not bound to a specific vendor
 *
 * Configuration priority (inside callAuxLLM):
 *   1. All three of AUX_LLM_BASE_URL, AUX_LLM_API_KEY, and AUX_LLM_MODEL are set
 *      → use the protocol specified by AUX_LLM_PROTOCOL:
 *        - 'openai' (default) → POST /chat/completions (OpenAI Chat Completions)
 *        - 'anthropic'        → POST /v1/messages       (Anthropic Messages API)
 *      When AUX_LLM_PROTOCOL is not explicitly set, heuristically detect from baseUrl:
 *      contains 'anthropic' → anthropic; anything else → openai.
 *   2. Otherwise → call the main-model caller registered at server startup via registerMainLLM
 *   3. Neither available → throw AuxLLMError
 *
 * Compatible with most inexpensive small models: DeepSeek / Qwen / GLM / Moonshot / Groq / Together /
 * OpenRouter / self-hosted vLLM / Ollama (OpenAI protocol) + Anthropic official / gateways that speak
 * the Anthropic protocol (e.g. neolink.vnet.com / self-hosted anthropic-shim, etc.).
 */

export interface AuxLLMRequest {
  /** System prompt, optional */
  system?: string;
  /** User message (required) */
  user: string;
  /** Maximum output tokens, default 4096 */
  maxTokens?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

export type AuxLLMCaller = (req: AuxLLMRequest) => Promise<string>;

export class AuxLLMError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'not_configured'
      | 'http_error'
      | 'timeout'
      | 'invalid_response'
      | 'aborted',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AuxLLMError';
  }
}

let mainLLMCaller: AuxLLMCaller | null = null;

/**
 * Register the main-model caller. Called once at application layer (server / demo) startup.
 *
 * When AUX_LLM_* environment variables are not configured, callAuxLLM falls back to the caller
 * registered here — whatever main model the server uses, auxiliary calls use the same one,
 * keeping cost and capability under control.
 */
export function registerMainLLM(caller: AuxLLMCaller): void {
  mainLLMCaller = caller;
}

/** For testing only: clear the registered main-model caller */
export function clearMainLLMRegistration(): void {
  mainLLMCaller = null;
}

/** Whether a main-model caller is currently registered */
export function hasMainLLMRegistered(): boolean {
  return mainLLMCaller !== null;
}

export type AuxLLMProtocol = 'openai' | 'anthropic';

interface AuxLLMEnvConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: AuxLLMProtocol;
}

// 2026-05-14: add Anthropic protocol support. The original system only used OpenAI Chat Completions;
// gateways like neolink/anthropic-shim only accept /v1/messages, causing 200+HTML false-success pages.
function detectProtocol(baseUrl: string): AuxLLMProtocol {
  const explicit = process.env.AUX_LLM_PROTOCOL?.trim().toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;
  // Heuristic: URL contains 'anthropic' keyword (api.anthropic.com etc.) → anthropic
  if (/anthropic/i.test(baseUrl)) return 'anthropic';
  return 'openai';
}

function readAuxLLMEnv(): AuxLLMEnvConfig | null {
  const baseUrl = process.env.AUX_LLM_BASE_URL?.trim();
  const apiKey = process.env.AUX_LLM_API_KEY?.trim();
  const model = process.env.AUX_LLM_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model, protocol: detectProtocol(baseUrl) };
}

/** Whether a small model is currently configured via environment variables */
export function isAuxLLMConfigured(): boolean {
  return readAuxLLMEnv() !== null;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Call the auxiliary LLM.
 *
 * Prefers the small model configured via environment variables; otherwise falls back to the caller
 * registered via registerMainLLM. Throws AuxLLMError(kind='not_configured') when neither is available.
 */
export async function callAuxLLM(req: AuxLLMRequest): Promise<string> {
  const envConfig = readAuxLLMEnv();
  if (envConfig) {
    if (envConfig.protocol === 'anthropic') {
      return callAnthropicCompatible(envConfig, req);
    }
    return callOpenAICompatible(envConfig, req);
  }
  if (mainLLMCaller) {
    return mainLLMCaller(req);
  }
  throw new AuxLLMError(
    'Aux LLM not configured: set AUX_LLM_BASE_URL/AUX_LLM_API_KEY/AUX_LLM_MODEL, ' +
      'or call registerMainLLM() at application startup.',
    'not_configured',
  );
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string };
}

async function callOpenAICompatible(
  cfg: AuxLLMEnvConfig,
  req: AuxLLMRequest,
): Promise<string> {
  const endpoint = joinUrl(cfg.baseUrl, '/chat/completions');
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.user });

  const body = {
    model: cfg.model,
    messages,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
    temperature: 0.2,
  };

  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = req.signal
    ? anySignal([req.signal, timeoutSignal])
    : timeoutSignal;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new AuxLLMError(
        `Aux LLM request timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        req.signal?.aborted ? 'aborted' : 'timeout',
      );
    }
    throw new AuxLLMError(`Aux LLM network error: ${err.message}`, 'http_error');
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new AuxLLMError(
      `Aux LLM HTTP ${resp.status}: ${detail.slice(0, 500)}`,
      'http_error',
      resp.status,
    );
  }

  // 2026-05-13: read raw text then manually JSON.parse; on failure write the body preview into
  // the error to aid debugging "non-JSON body" (observed in production: deepseek proxies occasionally
  // return an HTML error page / incomplete JSON / SSE residue).
  let bodyText: string;
  try {
    bodyText = await resp.text();
  } catch (e) {
    throw new AuxLLMError(
      `Aux LLM body read failed: ${(e as Error)?.message ?? e}`,
      'invalid_response',
    );
  }

  let json: OpenAIChatResponse;
  try {
    json = JSON.parse(bodyText) as OpenAIChatResponse;
  } catch {
    const ctype = resp.headers.get('content-type') ?? '<no-content-type>';
    // 2026-05-13: categorize common issues and provide a direct troubleshooting hint
    let hint = '';
    if (/text\/html/i.test(ctype)) {
      hint =
        ' [hint] the endpoint returned HTML rather than a JSON API, usually because:' +
        '(1) AUX_LLM_BASE_URL is wrong (missing /v1 / points at a web UI address / wrong protocol prefix);' +
        `(2) model name '${cfg.model}' does not exist at ${cfg.baseUrl}, so the service returns an HTML error page.` +
        ' Make sure BASE_URL points at an OpenAI-compatible /chat/completions endpoint and the model exists.';
    } else if (/^text\/(plain|event-stream)/i.test(ctype)) {
      hint =
        ' [hint] the endpoint returned non-JSON text (possibly SSE / plain text). callAuxLLM does not support streaming; make sure the endpoint does not force SSE.';
    }
    throw new AuxLLMError(
      `Aux LLM returned non-JSON body (status=${resp.status} content-type=${ctype} length=${bodyText.length} model=${cfg.model} url=${cfg.baseUrl}):${hint}\nBODY[0..400]: ${bodyText.slice(0, 400).replace(/\n/g, ' ')}`,
      'invalid_response',
    );
  }

  if (json.error) {
    throw new AuxLLMError(
      `Aux LLM provider error: ${json.error.message ?? 'unknown'}`,
      'http_error',
    );
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new AuxLLMError(
      'Aux LLM returned empty content',
      'invalid_response',
    );
  }
  return content;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  error?: { message?: string; type?: string };
}

async function callAnthropicCompatible(
  cfg: AuxLLMEnvConfig,
  req: AuxLLMRequest,
): Promise<string> {
  const endpoint = joinUrl(cfg.baseUrl, '/v1/messages');

  // Anthropic protocol: system is a top-level field and does not go into the messages array
  const body: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: 'user'; content: string }>;
  } = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content: req.user }],
  };
  if (req.system) body.system = req.system;

  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = req.signal
    ? anySignal([req.signal, timeoutSignal])
    : timeoutSignal;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new AuxLLMError(
        `Aux LLM (anthropic) request timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        req.signal?.aborted ? 'aborted' : 'timeout',
      );
    }
    throw new AuxLLMError(
      `Aux LLM (anthropic) network error: ${err.message}`,
      'http_error',
    );
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new AuxLLMError(
      `Aux LLM (anthropic) HTTP ${resp.status}: ${detail.slice(0, 500)}`,
      'http_error',
      resp.status,
    );
  }

  let bodyText: string;
  try {
    bodyText = await resp.text();
  } catch (e) {
    throw new AuxLLMError(
      `Aux LLM (anthropic) body read failed: ${(e as Error)?.message ?? e}`,
      'invalid_response',
    );
  }

  let json: AnthropicMessagesResponse;
  try {
    json = JSON.parse(bodyText) as AnthropicMessagesResponse;
  } catch {
    const ctype = resp.headers.get('content-type') ?? '<no-content-type>';
    let hint = '';
    if (/text\/html/i.test(ctype)) {
      hint =
        ' [hint] endpoint returned HTML instead of JSON (Anthropic protocol):' +
        '(1) AUX_LLM_BASE_URL may be missing /v1 or pointing at a non-messages path;' +
        `(2) model name '${cfg.model}' may not exist in this gateway's whitelist (neolink/anthropic-shim);` +
        '(3) or this endpoint uses OpenAI protocol — check that AUX_LLM_PROTOCOL is not wrongly set to anthropic.';
    }
    throw new AuxLLMError(
      `Aux LLM (anthropic) returned non-JSON body (status=${resp.status} content-type=${ctype} length=${bodyText.length} model=${cfg.model} url=${cfg.baseUrl}):${hint}\nBODY[0..400]: ${bodyText.slice(0, 400).replace(/\n/g, ' ')}`,
      'invalid_response',
    );
  }

  if (json.error) {
    throw new AuxLLMError(
      `Aux LLM (anthropic) provider error: ${json.error.message ?? 'unknown'}`,
      'http_error',
    );
  }

  const text = json.content?.find((b) => b.type === 'text')?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new AuxLLMError(
      'Aux LLM (anthropic) returned empty content',
      'invalid_response',
    );
  }
  return text;
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  // If base already contains /chat/completions or /v1/messages, use it as-is
  if (/\/chat\/completions\/?$/.test(trimmedBase)) {
    return trimmedBase;
  }
  if (/\/v1\/messages\/?$/.test(trimmedBase)) {
    return trimmedBase;
  }
  return `${trimmedBase}/${trimmedPath}`;
}

/**
 * Merge multiple AbortSignals into one — fires when any of them aborts.
 *
 * Node 20+ has a native AbortSignal.any, but the current tsconfig targets ES2022 lib,
 * so this polyfill is used to avoid introducing a runtime detection branch.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener(
      'abort',
      () => controller.abort(s.reason),
      { once: true },
    );
  }
  return controller.signal;
}
