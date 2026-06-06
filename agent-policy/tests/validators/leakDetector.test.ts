import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLeakDetector,
  redactOutput,
  scanText,
  DEFAULT_LEAK_PATTERNS,
} from '../../src/validators/leakDetector.js';

const mkCtx = (params: Record<string, unknown>) => ({
  toolName: 'http',
  params,
  classification: null,
});

describe('LeakDetector', () => {
  it('blocks OpenAI key in params', async () => {
    const v = createLeakDetector();
    const r = await v(mkCtx({ body: 'my key is sk-abcdefghijklmnopqrstuvwxyz123456' }));
    assert.equal(r.action, 'deny');
    if (r.action === 'deny') assert.ok(r.reason.includes('openai_key'));
  });

  it('blocks AWS access key', async () => {
    const v = createLeakDetector();
    const r = await v(mkCtx({ body: 'AKIAIOSFODNN7EXAMPLE' }));
    assert.equal(r.action, 'deny');
  });

  it('blocks GitHub PAT', async () => {
    const v = createLeakDetector();
    // ghp_ + 36 alphanumeric
    const r = await v(mkCtx({ body: 'token=ghp_' + 'a'.repeat(36) }));
    assert.equal(r.action, 'deny');
  });

  it('blocks PEM private key', async () => {
    const v = createLeakDetector();
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...abc\n-----END RSA PRIVATE KEY-----';
    const r = await v(mkCtx({ body: pem }));
    assert.equal(r.action, 'deny');
  });

  it('redacts Bearer tokens', async () => {
    const v = createLeakDetector();
    const r = await v(mkCtx({
      headers: { Authorization: 'Bearer abc123xyz789verylongtokenhere' },
    }));
    assert.equal(r.action, 'mutate');
    if (r.action === 'mutate') {
      const h = (r.params as any).headers;
      assert.ok(!JSON.stringify(h).includes('abc123xyz789verylongtokenhere'));
      assert.ok(JSON.stringify(h).includes('REDACTED'));
    }
  });

  it('redacts JWT tokens', async () => {
    const v = createLeakDetector();
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_here_123';
    const r = await v(mkCtx({ body: jwt }));
    assert.equal(r.action, 'mutate');
  });

  it('passes clean text', async () => {
    const v = createLeakDetector();
    const r = await v(mkCtx({ body: 'hello world, normal text here' }));
    assert.equal(r.action, 'pass');
  });

  it('scans nested objects', async () => {
    const v = createLeakDetector();
    const r = await v(mkCtx({
      nested: { deep: { key: 'sk-abcdefghijklmnopqrstuvwxyz123456' } },
    }));
    assert.equal(r.action, 'deny');
  });

  it('scanText returns all hits', () => {
    const openai = 'sk-' + 'a'.repeat(30);
    const ghp = 'ghp_' + 'b'.repeat(36);
    const hits = scanText(`${openai} and ${ghp}`);
    assert.ok(hits.length >= 2);
    const ids = hits.map(h => h.patternId);
    assert.ok(ids.includes('openai_key'));
    assert.ok(ids.includes('github_pat'));
  });

  it('redactOutput replaces secrets with [REDACTED]', () => {
    const input = 'key=sk-abcdefghijklmnopqrstuvwxyz123456 end';
    const out = redactOutput(input);
    assert.ok(!out.includes('sk-abcdefghij'));
    assert.ok(out.includes('REDACTED'));
  });

  it('action overrides work', async () => {
    const v = createLeakDetector({
      actionOverrides: { openai_key: 'warn' },
    });
    const r = await v(mkCtx({ body: 'sk-abcdefghijklmnopqrstuvwxyz123456' }));
    assert.equal(r.action, 'pass'); // warn doesn't block
  });
});
