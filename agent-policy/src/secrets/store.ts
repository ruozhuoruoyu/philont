/**
 * SecretStore — encrypted credential storage
 *
 * Security model:
 *   - Master key comes from environment variable `PHILONT_MASTER_KEY` (base64, 32 bytes),
 *     or is generated and saved to `~/.philont/secret.key` (mode 0600)
 *   - Each secret is encrypted with AES-256-GCM (unique nonce + auth tag)
 *   - Disk persistence is optional (enabled when a path is provided)
 *   - Stored in encrypted form in memory; decrypted on get() to minimise plaintext dwell time
 *
 * Threat model:
 *   - Disk read → still requires the master key to decrypt
 *   - Process memory dump → plaintext briefly visible (an inherent limit of all memory-access attacks)
 *   - Malicious plugin / tool code → cannot obtain plaintext without calling SecretStore.get
 *     (env vars readable via `process.env.*` are outside this protection scope — see WASM sandbox)
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const KEY_LEN = 32;      // AES-256
const NONCE_LEN = 12;    // GCM recommended nonce length
const TAG_LEN = 16;      // GCM auth tag length

interface EncryptedBlob {
  /** base64-encoded ciphertext */
  ciphertext: string;
  /** base64-encoded nonce */
  nonce: string;
  /** base64-encoded auth tag */
  tag: string;
}

export interface SecretStoreOptions {
  /**
   * Master key: 32-byte base64 string.
   * If omitted, read from env PHILONT_MASTER_KEY; otherwise read from or generate
   * ~/.philont/secret.key.
   */
  masterKey?: string;
  /** Persistence path; in-memory only when omitted */
  path?: string;
  /** Master key file path (default ~/.philont/secret.key) */
  keyFilePath?: string;
}

/** Resolve the master key in priority order: option > env > key file > generate */
function resolveMasterKey(opts: SecretStoreOptions): Buffer {
  if (opts.masterKey) {
    const buf = Buffer.from(opts.masterKey, 'base64');
    if (buf.length !== KEY_LEN) throw new Error(`masterKey must be ${KEY_LEN} bytes base64`);
    return buf;
  }

  const fromEnv = process.env.PHILONT_MASTER_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length === KEY_LEN) return buf;
    // If not 32 bytes, stretch with scrypt (simple key derivation)
    return scryptSync(fromEnv, 'philont-v1', KEY_LEN);
  }

  const keyPath = opts.keyFilePath ?? `${homedir()}/.philont/secret.key`;
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, 'utf-8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === KEY_LEN) return buf;
  }

  // Generate a new key
  const generated = randomBytes(KEY_LEN);
  try {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, generated.toString('base64'), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  } catch {
    // Failure to write the file is not fatal: the key can still be used in-memory
  }
  return generated;
}

/** AES-256-GCM encryption */
function encryptValue(key: Buffer, plaintext: string): EncryptedBlob {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptValue(key: Buffer, blob: EncryptedBlob): string {
  const nonce = Buffer.from(blob.nonce, 'base64');
  const ct = Buffer.from(blob.ciphertext, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf-8');
}

export class SecretStore {
  private readonly masterKey: Buffer;
  private readonly path?: string;
  private data: Record<string, EncryptedBlob> = {};

  constructor(options: SecretStoreOptions = {}) {
    this.masterKey = resolveMasterKey(options);
    this.path = options.path;
    if (this.path && existsSync(this.path)) {
      try {
        const raw = readFileSync(this.path, 'utf-8');
        this.data = JSON.parse(raw) as Record<string, EncryptedBlob>;
      } catch {
        this.data = {};
      }
    }
  }

  /** Write a secret entry (overwrites any existing entry with the same id) */
  set(id: string, value: string): void {
    this.data[id] = encryptValue(this.masterKey, value);
    this.persist();
  }

  /**
   * Read the plaintext value (host-only API, must not be exposed to tool code)
   * @returns plaintext value, or undefined if the id does not exist
   */
  get(id: string): string | undefined {
    const blob = this.data[id];
    if (!blob) return undefined;
    try {
      return decryptValue(this.masterKey, blob);
    } catch {
      return undefined;
    }
  }

  /** Check whether the id exists (does not expose the value) */
  has(id: string): boolean {
    return id in this.data;
  }

  /** List all secret IDs (does not expose values) */
  list(): string[] {
    return Object.keys(this.data);
  }

  /** Delete one entry */
  delete(id: string): boolean {
    if (!(id in this.data)) return false;
    delete this.data[id];
    this.persist();
    return true;
  }

  /** Clear all secrets (for testing / key rotation) */
  clear(): void {
    this.data = {};
    this.persist();
  }

  /**
   * Scan text to see whether it contains the prefix of a stored secret (but not
   * the full value).
   *
   * Purpose: the LLM should never splice a secret prefix directly into an outbound
   * request as if it were the full key; the full value must travel via the
   * `{<id>}` placeholder so the injector can substitute it.  The LLM tends to
   * splice a prefix because it read something like `api_key_prefix: "mycox_9ffea9"`
   * from a fact source and mistook it for the complete key.  This method scans at
   * the outbound entry point; a hit means the LLM used the credential incorrectly.
   *
   * A full value appearing alongside (because it was legitimately injected) is not
   * a hit — that is the result of placeholder substitution and is legitimate.
   *
   * Prefix length strategy: min(12, len/3), and must be ≥ 6 characters (to avoid
   * false positives on short random strings).  Secrets shorter than 18 characters
   * are skipped entirely — the prefix would be too short to be reliable.
   */
  detectPrefixLeak(text: string): Array<{ id: string; prefix: string }> {
    if (typeof text !== 'string' || text.length === 0) return [];
    const hits: Array<{ id: string; prefix: string }> = [];
    for (const id of Object.keys(this.data)) {
      const value = this.get(id);
      if (!value) continue;
      const prefixLen = Math.min(12, Math.floor(value.length / 3));
      if (prefixLen < 6) continue;
      const prefix = value.slice(0, prefixLen);
      if (text.includes(prefix) && !text.includes(value)) {
        hits.push({ id, prefix });
      }
    }
    return hits;
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch {
      // Persistence failure does not affect in-memory operations
    }
  }
}
