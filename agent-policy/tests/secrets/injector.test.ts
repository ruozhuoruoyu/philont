import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '../../src/secrets/store.js';
import { createInjectingFetch } from '../../src/secrets/injector.js';

const MASTER_KEY = Buffer.alloc(32, 'a').toString('base64');

// 捕获 fetch 调用的 mock
const originalFetch = globalThis.fetch;
let lastCall: { url: string; init?: RequestInit } | null = null;

before(() => {
  globalThis.fetch = mock.fn(async (url: any, init?: any) => {
    lastCall = { url: String(url), init };
    return new Response('ok', { status: 200 });
  }) as any;
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe('createInjectingFetch', () => {
  it('replaces {SECRET_ID} in URL', async () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('TOKEN', 'abc-123');
    const f = createInjectingFetch(store);
    await f('https://api.example.com/user?auth={TOKEN}');
    assert.ok(lastCall!.url.includes('abc-123'));
    assert.ok(!lastCall!.url.includes('{TOKEN}'));
  });

  it('replaces {SECRET_ID} in headers', async () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('API_KEY', 'key-xyz');
    const f = createInjectingFetch(store);
    await f('https://api.example.com/', {
      headers: { 'Authorization': 'Bearer {API_KEY}' },
    });
    const h = lastCall!.init!.headers as Record<string, string>;
    assert.equal(h['Authorization'], 'Bearer key-xyz');
  });

  it('replaces in body string', async () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('TOKEN', 't-99');
    const f = createInjectingFetch(store);
    await f('https://api.example.com/', {
      method: 'POST',
      body: 'token={TOKEN}',
    });
    assert.equal(lastCall!.init!.body, 'token=t-99');
  });

  it('unknown placeholders → throw (2026-05-17 fail-fast)', async () => {
    // 老行为是"unknown placeholder 保持原样发出",2026-05-17 升级为 fail-fast
    // 防 401 死循环。如要回退老行为,见 PHILONT_INJECTOR_RESIDUE_BLOCK=0 测试。
    const store = new SecretStore({ masterKey: MASTER_KEY });
    const f = createInjectingFetch(store);
    await assert.rejects(
      () => f('https://api.example.com/?x={UNKNOWN}'),
      /Unknown credential placeholder/,
    );
  });

  it('allowedSecrets whitelist restricts replacement', async () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('A', 'a-val');
    store.set('B', 'b-val');
    const f = createInjectingFetch(store, { allowedSecrets: new Set(['A']) });
    await f('https://x.com/?a={A}&b={B}');
    assert.ok(lastCall!.url.includes('a-val'));
    assert.ok(lastCall!.url.includes('{B}'));  // not replaced
  });

  it('scanPreInject rejects when secret already in input', async () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('X', 'x-val');
    const f = createInjectingFetch(store, { scanPreInject: true });

    const realKey = 'sk-' + 'a'.repeat(30);
    await assert.rejects(
      () => f('https://x.com/', { body: `key=${realKey}` }),
      /Pre-inject leak detected/,
    );
  });

  it('onInject callback receives secret IDs', async () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('GH', 'gh-val');
    store.set('AWS', 'aws-val');
    let captured: any = null;
    const f = createInjectingFetch(store, {
      onInject: (info) => { captured = info; },
    });
    await f('https://x.com/', { headers: { H1: '{GH}', H2: '{AWS}' } });
    assert.ok(captured);
    assert.deepEqual([...captured.secretIds].sort(), ['AWS', 'GH']);
  });

  // ── 2026-05-10:kebab-case fallback(实战 mycox heartbeat 30+ 401 失败) ──

  it('fallback: kebab-case key 命中 SCREAMING_SNAKE placeholder', async () => {
    // SaveCredential 工具用 kebab-case 存(`mycox-api-key`),但提示 LLM 用
    // {MYCOX_API_KEY}。replacePlaceholders 应自动 fallback 查 kebab。
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('mycox-api-key', 'real-token-abc');
    const f = createInjectingFetch(store);
    await f('https://api.example.com/', {
      headers: { 'Authorization': 'Bearer {MYCOX_API_KEY}' },
    });
    const h = lastCall!.init!.headers as Record<string, string>;
    assert.equal(h['Authorization'], 'Bearer real-token-abc',
      'placeholder MYCOX_API_KEY 应 fallback 命中 store key mycox-api-key');
  });

  it('fallback: snake_case 全小写 key 命中 SCREAMING_SNAKE placeholder', async () => {
    // 兼容场景:存 key 用 snake_case 全小写(github_pat)→ {GITHUB_PAT} 命中
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('github_pat', 'ghp-xxx');
    const f = createInjectingFetch(store);
    await f('https://api.example.com/', {
      headers: { 'Authorization': 'token {GITHUB_PAT}' },
    });
    const h = lastCall!.init!.headers as Record<string, string>;
    assert.equal(h['Authorization'], 'token ghp-xxx');
  });

  it('exact match 优先(若 store 有大写 key,不走 fallback)', async () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('MYCOX_API_KEY', 'exact-uppercase');
    store.set('mycox-api-key', 'kebab-case');
    const f = createInjectingFetch(store);
    await f('https://api.example.com/', {
      headers: { 'Authorization': 'Bearer {MYCOX_API_KEY}' },
    });
    const h = lastCall!.init!.headers as Record<string, string>;
    assert.equal(h['Authorization'], 'Bearer exact-uppercase',
      '直查 id 命中 → 不走 fallback');
  });

  it('都不命中 → throw 列可用 ids(2026-05-17 fail-fast)', async () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('foo', 'bar');
    const f = createInjectingFetch(store);
    await assert.rejects(
      () =>
        f('https://api.example.com/', {
          headers: { 'Authorization': 'Bearer {NONEXISTENT_KEY}' },
        }),
      (err: Error) => {
        assert.match(err.message, /\{NONEXISTENT_KEY\}/);
        assert.match(err.message, /foo/); // 列了可用 id
        return true;
      },
    );
  });

  describe('SecretStore prefix leak guard (D-2, 2026-05-15)', () => {
    it('LLM 拼了真实 secret 的 prefix → throw', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('mycox-api-key', 'mycox_9ffea9ab12cd34ef56789012');
      const f = createInjectingFetch(store);
      await assert.rejects(
        () => f('https://api.example.com/', {
          headers: { 'Authorization': 'Bearer mycox_9ffea9' },
        }),
        /Pre-inject leak detected: secret prefix.*mycox-api-key/i,
      );
    });

    it('用占位符正常注入完整值 → 不 throw(完整 value 不算 leak)', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('mycox-api-key', 'mycox_9ffea9ab12cd34ef56789012');
      const f = createInjectingFetch(store);
      // PLACEHOLDER_RE 不支持 `-`,LLM 该写 `{MYCOX_API_KEY}` 走 kebab fallback
      await f('https://api.example.com/', {
        headers: { 'Authorization': 'Bearer {MYCOX_API_KEY}' },
      });
      const h = lastCall!.init!.headers as Record<string, string>;
      assert.equal(h['Authorization'], 'Bearer mycox_9ffea9ab12cd34ef56789012');
    });

    it('短 secret(< 18 字符) prefix 不触发(防误判)', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('short', 'abc12345');  // 8 chars
      const f = createInjectingFetch(store);
      // 'abc12345' 出现在 body 也不应触发(prefixLen 太短)
      await f('https://api.example.com/', {
        method: 'POST',
        body: 'username=abc12345',
      });
      assert.ok(lastCall);
    });
  });

  describe('kebab-case placeholder (2026-05-15)', () => {
    it('{kebab-case-name} 直接匹配并 resolve(LLM 自然写法)', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('mycox-api-key', 'real-token-value-123456789');
      const f = createInjectingFetch(store);
      await f('https://api.example.com/', {
        headers: { 'Authorization': 'Bearer {mycox-api-key}' },
      });
      const h = lastCall!.init!.headers as Record<string, string>;
      assert.equal(h['Authorization'], 'Bearer real-token-value-123456789',
        'kebab-case placeholder 应直接命中');
    });

    it('{SNAKE_UPPER} fallback 仍 work(向后兼容)', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('mycox-api-key', 'val-2-9876543210');
      const f = createInjectingFetch(store);
      await f('https://api.example.com/', {
        headers: { 'Authorization': 'Bearer {MYCOX_API_KEY}' },
      });
      const h = lastCall!.init!.headers as Record<string, string>;
      assert.equal(h['Authorization'], 'Bearer val-2-9876543210',
        'SNAKE_UPPER fallback 到 kebab 仍正常');
    });

    it('抽象 example {<credential-name>} 不匹配(LLM 复制 example 不出错)', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('some-key', 'real-val-1234567890');
      const f = createInjectingFetch(store);
      await f('https://api.example.com/', {
        headers: { 'Authorization': 'Bearer {<credential-name>}' },
      });
      const h = lastCall!.init!.headers as Record<string, string>;
      assert.equal(h['Authorization'], 'Bearer {<credential-name>}',
        '含 `<` 的抽象占位符保持原样(让 upstream 错误教育 LLM 填具体名)');
    });
  });

  describe('placeholder residue fail-fast (Phase 12 cont, 2026-05-17)', () => {
    it('未解析的 placeholder 残留 → throw 错误,列可用 ids', async () => {
      lastCall = null; // 重置 cross-test 共享状态,验证本测试内 fetch 没被调用
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('valid-key', 'real-value-1234567890');
      const f = createInjectingFetch(store);
      await assert.rejects(
        () =>
          f('https://api.example.com/', {
            headers: { 'Authorization': 'Bearer {totally-unknown-name}' },
          }),
        (err: Error) => {
          assert.match(err.message, /Unknown credential placeholder/);
          assert.match(err.message, /\{totally-unknown-name\}/);
          assert.match(err.message, /valid-key/); // 列了可用 id
          return true;
        },
      );
      assert.equal(lastCall, null, 'fail-fast 后不应发出 fetch');
    });

    it('实战 mycox `{Absorption}` typo → throw + 提示正确 cred id', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('mycox-api-key', 'sk-mycox-real-value-1234');
      const f = createInjectingFetch(store);
      await assert.rejects(
        () =>
          f('https://mycox.ai/api/posts/x/upvote', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer {Absorption}' },
          }),
        (err: Error) => {
          assert.match(err.message, /\{Absorption\}/);
          assert.match(err.message, /mycox-api-key/);
          return true;
        },
      );
    });

    it('多个未知 placeholder → 全部列出', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      const f = createInjectingFetch(store);
      await assert.rejects(
        () =>
          f('https://api.x/path?a={KEY_ONE}', {
            headers: { 'X-Auth': '{KEY_TWO}' },
          }),
        (err: Error) => {
          assert.match(err.message, /\{KEY_ONE\}/);
          assert.match(err.message, /\{KEY_TWO\}/);
          return true;
        },
      );
    });

    it('PHILONT_INJECTOR_RESIDUE_BLOCK=0 → warn-only 老行为', async () => {
      const orig = process.env.PHILONT_INJECTOR_RESIDUE_BLOCK;
      process.env.PHILONT_INJECTOR_RESIDUE_BLOCK = '0';
      try {
        const store = new SecretStore({ masterKey: MASTER_KEY });
        store.set('valid-key', 'real-value-1234567890');
        const f = createInjectingFetch(store);
        await f('https://api.example.com/', {
          headers: { 'Authorization': 'Bearer {totally-unknown-name}' },
        });
        assert.ok(lastCall);
        const h = lastCall!.init!.headers as Record<string, string>;
        assert.equal(h['Authorization'], 'Bearer {totally-unknown-name}');
      } finally {
        if (orig === undefined) delete process.env.PHILONT_INJECTOR_RESIDUE_BLOCK;
        else process.env.PHILONT_INJECTOR_RESIDUE_BLOCK = orig;
      }
    });

    it('SecretStore 空 → 错误提示 "call saveCredential first"', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      const f = createInjectingFetch(store);
      await assert.rejects(
        () =>
          f('https://api.example.com/', {
            headers: { 'Authorization': 'Bearer {anything}' },
          }),
        (err: Error) => {
          assert.match(err.message, /call saveCredential first/);
          return true;
        },
      );
    });

    // 2026-05-17 cont(实战 false positive):body 内的合法 `{...}` 不应触发 fail-fast
    it('body 含合法 `{template}` 字符 → 不 reject(实战 mycox 新帖正文 bug)', async () => {
      lastCall = null;
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('mycox-api-key', 'real-token-xyz789');
      const f = createInjectingFetch(store);
      // LLM POST 新帖,body 含正文模板字符(论文术语 / 引用),Authorization 用对了 cred
      await f('https://mycox.ai/api/posts', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer {mycox-api-key}' },
        body: '{"title":"On {cost-of-error} and {High-Status}","content":"all about {All}"}',
      });
      const captured = lastCall as { url: string; init?: RequestInit } | null;
      assert.ok(captured, '合法 body 模板字符 → 应正常发出 fetch');
      // 验证 header 注入了真实 token
      const h = captured!.init!.headers as Record<string, string>;
      assert.equal(h['Authorization'], 'Bearer real-token-xyz789');
    });

    it('headers 内错 placeholder + body 合法模板 → 仍 reject(只看 header typo)', async () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('valid-key', 'real-value');
      const f = createInjectingFetch(store);
      await assert.rejects(
        () =>
          f('https://api.example.com/', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer {Absorption}' },
            body: '{"text":"some {template} content"}',
          }),
        (err: Error) => {
          assert.match(err.message, /\{Absorption\}/);
          // 不应误把 body 里的 {template} 列进 error
          assert.doesNotMatch(err.message, /\{template\}/);
          return true;
        },
      );
    });
  });
});
