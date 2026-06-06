import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderForTelegram } from '../src/channels/telegram/render.js';
import { readTelegramConfig } from '../src/channels/telegram/config.js';
import { parseTelegramChatId } from '../src/channels/telegram/media_channel.js';

describe('renderForTelegram', () => {
  it('剥 **bold** / 标题 #', () => {
    assert.equal(renderForTelegram('## 标题\n**粗** 普通'), '标题\n粗 普通');
  });
  it('表格 → 紧凑行,分隔行丢弃', () => {
    const out = renderForTelegram('| a | b |\n|---|---|\n| 1 | 2 |');
    assert.equal(out, 'a | b\n1 | 2');
  });
  it('代码块原样保留', () => {
    const src = '```js\nconst x = 1;\n```';
    assert.equal(renderForTelegram(src), src);
  });
  it('折叠多余空行', () => {
    assert.equal(renderForTelegram('a\n\n\n\nb'), 'a\n\nb');
  });
});

describe('readTelegramConfig', () => {
  it('未启用 → null', () => {
    assert.equal(readTelegramConfig({}), null);
    assert.equal(readTelegramConfig({ TELEGRAM_ENABLED: '0' }), null);
  });
  it('启用但缺 token → null', () => {
    assert.equal(readTelegramConfig({ TELEGRAM_ENABLED: '1' }), null);
  });
  it('启用 + token → 配置;默认 dm=allowlist/group=disabled', () => {
    const c = readTelegramConfig({ TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'abc' });
    assert.equal(c?.token, 'abc');
    assert.equal(c?.policy.dmPolicy, 'allowlist');
    assert.equal(c?.policy.groupPolicy, 'disabled');
  });
  it('解析 allowlist + 自定义 policy', () => {
    const c = readTelegramConfig({
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_DM_POLICY: 'open',
      TELEGRAM_ALLOWED_USERS: '111, 222 ,333',
    });
    assert.equal(c?.policy.dmPolicy, 'open');
    assert.deepEqual(c?.policy.allowedUsers, ['111', '222', '333']);
  });
});

describe('parseTelegramChatId', () => {
  it('DM:取 userId(==chatId)', () => {
    assert.equal(parseTelegramChatId('telegram:mybot:12345', 'mybot'), '12345');
  });
  it('群:取群 chatId', () => {
    assert.equal(parseTelegramChatId('telegram:mybot:group:-100999:777', 'mybot'), '-100999');
  });
  it('前缀不匹配 → null', () => {
    assert.equal(parseTelegramChatId('wechat:x:1', 'mybot'), null);
    assert.equal(parseTelegramChatId('telegram:otherbot:1', 'mybot'), null);
  });
});
