/**
 * webSearch tool - web search with a zero-config fallback chain
 *
 * Design principles (aligned with Claude Code WebSearchTool):
 *   - Output **only title + url**, actively discarding snippet/content
 *   - Let the model fetch details on demand rather than being led by snippets to generate answers directly
 *   - Reduce context pollution (HTML tags, ad boilerplate, etc. won't leak in via snippets)
 *
 * Priority chain — each tier degrades to the next on error or empty results, so search works
 * with **zero configuration** in every case:
 *   1. Native API search — server-side `web_search` tool on the Anthropic-compatible endpoint the
 *      main LLM already uses (real Anthropic, or DeepSeek's /anthropic endpoint, etc.). Reuses
 *      ANTHROPIC_API_KEY — no extra key, results carry the provider's own ranking. Disable with
 *      PHILONT_WEB_SEARCH_NATIVE=0.
 *   2. Third-party search API — Tavily / Serper / Brave, if the user configured a key.
 *   3. Keyless scraping — DuckDuckGo then Bing HTML. Always available, no key, provider-agnostic.
 *      Disable with PHILONT_WEB_SEARCH_SCRAPE=0.
 */

import type { Tool } from '@agent/policy';

/** A single search result — only title + url, deliberately no snippet */
interface SearchHit {
  title: string;
  url: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Tier 1: native server-side web_search on the Anthropic-compatible endpoint ────────────────
async function searchNative(query: string, limit: number): Promise<SearchHit[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const baseURL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';
  // web_search_20250305 is the GA tool (no beta header); newer endpoints also accept _20260209.
  const toolType = process.env.PHILONT_WEB_SEARCH_NATIVE_TOOL || 'web_search_20250305';

  const resp = await fetchWithTimeout(
    `${baseURL}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          { role: 'user', content: `Search the web and list the most relevant results for: ${query}` },
        ],
        tools: [{ type: toolType, name: 'web_search', max_uses: 1 }],
      }),
    },
    25_000,
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}${body ? ` ${body.slice(0, 160)}` : ''}`);
  }
  const data = (await resp.json()) as {
    content?: Array<{ type: string; content?: unknown }>;
  };

  const hits: SearchHit[] = [];
  for (const block of data.content ?? []) {
    if (block.type !== 'web_search_tool_result') continue;
    const inner = block.content;
    // Error shape: { type: 'web_search_tool_result_error', error_code: ... } → treat as failure.
    if (inner && !Array.isArray(inner) && (inner as { type?: string }).type?.includes('error')) {
      throw new Error(`tool error: ${(inner as { error_code?: string }).error_code ?? 'unknown'}`);
    }
    if (Array.isArray(inner)) {
      for (const r of inner as Array<{ title?: unknown; url?: unknown }>) {
        if (typeof r?.title === 'string' && typeof r?.url === 'string') {
          hits.push({ title: r.title, url: r.url });
        }
      }
    }
  }
  return hits.slice(0, limit);
}

// ── Tier 2: third-party search APIs (require a key) ───────────────────────────────────────────
type ThirdPartyBackend = 'tavily' | 'serper' | 'brave';

function detectThirdParty(): ThirdPartyBackend | null {
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.SERPER_API_KEY) return 'serper';
  if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  return null;
}

async function searchTavily(query: string, limit: number): Promise<SearchHit[]> {
  const resp = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: limit,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    },
    15_000,
  );
  if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);
  const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string }> };
  return (data.results ?? [])
    .filter((r): r is { title: string; url: string } => typeof r.title === 'string' && typeof r.url === 'string')
    .map((r) => ({ title: r.title, url: r.url }));
}

async function searchSerper(query: string, limit: number): Promise<SearchHit[]> {
  const resp = await fetchWithTimeout(
    'https://google.serper.dev/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SERPER_API_KEY! },
      body: JSON.stringify({ q: query, num: limit }),
    },
    15_000,
  );
  if (!resp.ok) throw new Error(`Serper HTTP ${resp.status}`);
  const data = (await resp.json()) as { organic?: Array<{ title?: string; link?: string }> };
  return (data.organic ?? [])
    .filter((r): r is { title: string; link: string } => typeof r.title === 'string' && typeof r.link === 'string')
    .map((r) => ({ title: r.title, url: r.link }));
}

async function searchBrave(query: string, limit: number): Promise<SearchHit[]> {
  const resp = await fetchWithTimeout(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY!,
      },
    },
    15_000,
  );
  if (!resp.ok) throw new Error(`Brave HTTP ${resp.status}`);
  const data = (await resp.json()) as { web?: { results?: Array<{ title?: string; url?: string }> } };
  return (data.web?.results ?? [])
    .filter((r): r is { title: string; url: string } => typeof r.title === 'string' && typeof r.url === 'string')
    .map((r) => ({ title: r.title, url: r.url }));
}

function searchThirdParty(backend: ThirdPartyBackend, query: string, limit: number): Promise<SearchHit[]> {
  switch (backend) {
    case 'tavily':
      return searchTavily(query, limit);
    case 'serper':
      return searchSerper(query, limit);
    case 'brave':
      return searchBrave(query, limit);
  }
}

// ── Tier 3: keyless HTML scraping (DuckDuckGo → Bing) ─────────────────────────────────────────
async function searchDuckDuckGo(query: string, limit: number): Promise<SearchHit[]> {
  const resp = await fetchWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': UA, Accept: 'text/html' } },
    12_000,
  );
  if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  const html = await resp.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && hits.length < limit) {
    let url = m[1];
    // DuckDuckGo wraps targets in a redirect: //duckduckgo.com/l/?uddg=<encoded>&...
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith('//')) url = 'https:' + url;
    const title = stripTags(m[2]);
    if (url && title && /^https?:\/\//.test(url)) hits.push({ title, url });
  }
  return hits;
}

function decodeBingUrl(url: string): string {
  // Bing wraps targets as bing.com/ck/a?...&u=a1<base64url>&...
  const m = url.match(/[?&]u=a1([^&]+)/);
  if (!m) return url;
  try {
    let b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return url;
  }
}

async function searchBing(query: string, limit: number): Promise<SearchHit[]> {
  const resp = await fetchWithTimeout(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`,
    { headers: { 'User-Agent': UA, Accept: 'text/html' } },
    12_000,
  );
  if (!resp.ok) throw new Error(`Bing HTTP ${resp.status}`);
  const html = await resp.text();
  const hits: SearchHit[] = [];
  const liRe = /<li class="b_algo">([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null && hits.length < limit) {
    const a = m[1].match(/<h2>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decodeBingUrl(a[1]);
    const title = stripTags(a[2]);
    if (url && title && /^https?:\/\//.test(url)) hits.push({ title, url });
  }
  return hits;
}

async function searchScrape(query: string, limit: number): Promise<SearchHit[]> {
  try {
    const ddg = await searchDuckDuckGo(query, limit);
    if (ddg.length) return ddg;
  } catch {
    /* fall through to Bing */
  }
  return searchBing(query, limit);
}

// ── Render ────────────────────────────────────────────────────────────────────────────────────
function formatResults(query: string, hits: SearchHit[]): string {
  const head = `Web search results for query: "${query}"\n\n`;
  if (hits.length === 0) return `${head}No links found.`;
  const links = `Links: ${JSON.stringify(hits)}\n\n`;
  const reminder =
    'REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.';
  return head + links + reminder;
}

export const webSearchTool: Tool = {
  name: 'webSearch',
  description:
    'Search the web for up-to-date information. Tries native API search first, then a configured ' +
    'search API (Tavily/Serper/Brave), then keyless scraping — so it works with no setup. Returns ' +
    'a list of titles and links; use webFetch to retrieve the body when you need it.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Number of results to return (default 5)' },
    },
    required: ['query'],
  },
  capability: 'read',
  domain: 'network',
  async execute(params) {
    const query = params.query as string;
    const limit = (params.limit as number) || 5;

    const chain: Array<{ name: string; run: () => Promise<SearchHit[]> }> = [];
    if (process.env.ANTHROPIC_API_KEY && process.env.PHILONT_WEB_SEARCH_NATIVE !== '0') {
      chain.push({ name: 'native', run: () => searchNative(query, limit) });
    }
    const tp = detectThirdParty();
    if (tp) chain.push({ name: tp, run: () => searchThirdParty(tp, query, limit) });
    if (process.env.PHILONT_WEB_SEARCH_SCRAPE !== '0') {
      chain.push({ name: 'scrape', run: () => searchScrape(query, limit) });
    }

    if (chain.length === 0) {
      return {
        success: false,
        output: '',
        error:
          'No search backend available. Set ANTHROPIC_API_KEY (native), a TAVILY/SERPER/BRAVE key, ' +
          'or leave PHILONT_WEB_SEARCH_SCRAPE unset to allow keyless scraping.',
      };
    }

    const errors: string[] = [];
    let ranClean = false; // at least one backend ran without throwing (genuinely 0 hits)
    for (const { name, run } of chain) {
      try {
        const hits = await run();
        if (hits.length > 0) {
          console.log(`[webSearch] backend=${name} hits=${hits.length} query=${JSON.stringify(query)}`);
          return { success: true, output: formatResults(query, hits) };
        }
        ranClean = true;
        errors.push(`${name}: no results`);
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.warn(`[webSearch] backend=${name} failed/empty, degrading`);
    }

    // A backend ran successfully but the web genuinely had nothing → report empty, not failure
    // (so the model knows the search executed rather than the tool being broken).
    if (ranClean) return { success: true, output: formatResults(query, []) };

    return {
      success: false,
      output: '',
      error: `All search backends failed. Tried — ${errors.join('; ')}`,
    };
  },
};
