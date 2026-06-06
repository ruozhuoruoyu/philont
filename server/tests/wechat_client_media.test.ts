/**
 * iLink 媒体收发(downloadMedia / uploadAndSendMedia / sendItems)单元测试。
 *
 * 全 fetch 注入,无外网。验证:
 *   - downloadMedia 走 encrypt_query_param vs full_url 两条路径,有 aes_key 时解密
 *   - SSRF 防护:full_url 必须命中 host allowlist
 *   - uploadAndSendMedia 完整 3 步流程(getuploadurl → CDN POST → sendmessage)
 *   - aes_key 字段用 base64(hex) 编码(防灰图)
 *   - x-encrypted-param 响应头被正确取用
 *   - upload_full_url vs upload_param 两种 server 形态
 *   - file/image/video/voice 的 item 形状与 hermes 一致
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ILinkClient,
  ILINK_DEFAULT_CDN_BASE_URL,
  MEDIA_IMAGE,
  MEDIA_FILE,
  MEDIA_VIDEO,
  MEDIA_VOICE,
  ITEM_IMAGE,
  ITEM_FILE,
  ITEM_VIDEO,
  ITEM_VOICE,
  assertWeixinCdnUrl,
  buildOutboundMediaItem,
  type FetchLike,
  type MediaRef,
} from '../src/channels/wechat/client.js';
import {
  aesKeyToApiFormat,
  encryptMedia,
  generateMediaKey,
  parseAesKey,
} from '../src/channels/wechat/crypto.js';

interface QueuedResp {
  status?: number;
  body?: any;
  bodyBytes?: Buffer;
  headers?: Record<string, string>;
}

/** 多端点共用的 mock fetch:按 URL pattern 路由响应队列 */
function makeRoutedFetch(): FetchLike & {
  on(matcher: (url: string) => boolean, ...resps: QueuedResp[]): void;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const routes: Array<{ matcher: (u: string) => boolean; queue: QueuedResp[] }> = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    for (const r of routes) {
      if (r.matcher(url) && r.queue.length > 0) {
        const next = r.queue.shift()!;
        const status = next.status ?? 200;
        const headers = next.headers ?? {};
        if (next.bodyBytes !== undefined) {
          return new Response(next.bodyBytes, { status, headers });
        }
        return new Response(JSON.stringify(next.body ?? {}), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        });
      }
    }
    throw new Error(`mock fetch: no route matches ${url}`);
  };
  (fn as any).on = (matcher: (u: string) => boolean, ...resps: QueuedResp[]) => {
    routes.push({ matcher, queue: [...resps] });
  };
  (fn as any).calls = calls;
  return fn as any;
}

// ── SSRF / URL helpers ────────────────────────────────────────────

test('assertWeixinCdnUrl: 命中 allowlist 通过', () => {
  assertWeixinCdnUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1');
  assertWeixinCdnUrl('https://wx.qlogo.cn/x/y');
});

test('assertWeixinCdnUrl: 不在 allowlist 抛错', () => {
  assert.throws(() => assertWeixinCdnUrl('https://evil.example.com/x'), /not in allowlist/);
  assert.throws(() => assertWeixinCdnUrl('https://novac2c.cdn.weixin.qq.com.evil.com/x'), /not in allowlist/);
});

test('assertWeixinCdnUrl: 非 http/https 协议拒绝', () => {
  assert.throws(
    () => assertWeixinCdnUrl('file:///etc/passwd'),
    /protocol disallowed/,
  );
});

// ── downloadMedia ─────────────────────────────────────────────────

test('downloadMedia: encrypt_query_param 路径 + 解密', async () => {
  const fetch = makeRoutedFetch();
  const key = generateMediaKey();
  const plain = Buffer.from('hello image');
  const ct = encryptMedia(plain, key);

  fetch.on(
    (u) => u.includes('/c2c/download') && u.includes('encrypted_query_param='),
    { bodyBytes: ct, headers: { 'content-type': 'application/octet-stream' } },
  );

  const c = new ILinkClient({ fetch });
  const got = await c.downloadMedia({
    encrypt_query_param: 'opaque-token',
    aes_key: aesKeyToApiFormat(key),
  });
  assert.deepEqual(got, plain);
  // URL 含 cdn 默认 base + encoded query param
  assert.ok(fetch.calls[0].url.startsWith(ILINK_DEFAULT_CDN_BASE_URL + '/download?'));
  assert.ok(fetch.calls[0].url.includes('opaque-token'));
});

test('downloadMedia: full_url 路径(白名单 host)+ 解密', async () => {
  const fetch = makeRoutedFetch();
  const key = generateMediaKey();
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]); // jpeg-ish magic
  const ct = encryptMedia(plain, key);

  fetch.on((u) => u.startsWith('https://wx.qlogo.cn/'), { bodyBytes: ct });

  const c = new ILinkClient({ fetch });
  const got = await c.downloadMedia({
    full_url: 'https://wx.qlogo.cn/path/to/img',
    aes_key: aesKeyToApiFormat(key),
  });
  assert.deepEqual(got, plain);
});

test('downloadMedia: full_url 命中非白名单 → 拒绝(SSRF)', async () => {
  const fetch = makeRoutedFetch();
  const c = new ILinkClient({ fetch });
  await assert.rejects(
    () => c.downloadMedia({ full_url: 'http://evil.com/x' }),
    /not in allowlist/,
  );
  // 没有 fetch 被调,纯前置拦截
  assert.equal(fetch.calls.length, 0);
});

test('downloadMedia: 缺 aes_key → 原样返回密文(server 偶有不加密小图)', async () => {
  const fetch = makeRoutedFetch();
  const raw = Buffer.from('plain bytes no aes');
  fetch.on((u) => u.includes('/c2c/download'), { bodyBytes: raw });
  const c = new ILinkClient({ fetch });
  const got = await c.downloadMedia({ encrypt_query_param: 'tok' });
  assert.deepEqual(got, raw);
});

test('downloadMedia: 既无 encrypt_query_param 也无 full_url 抛错', async () => {
  const c = new ILinkClient({ fetch: makeRoutedFetch() });
  await assert.rejects(() => c.downloadMedia({}), /neither encrypt_query_param nor full_url/);
});

// ── buildOutboundMediaItem ────────────────────────────────────────

test('buildOutboundMediaItem: image item 形状(hermes 兼容)', () => {
  const m: MediaRef = { encrypt_query_param: 'p', aes_key: 'k', encrypt_type: 1 };
  const item = buildOutboundMediaItem({
    mediaType: MEDIA_IMAGE,
    mediaField: m,
    paddedSize: 32,
    rawSize: 20,
    md5Hex: 'abc',
  });
  assert.equal(item.type, ITEM_IMAGE);
  assert.deepEqual((item as any).image_item.media, m);
  assert.equal((item as any).image_item.mid_size, 32);
});

test('buildOutboundMediaItem: file item 必须给 fileName + len 是 string', () => {
  const m: MediaRef = { encrypt_query_param: 'p', aes_key: 'k', encrypt_type: 1 };
  assert.throws(() =>
    buildOutboundMediaItem({
      mediaType: MEDIA_FILE,
      mediaField: m,
      paddedSize: 32,
      rawSize: 20,
      md5Hex: 'abc',
    }),
  /requires fileName/,
  );
  const item = buildOutboundMediaItem({
    mediaType: MEDIA_FILE,
    mediaField: m,
    paddedSize: 32,
    rawSize: 20,
    md5Hex: 'abc',
    fileName: 'a.pdf',
  });
  assert.equal(item.type, ITEM_FILE);
  assert.equal((item as any).file_item.file_name, 'a.pdf');
  assert.equal((item as any).file_item.len, '20', 'len 是 string,不是 number');
});

test('buildOutboundMediaItem: video item 含 video_md5', () => {
  const m: MediaRef = { encrypt_query_param: 'p', aes_key: 'k', encrypt_type: 1 };
  const item = buildOutboundMediaItem({
    mediaType: MEDIA_VIDEO,
    mediaField: m,
    paddedSize: 64,
    rawSize: 50,
    md5Hex: 'video-md5',
  });
  assert.equal(item.type, ITEM_VIDEO);
  assert.equal((item as any).video_item.video_md5, 'video-md5');
  assert.equal((item as any).video_item.video_size, 64);
});

test('buildOutboundMediaItem: voice item 含 silk 编码默认参数', () => {
  const m: MediaRef = { encrypt_query_param: 'p', aes_key: 'k', encrypt_type: 1 };
  const item = buildOutboundMediaItem({
    mediaType: MEDIA_VOICE,
    mediaField: m,
    paddedSize: 32,
    rawSize: 20,
    md5Hex: 'abc',
  });
  assert.equal(item.type, ITEM_VOICE);
  const voi = (item as any).voice_item;
  assert.equal(voi.encode_type, 6);
  assert.equal(voi.bits_per_sample, 16);
  assert.equal(voi.sample_rate, 24000);
});

// ── uploadAndSendMedia 完整流程 ──────────────────────────────────

test('uploadAndSendMedia: image 完整 3 步流程(getuploadurl + CDN POST + sendmessage)', async () => {
  const fetch = makeRoutedFetch();
  // step 1: getuploadurl 返回 upload_full_url
  fetch.on(
    (u) => u.includes('ilink/bot/getuploadurl'),
    { body: { ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?xxx' } },
  );
  // step 2: CDN POST 返回 x-encrypted-param 头
  fetch.on(
    (u) => u.includes('/c2c/upload'),
    { headers: { 'x-encrypted-param': 'enc-token-from-cdn' } },
  );
  // step 3: sendmessage
  fetch.on(
    (u) => u.endsWith('ilink/bot/sendmessage'),
    { body: { ret: 0, message_id: 'sent-1' } },
  );

  const c = new ILinkClient({ token: 'tok', fetch });
  const plain = Buffer.from('FAKEIMAGEBYTES');
  const r = await c.uploadAndSendMedia('user-x', MEDIA_IMAGE, plain);
  assert.equal(r.ret, 0);
  assert.equal(r.message_id, 'sent-1');

  // 验 step 1 body 形状
  const upBody = JSON.parse((fetch.calls[0].init.body as string));
  assert.equal(upBody.media_type, MEDIA_IMAGE);
  assert.equal(upBody.to_user_id, 'user-x');
  assert.equal(upBody.rawsize, plain.length);
  assert.equal(typeof upBody.aeskey, 'string');
  assert.equal(upBody.aeskey.length, 32, 'aeskey 走 hex(32 字符)');
  assert.equal(upBody.no_need_thumb, true);

  // 验 step 2 是 POST + octet-stream + 密文 body 长度 = padded
  assert.equal(fetch.calls[1].init.method, 'POST');
  assert.equal((fetch.calls[1].init.headers as any)['Content-Type'], 'application/octet-stream');

  // 验 step 3 sendmessage body 含 image_item.media,且 aes_key 是 base64(hex)
  const sendBody = JSON.parse((fetch.calls[2].init.body as string));
  const item = sendBody.msg.item_list[0];
  assert.equal(item.type, ITEM_IMAGE);
  assert.equal(item.image_item.media.encrypt_query_param, 'enc-token-from-cdn');
  assert.equal(item.image_item.media.encrypt_type, 1);
  // aes_key 必须是 base64(hex_string),解码后是 32 字节 ASCII
  const decodedAes = Buffer.from(item.image_item.media.aes_key, 'base64');
  assert.equal(decodedAes.length, 32, 'aes_key 必须是 base64(hex);否则接收方灰图');
  // 而且解 hex 后回到 16 字节
  assert.equal(parseAesKey(item.image_item.media.aes_key).length, 16);
});

test('uploadAndSendMedia: upload_param 形态 → caller 自己拼 CDN URL', async () => {
  const fetch = makeRoutedFetch();
  fetch.on(
    (u) => u.includes('ilink/bot/getuploadurl'),
    { body: { ret: 0, upload_param: 'param-from-server' } },
  );
  let capturedUploadUrl = '';
  fetch.on(
    (u) => u.includes('/c2c/upload'),
    { headers: { 'x-encrypted-param': 'enc' } },
  );
  fetch.on(
    (u) => u.endsWith('ilink/bot/sendmessage'),
    { body: { ret: 0, message_id: 'm' } },
  );

  const c = new ILinkClient({ token: 't', fetch });
  await c.uploadAndSendMedia('u', MEDIA_IMAGE, Buffer.from('x'));
  capturedUploadUrl = fetch.calls[1].url;
  assert.ok(capturedUploadUrl.startsWith(ILINK_DEFAULT_CDN_BASE_URL + '/upload'));
  assert.ok(capturedUploadUrl.includes('encrypted_query_param=param-from-server'));
  assert.ok(capturedUploadUrl.includes('filekey='));
});

test('uploadAndSendMedia: file 必须给 fileName,否则前置拒', async () => {
  const c = new ILinkClient({ token: 't', fetch: makeRoutedFetch() });
  await assert.rejects(
    () => c.uploadAndSendMedia('u', MEDIA_FILE, Buffer.from('x')),
    /requires opts.fileName/,
  );
});

test('uploadAndSendMedia: getuploadurl 失败 → 抛错带 ret/errmsg', async () => {
  const fetch = makeRoutedFetch();
  fetch.on(
    (u) => u.includes('ilink/bot/getuploadurl'),
    { body: { ret: -1, errmsg: 'quota' } },
  );
  const c = new ILinkClient({ token: 't', fetch });
  await assert.rejects(
    () => c.uploadAndSendMedia('u', MEDIA_IMAGE, Buffer.from('x')),
    /getuploadurl failed ret=-1.*quota/,
  );
});

test('uploadAndSendMedia: CDN 响应少 x-encrypted-param 头 → 抛错', async () => {
  const fetch = makeRoutedFetch();
  fetch.on(
    (u) => u.includes('ilink/bot/getuploadurl'),
    { body: { ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?x' } },
  );
  fetch.on(
    (u) => u.includes('/c2c/upload'),
    { headers: {} /* 故意不给 */ },
  );
  const c = new ILinkClient({ token: 't', fetch });
  await assert.rejects(
    () => c.uploadAndSendMedia('u', MEDIA_IMAGE, Buffer.from('x')),
    /missing x-encrypted-param header/,
  );
});

test('sendItems: 通用接口可直接发任意 item_list', async () => {
  const fetch = makeRoutedFetch();
  fetch.on((u) => u.endsWith('ilink/bot/sendmessage'), { body: { ret: 0, message_id: 'm' } });
  const c = new ILinkClient({ token: 't', fetch });
  const r = await c.sendItems('u', [
    { type: 1, text_item: { text: 'hi' } } as any,
    { type: 1, text_item: { text: 'two' } } as any,
  ]);
  assert.equal(r.ret, 0);
  const body = JSON.parse((fetch.calls[0].init.body as string));
  assert.equal(body.msg.item_list.length, 2);
});
