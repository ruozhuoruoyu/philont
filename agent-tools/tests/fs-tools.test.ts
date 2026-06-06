import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepTool, globTool, patchTool } from '../src/index.js';

const TMP = join(tmpdir(), `philont-fs-test-${Date.now()}`);

describe('grep', () => {
  before(async () => {
    await mkdir(join(TMP, 'src'), { recursive: true });
    await writeFile(join(TMP, 'src', 'a.ts'), 'export function foo() {}\nconst BAR = 1;\n');
    await writeFile(join(TMP, 'src', 'b.ts'), 'export function bar() {}\nconst FOO = 2;\n');
    await writeFile(join(TMP, 'src', 'c.js'), 'var x = foo;\n');
    await writeFile(join(TMP, 'README.md'), '# project\nfoo and bar\n');
  });

  after(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it('finds pattern in files', async () => {
    const r = await grepTool.execute({ pattern: 'function', path: TMP });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('a.ts'));
    assert.ok(r.output.includes('b.ts'));
  });

  it('filters by extensions', async () => {
    const r = await grepTool.execute({
      pattern: 'foo',
      path: TMP,
      extensions: ['.ts'],
    });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('a.ts'));
    assert.ok(!r.output.includes('c.js'));
    assert.ok(!r.output.includes('README.md'));
  });

  it('respects case insensitivity', async () => {
    const ci = await grepTool.execute({
      pattern: 'FOO',
      path: TMP,
      caseSensitive: false,
    });
    assert.equal(ci.success, true);
    assert.ok(ci.output.includes('a.ts')); // matches "foo" in a.ts
    assert.ok(ci.output.includes('b.ts')); // matches "FOO" in b.ts
  });

  it('respects maxMatches limit', async () => {
    const r = await grepTool.execute({
      pattern: '.',  // matches every line
      path: TMP,
      maxMatches: 2,
    });
    assert.equal(r.success, true);
    const matchLines = r.output.split('\n').filter((l) => l.match(/\.(ts|js|md):\d+:/));
    assert.ok(matchLines.length <= 2);
  });

  it('rejects invalid regex', async () => {
    const r = await grepTool.execute({ pattern: '[invalid', path: TMP });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('Invalid regex'));
  });

  it('returns no-match message for empty results', async () => {
    const r = await grepTool.execute({ pattern: 'XXXNOTEXIST', path: TMP });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('No matches'));
  });
});

describe('glob', () => {
  before(async () => {
    await mkdir(join(TMP, 'gsrc', 'deep', 'nested'), { recursive: true });
    await writeFile(join(TMP, 'gsrc', 'a.ts'), '');
    await writeFile(join(TMP, 'gsrc', 'a.test.ts'), '');
    await writeFile(join(TMP, 'gsrc', 'b.js'), '');
    await writeFile(join(TMP, 'gsrc', 'deep', 'c.ts'), '');
    await writeFile(join(TMP, 'gsrc', 'deep', 'nested', 'd.ts'), '');
  });

  after(async () => {
    await rm(join(TMP, 'gsrc'), { recursive: true, force: true });
  });

  it('matches **/*.ts across nested dirs', async () => {
    const r = await globTool.execute({
      pattern: '**/*.ts',
      cwd: join(TMP, 'gsrc'),
    });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('a.ts'));
    assert.ok(r.output.includes('c.ts'));
    assert.ok(r.output.includes('d.ts'));
    assert.ok(!r.output.includes('b.js'));
  });

  it('supports brace expansion', async () => {
    const r = await globTool.execute({
      pattern: '*.{js,ts}',
      cwd: join(TMP, 'gsrc'),
    });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('a.ts'));
    assert.ok(r.output.includes('b.js'));
    assert.ok(!r.output.includes('c.ts')); // in deep/, not top-level
  });

  it('single * does not cross directory boundary', async () => {
    const r = await globTool.execute({
      pattern: '*.ts',
      cwd: join(TMP, 'gsrc'),
    });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('a.ts'));
    assert.ok(!r.output.includes('d.ts'));
  });

  it('returns empty message when no match', async () => {
    const r = await globTool.execute({
      pattern: '**/*.nope',
      cwd: join(TMP, 'gsrc'),
    });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('No files matching'));
  });
});

describe('patch', () => {
  const FILE = join(TMP, 'patch-target.txt');

  before(async () => {
    await mkdir(TMP, { recursive: true });
  });

  it('replaces unique text', async () => {
    await writeFile(FILE, 'Hello OLD_NAME, welcome!');
    const r = await patchTool.execute({
      path: FILE,
      mode: 'replace',
      oldText: 'OLD_NAME',
      newText: 'World',
    });
    assert.equal(r.success, true);
    const content = await readFile(FILE, 'utf-8');
    assert.equal(content, 'Hello World, welcome!');
  });

  it('rejects non-unique replacement', async () => {
    await writeFile(FILE, 'foo foo foo');
    const r = await patchTool.execute({
      path: FILE,
      mode: 'replace',
      oldText: 'foo',
      newText: 'bar',
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('3 times'));
  });

  it('rejects missing oldText', async () => {
    await writeFile(FILE, 'content');
    const r = await patchTool.execute({
      path: FILE,
      mode: 'replace',
      oldText: 'missing',
      newText: 'new',
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('not found'));
  });

  it('prepend adds to start', async () => {
    await writeFile(FILE, 'body');
    const r = await patchTool.execute({
      path: FILE,
      mode: 'prepend',
      newText: 'head\n',
    });
    assert.equal(r.success, true);
    const content = await readFile(FILE, 'utf-8');
    assert.equal(content, 'head\nbody');
  });

  it('append adds to end', async () => {
    await writeFile(FILE, 'head\n');
    const r = await patchTool.execute({
      path: FILE,
      mode: 'append',
      newText: 'tail',
    });
    assert.equal(r.success, true);
    const content = await readFile(FILE, 'utf-8');
    assert.equal(content, 'head\ntail');
  });

  it('prepend creates file if missing', async () => {
    const newFile = join(TMP, 'new-from-prepend.txt');
    const r = await patchTool.execute({
      path: newFile,
      mode: 'prepend',
      newText: 'created\n',
    });
    assert.equal(r.success, true);
    const content = await readFile(newFile, 'utf-8');
    assert.equal(content, 'created\n');
  });

  after(async () => {
    await rm(TMP, { recursive: true, force: true });
  });
});
