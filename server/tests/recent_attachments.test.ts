/**
 * recent_attachments 单测
 *
 * 解决"用户跨 channel 上传 → 下一轮说'刚刚上传的'找不到"的 P1-2 bug。
 * 不变量验证:
 *   - 推入即可读
 *   - 倒序(最新在前)
 *   - 超 ttl 过滤
 *   - ring buffer 满后丢最旧的
 *   - 多 channel 共存
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordAttachment,
  recentAttachments,
  _resetForTests,
} from '../src/channels/recent_attachments.js';

function makeAtt(overrides: { ts?: number; channel?: string; filename?: string } = {}) {
  return {
    channel: overrides.channel ?? 'wechat:acc1',
    kind: 'file' as const,
    filename: overrides.filename ?? 'x.pdf',
    path: `/tmp/${overrides.filename ?? 'x.pdf'}`,
    fromUser: 'u123',
    ts: overrides.ts ?? Date.now(),
  };
}

test('recent_attachments: 推入后立即可读', () => {
  _resetForTests();
  recordAttachment(makeAtt({ filename: 'a.pdf' }));
  const out = recentAttachments();
  assert.equal(out.length, 1);
  assert.equal(out[0].filename, 'a.pdf');
});

test('recent_attachments: 倒序(最新在前)', () => {
  _resetForTests();
  const t0 = Date.now() - 10_000;
  recordAttachment(makeAtt({ filename: 'old.pdf', ts: t0 }));
  recordAttachment(makeAtt({ filename: 'new.pdf', ts: t0 + 1000 }));
  const out = recentAttachments();
  assert.equal(out[0].filename, 'new.pdf');
  assert.equal(out[1].filename, 'old.pdf');
});

test('recent_attachments: 超 ttl 不返回', () => {
  _resetForTests();
  const now = Date.now();
  recordAttachment(makeAtt({ filename: 'fresh.pdf', ts: now - 1000 }));
  recordAttachment(makeAtt({ filename: 'stale.pdf', ts: now - 2 * 60 * 60_000 }));
  // ttl 1h(默认),stale 应被过滤
  const out = recentAttachments({ ttlMs: 60 * 60_000, now });
  assert.equal(out.length, 1);
  assert.equal(out[0].filename, 'fresh.pdf');
});

test('recent_attachments: ring buffer 上限 20,超出丢最老', () => {
  _resetForTests();
  for (let i = 0; i < 25; i++) {
    recordAttachment(makeAtt({ filename: `f${i}.pdf` }));
  }
  // limit=25 应该最多返回 20(buffer 上限)
  const out = recentAttachments({ limit: 100 });
  assert.equal(out.length, 20);
  // 最新的 20 条:f24...f5;最老 f0...f4 已被挤掉
  assert.equal(out[0].filename, 'f24.pdf');
  assert.equal(out[out.length - 1].filename, 'f5.pdf');
});

test('recent_attachments: 多 channel 共存,按时间序混排', () => {
  _resetForTests();
  const t0 = Date.now();
  recordAttachment(makeAtt({ channel: 'wechat:acc1', filename: 'wx.pdf', ts: t0 }));
  recordAttachment(makeAtt({ channel: 'webui', filename: 'web.pdf', ts: t0 + 100 }));
  recordAttachment(makeAtt({ channel: 'wechat:acc2', filename: 'wx2.pdf', ts: t0 + 200 }));
  const out = recentAttachments();
  // 倒序:wx2 (acc2) → web (webui) → wx (acc1)
  assert.deepEqual(
    out.map((a) => a.channel),
    ['wechat:acc2', 'webui', 'wechat:acc1'],
  );
});

test('recent_attachments: limit 截断', () => {
  _resetForTests();
  for (let i = 0; i < 5; i++) {
    recordAttachment(makeAtt({ filename: `f${i}.pdf` }));
  }
  const out = recentAttachments({ limit: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0].filename, 'f4.pdf');
  assert.equal(out[1].filename, 'f3.pdf');
});
