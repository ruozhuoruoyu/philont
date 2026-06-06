import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore } from '../../src/secrets/store.js';

const TMP = mkdtempSync(join(tmpdir(), 'philont-secrets-'));
const KEY_FILE = join(TMP, 'key');
const STORE_FILE = join(TMP, 'secrets.json');
const MASTER_KEY = Buffer.alloc(32, 'a').toString('base64');

describe('SecretStore', () => {
  after(() => rmSync(TMP, { recursive: true, force: true }));

  it('set/get roundtrip in memory', () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('API_KEY', 'secret-value-123');
    assert.equal(store.get('API_KEY'), 'secret-value-123');
  });

  it('has() does not expose value', () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('T', 'x');
    assert.equal(store.has('T'), true);
    assert.equal(store.has('MISSING'), false);
  });

  it('list() returns only IDs', () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('A', 'foo');
    store.set('B', 'bar');
    const ids = store.list().sort();
    assert.deepEqual(ids, ['A', 'B']);
  });

  it('delete removes entry', () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('X', 'val');
    assert.equal(store.delete('X'), true);
    assert.equal(store.has('X'), false);
    assert.equal(store.delete('MISSING'), false);
  });

  it('persists to disk with 0600 mode', () => {
    const store = new SecretStore({ masterKey: MASTER_KEY, path: STORE_FILE });
    store.set('PERSIST_KEY', 'persist-value');
    assert.ok(existsSync(STORE_FILE));
    const mode = statSync(STORE_FILE).mode & 0o777;
    assert.equal(mode, 0o600);

    // Disk content should not include plaintext
    const raw = readFileSync(STORE_FILE, 'utf-8');
    assert.ok(!raw.includes('persist-value'));
  });

  it('reads persisted file on reopen', () => {
    const store1 = new SecretStore({ masterKey: MASTER_KEY, path: STORE_FILE });
    store1.set('REOPEN_KEY', 'reopen-value');
    const store2 = new SecretStore({ masterKey: MASTER_KEY, path: STORE_FILE });
    assert.equal(store2.get('REOPEN_KEY'), 'reopen-value');
  });

  it('wrong master key fails to decrypt (returns undefined)', () => {
    const store1 = new SecretStore({ masterKey: MASTER_KEY, path: join(TMP, 'bad.json') });
    store1.set('K', 'v');

    const differentKey = Buffer.alloc(32, 'b').toString('base64');
    const store2 = new SecretStore({ masterKey: differentKey, path: join(TMP, 'bad.json') });
    assert.equal(store2.get('K'), undefined);
  });

  it('generates key file when none provided', () => {
    delete process.env.PHILONT_MASTER_KEY;
    const store = new SecretStore({ keyFilePath: KEY_FILE });
    store.set('X', 'y');
    assert.ok(existsSync(KEY_FILE));
    const mode = statSync(KEY_FILE).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(store.get('X'), 'y');
  });

  it('clear removes all', () => {
    const store = new SecretStore({ masterKey: MASTER_KEY });
    store.set('A', '1');
    store.set('B', '2');
    store.clear();
    assert.deepEqual(store.list(), []);
  });

  describe('detectPrefixLeak', () => {
    it('hits when text contains secret prefix but not full value', () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      // value length=30, prefixLen=min(12, floor(30/3))=10, prefix='mycox_9ffe'
      store.set('mycox-api-key', 'mycox_9ffea9ab12cd34ef56789012');
      const text = 'Authorization: Bearer mycox_9ffea9';   // text 含 'mycox_9ffe' 子串
      const hits = store.detectPrefixLeak(text);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, 'mycox-api-key');
      assert.equal(hits[0].prefix, 'mycox_9ffe');
    });

    it('does NOT hit when full value is in text (placeholder already replaced)', () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('mycox-api-key', 'mycox_9ffea9ab12cd34ef56789012');
      const text = 'Authorization: Bearer mycox_9ffea9ab12cd34ef56789012';  // 完整值
      assert.deepEqual(store.detectPrefixLeak(text), []);
    });

    it('skips short secrets (< 18 chars, prefixLen < 6)', () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('short', 'abc12345');  // 8 chars → prefixLen = floor(8/3) = 2 < 6 → skip
      const text = 'Authorization: Bearer abc12345';
      assert.deepEqual(store.detectPrefixLeak(text), []);
    });

    it('empty/non-string text returns []', () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('k', 'mycox_9ffea9abcdef0123456789');
      assert.deepEqual(store.detectPrefixLeak(''), []);
      assert.deepEqual(store.detectPrefixLeak(null as unknown as string), []);
    });

    it('multi-secret hits ordered by store iteration', () => {
      const store = new SecretStore({ masterKey: MASTER_KEY });
      store.set('alpha-key', 'alpha_abcdef123456789012345');
      store.set('beta-key', 'beta_zyxwvu98765432109876');
      const text = 'A=alpha_abcdef B=beta_zyxwv';
      const hits = store.detectPrefixLeak(text);
      assert.equal(hits.length, 2);
      assert.ok(hits.find(h => h.id === 'alpha-key'));
      assert.ok(hits.find(h => h.id === 'beta-key'));
    });
  });
});
