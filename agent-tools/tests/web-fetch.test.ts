import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webFetchTool, clearWebFetchCache } from '../src/network/webFetch.js';
import {
  registerMainLLM,
  clearMainLLMRegistration,
} from '../src/utils/aux-llm.js';

const ENV_KEYS = ['AUX_LLM_BASE_URL', 'AUX_LLM_API_KEY', 'AUX_LLM_MODEL'] as const;
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
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function setAuxEnv() {
  process.env.AUX_LLM_BASE_URL = 'https://aux.example.com/v1';
  process.env.AUX_LLM_API_KEY = 'sk-aux';
  process.env.AUX_LLM_MODEL = 'mini';
}

interface CapturedCall {
  url: string;
  init: RequestInit;
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
    calls.push({ url, init });
    return responder({ url, init });
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const SIMPLE_HTML = `
<html>
<head><title>DeepSeek V4 Paper</title></head>
<body>
<nav>nav garbage</nav>
<header><img src="logo.png" width="400"></header>
<main>
  <h1>DeepSeek V4: Towards Highly Efficient Architectures</h1>
  <p>This paper proposes a new framework for accelerating <a href="/abs/2503.00001">agent inference</a>.</p>
  <h2>Background</h2>
  <p>Recent work has shown that <code>self-attention</code> is the bottleneck.</p>
  <ul>
    <li>Improvement A</li>
    <li>Improvement B</li>
  </ul>
  <script>tracker.send()</script>
  <style>body { color: red; }</style>
</main>
<footer>copyright junk</footer>
</body>
</html>
`;

describe('webFetchTool', () => {
  before(saveEnv);
  after(restoreEnv);
  beforeEach(() => {
    clearEnv();
    clearMainLLMRegistration();
    clearWebFetchCache();
  });
  afterEach(() => {
    clearMainLLMRegistration();
  });

  describe('input validation', () => {
    it('rejects invalid URL', async () => {
      const r = await webFetchTool.execute({ url: 'not a url' });
      assert.equal(r.success, false);
      assert.match(r.error ?? '', /invalid_url/);
    });

    it('rejects FTP / file protocols', async () => {
      const r = await webFetchTool.execute({ url: 'ftp://example.com/x' });
      assert.equal(r.success, false);
      assert.match(r.error ?? '', /unsupported_protocol/);
    });

    it('rejects URLs with credentials', async () => {
      const r = await webFetchTool.execute({ url: 'https://user:pw@example.com' });
      assert.equal(r.success, false);
      assert.match(r.error ?? '', /credentials/);
    });

    it('rejects URLs > 2000 chars', async () => {
      const long = 'https://example.com/' + 'a'.repeat(2001);
      const r = await webFetchTool.execute({ url: long });
      assert.equal(r.success, false);
      assert.match(r.error ?? '', /URL too long/);
    });
  });

  describe('basic fetch (no prompt → markdown path)', () => {
    it('strips HTML noise and returns clean markdown', async () => {
      const fakeFetch = mockFetch(() => htmlResponse(SIMPLE_HTML));
      try {
        const r = await webFetchTool.execute({ url: 'https://example.com/paper' });
        assert.equal(r.success, true, r.error);
        // 噪声不见了
        assert.ok(!/<img/.test(r.output));
        assert.ok(!/<script/.test(r.output));
        assert.ok(!/<style/.test(r.output));
        assert.ok(!/tracker\.send/.test(r.output));
        assert.ok(!/copyright junk/.test(r.output)); // footer 干掉
        assert.ok(!/nav garbage/.test(r.output));
        // 关键内容保留
        assert.match(r.output, /DeepSeek V4/);
        assert.match(r.output, /agent inference/);
        // 结构化转换
        assert.match(r.output, /^# DeepSeek V4/m); // h1 → markdown header
        assert.match(r.output, /^## Background/m);
        assert.match(r.output, /`self-attention`/); // <code> → backticks
        assert.match(r.output, /- Improvement A/);
        assert.match(r.output, /\[agent inference\]\(https:\/\/example\.com\/abs/); // 相对链接转绝对
      } finally {
        fakeFetch.restore();
      }
    });

    it('extracts title and includes it in metadata', async () => {
      const fakeFetch = mockFetch(() => htmlResponse(SIMPLE_HTML));
      try {
        const r = await webFetchTool.execute({ url: 'https://example.com/paper' });
        assert.match(r.output, /Title: DeepSeek V4 Paper/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('truncates when content exceeds maxChars', async () => {
      const big = '<html><body>' + 'x'.repeat(50_000) + '</body></html>';
      const fakeFetch = mockFetch(() => htmlResponse(big));
      try {
        const r = await webFetchTool.execute({
          url: 'https://example.com/big',
          maxChars: 1000,
        });
        assert.equal(r.success, true);
        assert.match(r.output, /\[Content truncated due to length/);
        assert.match(r.output, /Truncated: true/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('upgrades http to https', async () => {
      const fakeFetch = mockFetch(() => htmlResponse('<html>x</html>'));
      try {
        await webFetchTool.execute({ url: 'http://example.com/' });
        assert.equal(fakeFetch.calls.length, 1);
        assert.match(fakeFetch.calls[0].url, /^https:\/\//);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('redirect handling', () => {
    it('auto-follows same-host redirect', async () => {
      const fakeFetch = mockFetch((call) => {
        if (call.url === 'https://example.com/a') {
          return new Response(null, {
            status: 301,
            headers: { Location: 'https://example.com/b' },
          });
        }
        return htmlResponse('<html><title>final</title><p>final body</p></html>');
      });
      try {
        const r = await webFetchTool.execute({ url: 'https://example.com/a' });
        assert.equal(r.success, true);
        assert.match(r.output, /Title: final/);
        assert.match(r.output, /final body/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('treats www. as same host', async () => {
      const fakeFetch = mockFetch((call) => {
        if (call.url === 'https://example.com/') {
          return new Response(null, {
            status: 301,
            headers: { Location: 'https://www.example.com/' },
          });
        }
        return htmlResponse('<html><title>www-redirect</title><body>x</body></html>');
      });
      try {
        const r = await webFetchTool.execute({ url: 'https://example.com/' });
        assert.match(r.output, /Title: www-redirect/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('returns REDIRECT_DETECTED on cross-host redirect', async () => {
      const fakeFetch = mockFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://attacker.com/evil' },
          }),
      );
      try {
        const r = await webFetchTool.execute({ url: 'https://example.com/' });
        assert.equal(r.success, true);
        assert.match(r.output, /REDIRECT DETECTED/);
        assert.match(r.output, /https:\/\/attacker\.com\/evil/);
        assert.match(r.output, /Extractor: redirect/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('caps redirect chain', async () => {
      let i = 0;
      const fakeFetch = mockFetch(() => {
        i++;
        return new Response(null, {
          status: 301,
          headers: { Location: `https://example.com/r${i}` },
        });
      });
      try {
        const r = await webFetchTool.execute({ url: 'https://example.com/r0' });
        assert.equal(r.success, false);
        assert.match(r.error ?? '', /too_many_redirects/);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('distillation path (with prompt)', () => {
    it('calls aux-llm when prompt provided', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch((call) => {
        if (call.url.includes('aux.example.com')) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ARXIV: 2503.00001' } }],
            }),
            { status: 200 },
          );
        }
        return htmlResponse(SIMPLE_HTML);
      });
      try {
        const r = await webFetchTool.execute({
          url: 'https://example.com/paper',
          prompt: 'Extract the arxiv id of the paper.',
        });
        assert.equal(r.success, true);
        assert.match(r.output, /ARXIV: 2503\.00001/);
        assert.match(r.output, /Extractor: distilled/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('falls back to markdown when aux-llm errors out', async () => {
      // env 不配 + 不注册 main caller → AuxLLMError(not_configured)
      const fakeFetch = mockFetch(() => htmlResponse(SIMPLE_HTML));
      try {
        const r = await webFetchTool.execute({
          url: 'https://example.com/paper',
          prompt: 'extract arxiv id',
        });
        assert.equal(r.success, true);
        assert.match(r.output, /Aux-LLM distillation failed/);
        assert.match(r.output, /not_configured/);
        // markdown 内容仍然回来了
        assert.match(r.output, /DeepSeek V4/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('uses registered main caller when env not set', async () => {
      let mainCalled = false;
      registerMainLLM(async () => {
        mainCalled = true;
        return 'main-distilled-result';
      });
      const fakeFetch = mockFetch(() => htmlResponse(SIMPLE_HTML));
      try {
        const r = await webFetchTool.execute({
          url: 'https://example.com/paper',
          prompt: 'summarize',
        });
        assert.equal(mainCalled, true);
        assert.match(r.output, /main-distilled-result/);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('preapproved hosts', () => {
    it('marks docs.python.org as preapproved (skip distill)', async () => {
      const fakeFetch = mockFetch(() => htmlResponse(SIMPLE_HTML));
      try {
        const r = await webFetchTool.execute({
          url: 'https://docs.python.org/3/library/asyncio.html',
        });
        assert.match(r.output, /Extractor: preapproved/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('arxiv.org is preapproved', async () => {
      const fakeFetch = mockFetch(() =>
        htmlResponse('<html><title>arxiv abstract</title><body>abstract text</body></html>'),
      );
      try {
        const r = await webFetchTool.execute({
          url: 'https://arxiv.org/abs/2503.00001',
        });
        assert.match(r.output, /Extractor: preapproved/);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('caching', () => {
    it('serves second call from cache', async () => {
      let n = 0;
      const fakeFetch = mockFetch(() => {
        n++;
        return htmlResponse(SIMPLE_HTML);
      });
      try {
        await webFetchTool.execute({ url: 'https://example.com/x' });
        await webFetchTool.execute({ url: 'https://example.com/x' });
        assert.equal(n, 1, 'second call should hit cache, not re-fetch');
      } finally {
        fakeFetch.restore();
      }
    });

    it('different prompts cache separately', async () => {
      setAuxEnv();
      let auxCalls = 0;
      const fakeFetch = mockFetch((call) => {
        if (call.url.includes('aux.example.com')) {
          auxCalls++;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: `r${auxCalls}` } }] }),
            { status: 200 },
          );
        }
        return htmlResponse(SIMPLE_HTML);
      });
      try {
        await webFetchTool.execute({
          url: 'https://example.com/y',
          prompt: 'p1',
        });
        await webFetchTool.execute({
          url: 'https://example.com/y',
          prompt: 'p2',
        });
        assert.equal(auxCalls, 2, 'different prompts must trigger fresh distillation');
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('error reporting', () => {
    it('classifies 4xx HTTP errors', async () => {
      const fakeFetch = mockFetch(() => new Response('not found', { status: 404 }));
      try {
        const r = await webFetchTool.execute({ url: 'https://example.com/missing' });
        assert.equal(r.success, false);
        assert.match(r.error ?? '', /http_error/);
        assert.match(r.error ?? '', /HTTP 404/);
      } finally {
        fakeFetch.restore();
      }
    });

    it('classifies network errors', async () => {
      const fakeFetch = mockFetch(() => {
        throw new Error('ECONNREFUSED');
      });
      try {
        const r = await webFetchTool.execute({ url: 'https://example.com/' });
        assert.equal(r.success, false);
        assert.match(r.error ?? '', /Network error/);
      } finally {
        fakeFetch.restore();
      }
    });
  });
});
