import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callAuxLLM,
  registerMainLLM,
  clearMainLLMRegistration,
  hasMainLLMRegistered,
  isAuxLLMConfigured,
  AuxLLMError,
  type AuxLLMCaller,
  type AuxLLMRequest,
} from '../src/utils/aux-llm.js';

// ── 测试工具 ──────────────────────────────────────────────

const ENV_KEYS = [
  'AUX_LLM_BASE_URL',
  'AUX_LLM_API_KEY',
  'AUX_LLM_MODEL',
  'AUX_LLM_PROTOCOL',
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
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function setAuxEnv(base = 'https://api.example.com/v1', key = 'sk-test', model = 'mini-llm') {
  process.env.AUX_LLM_BASE_URL = base;
  process.env.AUX_LLM_API_KEY = key;
  process.env.AUX_LLM_MODEL = model;
}

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

function mockFetch(
  responder: (call: CapturedCall) => Response | Promise<Response>,
): { restore: () => void; calls: CapturedCall[] } {
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

function makeOpenAIResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeAnthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// ── 套件 ──────────────────────────────────────────────────

describe('aux-llm', () => {
  before(saveEnv);
  after(restoreEnv);
  beforeEach(() => {
    clearEnv();
    clearMainLLMRegistration();
  });
  afterEach(() => {
    clearMainLLMRegistration();
  });

  describe('configuration detection', () => {
    it('isAuxLLMConfigured returns false when env not set', () => {
      assert.equal(isAuxLLMConfigured(), false);
    });

    it('isAuxLLMConfigured returns true only when all three env vars set', () => {
      process.env.AUX_LLM_BASE_URL = 'https://x';
      assert.equal(isAuxLLMConfigured(), false);
      process.env.AUX_LLM_API_KEY = 'k';
      assert.equal(isAuxLLMConfigured(), false);
      process.env.AUX_LLM_MODEL = 'm';
      assert.equal(isAuxLLMConfigured(), true);
    });

    it('hasMainLLMRegistered reflects registration state', () => {
      assert.equal(hasMainLLMRegistered(), false);
      registerMainLLM(async () => 'x');
      assert.equal(hasMainLLMRegistered(), true);
      clearMainLLMRegistration();
      assert.equal(hasMainLLMRegistered(), false);
    });
  });

  describe('callAuxLLM — env path (small model)', () => {
    it('calls OpenAI-compatible endpoint with correct shape', async () => {
      setAuxEnv('https://api.example.com/v1', 'sk-test-123', 'mini-llm');
      const fakeFetch = mockFetch(() => makeOpenAIResponse('answer text'));
      try {
        const out = await callAuxLLM({ system: 'sys', user: 'hello' });
        assert.equal(out, 'answer text');
        assert.equal(fakeFetch.calls.length, 1);
        const call = fakeFetch.calls[0];
        assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
        const headers = call.init.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer sk-test-123');
        assert.equal(headers['Content-Type'], 'application/json');
        const body = call.body as {
          model: string;
          messages: Array<{ role: string; content: string }>;
          stream: boolean;
        };
        assert.equal(body.model, 'mini-llm');
        assert.equal(body.stream, false);
        assert.deepEqual(body.messages, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ]);
      } finally {
        fakeFetch.restore();
      }
    });

    it('omits system message when not provided', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(() => makeOpenAIResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        const body = fakeFetch.calls[0].body as {
          messages: Array<{ role: string }>;
        };
        assert.equal(body.messages.length, 1);
        assert.equal(body.messages[0].role, 'user');
      } finally {
        fakeFetch.restore();
      }
    });

    it('handles base url that already includes /chat/completions', async () => {
      setAuxEnv('https://api.example.com/v1/chat/completions', 'k', 'm');
      const fakeFetch = mockFetch(() => makeOpenAIResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        assert.equal(
          fakeFetch.calls[0].url,
          'https://api.example.com/v1/chat/completions',
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws AuxLLMError on HTTP error', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(
        () => new Response('rate limited', { status: 429 }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => {
            assert.ok(e instanceof AuxLLMError);
            assert.equal((e as AuxLLMError).kind, 'http_error');
            assert.equal((e as AuxLLMError).status, 429);
            return true;
          },
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws on empty choice content', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(
        () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
            status: 200,
          }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => (e as AuxLLMError).kind === 'invalid_response',
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws on provider error JSON', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(
        () =>
          new Response(
            JSON.stringify({ error: { message: 'invalid api key', type: 'auth_error' } }),
            { status: 200 },
          ),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => {
            const err = e as AuxLLMError;
            return err.kind === 'http_error' && /invalid api key/.test(err.message);
          },
        );
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('callAuxLLM — anthropic protocol', () => {
    it('uses /v1/messages and x-api-key header when AUX_LLM_PROTOCOL=anthropic', async () => {
      setAuxEnv('https://neolink.vnet.com/api', 'sk-ant-test', 'deepseek-v4-flash');
      process.env.AUX_LLM_PROTOCOL = 'anthropic';
      const fakeFetch = mockFetch(() => makeAnthropicResponse('anthropic reply'));
      try {
        const out = await callAuxLLM({ system: 'you are helpful', user: 'hi' });
        assert.equal(out, 'anthropic reply');
        assert.equal(fakeFetch.calls.length, 1);
        const call = fakeFetch.calls[0];
        assert.equal(call.url, 'https://neolink.vnet.com/api/v1/messages');
        const headers = call.init.headers as Record<string, string>;
        assert.equal(headers['x-api-key'], 'sk-ant-test');
        assert.equal(headers['anthropic-version'], '2023-06-01');
        const body = call.body as {
          model: string;
          system?: string;
          messages: Array<{ role: string; content: string }>;
        };
        assert.equal(body.model, 'deepseek-v4-flash');
        assert.equal(body.system, 'you are helpful');
        assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
      } finally {
        fakeFetch.restore();
      }
    });

    it('auto-detects anthropic protocol from baseUrl containing "anthropic"', async () => {
      setAuxEnv('https://api.anthropic.com', 'sk-ant', 'claude-haiku-4-5');
      const fakeFetch = mockFetch(() => makeAnthropicResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        assert.equal(fakeFetch.calls[0].url, 'https://api.anthropic.com/v1/messages');
      } finally {
        fakeFetch.restore();
      }
    });

    it('explicit AUX_LLM_PROTOCOL=openai overrides anthropic-looking baseUrl', async () => {
      setAuxEnv('https://anthropic-proxy.example.com/v1', 'k', 'm');
      process.env.AUX_LLM_PROTOCOL = 'openai';
      const fakeFetch = mockFetch(() => makeOpenAIResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        assert.equal(
          fakeFetch.calls[0].url,
          'https://anthropic-proxy.example.com/v1/chat/completions',
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('handles base url that already includes /v1/messages', async () => {
      setAuxEnv('https://neolink.vnet.com/api/v1/messages', 'k', 'm');
      process.env.AUX_LLM_PROTOCOL = 'anthropic';
      const fakeFetch = mockFetch(() => makeAnthropicResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        assert.equal(fakeFetch.calls[0].url, 'https://neolink.vnet.com/api/v1/messages');
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws invalid_response with HTML hint when endpoint returns HTML', async () => {
      setAuxEnv('https://neolink.vnet.com/api', 'k', 'm');
      process.env.AUX_LLM_PROTOCOL = 'anthropic';
      const fakeFetch = mockFetch(
        () =>
          new Response('<html>404 not found</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => {
            const err = e as AuxLLMError;
            return (
              err.kind === 'invalid_response' &&
              /anthropic/.test(err.message) &&
              /\[hint\]/.test(err.message)
            );
          },
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('omits system field when not provided', async () => {
      setAuxEnv('https://api.anthropic.com', 'k', 'm');
      const fakeFetch = mockFetch(() => makeAnthropicResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        const body = fakeFetch.calls[0].body as { system?: string };
        assert.equal(body.system, undefined);
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws on empty content array', async () => {
      setAuxEnv('https://api.anthropic.com', 'k', 'm');
      const fakeFetch = mockFetch(
        () =>
          new Response(
            JSON.stringify({ content: [], stop_reason: 'end_turn' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => (e as AuxLLMError).kind === 'invalid_response',
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws AuxLLMError on HTTP error in anthropic path', async () => {
      setAuxEnv('https://api.anthropic.com', 'k', 'm');
      const fakeFetch = mockFetch(
        () => new Response('rate limited', { status: 429 }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => {
            const err = e as AuxLLMError;
            return err.kind === 'http_error' && err.status === 429 &&
                   /anthropic/.test(err.message);
          },
        );
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('callAuxLLM — fallback to main LLM', () => {
    it('uses registered main caller when env not configured', async () => {
      const calls: AuxLLMRequest[] = [];
      const main: AuxLLMCaller = async (req) => {
        calls.push(req);
        return 'main-result';
      };
      registerMainLLM(main);

      const out = await callAuxLLM({ system: 's', user: 'u' });
      assert.equal(out, 'main-result');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].user, 'u');
      assert.equal(calls[0].system, 's');
    });

    it('prefers env config over main caller when both set', async () => {
      setAuxEnv();
      let mainCalled = false;
      registerMainLLM(async () => {
        mainCalled = true;
        return 'should-not-be-called';
      });
      const fakeFetch = mockFetch(() => makeOpenAIResponse('from-env'));
      try {
        const out = await callAuxLLM({ user: 'q' });
        assert.equal(out, 'from-env');
        assert.equal(mainCalled, false);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('callAuxLLM — not configured', () => {
    it('throws AuxLLMError(not_configured) when neither env nor main caller set', async () => {
      await assert.rejects(
        () => callAuxLLM({ user: 'q' }),
        (e: unknown) => {
          assert.ok(e instanceof AuxLLMError);
          assert.equal((e as AuxLLMError).kind, 'not_configured');
          return true;
        },
      );
    });
  });
});
