/**
 * WeChat (iLink Bot) media encryption layer — AES-128-ECB + PKCS7 padding
 *
 * Protocol elements (reference: hermes-agent weixin adapter public docs):
 *   - Before uploading media, generate a 16-byte random AES-128 key
 *   - Encrypt the media byte stream with that key using ECB + PKCS7
 *   - PUT the ciphertext to https://novac2c.cdn.weixin.qq.com/c2c
 *   - The key itself is sent back to the owner via the iLink Bot API (TLS-protected)
 *     alongside the message metadata
 *   - When receiving media, perform the reverse decryption
 *
 * Design discipline:
 *   - Pure functions, no IO, easy to unit-test
 *   - No third-party crypto libraries; only node:crypto
 *   - Wrong key / wrong padding throws clear exceptions so callers can branch
 *   - **Never expose raw keys to logs** — callers are responsible for keeping keys
 *     out of audit logs / console output
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-128 block size / key length, both 16 bytes (128 bits). */
export const AES_BLOCK_SIZE = 16;
export const AES_KEY_SIZE = 16;

/**
 * Generate a 16-byte random key (single-use per message).
 *
 * Uses node:crypto's CSPRNG. Each media message gets an independent key
 * so that compromising one does not affect others.
 */
export function generateMediaKey(): Buffer {
  return randomBytes(AES_KEY_SIZE);
}

/**
 * AES-128-ECB + PKCS7 encryption.
 *
 * @param plaintext  Raw byte stream (media binary)
 * @param key        16-byte key
 * @returns          Ciphertext byte stream (length = ⌈plaintext.length / 16⌉ * 16)
 * @throws           Error('invalid key length') if key !== 16 bytes
 */
export function encryptMedia(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== AES_KEY_SIZE) {
    throw new Error(`invalid key length: expected ${AES_KEY_SIZE}, got ${key.length}`);
  }
  // ECB does not use an IV; node's API requires null
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true); // PKCS7 is on by default
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * AES-128-ECB + PKCS7 decryption (lenient variant, consistent with hermes).
 *
 * Does not use node's built-in setAutoPadding — that throws 'bad decrypt' on
 * invalid padding. Some media on the iLink CDN does not strictly conform to PKCS7
 * (it may be pre-truncated or zero-padded). The hermes approach is: check whether
 * the last byte is a valid PKCS7 pad value; if yes, strip it; otherwise return the
 * full decrypted result as-is. This policy is replicated here to avoid discarding
 * images that would otherwise be usable.
 *
 * @param ciphertext  Ciphertext byte stream (length must be a multiple of 16)
 * @param key         16-byte key
 * @returns           Raw byte stream
 * @throws            Error if key length is wrong or ciphertext length is not a block multiple
 */
export function decryptMedia(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== AES_KEY_SIZE) {
    throw new Error(`invalid key length: expected ${AES_KEY_SIZE}, got ${key.length}`);
  }
  if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK_SIZE !== 0) {
    throw new Error(
      `invalid ciphertext length: must be non-empty multiple of ${AES_BLOCK_SIZE}, got ${ciphertext.length}`,
    );
  }
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false); // disable auto-unpad; check the last byte manually
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (padded.length === 0) return padded;
  const padLen = padded[padded.length - 1];
  if (padLen >= 1 && padLen <= AES_BLOCK_SIZE) {
    // Tail should have padLen identical bytes (standard PKCS7)
    let valid = true;
    for (let i = padded.length - padLen; i < padded.length; i++) {
      if (padded[i] !== padLen) {
        valid = false;
        break;
      }
    }
    if (valid) return padded.subarray(0, padded.length - padLen);
  }
  return padded;
}

/**
 * Encode a 16-byte key into the `aes_key` field format expected by the iLink server.
 *
 * **Critical**: the server expects `base64(hex_string)` **not** `base64(raw_bytes)`.
 * That is: convert the key to a 32-character hex string first, then base64-encode
 * the ASCII bytes of that hex string.
 * Using the wrong format will not cause a server error, but the receiving side will
 * produce garbled output during decryption, which shows up as a grey image in WeChat.
 *
 * Reference: hermes weixin.py aes_key encoding note.
 */
export function aesKeyToApiFormat(key: Buffer): string {
  if (key.length !== AES_KEY_SIZE) {
    throw new Error(`invalid key length: expected ${AES_KEY_SIZE}, got ${key.length}`);
  }
  return Buffer.from(key.toString('hex'), 'ascii').toString('base64');
}

/**
 * Parse the raw 16-byte key from the `aes_key` field of an iLink inbound message.
 *
 * Compatible with two server shapes (see hermes _parse_aes_key):
 *   1. base64(raw 16 bytes) → decode to 16 bytes and use directly
 *   2. base64(32-char hex string) → decode to 32 ASCII bytes, then hex-decode to 16 bytes
 *
 * Both variants have been observed in production; inbound compatibility is handled here.
 */
export function parseAesKey(apiAesKey: string): Buffer {
  if (typeof apiAesKey !== 'string' || apiAesKey.length === 0) {
    throw new Error('aes_key must be non-empty string');
  }
  const decoded = Buffer.from(apiAesKey, 'base64');
  if (decoded.length === AES_KEY_SIZE) return decoded;
  if (decoded.length === AES_KEY_SIZE * 2) {
    const text = decoded.toString('ascii');
    if (/^[0-9a-fA-F]+$/.test(text)) {
      return Buffer.from(text, 'hex');
    }
  }
  throw new Error(`unexpected aes_key format (${decoded.length} decoded bytes)`);
}

/**
 * Compute the byte length after PKCS7 padding.
 *
 * **Critical** — kept consistent with hermes: `((size + 1 + 15) // 16) * 16`.
 * The +1 ensures that inputs whose length is already an exact multiple of 16 still
 * get a full extra block of padding (standard PKCS7 behaviour).
 * The uploadurl endpoint requires `filesize` to be this value; the server uses it
 * for quota checking.
 */
export function pkcs7PaddedSize(rawSize: number): number {
  if (!Number.isInteger(rawSize) || rawSize < 0) {
    throw new Error(`pkcs7PaddedSize: rawSize must be non-negative int, got ${rawSize}`);
  }
  return Math.ceil((rawSize + 1) / AES_BLOCK_SIZE) * AES_BLOCK_SIZE;
}
