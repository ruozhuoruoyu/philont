/**
 * WeChat MediaChannel 单元测试 —— 不动 fetch,只验路由 + size 校验 + iLink 调用形状。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeChatMediaChannel,
  parseWeChatPeer,
} from '../src/channels/wechat/media_channel.js';
import {
  ILinkClient,
  MEDIA_IMAGE,
  MEDIA_FILE,
  type FetchLike,
} from '../src/channels/wechat/client.js';

function makeFakeFetch(): FetchLike & { calls: any[] } {
  const calls: any[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('ilink/bot/getuploadurl')) {
      return new Response(
        JSON.stringify({
          ret: 0,
          upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?x',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/c2c/upload')) {
      return new Response('', {
        status: 200,
        headers: { 'x-encrypted-param': 'enc-token' },
      });
    }
    if (url.endsWith('ilink/bot/sendmessage')) {
      return new Response(
        JSON.stringify({ ret: 0, message_id: 'mm-1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('?', { status: 404 });
  };
  (fn as any).calls = calls;
  return fn as any;
}

// ── parseWeChatPeer ────────────────────────────────────────────

test('parseWeChatPeer: DM sid 解出 userId(含 @im.wechat 后缀)', () => {
  assert.equal(
    parseWeChatPeer('wechat:o9cq801@im.wechat:other-user@im.wechat', 'o9cq801@im.wechat'),
    'other-user@im.wechat',
  );
});

test('parseWeChatPeer: 群 sid 取 groupId(回到群,不私聊)', () => {
  assert.equal(
    parseWeChatPeer('wechat:my-acct:group:group-123:user-y', 'my-acct'),
    'group-123',
  );
});

test('parseWeChatPeer: 不匹配账号前缀 → null', () => {
  assert.equal(parseWeChatPeer('wechat:other-acct:user-x', 'my-acct'), null);
  assert.equal(parseWeChatPeer('not-wechat-sid', 'my-acct'), null);
});

test('parseWeChatPeer: 形状不对的群 sid → null', () => {
  // 缺最后的 :userId
  assert.equal(parseWeChatPeer('wechat:my-acct:group:gid', 'my-acct'), null);
});

// ── MediaChannel 集成 ──────────────────────────────────────────

test('MediaChannel: matches 只认 wechat:<acct>: 前缀', () => {
  const fetch = makeFakeFetch();
  const client = new ILinkClient({ token: 't', fetch });
  const ch = createWeChatMediaChannel({
    accountId: 'acct-1',
    client,
    readFile: () => Buffer.from('FAKE'),
    statFile: () => ({ size: 4 }),
  });
  assert.equal(ch.matches('wechat:acct-1:user-x'), true);
  assert.equal(ch.matches('wechat:acct-2:user-x'), false);
  assert.equal(ch.matches('plain-ws-sid'), false);
});

test('MediaChannel: send 给 DM peer → 调 sendmessage 时 to_user_id = peer', async () => {
  const fetch = makeFakeFetch();
  const client = new ILinkClient({ token: 't', fetch });
  const ch = createWeChatMediaChannel({
    accountId: 'acct',
    client,
    readFile: () => Buffer.from('FAKE'),
    statFile: () => ({ size: 4 }),
  });

  const r = await ch.send('wechat:acct:user-x', {
    kind: 'image',
    path: '/tmp/x.jpg',
  });
  assert.equal(r.messageId, 'mm-1');

  // 检查 sendmessage body 的 to_user_id 是 peer
  const sendCall = fetch.calls.find((c: any) => c.url.endsWith('ilink/bot/sendmessage'));
  assert.ok(sendCall);
  const body = JSON.parse(sendCall.init.body as string);
  assert.equal(body.msg.to_user_id, 'user-x');
});

test('MediaChannel: send 给群 sid → to_user_id = groupId(回到群)', async () => {
  const fetch = makeFakeFetch();
  const client = new ILinkClient({ token: 't', fetch });
  const ch = createWeChatMediaChannel({
    accountId: 'acct',
    client,
    readFile: () => Buffer.from('FAKE'),
    statFile: () => ({ size: 4 }),
  });
  await ch.send('wechat:acct:group:gid-1:user-y', {
    kind: 'image',
    path: '/tmp/x.jpg',
  });
  const sendCall = fetch.calls.find((c: any) => c.url.endsWith('ilink/bot/sendmessage'));
  const body = JSON.parse(sendCall.init.body as string);
  assert.equal(body.msg.to_user_id, 'gid-1');
});

test('MediaChannel: file kind 走 MEDIA_FILE,fileName 默认从 path 取 basename', async () => {
  const fetch = makeFakeFetch();
  const client = new ILinkClient({ token: 't', fetch });
  const ch = createWeChatMediaChannel({
    accountId: 'acct',
    client,
    readFile: () => Buffer.from('CONTENT'),
    statFile: () => ({ size: 7 }),
  });
  await ch.send('wechat:acct:user-x', {
    kind: 'file',
    path: '/tmp/some/dir/report.pdf',
  });
  const upBody = JSON.parse(fetch.calls[0].init.body as string);
  assert.equal(upBody.media_type, MEDIA_FILE);
  // 检 sendmessage 里 file_item.file_name = basename
  const sendCall = fetch.calls.find((c: any) => c.url.endsWith('ilink/bot/sendmessage'));
  const sendBody = JSON.parse(sendCall.init.body as string);
  assert.equal(sendBody.msg.item_list[0].file_item.file_name, 'report.pdf');
});

test('MediaChannel: 文件超大小上限 → 拒绝(不读文件、不发请求)', async () => {
  const fetch = makeFakeFetch();
  const client = new ILinkClient({ token: 't', fetch });
  let readCalled = false;
  const ch = createWeChatMediaChannel({
    accountId: 'acct',
    client,
    maxBytes: 100,
    readFile: () => {
      readCalled = true;
      return Buffer.alloc(0);
    },
    statFile: () => ({ size: 200 }),
  });
  await assert.rejects(
    () => ch.send('wechat:acct:user-x', { kind: 'image', path: '/tmp/big.jpg' }),
    /file too large/,
  );
  assert.equal(readCalled, false, 'readFile 不应被调');
  assert.equal(fetch.calls.length, 0, '不应发任何 HTTP 请求');
});

test('MediaChannel: 空文件 → 拒绝', async () => {
  const fetch = makeFakeFetch();
  const client = new ILinkClient({ token: 't', fetch });
  const ch = createWeChatMediaChannel({
    accountId: 'acct',
    client,
    readFile: () => Buffer.alloc(0),
    statFile: () => ({ size: 0 }),
  });
  await assert.rejects(
    () => ch.send('wechat:acct:user-x', { kind: 'image', path: '/tmp/empty.jpg' }),
    /file is empty/,
  );
});

test('MediaChannel: peer 解析失败 sid → 抛错(不发请求)', async () => {
  const fetch = makeFakeFetch();
  const client = new ILinkClient({ token: 't', fetch });
  const ch = createWeChatMediaChannel({
    accountId: 'acct',
    client,
    readFile: () => Buffer.from('x'),
    statFile: () => ({ size: 1 }),
  });
  await assert.rejects(
    () => ch.send('not-wechat-sid', { kind: 'image', path: '/tmp/x.jpg' }),
    /cannot extract peer/,
  );
});
