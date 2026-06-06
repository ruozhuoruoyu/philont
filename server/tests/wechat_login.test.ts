/**
 * 扫码登录状态机单元测试。client 完全 mock。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ILinkClient, type FetchLike } from '../src/channels/wechat/client.js';
import { loginWithQrCode } from '../src/channels/wechat/login.js';

/** 用 fetch mock 控制 client 的整个响应序列 */
function mockFetch(responses: Array<any>): FetchLike & { calls: any[] } {
  const queue = [...responses];
  const calls: any[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body });
    const next = queue.shift();
    if (!next) throw new Error('no more mock responses');
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  (fn as any).calls = calls;
  return fn as any;
}

const noSleep = async (_ms: number) => {};
const silent = () => {};

test('login: 一次扫码即 confirmed → 返回 credentials', async () => {
  const fetch = mockFetch([
    // get_bot_qrcode
    { ret: 0, qrcode: 'qhex', qrcode_img_content: 'http://qr/img' },
    // get_qrcode_status: confirmed
    {
      ret: 0,
      status: 'confirmed',
      bot_token: 'bearer-xyz',
      ilink_user_id: 'wxid_alice',
      baseurl: 'https://ilinkai.weixin.qq.com',
    },
  ]);
  const client = new ILinkClient({ fetch });
  const r = await loginWithQrCode({ client, render: silent, sleep: noSleep });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.credentials.token, 'bearer-xyz');
    assert.equal(r.credentials.accountId, 'wxid_alice');
    assert.equal(r.credentials.baseUrl, 'https://ilinkai.weixin.qq.com');
    assert.ok(r.credentials.createdAt > 0);
  }
});

test('login: wait → scaned → confirmed,中间 poll 多次', async () => {
  const fetch = mockFetch([
    { ret: 0, qrcode: 'q', qrcode_img_content: 'u' },
    { ret: 0, status: 'wait' },
    { ret: 0, status: 'wait' },
    { ret: 0, status: 'scaned' },
    {
      ret: 0,
      status: 'confirmed',
      bot_token: 't',
      ilink_user_id: 'me',
    },
  ]);
  const client = new ILinkClient({ fetch });
  const r = await loginWithQrCode({ client, render: silent, sleep: noSleep });
  assert.equal(r.ok, true);
});

test('login: 第一张 QR expired → 自动取第二张 → confirmed', async () => {
  const fetch = mockFetch([
    // QR 1
    { ret: 0, qrcode: 'q1', qrcode_img_content: 'u1' },
    { ret: 0, status: 'expired' },
    // QR 2
    { ret: 0, qrcode: 'q2', qrcode_img_content: 'u2' },
    { ret: 0, status: 'confirmed', bot_token: 't', ilink_user_id: 'me' },
  ]);
  const renders: any[] = [];
  const client = new ILinkClient({ fetch });
  const r = await loginWithQrCode({
    client,
    render: (info) => renders.push(info),
    sleep: noSleep,
  });
  assert.equal(r.ok, true);
  assert.equal(renders.length, 2, '应渲染两张 QR');
  assert.equal(renders[0].attempt, 1);
  assert.equal(renders[1].attempt, 2);
});

test('login: 超过 maxRefresh 仍 expired → qr_expired', async () => {
  const fetch = mockFetch([
    { ret: 0, qrcode: 'q', qrcode_img_content: 'u' },
    { ret: 0, status: 'expired' },
    { ret: 0, qrcode: 'q', qrcode_img_content: 'u' },
    { ret: 0, status: 'expired' },
  ]);
  const client = new ILinkClient({ fetch });
  const r = await loginWithQrCode({
    client,
    render: silent,
    sleep: noSleep,
    maxRefresh: 2,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'qr_expired');
});

test('login: get_bot_qrcode 返回 ret≠0 → malformed', async () => {
  const fetch = mockFetch([{ ret: -1, errmsg: 'no qr' }]);
  const client = new ILinkClient({ fetch });
  const r = await loginWithQrCode({ client, render: silent, sleep: noSleep });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'malformed_response');
});

test('login: confirmed 但缺 bot_token → malformed', async () => {
  const fetch = mockFetch([
    { ret: 0, qrcode: 'q', qrcode_img_content: 'u' },
    { ret: 0, status: 'confirmed', ilink_user_id: 'x' /* 没 bot_token */ },
  ]);
  const client = new ILinkClient({ fetch });
  const r = await loginWithQrCode({ client, render: silent, sleep: noSleep });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'malformed_response');
});

test('login: accountIdOverride 优先于 ilink_user_id', async () => {
  const fetch = mockFetch([
    { ret: 0, qrcode: 'q', qrcode_img_content: 'u' },
    { ret: 0, status: 'confirmed', bot_token: 't', ilink_user_id: 'wxid_xxx' },
  ]);
  const client = new ILinkClient({ fetch });
  const r = await loginWithQrCode({
    client,
    render: silent,
    sleep: noSleep,
    accountIdOverride: 'my-bot',
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.credentials.accountId, 'my-bot');
});
