/**
 * response_language 单测:回复语言解析(开源中译英过渡的 keystone)。
 * 不变量:微信→中文;显式 locale 优先;未知渠道→镜像用户语言;directive 含目标语言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelOf,
  localeToLanguage,
  resolveResponseLanguage,
  buildLanguageDirective,
} from '../src/response_language.js';

test('channelOf:取 sessionId 的渠道前缀', () => {
  assert.equal(channelOf('wechat:acct123:userA'), 'wechat');
  assert.equal(channelOf('webui'), 'webui');
  assert.equal(channelOf(''), '');
  assert.equal(channelOf(null), '');
});

test('localeToLanguage:常见 locale → 语言名;未知→null', () => {
  assert.equal(localeToLanguage('zh-CN'), 'Chinese');
  assert.equal(localeToLanguage('zh'), 'Chinese');
  assert.equal(localeToLanguage('en-US'), 'English');
  assert.equal(localeToLanguage('ja'), 'Japanese');
  assert.equal(localeToLanguage('xx-unknown'), null);
  assert.equal(localeToLanguage(''), null);
  assert.equal(localeToLanguage(null), null);
});

test('resolveResponseLanguage:微信→中文(渠道默认)', () => {
  assert.equal(resolveResponseLanguage({ channel: 'wechat:acct:user' }), 'Chinese');
});

test('resolveResponseLanguage:显式 user locale 优先于渠道默认', () => {
  // 微信用户但 locale=en → 尊重用户 locale
  assert.equal(resolveResponseLanguage({ channel: 'wechat:a:b', userLocale: 'en-US' }), 'English');
});

test('resolveResponseLanguage:未知渠道无 locale → 镜像用户语言', () => {
  const lang = resolveResponseLanguage({ channel: 'telegram:bot:user' });
  assert.match(lang, /user's own language/);
});

test('buildLanguageDirective:含目标语言 + 镜像兜底说明', () => {
  const d = buildLanguageDirective('Chinese');
  assert.match(d, /Response language/);
  assert.match(d, /Chinese/);
  assert.match(d, /For User/); // 指明作用于面向用户段
  assert.match(d, /mirror/i); // 用户换语言则镜像
});
