/**
 * NotesStore 测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

test('store and search notes via FTS5', () => {
  const { notes } = openMemoryDb(':memory:');

  notes.storeNote({ content: '用户讨论了 Rust borrow checker 的问题' });
  notes.storeNote({ content: '用户询问 Python 的异步编程' });
  notes.storeNote({ content: '关于 Rust 的所有权设计' });

  const rustNotes = notes.search('Rust');
  assert.equal(rustNotes.length, 2);

  const pythonNotes = notes.search('Python');
  assert.equal(pythonNotes.length, 1);
});

test('search returns empty for no match', () => {
  const { notes } = openMemoryDb(':memory:');
  notes.storeNote({ content: 'hello world' });
  const results = notes.search('nonexistent');
  assert.equal(results.length, 0);
});

test('importance orders results', () => {
  const { notes } = openMemoryDb(':memory:');

  notes.storeNote({ content: 'rust topic A', importance: 0.3 });
  notes.storeNote({ content: 'rust topic B', importance: 0.9 });
  notes.storeNote({ content: 'rust topic C', importance: 0.5 });

  const results = notes.search('rust');
  assert.equal(results.length, 3);
  assert.equal(results[0].content, 'rust topic B'); // highest importance first
});

test('listTopImportant returns sorted by importance', () => {
  const { notes } = openMemoryDb(':memory:');

  notes.storeNote({ content: 'low', importance: 0.1 });
  notes.storeNote({ content: 'high', importance: 0.9 });
  notes.storeNote({ content: 'mid', importance: 0.5 });

  const top = notes.listTopImportant(2);
  assert.equal(top.length, 2);
  assert.equal(top[0].content, 'high');
  assert.equal(top[1].content, 'mid');
});

test('sanitize FTS5 special characters', () => {
  const { notes } = openMemoryDb(':memory:');
  notes.storeNote({ content: 'test content' });

  // 包含特殊字符的查询不应抛错
  assert.doesNotThrow(() => notes.search('test"content'));
  assert.doesNotThrow(() => notes.search('test*'));
  assert.doesNotThrow(() => notes.search("test'"));
  assert.doesNotThrow(() => notes.search(''));
});

// ── v6: upsert + getById + getLatestSessionSummary ─────────────────────

test('upsertNote inserts on first call, updates on second', () => {
  const { notes } = openMemoryDb(':memory:');
  const id = 'session-summary-abc';

  const first = notes.upsertNote(id, { content: '初版摘要', importance: 1.0, sessionId: 'abc' });
  assert.equal(first.id, id);
  assert.equal(first.content, '初版摘要');
  assert.equal(notes.count(), 1);

  const second = notes.upsertNote(id, { content: '刷新的摘要', importance: 1.0, sessionId: 'abc' });
  assert.equal(notes.count(), 1, 'upsert 不应产生第二条记录');
  assert.equal(second.content, '刷新的摘要');
  assert.equal(second.createdAt, first.createdAt, 'created_at 不应变');
});

test('getNoteById returns null for missing', () => {
  const { notes } = openMemoryDb(':memory:');
  assert.equal(notes.getNoteById('nope'), null);
});

test('upsertNote FTS index stays current after update', () => {
  const { notes } = openMemoryDb(':memory:');
  const id = 'session-summary-xyz';
  notes.upsertNote(id, { content: '原始内容讨论项目 A', importance: 1.0, sessionId: 'xyz' });
  assert.equal(notes.search('项目 A').length, 1);

  notes.upsertNote(id, { content: '替换内容讨论项目 B', importance: 1.0, sessionId: 'xyz' });
  assert.equal(notes.search('项目 A').length, 0, 'UPDATE 触发器应清理旧 FTS 记录');
  assert.equal(notes.search('项目 B').length, 1);
});

test('getLatestSessionSummary returns most recent excluding current session', async () => {
  const { notes } = openMemoryDb(':memory:');
  notes.upsertNote('session-summary-old', {
    content: '旧会话摘要',
    importance: 1.0,
    sessionId: 'old',
  });
  await new Promise((r) => setTimeout(r, 5));
  notes.upsertNote('session-summary-mid', {
    content: '中间会话摘要',
    importance: 1.0,
    sessionId: 'mid',
  });
  await new Promise((r) => setTimeout(r, 5));
  notes.upsertNote('session-summary-current', {
    content: '当前会话摘要',
    importance: 1.0,
    sessionId: 'current',
  });

  // 排除当前 session,应拿到次新的
  const last = notes.getLatestSessionSummary('current');
  assert.ok(last);
  assert.equal(last.sessionId, 'mid');
  assert.equal(last.content, '中间会话摘要');

  // 无摘要数据时返回 null
  const { notes: empty } = openMemoryDb(':memory:');
  assert.equal(empty.getLatestSessionSummary('any'), null);
});

test('getLatestSessionSummary ignores regular notes without session-summary prefix', () => {
  const { notes } = openMemoryDb(':memory:');
  notes.storeNote({ content: '普通高重要度笔记', importance: 1.0, sessionId: 'other' });
  assert.equal(notes.getLatestSessionSummary('current'), null);
});
