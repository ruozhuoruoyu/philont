/**
 * WeChat 渲染层单元测试。
 *
 * 覆盖:
 *   - renderForWeChat:markdown → 微信文本(table / heading / bold / inline / fence / link)
 *   - formatToolForAuth:7 个白名单工具 + 1 个 fallback
 *   - renderAuthPromptForWeChat:完整授权消息组装
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderForWeChat,
  formatToolForAuth,
  renderAuthPromptForWeChat,
} from '../src/channels/wechat/wechat_render.js';

// ── renderForWeChat ────────────────────────────────────────────────────

test('renderForWeChat: **bold** stripped to plain text', () => {
  const md = '这是 **重点** 内容';
  const out = renderForWeChat(md);
  assert.equal(out, '这是 重点 内容');
});

test('renderForWeChat: ### heading → bare title', () => {
  const md = '### 📄 文档处理类\n下面是内容';
  const out = renderForWeChat(md);
  assert.equal(out, '📄 文档处理类\n下面是内容');
});

test('renderForWeChat: 2-col table → bullet list (key: value)', () => {
  const md = [
    '| 技能 | 说明 |',
    '|---|---|',
    '| pdf-to-word | PDF → Word |',
    '| doc-converter | 格式互转 |',
  ].join('\n');
  const out = renderForWeChat(md);
  assert.equal(out, '- pdf-to-word: PDF → Word\n- doc-converter: 格式互转');
});

test('renderForWeChat: 3-col table → bullet list (· separator)', () => {
  const md = [
    '| 方案 | 状态 | 原因 |',
    '|---|---|---|',
    '| online | 缺 key | 云端 API |',
  ].join('\n');
  const out = renderForWeChat(md);
  assert.equal(out, '- online · 缺 key · 云端 API');
});

test('renderForWeChat: 同时 strip 表格 cell 内的 **bold**', () => {
  const md = [
    '| 技能 | 说明 |',
    '|---|---|',
    '| **pdf-to-word** | PDF → Word |',
  ].join('\n');
  const out = renderForWeChat(md);
  assert.equal(out, '- pdf-to-word: PDF → Word');
});

test('renderForWeChat: inline `code` → 「code」', () => {
  const md = '调用 `use_skill("clawhub")` 装新技能';
  const out = renderForWeChat(md);
  assert.equal(out, '调用 「use_skill("clawhub")」 装新技能');
});

test('renderForWeChat: fenced code block preserved as-is', () => {
  const md = [
    '看代码:',
    '```python',
    'print("hello")',
    '```',
    '完了',
  ].join('\n');
  const out = renderForWeChat(md);
  assert.equal(out, '看代码:\n```python\nprint("hello")\n```\n完了');
});

test('renderForWeChat: [text](url) → "text (url)"', () => {
  const md = '注册 [siliconflow.cn](https://siliconflow.cn) 拿 key';
  const out = renderForWeChat(md);
  assert.equal(out, '注册 siliconflow.cn (https://siliconflow.cn) 拿 key');
});

test('renderForWeChat: 折叠 ≥3 连续空行为 1 个空行', () => {
  const md = 'a\n\n\n\nb';
  const out = renderForWeChat(md);
  assert.equal(out, 'a\n\nb');
});

test('renderForWeChat: empty / null safe', () => {
  assert.equal(renderForWeChat(''), '');
  assert.equal(renderForWeChat('plain text'), 'plain text');
});

test('renderForWeChat: fenced block 内不 strip markdown', () => {
  // 代码块内的 **bold** 应保留(LLM 可能在 code 里展示 markdown 语法本身)
  const md = '```\n**保留**\n```';
  const out = renderForWeChat(md);
  assert.equal(out, '```\n**保留**\n```');
});

// ── formatToolForAuth ──────────────────────────────────────────────────

test('formatToolForAuth: writeFile 展示路径 + 大小 + 内容预览', () => {
  const out = formatToolForAuth('writeFile', {
    path: '/tmp/foo.txt',
    content: 'hello world',
  });
  assert.match(out, /📝 writeFile/);
  assert.match(out, /路径: \/tmp\/foo\.txt/);
  assert.match(out, /大小: 11 字节/);
  assert.match(out, /内容预览: hello world/);
});

test('formatToolForAuth: shell 展示命令 + cwd', () => {
  const out = formatToolForAuth('shell', {
    command: 'ls -la /etc',
    cwd: '/home/user',
  });
  assert.match(out, /💻 shell/);
  assert.match(out, /命令: ls -la \/etc/);
  assert.match(out, /目录: \/home\/user/);
});

test('formatToolForAuth: shell 命令长字符串截断 200', () => {
  const longCmd = 'a'.repeat(500);
  const out = formatToolForAuth('shell', { command: longCmd });
  // 截到 200 含 …
  assert.match(out, /命令: a{199}…/);
});

test('formatToolForAuth: readFile 展示路径', () => {
  const out = formatToolForAuth('readFile', { path: '/etc/passwd' });
  assert.match(out, /📖 readFile/);
  assert.match(out, /路径: \/etc\/passwd/);
});

test('formatToolForAuth: glob 展示模式 + 目录', () => {
  const out = formatToolForAuth('glob', { pattern: '*.ts', cwd: 'src' });
  assert.match(out, /🔍 glob/);
  assert.match(out, /模式: \*\.ts/);
  assert.match(out, /目录: src/);
});

test('formatToolForAuth: http 展示 method + url', () => {
  const out = formatToolForAuth('http', {
    url: 'https://api.example.com/v1/data',
    method: 'POST',
  });
  assert.match(out, /🌐 http/);
  assert.match(out, /POST https:\/\/api\.example\.com\/v1\/data/);
});

test('formatToolForAuth: http 默认 GET', () => {
  const out = formatToolForAuth('http', { url: 'https://x.com' });
  assert.match(out, /GET https:\/\/x\.com/);
});

test('formatToolForAuth: installSkill 展示技能名 + 来源', () => {
  const out = formatToolForAuth('installSkill', {
    name: 'tesseract-image-ocr',
    source: 'clawhub:tesseract',
  });
  assert.match(out, /📦 installSkill/);
  assert.match(out, /技能: tesseract-image-ocr/);
  assert.match(out, /来源: clawhub:tesseract/);
});

test('formatToolForAuth: 未知工具 fallback JSON', () => {
  const out = formatToolForAuth('mysteryTool', { foo: 'bar', baz: 42 });
  assert.match(out, /⚙️ mysteryTool/);
  assert.match(out, /参数: \{"foo":"bar","baz":42\}/);
});

test('formatToolForAuth: 空 input 不抛错', () => {
  const out = formatToolForAuth('writeFile', null);
  assert.match(out, /📝 writeFile/);
});

// ── renderAuthPromptForWeChat ──────────────────────────────────────────

test('renderAuthPromptForWeChat: 完整消息含标题 / 工具详情 / 决策提示', () => {
  const out = renderAuthPromptForWeChat({
    toolName: 'writeFile',
    capability: 'write',
    domain: 'local',
    input: { path: '/tmp/x', content: 'data' },
  });
  assert.match(out, /^🔐 Agent 请求授权/);
  assert.match(out, /📝 writeFile/);
  assert.match(out, /权限: write\/local/);
  assert.match(out, /同意/);
  assert.match(out, /拒绝/);
  assert.match(out, /10 分钟有效/);
});

test('renderAuthPromptForWeChat: clarification 非空时插入', () => {
  const out = renderAuthPromptForWeChat({
    toolName: 'shell',
    capability: 'execute',
    domain: 'local',
    input: { command: 'ls' },
    clarification: '没有理解您的意思',
  });
  assert.match(out, /没有理解您的意思/);
});
