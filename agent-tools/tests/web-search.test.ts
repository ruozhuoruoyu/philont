import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webSearchTool } from '../src/network/webSearch.js';

const ENV_KEYS = [
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'PHILONT_WEB_SEARCH_NATIVE',
  'PHILONT_WEB_SEARCH_SCRAPE',
  'PHILONT_WEB_SEARCH_NATIVE_TOOL',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function saveEnv() {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}
// Isolate a single tier per test: clear all keys, and turn OFF native + scrape by default so the
// third-party tests run alone. Tests that exercise native/scrape re-enable them explicitly.
function clearKeys() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PHILONT_WEB_SEARCH_NATIVE = '0';
  process.env.PHILONT_WEB_SEARCH_SCRAPE = '0';
}

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

function mockFetch(
  responder: (call: CapturedCall) => Response | Promise<Response>,
) {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let body: unknown;
    try {
      body = init.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      body = init.body;
    }
    const call: CapturedCall = { url, init, body };
    calls.push(call);
    return responder(call);
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

describe('webSearchTool', () => {
  before(saveEnv);
  after(restoreEnv);
  beforeEach(clearKeys);

  it('returns error when no backend available (native+scrape off, no key)', async () => {
    const r = await webSearchTool.execute({ query: 'q' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /No search backend available/);
  });

  describe('Tavily backend', () => {
    it('strips snippet/content fields entirely', async () => {
      process.env.TAVILY_API_KEY = 'tk';
      const fakeFetch = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  title: 'DeepSeek V4 paper',
                  url: 'https://arxiv.org/abs/2503.00001',
                  // 即使后端返回 content，工具也不应把它带回去
                  content:
                    '<img src="logo.png" width="400"> Lorem ipsum dolor sit amet',
                  score: 0.9,
                },
              ],
            }),
            { status: 200 },
          ),
      );
      try {
        const r = await webSearchTool.execute({ query: 'DeepSeek V4' });
        assert.equal(r.success, true);
        // 关键断言：输出里绝不能出现 snippet/content/score
        assert.ok(!/Lorem ipsum/.test(r.output));
        assert.ok(!/<img/.test(r.output));
        assert.ok(!/score/.test(r.output));
        assert.ok(!/snippet/.test(r.output));
        // 输出格式必须是 Claude Code 风格
        assert.match(r.output, /Web search results for query: "DeepSeek V4"/);
        assert.match(r.output, /Links: \[/);
        assert.match(r.output, /REMINDER:.*markdown hyperlinks/);
        // JSON 里只有 title 和 url 两个字段
        const linksMatch = r.output.match(/Links: (\[.*?\])\n\n/s);
        assert.ok(linksMatch);
        const links = JSON.parse(linksMatch![1]);
        assert.equal(links.length, 1);
        assert.deepEqual(Object.keys(links[0]).sort(), ['title', 'url']);
        assert.equal(links[0].title, 'DeepSeek V4 paper');
        assert.equal(links[0].url, 'https://arxiv.org/abs/2503.00001');
      } finally {
        fakeFetch.restore();
      }
    });

    it('passes correct request body to Tavily', async () => {
      process.env.TAVILY_API_KEY = 'tk';
      const fakeFetch = mockFetch(
        () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      try {
        await webSearchTool.execute({ query: 'foo', limit: 3 });
        assert.equal(fakeFetch.calls.length, 1);
        const body = fakeFetch.calls[0].body as {
          api_key: string;
          query: string;
          max_results: number;
          search_depth: string;
          include_answer: boolean;
          include_raw_content: boolean;
          include_images: boolean;
        };
        assert.equal(body.api_key, 'tk');
        assert.equal(body.query, 'foo');
        assert.equal(body.max_results, 3);
        assert.equal(body.search_depth, 'basic');
        assert.equal(body.include_answer, false);
        assert.equal(body.include_raw_content, false);
        assert.equal(body.include_images, false);
      } finally {
        fakeFetch.restore();
      }
    });

    it('returns "No links found" on empty results', async () => {
      process.env.TAVILY_API_KEY = 'tk';
      const fakeFetch = mockFetch(
        () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      try {
        const r = await webSearchTool.execute({ query: 'no-hits' });
        assert.equal(r.success, true);
        assert.match(r.output, /No links found/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('skips malformed results (missing title or url)', async () => {
      process.env.TAVILY_API_KEY = 'tk';
      const fakeFetch = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              results: [
                { title: 'good', url: 'https://a' },
                { title: 'no-url' },
                { url: 'https://no-title' },
                {},
              ],
            }),
            { status: 200 },
          ),
      );
      try {
        const r = await webSearchTool.execute({ query: 'mix' });
        const linksMatch = r.output.match(/Links: (\[.*?\])\n\n/s);
        const links = JSON.parse(linksMatch![1]);
        assert.equal(links.length, 1);
        assert.equal(links[0].title, 'good');
      } finally {
        fakeFetch.restore();
      }
    });

    it('reports backend error', async () => {
      process.env.TAVILY_API_KEY = 'tk';
      const fakeFetch = mockFetch(() => new Response('rate limited', { status: 429 }));
      try {
        const r = await webSearchTool.execute({ query: 'q' });
        assert.equal(r.success, false);
        assert.match(r.error ?? '', /tavily/);
        assert.match(r.error ?? '', /429/);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('Serper backend', () => {
    it('extracts title + link only', async () => {
      process.env.SERPER_API_KEY = 'sk';
      const fakeFetch = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              organic: [
                {
                  title: 'foo',
                  link: 'https://foo',
                  snippet: 'should be dropped',
                },
              ],
            }),
            { status: 200 },
          ),
      );
      try {
        const r = await webSearchTool.execute({ query: 'q' });
        assert.equal(r.success, true);
        assert.ok(!/should be dropped/.test(r.output));
        const linksMatch = r.output.match(/Links: (\[.*?\])\n\n/s);
        const links = JSON.parse(linksMatch![1]);
        assert.deepEqual(links, [{ title: 'foo', url: 'https://foo' }]);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('Brave backend', () => {
    it('extracts title + url only', async () => {
      process.env.BRAVE_SEARCH_API_KEY = 'bk';
      const fakeFetch = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              web: {
                results: [
                  {
                    title: 'bar',
                    url: 'https://bar',
                    description: 'dropped',
                  },
                ],
              },
            }),
            { status: 200 },
          ),
      );
      try {
        const r = await webSearchTool.execute({ query: 'q' });
        assert.equal(r.success, true);
        assert.ok(!/dropped/.test(r.output));
        const linksMatch = r.output.match(/Links: (\[.*?\])\n\n/s);
        const links = JSON.parse(linksMatch![1]);
        assert.deepEqual(links, [{ title: 'bar', url: 'https://bar' }]);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('backend priority', () => {
    it('prefers Tavily over Serper over Brave when multiple keys set', async () => {
      process.env.TAVILY_API_KEY = 'tk';
      process.env.SERPER_API_KEY = 'sk';
      process.env.BRAVE_SEARCH_API_KEY = 'bk';
      const fakeFetch = mockFetch((call) => {
        assert.match(call.url, /api\.tavily\.com/);
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      });
      try {
        await webSearchTool.execute({ query: 'q' });
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('native API search (tier 1)', () => {
    it('parses web_search_tool_result blocks into title+url and is tried first', async () => {
      process.env.PHILONT_WEB_SEARCH_NATIVE = '1'; // re-enable (clearKeys turned it off)
      process.env.ANTHROPIC_API_KEY = 'ak';
      process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
      process.env.TAVILY_API_KEY = 'tk'; // present, but native should win and we never reach it
      const fakeFetch = mockFetch((call) => {
        // first (and only) call must be the native /v1/messages endpoint, not Tavily
        assert.match(call.url, /api\.deepseek\.com\/anthropic\/v1\/messages/);
        const body = call.body as { tools: Array<{ type: string; name: string }> };
        assert.equal(body.tools[0].name, 'web_search');
        return new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'Here are results' },
              {
                type: 'web_search_tool_result',
                content: [
                  { title: 'Goldbach conjecture', url: 'https://en.wikipedia.org/wiki/Goldbach', page_age: '1d' },
                  { title: 'no-url-skip' },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      });
      try {
        const r = await webSearchTool.execute({ query: 'goldbach' });
        assert.equal(r.success, true);
        assert.equal(fakeFetch.calls.length, 1); // never degraded to Tavily
        const links = JSON.parse(r.output.match(/Links: (\[.*?\])\n\n/s)![1]);
        assert.deepEqual(links, [{ title: 'Goldbach conjecture', url: 'https://en.wikipedia.org/wiki/Goldbach' }]);
      } finally {
        fakeFetch.restore();
      }
    });

    it('degrades to the third-party key when native errors', async () => {
      process.env.PHILONT_WEB_SEARCH_NATIVE = '1';
      process.env.ANTHROPIC_API_KEY = 'ak';
      process.env.TAVILY_API_KEY = 'tk';
      const fakeFetch = mockFetch((call) => {
        if (/\/v1\/messages/.test(call.url)) return new Response('tool not supported', { status: 400 });
        assert.match(call.url, /api\.tavily\.com/);
        return new Response(JSON.stringify({ results: [{ title: 'fallback', url: 'https://fb' }] }), { status: 200 });
      });
      try {
        const r = await webSearchTool.execute({ query: 'q' });
        assert.equal(r.success, true);
        assert.equal(fakeFetch.calls.length, 2); // native attempted, then Tavily
        const links = JSON.parse(r.output.match(/Links: (\[.*?\])\n\n/s)![1]);
        assert.deepEqual(links, [{ title: 'fallback', url: 'https://fb' }]);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('keyless scraping (tier 3)', () => {
    it('parses DuckDuckGo HTML and decodes the uddg redirect', async () => {
      process.env.PHILONT_WEB_SEARCH_SCRAPE = '1'; // re-enable; no keys → scrape is the only tier
      const ddgHtml =
        '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=' +
        encodeURIComponent('https://example.com/page') +
        '&rut=x">Example &amp; Co</a></div>';
      const fakeFetch = mockFetch((call) => {
        assert.match(call.url, /html\.duckduckgo\.com/);
        return new Response(ddgHtml, { status: 200 });
      });
      try {
        const r = await webSearchTool.execute({ query: 'q' });
        assert.equal(r.success, true);
        const links = JSON.parse(r.output.match(/Links: (\[.*?\])\n\n/s)![1]);
        assert.deepEqual(links, [{ title: 'Example & Co', url: 'https://example.com/page' }]);
      } finally {
        fakeFetch.restore();
      }
    });
  });
});
