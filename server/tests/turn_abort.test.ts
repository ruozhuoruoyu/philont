/**
 * 中断牙齿(2026-05-29):用户中途停止当前 turn(UserHardStop)的 TS 实现。
 *
 * 端到端"abort 真的停掉正在跑的 turn"依赖 mock LLM + handleChatSend 全套
 * bootstrap(module-level llm 不可注入),留手动 / staging 验证。本文件锁住
 * 两个机制层不变量:
 *   1. isAbortError 正确识别 SDK 取消异常(APIUserAbortError / AbortError),
 *      与普通错误区分 —— 这是"abort 映射成 interrupted 而非 error"的判别点。
 *   2. abortActiveTurn 对无活 turn 的 session 安全返回 false(不抛)。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbortError, abortActiveTurn } from '../src/chat-handler.js';

test('isAbortError 识别 Anthropic SDK 的 APIUserAbortError', () => {
  const e = Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
  assert.equal(isAbortError(e), true);
});

test('isAbortError 识别 fetch 的 AbortError(DOMException name)', () => {
  const e = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  assert.equal(isAbortError(e), true);
});

test('isAbortError 不误判普通错误', () => {
  assert.equal(isAbortError(new Error('boom')), false);
  assert.equal(isAbortError(Object.assign(new Error('429'), { name: 'RateLimitError' })), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError('AbortError'), false); // 字符串没有 .name → false
});

test('abortActiveTurn 对无活 turn 的 session 安全返回 false', () => {
  assert.equal(abortActiveTurn('session-that-never-existed'), false);
});
