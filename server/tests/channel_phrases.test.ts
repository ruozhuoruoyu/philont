/**
 * channel_phrases 单元测试。
 *
 * 覆盖:
 *   - semanticToolPhrase:每个工具分组各 1 例 + 兜底 + 未知工具名
 *   - semanticToolFailPhrase:每个分组 + 兜底
 *   - 关键不变量:任何输入结果都**不含**工具名原文
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  semanticToolPhrase,
  semanticToolFailPhrase,
} from '../src/channel_phrases.js';

// ── semanticToolPhrase 分组覆盖 ────────────────────────────────────────

test('semanticToolPhrase: 网络类', () => {
  assert.equal(semanticToolPhrase('webSearch'), '正在搜索网络…');
  assert.equal(semanticToolPhrase('webFetch'), '正在抓取网页内容…');
  assert.equal(semanticToolPhrase('http'), '正在抓取网页内容…');
  assert.equal(semanticToolPhrase('downloadFile'), '正在下载文件…');
});

test('semanticToolPhrase: 文件读', () => {
  assert.equal(semanticToolPhrase('readFile'), '正在读取文件…');
  assert.equal(semanticToolPhrase('glob'), '正在搜索文件…');
  assert.equal(semanticToolPhrase('grep'), '正在搜索文件…');
  assert.equal(semanticToolPhrase('inspectPath'), '正在检查文件…');
});

test('semanticToolPhrase: 文件写', () => {
  assert.equal(semanticToolPhrase('writeFile'), '正在写入文件…');
  assert.equal(semanticToolPhrase('deleteFile'), '正在删除文件…');
  assert.equal(semanticToolPhrase('patch'), '正在修改文件…');
});

test('semanticToolPhrase: 执行类', () => {
  assert.equal(semanticToolPhrase('shell'), '正在执行命令…');
  assert.equal(semanticToolPhrase('process'), '正在执行命令…');
  assert.equal(semanticToolPhrase('git'), '正在执行 Git 操作…');
});

test('semanticToolPhrase: 记忆 / 技能 / 计划', () => {
  assert.equal(semanticToolPhrase('search_skills'), '正在检索记忆…');
  assert.equal(semanticToolPhrase('get_fact'), '正在查阅记忆…');
  assert.equal(semanticToolPhrase('store_fact'), '正在记录笔记…');
  assert.equal(semanticToolPhrase('use_skill'), '正在调用技能…');
  assert.equal(semanticToolPhrase('installSkill'), '正在管理技能…');
  assert.equal(semanticToolPhrase('plan_draft'), '正在制定计划…');
  assert.equal(semanticToolPhrase('plan_update_step'), '正在更新计划进度…');
  assert.equal(semanticToolPhrase('plan_knowledge'), '正在沉淀经验…');
});

test('semanticToolPhrase: 调度', () => {
  assert.equal(semanticToolPhrase('schedule_reminder'), '正在设置定时任务…');
  assert.equal(semanticToolPhrase('cancel_schedule'), '正在设置定时任务…');
});

test('semanticToolPhrase: 未知工具名 → 兜底', () => {
  assert.equal(semanticToolPhrase('mysteryTool'), '正在处理…');
  assert.equal(semanticToolPhrase(''), '正在处理…');
  assert.equal(semanticToolPhrase('echo'), '正在处理…');
});

// ── semanticToolFailPhrase 分组覆盖 ────────────────────────────────────

test('semanticToolFailPhrase: 分组', () => {
  assert.equal(semanticToolFailPhrase('webSearch'), '⚠ 网络搜索未成功,继续尝试…');
  assert.equal(semanticToolFailPhrase('http'), '⚠ 网页抓取未成功,继续尝试…');
  assert.equal(semanticToolFailPhrase('shell'), '⚠ 命令执行未成功,继续尝试…');
  assert.equal(semanticToolFailPhrase('git'), '⚠ Git 操作未成功,继续尝试…');
  assert.equal(semanticToolFailPhrase('readFile'), '⚠ 文件查找未成功,继续尝试…');
  assert.equal(semanticToolFailPhrase('writeFile'), '⚠ 文件操作未成功,继续尝试…');
  assert.equal(semanticToolFailPhrase('use_skill'), '⚠ 技能调用未成功,继续尝试…');
});

test('semanticToolFailPhrase: 未知工具名 → 兜底', () => {
  assert.equal(semanticToolFailPhrase('mysteryTool'), '⚠ 上一步未成功,继续尝试…');
});

// ── 关键不变量:不暴露工具名 ───────────────────────────────────────────

test('不变量:任何工具名输入,结果都不含工具名原文', () => {
  const allTools = [
    'webSearch', 'webFetch', 'http', 'downloadFile', 'readFile', 'glob',
    'grep', 'inspectPath', 'listDir', 'writeFile', 'deleteFile', 'moveFile',
    'patch', 'jsonPatch', 'shell', 'process', 'planAndExecute', 'git',
    'listCredentialNames', 'saveCredential', 'removeCredential', 'search_notes',
    'search_skills', 'recall_sessions', 'memory', 'get_fact', 'list_facts',
    'store_fact', 'use_skill', 'installSkill', 'uninstallSkill', 'plan_draft',
    'plan_revise', 'plan_update_step', 'plan_close', 'plan_knowledge',
    'task_mode_classify', 'schedule_reminder', 'cancel_schedule',
    'create_calendar_event', 'list_upcoming', 'replyWithMedia',
  ];
  for (const t of allTools) {
    const phrase = semanticToolPhrase(t);
    const failPhrase = semanticToolFailPhrase(t);
    // 工具名(去掉下划线后)不应出现在语义短语里
    assert.ok(
      !phrase.includes(t),
      `semanticToolPhrase('${t}') 泄露了工具名: "${phrase}"`,
    );
    assert.ok(
      !failPhrase.includes(t),
      `semanticToolFailPhrase('${t}') 泄露了工具名: "${failPhrase}"`,
    );
  }
});
