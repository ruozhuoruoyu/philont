/**
 * host OS 检测 — 验证 Windows / 类 Unix 两个分支的方言指引正确切换。
 * 用 Object.defineProperty 临时改 process.platform,再 fresh import host.js 求值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadHostFor(platform: string) {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  // cache-bust:加 query 让 ESM 重新求值模块顶层(HOST_IS_WINDOWS 在 import 时算)
  const mod = await import(`../src/utils/host.js?p=${platform}`);
  Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  return mod as typeof import('../src/utils/host.js');
}

test('Windows:用 cmd 方言指引(where / 无 heredoc / cmd.exe)', async () => {
  const h = await loadHostFor('win32');
  assert.equal(h.HOST_IS_WINDOWS, true);
  assert.match(h.hostShellLabel(), /Windows/);
  const g = h.hostShellGuidanceLines().join('\n');
  assert.match(g, /cmd\.exe/);
  assert.match(g, /where/);
  assert.match(g, /heredoc/);
  assert.match(h.hostEnvPromptLine(), /Windows/);
  // 不该把 Windows 说成 POSIX
  assert.doesNotMatch(g, /POSIX/);
});

test('Linux:用 POSIX 指引', async () => {
  const h = await loadHostFor('linux');
  assert.equal(h.HOST_IS_WINDOWS, false);
  assert.match(h.hostShellLabel(), /linux/);
  assert.match(h.hostShellGuidanceLines().join('\n'), /POSIX|sh\/bash/);
  assert.match(h.hostEnvPromptLine(), /linux/);
});
