/**
 * WeChat AES-128-ECB 加解密单元测试。
 *
 * 不依赖外网,验证纯函数行为:
 *   - round-trip 一致性(任意 plaintext)
 *   - PKCS7 padding 边界(刚好 16 字节倍数 / 1 字节 / 33 字节)
 *   - 错 key 长度 → 抛明确异常
 *   - 错密文长度 → 抛明确异常
 *   - 错 key 解 → 抛 padding 错(node 'bad decrypt')
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  AES_BLOCK_SIZE,
  AES_KEY_SIZE,
  generateMediaKey,
  encryptMedia,
  decryptMedia,
  aesKeyToApiFormat,
  parseAesKey,
  pkcs7PaddedSize,
} from '../src/channels/wechat/crypto.js';

test('generateMediaKey 产出 16 字节,且每次随机', () => {
  const k1 = generateMediaKey();
  const k2 = generateMediaKey();
  assert.equal(k1.length, AES_KEY_SIZE);
  assert.equal(k2.length, AES_KEY_SIZE);
  assert.notEqual(k1.toString('hex'), k2.toString('hex'));
});

test('round-trip:任意 plaintext encrypt → decrypt 还原', () => {
  const key = generateMediaKey();
  for (const plain of [
    Buffer.from('hello'),
    Buffer.from(''),
    Buffer.from('a'.repeat(15)),                 // 1 字节差刚好满块
    Buffer.from('b'.repeat(16)),                 // 刚好满块(PKCS7 加 16 字节 padding)
    Buffer.from('c'.repeat(17)),                 // 跨块
    Buffer.from('中文混合 mixed 内容 ✓ 🎉', 'utf8'),
    randomBytes(1024),                           // 大块二进制
  ]) {
    const ct = encryptMedia(plain, key);
    const pt = decryptMedia(ct, key);
    assert.deepEqual(pt, plain, `failed for length ${plain.length}`);
  }
});

test('密文长度永远是 16 字节倍数', () => {
  const key = generateMediaKey();
  for (const len of [0, 1, 15, 16, 17, 31, 32, 33, 1023]) {
    const ct = encryptMedia(Buffer.alloc(len, 0xab), key);
    assert.equal(ct.length % AES_BLOCK_SIZE, 0, `len=${len} gave ct.length=${ct.length}`);
    // PKCS7 一定会加 padding(即使 plain 已经是块对齐),因此 ct.length > plain.length
    assert.ok(ct.length > len, `len=${len} ct should be strictly bigger after padding`);
  }
});

test('错 key 长度 (15 或 17) → 抛 invalid key length', () => {
  const plain = Buffer.from('test');
  assert.throws(
    () => encryptMedia(plain, Buffer.alloc(15)),
    /invalid key length/,
  );
  assert.throws(
    () => encryptMedia(plain, Buffer.alloc(17)),
    /invalid key length/,
  );
  assert.throws(
    () => decryptMedia(Buffer.alloc(16), Buffer.alloc(15)),
    /invalid key length/,
  );
});

test('错密文长度(非 16 倍数)→ 抛 invalid ciphertext length', () => {
  const key = generateMediaKey();
  assert.throws(
    () => decryptMedia(Buffer.alloc(0), key),
    /invalid ciphertext length/,
  );
  assert.throws(
    () => decryptMedia(Buffer.alloc(15), key),
    /invalid ciphertext length/,
  );
  assert.throws(
    () => decryptMedia(Buffer.alloc(31), key),
    /invalid ciphertext length/,
  );
});

test('错 key 解密 → 返回乱码不抛(permissive padding,与 hermes 一致)', () => {
  // 设计权衡:hermes 的 decrypt 是 permissive 的 —— padding 验证失败时
  // 不抛,而是把整个 padded 结果原样返回。理由:CDN 上的部分历史媒体并不
  // 严格 PKCS7,strict 模式会把本来能用的图也吞掉。
  // 这意味着错 key 表现是 "返回 garbage" 而不是 "抛错";caller 自己负责
  // 用 expected size / md5 / magic bytes 等手段判定结果有效。
  const k1 = generateMediaKey();
  const k2 = generateMediaKey();
  const plain = Buffer.from('secret payload');
  const ct = encryptMedia(plain, k1);
  const wrong = decryptMedia(ct, k2);
  assert.notEqual(wrong.toString('utf-8'), plain.toString('utf-8'), 'wrong key must not yield plaintext');
});

test('密钥不应在 encrypt/decrypt 间被修改(buffer 不可变)', () => {
  const key = generateMediaKey();
  const keyHexBefore = key.toString('hex');
  const ct = encryptMedia(Buffer.from('x'), key);
  decryptMedia(ct, key);
  assert.equal(key.toString('hex'), keyHexBefore, 'key buffer must not be mutated');
});

// 边界:确保 1024 字节随机 binary 也能 round-trip(模拟小图片)
test('1KB 随机 binary round-trip(模拟小媒体)', () => {
  const key = generateMediaKey();
  const plain = randomBytes(1024);
  const ct = encryptMedia(plain, key);
  const pt = decryptMedia(ct, key);
  assert.deepEqual(pt, plain);
});

// ── aes_key API 编码格式(防灰图)────────────────────────────────

test('aesKeyToApiFormat: 16 字节 key → base64(hex string),解出来仍是 16 字节', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const apiStr = aesKeyToApiFormat(key);
  // hermes 实测格式:base64 of 32-char hex string
  // hex = "00112233445566778899aabbccddeeff" (32 chars)
  // base64('00112233445566778899aabbccddeeff') = ...
  const decoded = Buffer.from(apiStr, 'base64');
  assert.equal(decoded.length, 32, 'decoded should be 32 ASCII bytes (hex string)');
  assert.equal(decoded.toString('ascii'), '00112233445566778899aabbccddeeff');
});

test('aesKeyToApiFormat: 错 key 长度抛错', () => {
  assert.throws(() => aesKeyToApiFormat(Buffer.alloc(15)), /invalid key length/);
});

test('parseAesKey: base64(hex) 格式还原(出向 round-trip)', () => {
  const orig = generateMediaKey();
  const apiStr = aesKeyToApiFormat(orig);
  const back = parseAesKey(apiStr);
  assert.deepEqual(back, orig);
});

test('parseAesKey: base64(raw 16 字节)格式也接受(入向兼容)', () => {
  const orig = generateMediaKey();
  const rawB64 = orig.toString('base64');
  const back = parseAesKey(rawB64);
  assert.deepEqual(back, orig);
});

test('parseAesKey: 不合法格式抛错', () => {
  assert.throws(() => parseAesKey(''), /must be non-empty/);
  // 8 字节 base64 → 不是 16 也不是 32
  assert.throws(() => parseAesKey(Buffer.alloc(8).toString('base64')), /unexpected aes_key format/);
});

// ── pkcs7PaddedSize ────────────────────────────────────────────

test('pkcs7PaddedSize: 0 → 16, 1 → 16, 15 → 16, 16 → 32, 17 → 32', () => {
  assert.equal(pkcs7PaddedSize(0), 16);
  assert.equal(pkcs7PaddedSize(1), 16);
  assert.equal(pkcs7PaddedSize(15), 16);
  assert.equal(pkcs7PaddedSize(16), 32, '刚好 16 倍数仍要 +16(标准 PKCS7)');
  assert.equal(pkcs7PaddedSize(17), 32);
  assert.equal(pkcs7PaddedSize(31), 32);
  assert.equal(pkcs7PaddedSize(32), 48);
});

test('pkcs7PaddedSize: 计算结果 == 实际 encryptMedia 输出长度', () => {
  const key = generateMediaKey();
  for (const size of [0, 1, 15, 16, 17, 100, 1024]) {
    const plain = randomBytes(size);
    const ct = encryptMedia(plain, key);
    assert.equal(ct.length, pkcs7PaddedSize(size), `mismatch at size=${size}`);
  }
});
