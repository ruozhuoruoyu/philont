/**
 * createSecuredHttpTool body 序列化单测。
 *
 * 2026-05-11 实战:LLM 给 http 工具传 body 时常常传 object 字面量,旧实现
 * `params.body as string` 直 cast,fetch 调 .toString() 发出 "[object Object]"
 * → 目标服务报 "JSON Parse error: Unexpected identifier 'object'"。
 *
 * 修复:body 是 object 时自动 JSON.stringify + 补 Content-Type。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '@agent/policy';
import { createSecuredHttpTool } from '../src/network/securedHttp.js';

const TEST_MASTER_KEY = Buffer.alloc(32, 0).toString('base64');

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

function withMockFetch<T>(
  response: { status: number; body: string },
  fn: (cap: CapturedFetch) => Promise<T>,
): Promise<T> {
  const cap: CapturedFetch = { url: '', init: undefined };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    cap.url = typeof input === 'string' ? input : String(input);
    cap.init = init;
    return new Response(response.body, { status: response.status });
  }) as typeof fetch;
  return fn(cap).finally(() => {
    globalThis.fetch = original;
  });
}

function makeTool() {
  const store = new SecretStore({ masterKey: TEST_MASTER_KEY });
  return createSecuredHttpTool(store);
}

test('body 是 string → 原样发送,不动 Content-Type', async () => {
  const tool = makeTool();
  await withMockFetch({ status: 200, body: '{"ok":true}' }, async (cap) => {
    const r = await tool.execute({
      url: 'https://api.example.com/x',
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'raw string body',
    });
    assert.equal(r.success, true);
    assert.equal(cap.init?.body, 'raw string body');
    const headers = cap.init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'text/plain');
  });
});

test('unresolved $VAR placeholder → rejected before fetch (no guessing)', async () => {
  const tool = makeTool();
  for (const url of ['https://$BASE_URL/api/posts', 'https://h/${HOST}/x', 'https://$API_URL/v1']) {
    const r = await tool.execute({ url, method: 'GET' });
    assert.equal(r.success, false, `should reject ${url}`);
    assert.match(r.error ?? '', /unresolved placeholder/);
  }
});

test('legitimate $ / {SECRET_ID} usage passes the placeholder gate', async () => {
  const tool = makeTool();
  // OData $filter/$top (lowercase) and a clean URL must NOT be rejected as placeholders.
  for (const url of ['https://api.example.com/api?$filter=x&$top=5', 'https://api.mycox.ai/api/posts']) {
    await withMockFetch({ status: 200, body: '{"ok":true}' }, async () => {
      const r = await tool.execute({ url, method: 'GET' });
      assert.equal(r.success, true, `should allow ${url}`);
    });
  }
});

test('body 是 object → 自动 JSON.stringify + 补 Content-Type', async () => {
  const tool = makeTool();
  await withMockFetch({ status: 200, body: '{"ok":true}' }, async (cap) => {
    const r = await tool.execute({
      url: 'https://api.example.com/register',
      method: 'POST',
      body: { invite_code: 'inv_123', handle: 'alice' },
    });
    assert.equal(r.success, true);
    assert.equal(
      cap.init?.body,
      '{"invite_code":"inv_123","handle":"alice"}',
    );
    const headers = cap.init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
  });
});

test('body 是 object 且 caller 已设 Content-Type → 不覆盖', async () => {
  const tool = makeTool();
  await withMockFetch({ status: 200, body: '{}' }, async (cap) => {
    await tool.execute({
      url: 'https://api.example.com/x',
      method: 'POST',
      headers: { 'content-type': 'application/vnd.foo+json' }, // 小写 + 自定义
      body: { a: 1 },
    });
    const headers = cap.init?.headers as Record<string, string>;
    // 大小写不敏感:不应额外加 "Content-Type" 字段
    const ctKeys = Object.keys(headers).filter(
      (k) => k.toLowerCase() === 'content-type',
    );
    assert.equal(ctKeys.length, 1);
    assert.equal(headers['content-type'], 'application/vnd.foo+json');
  });
});

test('body 是 array → 也 stringify', async () => {
  const tool = makeTool();
  await withMockFetch({ status: 200, body: '[]' }, async (cap) => {
    await tool.execute({
      url: 'https://api.example.com/batch',
      method: 'POST',
      body: [{ id: 1 }, { id: 2 }],
    });
    assert.equal(cap.init?.body, '[{"id":1},{"id":2}]');
  });
});

test('body 缺省 → fetch 收到 undefined', async () => {
  const tool = makeTool();
  await withMockFetch({ status: 200, body: 'ok' }, async (cap) => {
    await tool.execute({
      url: 'https://api.example.com/health',
      method: 'GET',
    });
    assert.equal(cap.init?.body, undefined);
  });
});

test('body 是 null → 当 undefined 处理', async () => {
  const tool = makeTool();
  await withMockFetch({ status: 200, body: 'ok' }, async (cap) => {
    await tool.execute({
      url: 'https://api.example.com/x',
      method: 'POST',
      body: null,
    });
    assert.equal(cap.init?.body, undefined);
  });
});

test('url 缺失 → fail-fast,不发请求', async () => {
  const tool = makeTool();
  const fetchCalls: number[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls.push(1);
    return new Response('should not be called', { status: 200 });
  }) as typeof fetch;
  try {
    const r = await tool.execute({ method: 'GET' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /url.*required/);
    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('url 是空串 → fail-fast', async () => {
  const tool = makeTool();
  const r = await tool.execute({ url: '', method: 'GET' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /url.*required/);
});

test('url 是 number → fail-fast', async () => {
  const tool = makeTool();
  const r = await tool.execute({ url: 123 as unknown as string, method: 'GET' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /url.*required/);
});

test('回归保护:object body 不再产 "[object Object]"', async () => {
  const tool = makeTool();
  await withMockFetch({ status: 200, body: 'ok' }, async (cap) => {
    await tool.execute({
      url: 'https://api.example.com/x',
      method: 'POST',
      body: { foo: 'bar' },
    });
    assert.notEqual(cap.init?.body, '[object Object]');
    assert.match(String(cap.init?.body), /^\{.*"foo":"bar".*\}$/);
  });
});

// 2026-05-17:URL HTML-leak sanitize 校验
test('url 含 HTML 闭合标签字符 ">" → reject(实战 mycox bug)', async () => {
  const tool = makeTool();
  const r = await tool.execute({
    url: 'https://my">https://mycox.ai/api/posts/x/comments',
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /HTML tag characters/);
});

test('url 含 "<" → reject', async () => {
  const tool = makeTool();
  const r = await tool.execute({ url: 'https://api.x/<script>' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /HTML tag characters/);
});

test('url 含 HTML entity &quot; → reject', async () => {
  const tool = makeTool();
  const r = await tool.execute({ url: 'https://api.x/path&quot;foo' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /HTML tag characters/);
});

test('url 含 { } 占位符(SECRET_ID) → 不 reject', async () => {
  const tool = makeTool();
  await withMockFetch({ status: 200, body: 'ok' }, async (cap) => {
    const r = await tool.execute({
      url: 'https://api.x/path?token={MY_TOKEN}',
      method: 'GET',
    });
    // 占位符没注册 secret 会跑出错,但**不是** URL 校验拦的 — 错误信息不应含 "HTML tag characters"
    if (r.success === false) {
      assert.doesNotMatch(r.error ?? '', /HTML tag characters/);
    }
    assert.equal(typeof cap.url, 'string');
  });
});
