/**
 * webFetch tool - fetch web page content
 *
 * Design reference: Claude Code 2.1.88 WebFetchTool/utils.ts
 *
 * Key capabilities:
 *   1. URL validation (protocol, length, no credentials, parseable)
 *   2. http → https auto-upgrade
 *   3. Same-domain redirects auto-followed; cross-domain redirects **return REDIRECT_DETECTED for the model to re-issue explicitly**
 *      (prevent open redirect attacks + let the agent re-decide)
 *   4. HTML → Markdown conversion (no external deps; includes a lightweight converter)
 *   5. Optional prompt parameter: if given, runs callAuxLLM distillation (extracts per caller intent);
 *      if omitted, returns markdown truncated to maxChars
 *   6. Pre-approved domains (dev-doc sites) take the fast path: skip distillation, return raw content
 *   7. Simple TTL cache (15 minutes) to avoid re-fetching the same URL
 *   8. Named errors (IngestError) let the caller decide to retry / switch source / bounce
 *
 * Differences from the previous implementation:
 *   - Before: regex-stripped HTML, maxLength default 10K, no redirect policy, no distillation, no cache
 *   - Now: all of 1-8 are in place; the model context is no longer polluted by HTML noise
 */

import type { Tool } from '@agent/policy';
import { callAuxLLM, AuxLLMError } from '../utils/aux-llm.js';
import { extractTitle, htmlToMarkdown } from './html-to-markdown.js';
import { isPreapprovedHost } from './preapproved.js';

// ── Constants ────────────────────────────────────────────────────────

const MAX_URL_LENGTH = 2000;
const MAX_HTTP_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; PhilontAgent/1.0; +https://philont.dev)';
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
// Content truncation before calling aux-llm distillation (avoid stuffing an oversized prompt into the small model)
const DISTILL_INPUT_MAX_CHARS = 60_000;
// Maximum length for pre-approved sites when returning markdown inline — content beyond this is still truncated
const PREAPPROVED_INLINE_MAX = 100_000;

// ── Error class ──────────────────────────────────────────────────────

export type IngestErrorKind =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'too_many_redirects'
  | 'cross_host_redirect'
  | 'http_error'
  | 'timeout'
  | 'aborted'
  | 'response_too_large'
  | 'distill_failed';

export class IngestError extends Error {
  constructor(
    message: string,
    public readonly kind: IngestErrorKind,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

// ── Cache (lightweight TTL Map, avoids pulling in lru-cache) ─────────

interface CacheEntry {
  expiresAt: number;
  payload: FetchResultPayload;
}

const URL_CACHE = new Map<string, CacheEntry>();

function cacheGet(key: string): FetchResultPayload | undefined {
  const e = URL_CACHE.get(key);
  if (!e) return undefined;
  if (e.expiresAt < Date.now()) {
    URL_CACHE.delete(key);
    return undefined;
  }
  return e.payload;
}

function cacheSet(key: string, payload: FetchResultPayload): void {
  if (URL_CACHE.size >= CACHE_MAX_ENTRIES) {
    // Simple FIFO eviction (Map preserves insertion order)
    const oldest = URL_CACHE.keys().next().value;
    if (oldest !== undefined) URL_CACHE.delete(oldest);
  }
  URL_CACHE.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    payload,
  });
}

/** For testing only */
export function clearWebFetchCache(): void {
  URL_CACHE.clear();
}

// ── URL validation / upgrade ──────────────────────────────────────────

function validateAndUpgradeUrl(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) {
    throw new IngestError(
      `URL too long (${raw.length} chars > ${MAX_URL_LENGTH})`,
      'invalid_url',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new IngestError(`Invalid URL: ${raw}`, 'invalid_url');
  }
  if (parsed.username || parsed.password) {
    throw new IngestError(
      'URL must not contain credentials',
      'invalid_url',
    );
  }
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  } else if (parsed.protocol !== 'https:') {
    throw new IngestError(
      `Unsupported protocol: ${parsed.protocol}`,
      'unsupported_protocol',
    );
  }
  // Must have a parseable hostname (at least one dot, filters out single-label hostnames)
  const parts = parsed.hostname.split('.');
  if (parts.length < 2 || parts.some((p) => p.length === 0)) {
    throw new IngestError(`Invalid hostname: ${parsed.hostname}`, 'invalid_url');
  }
  return parsed;
}

/** Same domain ±www. is treated as a permitted redirect; all other cross-domain redirects require the caller to re-decide. */
function isPermittedRedirect(orig: URL, redirect: URL): boolean {
  if (redirect.protocol !== orig.protocol) return false;
  if (redirect.port !== orig.port) return false;
  if (redirect.username || redirect.password) return false;
  const stripWww = (h: string) => h.replace(/^www\./, '');
  return stripWww(orig.hostname) === stripWww(redirect.hostname);
}

// ── HTTP fetch (with custom redirect policy) ─────────────────────────

interface FetchSuccess {
  kind: 'success';
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
}

interface FetchRedirect {
  kind: 'redirect';
  originalUrl: string;
  redirectUrl: string;
  status: number;
}

type FetchOutcome = FetchSuccess | FetchRedirect;

async function fetchWithRedirectPolicy(
  url: string,
  signal: AbortSignal,
  depth = 0,
): Promise<FetchOutcome> {
  if (depth > MAX_REDIRECTS) {
    throw new IngestError(
      `Too many redirects (>${MAX_REDIRECTS})`,
      'too_many_redirects',
    );
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Accept: 'text/markdown, text/html;q=0.9, */*;q=0.1',
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // We handle redirects ourselves to avoid fetch's default cross-domain following
      redirect: 'manual',
      signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new IngestError(
        `Fetch timed out or aborted: ${err.message}`,
        signal.aborted ? 'aborted' : 'timeout',
      );
    }
    throw new IngestError(`Network error: ${err.message}`, 'http_error');
  }

  // Redirects: 301/302/303/307/308
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get('location');
    if (!location) {
      throw new IngestError(
        `Redirect ${resp.status} missing Location header`,
        'http_error',
        resp.status,
      );
    }
    const redirectUrl = new URL(location, url).toString();
    const orig = new URL(url);
    const next = new URL(redirectUrl);
    if (isPermittedRedirect(orig, next)) {
      return fetchWithRedirectPolicy(redirectUrl, signal, depth + 1);
    }
    return {
      kind: 'redirect',
      originalUrl: url,
      redirectUrl,
      status: resp.status,
    };
  }

  if (!resp.ok) {
    throw new IngestError(
      `HTTP ${resp.status} ${resp.statusText}`,
      'http_error',
      resp.status,
    );
  }

  const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';

  // Read up to MAX_HTTP_CONTENT_BYTES. fetch has no native size cap; we use
  // ArrayBuffer and slice — this has no side effects for the vast majority of pages.
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_HTTP_CONTENT_BYTES) {
    throw new IngestError(
      `Response too large (${buf.byteLength} bytes > ${MAX_HTTP_CONTENT_BYTES})`,
      'response_too_large',
    );
  }
  const body = new TextDecoder('utf-8', { fatal: false }).decode(buf);

  return {
    kind: 'success',
    finalUrl: url,
    status: resp.status,
    contentType,
    body,
    bytes: buf.byteLength,
  };
}

// ── Distillation ─────────────────────────────────────────────────────

const SECONDARY_SYSTEM_PROMPT =
  'You extract information from web page content per the user\'s instructions. ' +
  'Reply concisely; quote sparingly (max 125 chars per quote); never reproduce song lyrics.';

function buildDistillUser(content: string, prompt: string): string {
  return `Web page content:\n---\n${content}\n---\n\n${prompt}\n\nProvide a concise response based only on the content above.`;
}

// ── Tool result payload ──────────────────────────────────────────────

interface FetchResultPayload {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  /** The body actually returned to the model (already distilled or truncated) */
  text: string;
  /** Whether the content was truncated */
  truncated: boolean;
  /** Extraction method: raw/markdown/distilled/preapproved */
  extractor: 'raw' | 'markdown' | 'distilled' | 'preapproved' | 'redirect';
  /** Raw markdown length (before truncation/distillation) */
  rawLength: number;
  fetchedAt: string;
  tookMs: number;
}

function renderRedirectPayload(
  url: string,
  outcome: FetchRedirect,
  tookMs: number,
): FetchResultPayload {
  const statusText =
    outcome.status === 301
      ? 'Moved Permanently'
      : outcome.status === 308
        ? 'Permanent Redirect'
        : outcome.status === 307
          ? 'Temporary Redirect'
          : outcome.status === 303
            ? 'See Other'
            : 'Found';
  const message =
    `REDIRECT DETECTED: The URL redirects to a different host.\n\n` +
    `Original URL: ${outcome.originalUrl}\n` +
    `Redirect URL: ${outcome.redirectUrl}\n` +
    `Status: ${outcome.status} ${statusText}\n\n` +
    `To complete your request, call webFetch again with url="${outcome.redirectUrl}".`;
  return {
    url,
    finalUrl: outcome.redirectUrl,
    status: outcome.status,
    contentType: 'text/plain',
    text: message,
    truncated: false,
    extractor: 'redirect',
    rawLength: message.length,
    fetchedAt: new Date().toISOString(),
    tookMs,
  };
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: text.slice(0, max) + '\n\n[Content truncated due to length...]',
    truncated: true,
  };
}

// ── Main entry point ─────────────────────────────────────────────────

interface WebFetchInput {
  url: string;
  /** Optional — if given, runs aux-llm distillation and extracts per prompt */
  prompt?: string;
  /** Extraction mode: markdown preserves links/headings; text is plain text only. Default markdown */
  extractMode?: 'markdown' | 'text';
  /** Maximum output characters. Default 100000 */
  maxChars?: number;
}

async function runWebFetch(input: WebFetchInput): Promise<FetchResultPayload> {
  const start = Date.now();
  const parsed = validateAndUpgradeUrl(input.url);
  const upgradedUrl = parsed.toString();
  const extractMode = input.extractMode ?? 'markdown';
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const cacheKey = `${upgradedUrl}::${extractMode}::${maxChars}::${input.prompt ?? ''}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const outcome = await fetchWithRedirectPolicy(upgradedUrl, signal);

  if (outcome.kind === 'redirect') {
    const payload = renderRedirectPayload(input.url, outcome, Date.now() - start);
    cacheSet(cacheKey, payload);
    return payload;
  }

  // Non-HTML (JSON/plain text/server-rendered markdown) treated directly as text
  let title: string | undefined;
  let markdown: string;
  let extractor: FetchResultPayload['extractor'];

  if (outcome.contentType.includes('text/html')) {
    title = extractTitle(outcome.body);
    markdown = htmlToMarkdown(outcome.body, {
      mode: extractMode,
      preserveLinks: extractMode === 'markdown',
      baseUrl: outcome.finalUrl,
    });
    extractor = 'markdown';
  } else if (outcome.contentType.includes('application/json')) {
    try {
      markdown = JSON.stringify(JSON.parse(outcome.body), null, 2);
    } catch {
      markdown = outcome.body;
    }
    extractor = 'raw';
  } else {
    markdown = outcome.body;
    extractor = 'raw';
  }

  const rawLength = markdown.length;

  // Pre-approved site + manageable content length → skip distillation and return directly (Claude Code design)
  const isPreapproved = isPreapprovedHost(parsed.hostname, parsed.pathname);
  if (
    isPreapproved &&
    !input.prompt &&
    rawLength <= PREAPPROVED_INLINE_MAX
  ) {
    const payload: FetchResultPayload = {
      url: input.url,
      finalUrl: outcome.finalUrl,
      status: outcome.status,
      contentType: outcome.contentType,
      title,
      text: markdown,
      truncated: false,
      extractor: 'preapproved',
      rawLength,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
    };
    cacheSet(cacheKey, payload);
    return payload;
  }

  // Caller passed a prompt → take the distillation path
  if (input.prompt) {
    const distillInput =
      rawLength > DISTILL_INPUT_MAX_CHARS
        ? markdown.slice(0, DISTILL_INPUT_MAX_CHARS) + '\n[content truncated]'
        : markdown;
    let distilled: string;
    try {
      distilled = await callAuxLLM({
        system: SECONDARY_SYSTEM_PROMPT,
        user: buildDistillUser(distillInput, input.prompt),
      });
    } catch (e) {
      if (e instanceof AuxLLMError) {
        // On distillation failure, degrade to truncated output but flag it explicitly so the model knows
        const fallback = truncate(markdown, maxChars);
        const payload: FetchResultPayload = {
          url: input.url,
          finalUrl: outcome.finalUrl,
          status: outcome.status,
          contentType: outcome.contentType,
          title,
          text:
            `[NOTE] Aux-LLM distillation failed (${e.kind}: ${e.message}). ` +
            `Returning ${fallback.truncated ? 'truncated' : 'full'} markdown instead.\n\n` +
            fallback.text,
          truncated: fallback.truncated,
          extractor: 'markdown',
          rawLength,
          fetchedAt: new Date().toISOString(),
          tookMs: Date.now() - start,
        };
        cacheSet(cacheKey, payload);
        return payload;
      }
      throw e;
    }
    const payload: FetchResultPayload = {
      url: input.url,
      finalUrl: outcome.finalUrl,
      status: outcome.status,
      contentType: outcome.contentType,
      title,
      text: distilled,
      truncated: rawLength > DISTILL_INPUT_MAX_CHARS,
      extractor: 'distilled',
      rawLength,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
    };
    cacheSet(cacheKey, payload);
    return payload;
  }

  // No prompt → return markdown directly with tail truncation
  const t = truncate(markdown, maxChars);
  const payload: FetchResultPayload = {
    url: input.url,
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    contentType: outcome.contentType,
    title,
    text: t.text,
    truncated: t.truncated,
    extractor,
    rawLength,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
  };
  cacheSet(cacheKey, payload);
  return payload;
}

function formatPayload(p: FetchResultPayload): string {
  // Similar to Claude Code — return metadata and body together. Structured fields first, body after.
  // The model gets key facts (url/title/extractor) and can also continue reading the full text.
  const meta = [
    `URL: ${p.url}`,
    p.finalUrl !== p.url ? `Final URL: ${p.finalUrl}` : null,
    p.title ? `Title: ${p.title}` : null,
    `Status: ${p.status}`,
    `Extractor: ${p.extractor}`,
    p.truncated ? `Truncated: true (raw length ${p.rawLength})` : null,
    `Fetched in ${p.tookMs}ms`,
  ]
    .filter(Boolean)
    .join('\n');
  return `${meta}\n\n---\n\n${p.text}`;
}

export const webFetchTool: Tool = {
  name: 'webFetch',
  description: [
    'Fetch URL content and extract it as Markdown / plain text; can call an auxiliary LLM to do structured extraction per a prompt.',
    'Behavior contract:',
    '  - url is required; prompt is optional (if given, distills per intent; if not, returns truncated markdown)',
    '  - http is auto-upgraded to https',
    '  - cross-host redirects are not auto-followed; returns REDIRECT_DETECTED so you re-issue explicitly',
    '  - pre-approved hosts (dev-doc sites) skip distillation and return the raw content',
    '  - default output cap is 100K characters; adjustable via maxChars',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP/HTTPS URL' },
      prompt: {
        type: 'string',
        description: 'Optional: if given, an auxiliary LLM extracts content per this prompt; if omitted, returns truncated markdown',
      },
      extractMode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: 'Extraction mode, default markdown (preserves heading/link structure)',
      },
      maxChars: {
        type: 'number',
        description: 'Maximum output characters, default 100000',
      },
    },
    required: ['url'],
  },
  capability: 'read',
  domain: 'network',
  async execute(params) {
    try {
      const payload = await runWebFetch({
        url: params.url as string,
        prompt: params.prompt as string | undefined,
        extractMode: params.extractMode as 'markdown' | 'text' | undefined,
        maxChars: params.maxChars as number | undefined,
      });
      return {
        success: true,
        output: formatPayload(payload),
      };
    } catch (e) {
      if (e instanceof IngestError) {
        return {
          success: false,
          output: '',
          error: `Fetch failed (${e.kind}${e.status ? `, HTTP ${e.status}` : ''}): ${e.message}`,
        };
      }
      const err = e as Error;
      return {
        success: false,
        output: '',
        error: `Fetch failed: ${err.message ?? String(e)}`,
      };
    }
  },
};
