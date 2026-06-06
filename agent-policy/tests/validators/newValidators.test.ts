import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateLimitValidator,
  createUrlAllowlistValidator,
  createContentLengthValidator,
  createCommandAllowlistValidator,
  DEFAULT_SAFE_BINS,
  wrapToolWithOutputScan,
} from '../../src/validators/index.js';
import type { Tool } from '../../src/tools/types.js';

const mkCtx = (toolName: string, params: Record<string, unknown>) => ({
  toolName,
  params,
  classification: null,
});

describe('RateLimitValidator', () => {
  it('allows calls under limit', async () => {
    const v = createRateLimitValidator({ windowMs: 1000, maxCalls: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await v(mkCtx('x', {}));
      assert.equal(r.action, 'pass');
    }
  });

  it('denies when over limit', async () => {
    const v = createRateLimitValidator({ windowMs: 10_000, maxCalls: 2 });
    await v(mkCtx('x', {}));
    await v(mkCtx('x', {}));
    const r = await v(mkCtx('x', {}));
    assert.equal(r.action, 'deny');
    if (r.action === 'deny') assert.equal(r.code, 'RATE_LIMIT_EXCEEDED');
  });

  it('per-tool separate counters', async () => {
    const v = createRateLimitValidator({ windowMs: 10_000, maxCalls: 1 });
    await v(mkCtx('a', {}));
    const ra = await v(mkCtx('a', {}));
    const rb = await v(mkCtx('b', {})); // separate counter for b
    assert.equal(ra.action, 'deny');
    assert.equal(rb.action, 'pass');
  });

  it('exempt tools skip', async () => {
    const v = createRateLimitValidator({ maxCalls: 1, exempt: new Set(['ping']) });
    await v(mkCtx('ping', {}));
    const r = await v(mkCtx('ping', {}));
    assert.equal(r.action, 'pass');
  });
});

describe('UrlAllowlistValidator', () => {
  it('allows whitelisted host', async () => {
    const v = createUrlAllowlistValidator({ allowHosts: ['api.github.com'] });
    const r = await v(mkCtx('http', { url: 'https://api.github.com/user' }));
    assert.equal(r.action, 'pass');
  });

  it('blocks non-allowlisted host', async () => {
    const v = createUrlAllowlistValidator({ allowHosts: ['api.github.com'] });
    const r = await v(mkCtx('http', { url: 'https://evil.com/' }));
    assert.equal(r.action, 'deny');
  });

  it('supports wildcard subdomain', async () => {
    const v = createUrlAllowlistValidator({ allowHosts: ['*.example.com'] });
    assert.equal((await v(mkCtx('http', { url: 'https://a.example.com/' }))).action, 'pass');
    assert.equal((await v(mkCtx('http', { url: 'https://b.c.example.com/' }))).action, 'pass');
    // exact "example.com" does not match "*.example.com"
    assert.equal((await v(mkCtx('http', { url: 'https://example.com/' }))).action, 'deny');
  });

  it('path prefix enforcement', async () => {
    const v = createUrlAllowlistValidator({
      allowHosts: ['api.github.com'],
      allowPaths: { 'api.github.com': ['/user', '/repos'] },
    });
    assert.equal((await v(mkCtx('http', { url: 'https://api.github.com/user/x' }))).action, 'pass');
    assert.equal((await v(mkCtx('http', { url: 'https://api.github.com/admin' }))).action, 'deny');
  });

  it('requireHttps rejects http://', async () => {
    const v = createUrlAllowlistValidator({
      allowHosts: ['api.github.com'],
      requireHttps: true,
    });
    const r = await v(mkCtx('http', { url: 'http://api.github.com/' }));
    assert.equal(r.action, 'deny');
  });

  it('empty allowList passes through', async () => {
    const v = createUrlAllowlistValidator({ allowHosts: [] });
    const r = await v(mkCtx('http', { url: 'https://anywhere.com/' }));
    assert.equal(r.action, 'pass');
  });
});

describe('ContentLengthValidator', () => {
  it('allows normal size', async () => {
    const v = createContentLengthValidator();
    const r = await v(mkCtx('writeFile', { path: 'a.txt', content: 'hello' }));
    assert.equal(r.action, 'pass');
  });

  it('blocks huge total', async () => {
    const v = createContentLengthValidator({ maxTotalBytes: 1024 });
    const big = 'x'.repeat(2000);
    const r = await v(mkCtx('writeFile', { content: big }));
    assert.equal(r.action, 'deny');
    if (r.action === 'deny') assert.equal(r.code, 'CONTENT_LENGTH_TOTAL');
  });

  it('blocks huge field', async () => {
    const v = createContentLengthValidator({
      fieldMax: { command: 10 },
    });
    const r = await v(mkCtx('shell', { command: 'echo helloworld' }));
    assert.equal(r.action, 'deny');
    if (r.action === 'deny') assert.equal(r.code, 'CONTENT_LENGTH_FIELD');
  });

  it('default limits are sane', async () => {
    const v = createContentLengthValidator();
    const r1 = await v(mkCtx('shell', { command: 'x'.repeat(100 * 1024) }));
    assert.equal(r1.action, 'deny');
    const r2 = await v(mkCtx('shell', { command: 'ls -la' }));
    assert.equal(r2.action, 'pass');
  });
});

describe('CommandAllowlistValidator', () => {
  it('allows whitelisted bin', async () => {
    const v = createCommandAllowlistValidator({ allow: DEFAULT_SAFE_BINS });
    const r = await v(mkCtx('shell', { command: 'ls -la' }));
    assert.equal(r.action, 'pass');
  });

  it('blocks unknown bin', async () => {
    const v = createCommandAllowlistValidator({ allow: DEFAULT_SAFE_BINS });
    const r = await v(mkCtx('shell', { command: 'curl https://x.com' }));
    assert.equal(r.action, 'deny');
  });

  it('blocks shell metacharacters by default', async () => {
    const v = createCommandAllowlistValidator({ allow: DEFAULT_SAFE_BINS });
    const r = await v(mkCtx('shell', { command: 'ls | grep foo' }));
    assert.equal(r.action, 'deny');
  });

  it('denies blacklisted flags', async () => {
    const v = createCommandAllowlistValidator({ allow: DEFAULT_SAFE_BINS });
    const r = await v(mkCtx('shell', { command: 'find . -exec rm {}' }));
    assert.equal(r.action, 'deny');
  });

  it('respects maxArgs', async () => {
    const v = createCommandAllowlistValidator({
      allow: [{ bin: 'ls', maxArgs: 1 }],
    });
    const r = await v(mkCtx('shell', { command: 'ls a b c d' }));
    assert.equal(r.action, 'deny');
  });

  it('handles absolute paths', async () => {
    const v = createCommandAllowlistValidator({ allow: DEFAULT_SAFE_BINS });
    const r = await v(mkCtx('shell', { command: '/usr/bin/ls -la' }));
    assert.equal(r.action, 'pass');
  });
});

describe('OutputLeakDetector (wrapToolWithOutputScan)', () => {
  const mkTool = (output: string): Tool => ({
    name: 'fake',
    description: '',
    schema: {},
    capability: 'read',
    domain: 'local',
    async execute() {
      return { success: true, output };
    },
  });

  it('passes clean output', async () => {
    const t = wrapToolWithOutputScan(mkTool('hello world'));
    const r = await t.execute({});
    assert.equal(r.output, 'hello world');
    assert.equal(r.success, true);
  });

  it('replaces output when block pattern hits', async () => {
    const t = wrapToolWithOutputScan(mkTool('key=sk-' + 'a'.repeat(30)));
    const r = await t.execute({});
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('forbidden secrets'));
  });

  it('redacts output when mode=redact', async () => {
    const t = wrapToolWithOutputScan(mkTool('key=sk-' + 'a'.repeat(30)), { blockAction: 'redact' });
    const r = await t.execute({});
    assert.equal(r.success, true);
    assert.ok(r.output.includes('REDACTED'));
    assert.ok(!r.output.includes('sk-aaaaaaaaaaaa'));
  });

  it('redacts Bearer tokens', async () => {
    const t = wrapToolWithOutputScan(mkTool('resp: Bearer abcdefghij1234567890xyz'));
    const r = await t.execute({});
    assert.ok(r.output.includes('REDACTED'));
  });
});
