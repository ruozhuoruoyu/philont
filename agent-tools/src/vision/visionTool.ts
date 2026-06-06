/**
 * vision — image understanding tool
 *
 * Lets the agent pass an image (local path or URL) along with a question to a vision model and
 * receive back a text description/answer.
 * Typical uses: inspect UI screenshots, read chart numbers, identify photo contents, OCR scanned documents.
 *
 * Model resolution (highest to lowest priority):
 *   1. VISION_LLM_BASE_URL + VISION_LLM_API_KEY + VISION_LLM_MODEL — explicit dedicated configuration
 *      (uses the Anthropic Messages protocol /v1/messages).
 *   2. ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL) — reuse main-model credentials; model name taken
 *      from VISION_LLM_MODEL ?? VISION_MODEL ?? MODEL ?? default Claude. When the main model is Claude,
 *      **zero configuration needed** (Claude models are natively multimodal).
 *   3. Neither available → success=false with instructions on how to configure.
 *
 * Design discipline:
 *   - Pure fetch to /v1/messages; no new dependencies (agent-tools remains a single @agent/policy dependency).
 *   - media_type detected via magic bytes (not trusted from extension); only accepts Anthropic-supported jpeg/png/gif/webp.
 *   - capability='read' / domain='network': reads image + calls model; no side effects.
 *   - Never throws — all errors go through { success:false, error }.
 */

import { readFile } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_VISION_MODEL = 'claude-sonnet-4-6';
/** Anthropic single-image base64 limit is approximately 5MB (API hard limit); leave headroom and check by raw bytes before base64 expansion. */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

type AnthropicMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

type VisionProtocol = 'anthropic' | 'openai';

interface VisionModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: VisionProtocol;
}

/**
 * Protocol detection: VISION_LLM_PROTOCOL takes explicit priority; otherwise heuristically detect from baseURL
 * (contains 'anthropic' → anthropic; anything else → openai).
 *
 * Most major domestic multimodal models (Qwen-VL / GLM-4V / Step / MiniMax etc.) use the OpenAI-compatible
 * protocol (/chat/completions + image_url), so openai is the default.
 */
function detectProtocol(env: NodeJS.ProcessEnv, baseUrl: string): VisionProtocol {
  const explicit = env.VISION_LLM_PROTOCOL?.trim().toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;
  return /anthropic/i.test(baseUrl) ? 'anthropic' : 'openai';
}

function resolveVisionConfig(env: NodeJS.ProcessEnv): VisionModelConfig | null {
  const explicitBase = env.VISION_LLM_BASE_URL?.trim();
  const explicitKey = env.VISION_LLM_API_KEY?.trim();
  const explicitModel = env.VISION_LLM_MODEL?.trim();
  if (explicitBase && explicitKey && explicitModel) {
    return {
      baseUrl: explicitBase,
      apiKey: explicitKey,
      model: explicitModel,
      protocol: detectProtocol(env, explicitBase),
    };
  }

  // Reuse main-model (Anthropic) credentials — only meaningful when the main model is itself multimodal (e.g. Claude).
  // When the main model is non-multimodal (e.g. DeepSeek), explicitly configure VISION_LLM_*.
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    return {
      baseUrl: env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com',
      apiKey: anthropicKey,
      model: explicitModel || env.VISION_MODEL?.trim() || env.MODEL?.trim() || DEFAULT_VISION_MODEL,
      protocol: 'anthropic',
    };
  }
  return null;
}

/** Magic-byte sniffing: returns the Anthropic-supported media_type, or null if unrecognized. */
function sniffMediaType(buf: Buffer): AnthropicMediaType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return 'image/png';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
    return 'image/gif';
  // WEBP: "RIFF"...."WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  )
    return 'image/webp';
  return null;
}

/** Load the source (URL or local path) into a Buffer. */
async function loadImageBytes(source: string, signal: AbortSignal): Promise<Buffer> {
  if (/^https?:\/\//i.test(source)) {
    const resp = await fetch(source, { signal });
    if (!resp.ok) {
      throw new Error(`Image download HTTP ${resp.status}`);
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  }
  // Local path (file:// prefix supported)
  const path = source.startsWith('file://') ? new URL(source) : source;
  return readFile(path);
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string; type?: string };
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

/** Uniformly parse both protocol responses into { text?, error? }. */
function parseVisionResponse(protocol: VisionProtocol, raw: string): { text?: string; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: `Non-JSON response: ${raw.slice(0, 200)}` };
  }
  if (protocol === 'anthropic') {
    const r = json as AnthropicMessagesResponse;
    if (r.error) return { error: r.error.message ?? 'unknown' };
    const text = r.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    return { text };
  }
  const r = json as OpenAIChatResponse;
  if (r.error) return { error: r.error.message ?? 'unknown' };
  const content = r.choices?.[0]?.message?.content;
  return { text: typeof content === 'string' ? content.trim() : undefined };
}

export const visionTool: Tool = {
  name: 'vision',
  description:
    'Send an image (a local absolute path or an http(s) URL) plus a question to a vision model and get a text answer. ' +
    'Use it to read screenshots, chart numbers, recognize photos, OCR scans, etc. Supports jpeg/png/gif/webp.',
  schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Image source: a local absolute path (file:// allowed) or an http(s) URL.',
      },
      prompt: {
        type: 'string',
        description: 'Your question/instruction about the image. Defaults to "Describe the contents of this image in detail".',
      },
      maxTokens: {
        type: 'number',
        description: `Maximum tokens for the model's answer, default ${DEFAULT_MAX_TOKENS}.`,
      },
    },
    required: ['source'],
  },
  capability: 'read',
  domain: 'network',
  async execute(params) {
    const source = params.source as string;
    if (!source || typeof source !== 'string') {
      return { success: false, output: '', error: 'vision: missing source (image path or URL)' };
    }
    const prompt =
      typeof params.prompt === 'string' && params.prompt.trim()
        ? params.prompt
        : 'Describe the contents of this image in detail.';
    const maxTokens =
      typeof params.maxTokens === 'number' && params.maxTokens > 0
        ? Math.floor(params.maxTokens)
        : DEFAULT_MAX_TOKENS;

    const cfg = resolveVisionConfig(process.env);
    if (!cfg) {
      return {
        success: false,
        output: '',
        error:
          'vision model not configured: set VISION_LLM_BASE_URL/VISION_LLM_API_KEY/VISION_LLM_MODEL, ' +
          'or set ANTHROPIC_API_KEY (reuses the main model; model defaults to ' + DEFAULT_VISION_MODEL + ').',
      };
    }

    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

    // 1) Load the image
    let bytes: Buffer;
    try {
      bytes = await loadImageBytes(source, timeoutSignal);
    } catch (e) {
      return { success: false, output: '', error: `vision: failed to read image — ${(e as Error)?.message ?? e}` };
    }
    if (bytes.length === 0) {
      return { success: false, output: '', error: `vision: image is empty (0 bytes): ${source}` };
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return {
        success: false,
        output: '',
        error: `vision: image ${(bytes.length / 1024 / 1024).toFixed(1)}MB exceeds the ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)}MB limit; compress it first.`,
      };
    }
    const mediaType = sniffMediaType(bytes);
    if (!mediaType) {
      return {
        success: false,
        output: '',
        error: 'vision: unrecognized image format (only jpeg/png/gif/webp supported).',
      };
    }

    // 2) Call the model (branching by protocol: anthropic /v1/messages + image block;
    //    openai /chat/completions + image_url data URL)
    const b64 = bytes.toString('base64');
    const isAnthropic = cfg.protocol === 'anthropic';
    const endpoint = cfg.baseUrl.replace(/\/+$/, '') + (isAnthropic ? '/v1/messages' : '/chat/completions');
    const body = isAnthropic
      ? {
          model: cfg.model,
          max_tokens: maxTokens,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
                { type: 'text', text: prompt },
              ],
            },
          ],
        }
      : {
          model: cfg.model,
          max_tokens: maxTokens,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
              ],
            },
          ],
        };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isAnthropic) {
      headers['x-api-key'] = cfg.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }

    let resp: Response;
    try {
      resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: timeoutSignal });
    } catch (e) {
      const err = e as Error;
      const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? ' (timeout)' : ' (network error)';
      return { success: false, output: '', error: `vision: calling the vision model${kind} — ${err.message}` };
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return {
        success: false,
        output: '',
        error: `vision: vision model HTTP ${resp.status} (model=${cfg.model}, ${cfg.protocol}) — ${detail.slice(0, 400)}`,
      };
    }

    const parsed = parseVisionResponse(cfg.protocol, await resp.text());
    if (parsed.error) {
      return { success: false, output: '', error: `vision: model error — ${parsed.error}` };
    }
    if (!parsed.text) {
      return { success: false, output: '', error: 'vision: model returned empty content' };
    }
    return { success: true, output: parsed.text };
  },
};
