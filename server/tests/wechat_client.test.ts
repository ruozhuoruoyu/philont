/**
 * iLink HTTP client 单元测试。fetch 注入,无外网。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ILinkClient,
  ILINK_DEFAULT_BASE_URL,
  ILINK_CHANNEL_VERSION,
  ITEM_TEXT,
  ITEM_IMAGE,
  ITEM_FILE,
  extractTextFromInbound,
  inboundIsGroup,
  inboundGroupId,
  type FetchLike,
  type InboundMessage,
} from '../src/channels/wechat/client.js';

/** 记录每次请求 + 用栈式 response 序列回放 */
function makeMockFetch(responses: Array<{ status?: number; body: any }>): FetchLike & {
  calls: Array<{ url: string; init: RequestInit; bodyJson: any }>;
} {
  const calls: Array<{ url: string; init: RequestInit; bodyJson: any }> = [];
  const queue = [...responses];
  const fn: FetchLike = async (url, init) => {
    const bodyStr = typeof init.body === 'string' ? init.body : '';
    let bodyJson: any = null;
    try {
      bodyJson = bodyStr ? JSON.parse(bodyStr) : null;
    } catch {
      /* ignore */
    }
    calls.push({ url, init, bodyJson });
    const next = queue.shift();
    if (!next) throw new Error('mock fetch: no more queued responses');
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  (fn as any).calls = calls;
  return fn as FetchLike & typeof fn & { calls: typeof calls };
}

test('client: getUpdates body 含 get_updates_buf + base_info', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0, msgs: [], get_updates_buf: 'cursor1' } }]);
  const c = new ILinkClient({ baseUrl: 'https://example.com', token: 'tok', fetch });
  const r = await c.getUpdates('startBuf');
  assert.equal(r.ret, 0);
  assert.equal(r.get_updates_buf, 'cursor1');
  assert.equal((fetch as any).calls.length, 1);
  const call = (fetch as any).calls[0];
  assert.equal(call.url, 'https://example.com/ilink/bot/getupdates');
  assert.equal(call.bodyJson.get_updates_buf, 'startBuf');
  assert.equal(call.bodyJson.base_info.channel_version, ILINK_CHANNEL_VERSION);
});

test('client: 请求头含 Authorization Bearer + iLink 自定义头', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0 } }]);
  const c = new ILinkClient({ token: 'mytoken', fetch });
  await c.getUpdates('');
  const headers = (fetch as any).calls[0].init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer mytoken');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['AuthorizationType'], 'ilink_bot_token');
  assert.equal(headers['iLink-App-Id'], 'bot');
  assert.equal(headers['iLink-App-ClientVersion'], '131072');
  assert.ok(headers['X-WECHAT-UIN'].length > 0);
});

test('client: 未登录(无 token)不带 Authorization 头', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0, qrcode: 'abc', qrcode_img_content: 'http://x' } }]);
  const c = new ILinkClient({ fetch });
  await c.getBotQrCode(3);
  const headers = (fetch as any).calls[0].init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], undefined);
});

test('client: sendText 构造 item_list type=1 + 默认 client_id', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0, message_id: 'm1' } }]);
  const c = new ILinkClient({ token: 't', fetch });
  await c.sendText('user_x', '你好');
  const body = (fetch as any).calls[0].bodyJson;
  assert.equal(body.msg.to_user_id, 'user_x');
  assert.equal(body.msg.message_type, 2);
  assert.equal(body.msg.message_state, 2);
  assert.equal(body.msg.item_list[0].type, ITEM_TEXT);
  assert.equal(body.msg.item_list[0].text_item.text, '你好');
  assert.ok(body.msg.client_id.length > 0);
  assert.equal(body.msg.context_token, undefined);
});

test('client: sendText 带 contextToken → body.msg.context_token 出现', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0 } }]);
  const c = new ILinkClient({ token: 't', fetch });
  await c.sendText('u', 'hi', { contextToken: 'ctx-123' });
  const body = (fetch as any).calls[0].bodyJson;
  assert.equal(body.msg.context_token, 'ctx-123');
});

test('client: 不应手动设 Content-Length(中文 body 时 char 数 ≠ 字节数会被 undici 中止)', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0 } }]);
  const c = new ILinkClient({ token: 't', fetch });
  await c.sendText('u', '你好,这是一段中文回复');
  const headers = (fetch as any).calls[0].init.headers as Record<string, string>;
  assert.equal(headers['Content-Length'], undefined);
});

test('client: 非 200 抛错', async () => {
  const fetch = makeMockFetch([{ status: 502, body: { error: 'bad gateway' } }]);
  const c = new ILinkClient({ token: 't', fetch });
  await assert.rejects(() => c.getUpdates(''), /HTTP 502/);
});

test('client: 缺 ret 字段视作 0(默认成功),与 hermes 一致', async () => {
  const fetch = makeMockFetch([{ body: { msgs: [], get_updates_buf: 'cur' } }]);
  const c = new ILinkClient({ token: 't', fetch });
  const r = await c.getUpdates('');
  assert.equal(r.ret, 0);
  assert.equal(r.get_updates_buf, 'cur');
});

test('client: 缺 ret 但有 errcode → 复制到 ret', async () => {
  const fetch = makeMockFetch([{ body: { errcode: -14, errmsg: 'session expired' } }]);
  const c = new ILinkClient({ token: 't', fetch });
  const r = await c.getUpdates('');
  assert.equal(r.ret, -14);
  assert.equal(r.errcode, -14);
  assert.equal(r.errmsg, 'session expired');
});

test('client: 响应不是 object → 抛(传输层错)', async () => {
  const fetch = makeMockFetch([{ body: 'plain string' as any }]);
  const c = new ILinkClient({ token: 't', fetch });
  await assert.rejects(() => c.getUpdates(''), /not an object/);
});

test('client: setToken 后续请求生效', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0 } }, { body: { ret: 0 } }]);
  const c = new ILinkClient({ fetch });
  await c.getBotQrCode(3);
  c.setToken('new-token');
  await c.getUpdates('');
  const h0 = (fetch as any).calls[0].init.headers;
  const h1 = (fetch as any).calls[1].init.headers;
  assert.equal(h0['Authorization'], undefined);
  assert.equal(h1['Authorization'], 'Bearer new-token');
});

test('client: 默认 baseUrl 是 ilinkai.weixin.qq.com', () => {
  const c = new ILinkClient({});
  assert.equal(c.baseUrl, ILINK_DEFAULT_BASE_URL);
});

test('client: getBotQrCode 是 GET + bot_type query 参数', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0, qrcode: 'q', qrcode_img_content: 'u' } }]);
  const c = new ILinkClient({ fetch });
  await c.getBotQrCode(3);
  const call = (fetch as any).calls[0];
  assert.equal(call.init.method, 'GET');
  assert.ok(call.url.includes('get_bot_qrcode?bot_type=3'));
  // GET 不带 body
  assert.equal(call.init.body, undefined);
  // GET 不带 Authorization 也不带 AuthorizationType
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], undefined);
  assert.equal(headers['AuthorizationType'], undefined);
  assert.equal(headers['iLink-App-Id'], 'bot');
  assert.equal(headers['iLink-App-ClientVersion'], '131072');
});

test('client: getQrCodeStatus 是 GET + qrcode query 参数(URL encode)', async () => {
  const fetch = makeMockFetch([{ body: { ret: 0, status: 'wait' } }]);
  const c = new ILinkClient({ fetch });
  await c.getQrCodeStatus('hex-token+abc');
  const call = (fetch as any).calls[0];
  assert.equal(call.init.method, 'GET');
  assert.ok(call.url.includes('get_qrcode_status?qrcode=hex-token%2Babc'));
});

// ── inbound 解析 helpers ────────────────────────────────────────────

test('extractTextFromInbound: 单 text item', () => {
  const msg: InboundMessage = { item_list: [{ type: ITEM_TEXT, text_item: { text: 'hello' } }] };
  assert.equal(extractTextFromInbound(msg), 'hello');
});

test('extractTextFromInbound: 媒体类型转占位符', () => {
  const msg: InboundMessage = {
    item_list: [
      { type: ITEM_TEXT, text_item: { text: '看图:' } },
      { type: ITEM_IMAGE, image_item: { media: {} } },
      { type: ITEM_FILE, file_item: { media: {}, file_name: 'a.pdf' } },
    ],
  };
  const t = extractTextFromInbound(msg);
  assert.ok(t.includes('看图:'));
  assert.ok(t.includes('[图片]'));
  assert.ok(t.includes('[文件:a.pdf]'));
});

test('extractTextFromInbound: 空 item_list 返回空串', () => {
  assert.equal(extractTextFromInbound({}), '');
});

test('inboundIsGroup / inboundGroupId: room_id 优先 chat_room_id 兜底', () => {
  assert.equal(inboundIsGroup({ room_id: 'g1' }), true);
  assert.equal(inboundIsGroup({ chat_room_id: 'g2' }), true);
  assert.equal(inboundIsGroup({ from_user_id: 'u' }), false);
  assert.equal(inboundGroupId({ room_id: 'g1', chat_room_id: 'g2' }), 'g1');
  assert.equal(inboundGroupId({ chat_room_id: 'g2' }), 'g2');
  assert.equal(inboundGroupId({}), '');
});
