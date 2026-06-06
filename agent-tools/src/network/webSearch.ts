/**
 * webSearch tool - web search
 *
 * Design principles (aligned with Claude Code WebSearchTool):
 *   - Output **only title + url**, actively discarding snippet/content
 *   - Let the model fetch details on demand rather than being led by snippets to generate answers directly
 *   - Reduce context pollution (HTML tags, ad boilerplate, etc. won't leak in via snippets)
 *
 * Supports multiple backends:
 *   - Tavily  (TAVILY_API_KEY)
 *   - Serper  (SERPER_API_KEY)
 *   - Brave   (BRAVE_SEARCH_API_KEY)
 *
 * Auto-detects available backend; priority: Tavily > Serper > Brave
 */

import type { Tool } from '@agent/policy';

type SearchBackend = 'tavily' | 'serper' | 'brave';

/** A single search result — only title + url, deliberately no snippet */
interface SearchHit {
  title: string;
  url: string;
}

function detectBackend(): SearchBackend | null {
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.SERPER_API_KEY) return 'serper';
  if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  return null;
}

async function searchTavily(query: string, limit: number): Promise<SearchHit[]> {
  const resp = await fetch('https://api.tavily.com/search', {
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
  });
  if (!resp.ok) throw new Error(`Tavily API error: ${resp.status}`);
  const data = (await resp.json()) as {
    results?: Array<{ title?: string; url?: string }>;
  };
  return (data.results ?? [])
    .filter((r): r is { title: string; url: string } =>
      typeof r.title === 'string' && typeof r.url === 'string',
    )
    .map((r) => ({ title: r.title, url: r.url }));
}

async function searchSerper(query: string, limit: number): Promise<SearchHit[]> {
  const resp = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.SERPER_API_KEY!,
    },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!resp.ok) throw new Error(`Serper API error: ${resp.status}`);
  const data = (await resp.json()) as {
    organic?: Array<{ title?: string; link?: string }>;
  };
  return (data.organic ?? [])
    .filter((r): r is { title: string; link: string } =>
      typeof r.title === 'string' && typeof r.link === 'string',
    )
    .map((r) => ({ title: r.title, url: r.link }));
}

async function searchBrave(query: string, limit: number): Promise<SearchHit[]> {
  const resp = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY!,
      },
    },
  );
  if (!resp.ok) throw new Error(`Brave Search API error: ${resp.status}`);
  const data = (await resp.json()) as {
    web?: { results?: Array<{ title?: string; url?: string }> };
  };
  return (data.web?.results ?? [])
    .filter((r): r is { title: string; url: string } =>
      typeof r.title === 'string' && typeof r.url === 'string',
    )
    .map((r) => ({ title: r.title, url: r.url }));
}

/**
 * Render search hits into a Claude Code WebSearchTool-style tool result.
 *
 * Example:
 *   Web search results for query: "DeepSeek V4"
 *
 *   Links: [{"title":"...","url":"..."}, ...]
 *
 *   REMINDER: You MUST include the sources above in your response using markdown hyperlinks.
 */
function formatResults(query: string, hits: SearchHit[]): string {
  const head = `Web search results for query: "${query}"\n\n`;
  if (hits.length === 0) {
    return `${head}No links found.`;
  }
  const links = `Links: ${JSON.stringify(hits)}\n\n`;
  const reminder =
    'REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.';
  return head + links + reminder;
}

export const webSearchTool: Tool = {
  name: 'webSearch',
  description: 'Search the web for up-to-date information (Tavily/Serper/Brave backends). Returns a list of titles and links; use webFetch to retrieve the body when you need it.',
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

    const backend = detectBackend();
    if (!backend) {
      return {
        success: false,
        output: '',
        error:
          'No search API key configured. Set one of: TAVILY_API_KEY, SERPER_API_KEY, BRAVE_SEARCH_API_KEY',
      };
    }

    try {
      let hits: SearchHit[];
      switch (backend) {
        case 'tavily':
          hits = await searchTavily(query, limit);
          break;
        case 'serper':
          hits = await searchSerper(query, limit);
          break;
        case 'brave':
          hits = await searchBrave(query, limit);
          break;
      }
      return {
        success: true,
        output: formatResults(query, hits),
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `Search failed (${backend}): ${error}`,
      };
    }
  },
};
