/**
 * installSkillTool / uninstallSkillTool 单测
 *
 * 用 process.chdir 切到 tmpdir 来隔离 .philont/skills/ 写入,避免污染开发机
 * 真实 philont 目录。每个 it 完成后 chdir 回原目录并 rm tmpdir。
 *
 * 不测 server-side hot-reload 集成(那靠 server 包的 integration test)。
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkillTool, uninstallSkillTool } from '../src/skills/installTool.js';

describe('installSkillTool', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await mkdtemp(join(tmpdir(), 'install-skill-test-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('write 模式:写新 SKILL.md 到 .philont/skills/<name>/', async () => {
    const content = `---
name: foo
description: test skill
---

# Foo

## When to Use
- testing

## Instructions
do thing`;

    const result = await installSkillTool.execute({ name: 'foo', content });
    assert.equal(result.success, true);
    assert.match(result.output, /Installed skill foo/);

    const file = join(tmpDir, '.philont', 'skills', 'foo', 'SKILL.md');
    const written = await readFile(file, 'utf-8');
    assert.match(written, /name: foo/);
    assert.match(written, /## When to Use/);
  });

  it('write 模式带 source:注入 frontmatter source 字段', async () => {
    const content = `---
name: bar
description: test
---

## When to Use
- bar

## Instructions
bar`;

    const result = await installSkillTool.execute({
      name: 'bar',
      content,
      source: 'clawhub:bar@1.0.0',
    });
    assert.equal(result.success, true);
    assert.match(result.output, /clawhub:bar@1\.0\.0/);

    const written = await readFile(
      join(tmpDir, '.philont', 'skills', 'bar', 'SKILL.md'),
      'utf-8',
    );
    assert.match(written, /^source: clawhub:bar@1\.0\.0$/m);
  });

  it('write 模式 frontmatter 缺 name:自动注入 name 字段', async () => {
    const content = `---
description: no name
---

## When to Use
- x

## Instructions
x`;

    const result = await installSkillTool.execute({ name: 'auto', content });
    assert.equal(result.success, true);

    const written = await readFile(
      join(tmpDir, '.philont', 'skills', 'auto', 'SKILL.md'),
      'utf-8',
    );
    assert.match(written, /^name: auto$/m);
  });

  it('patch 模式:已存在文件,只改 source 字段保留其他 frontmatter', async () => {
    // 先用 write 模式装一次
    const content = `---
name: pre
description: existing
version: 2.5
---

## When to Use
- pre

## Instructions
pre`;
    await installSkillTool.execute({ name: 'pre', content });

    // patch 模式打 source 标
    const result = await installSkillTool.execute({
      name: 'pre',
      source: 'clawhub:pre@2.5.0',
    });
    assert.equal(result.success, true);

    const written = await readFile(
      join(tmpDir, '.philont', 'skills', 'pre', 'SKILL.md'),
      'utf-8',
    );
    assert.match(written, /^description: existing$/m);
    assert.match(written, /^version: 2\.5$/m);
    assert.match(written, /^source: clawhub:pre@2\.5\.0$/m);
  });

  it('patch 模式:source 已存在 → 替换为新值,不重复', async () => {
    const content = `---
name: rep
description: x
source: clawhub:rep@1.0.0
---

## When to Use
- x

## Instructions
x`;
    await mkdir(join(tmpDir, '.philont', 'skills', 'rep'), { recursive: true });
    await writeFile(join(tmpDir, '.philont', 'skills', 'rep', 'SKILL.md'), content, 'utf-8');

    await installSkillTool.execute({ name: 'rep', source: 'clawhub:rep@2.0.0' });

    const written = await readFile(
      join(tmpDir, '.philont', 'skills', 'rep', 'SKILL.md'),
      'utf-8',
    );
    const matches = written.match(/^source:.*$/gm);
    assert.equal(matches?.length, 1, '只能有一个 source 行');
    assert.match(written, /clawhub:rep@2\.0\.0/);
  });

  it('patch 模式:.philont/skills 没有 fallback 到 skills/(clawhub 默认目录)', async () => {
    // 模拟用户用 `clawhub install foo` 装到默认 skills/
    const content = `---
name: cl
description: from clawhub default dir
---

## When to Use
- cl

## Instructions
cl`;
    await mkdir(join(tmpDir, 'skills', 'cl'), { recursive: true });
    await writeFile(join(tmpDir, 'skills', 'cl', 'SKILL.md'), content, 'utf-8');

    const result = await installSkillTool.execute({ name: 'cl', source: 'clawhub:cl@1.0' });
    assert.equal(result.success, true);
    assert.match(result.output, /migrated from skills\/ to \.philont\/skills/);

    // 应该出现在标准目录
    const written = await readFile(
      join(tmpDir, '.philont', 'skills', 'cl', 'SKILL.md'),
      'utf-8',
    );
    assert.match(written, /^source: clawhub:cl@1\.0$/m);
  });

  it('既无 content 又无 source → 错', async () => {
    const result = await installSkillTool.execute({ name: 'empty' });
    assert.equal(result.success, false);
    assert.match(result.error || '', /must provide at least content/);
  });

  it('patch 模式但文件不存在 → 错', async () => {
    const result = await installSkillTool.execute({
      name: 'nope',
      source: 'clawhub:nope@1.0',
    });
    assert.equal(result.success, false);
    assert.match(result.error || '', /patch mode requires the file to exist/);
  });

  it('name 路径遍历(\"..\") → 拒绝', async () => {
    const result = await installSkillTool.execute({
      name: '..',
      content: '---\nname: x\n---\nbody',
    });
    assert.equal(result.success, false);
    assert.match(result.error || '', /name/);
  });

  it('name 含路径分隔符 → 拒绝', async () => {
    const result = await installSkillTool.execute({
      name: 'foo/bar',
      content: '---\nname: x\n---\nbody',
    });
    assert.equal(result.success, false);
    assert.match(result.error || '', /\[a-z0-9_-\]/);
  });

  it('name 含大写 → 拒绝', async () => {
    const result = await installSkillTool.execute({
      name: 'Foo',
      content: '---\nname: x\n---\nbody',
    });
    assert.equal(result.success, false);
  });

  it('name 超过 64 字符 → 拒绝', async () => {
    const result = await installSkillTool.execute({
      name: 'a'.repeat(65),
      content: '---\nname: x\n---\nbody',
    });
    assert.equal(result.success, false);
    assert.match(result.error || '', /64/);
  });

  it('classification:capability=write, domain=self', () => {
    assert.equal(installSkillTool.capability, 'write');
    assert.equal(installSkillTool.domain, 'self');
  });
});

describe('uninstallSkillTool', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await mkdtemp(join(tmpdir(), 'uninstall-skill-test-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('删除存在的 .philont/skills/<name>/ 目录', async () => {
    await mkdir(join(tmpDir, '.philont', 'skills', 'doomed'), { recursive: true });
    await writeFile(
      join(tmpDir, '.philont', 'skills', 'doomed', 'SKILL.md'),
      '---\nname: doomed\n---\n',
      'utf-8',
    );

    const result = await uninstallSkillTool.execute({ name: 'doomed' });
    assert.equal(result.success, true);
    assert.match(result.output, /Uninstalled skill doomed/);

    await assert.rejects(
      stat(join(tmpDir, '.philont', 'skills', 'doomed')),
      /ENOENT/,
    );
  });

  it('幂等:目录不存在仍返回成功', async () => {
    const result = await uninstallSkillTool.execute({ name: 'nope' });
    assert.equal(result.success, true);
    assert.match(result.output, /directory was already absent/);
  });

  it('兼容 skills/ 目录(clawhub 默认装入位置)', async () => {
    await mkdir(join(tmpDir, 'skills', 'cl'), { recursive: true });
    await writeFile(join(tmpDir, 'skills', 'cl', 'SKILL.md'), '---\nname: cl\n---\n', 'utf-8');

    const result = await uninstallSkillTool.execute({ name: 'cl' });
    assert.equal(result.success, true);

    await assert.rejects(stat(join(tmpDir, 'skills', 'cl')), /ENOENT/);
  });

  it('两个目录都有时都删', async () => {
    await mkdir(join(tmpDir, '.philont', 'skills', 'both'), { recursive: true });
    await mkdir(join(tmpDir, 'skills', 'both'), { recursive: true });
    await writeFile(join(tmpDir, '.philont', 'skills', 'both', 'SKILL.md'), '---\nname: both\n---\n', 'utf-8');
    await writeFile(join(tmpDir, 'skills', 'both', 'SKILL.md'), '---\nname: both\n---\n', 'utf-8');

    const result = await uninstallSkillTool.execute({ name: 'both' });
    assert.equal(result.success, true);

    await assert.rejects(stat(join(tmpDir, '.philont', 'skills', 'both')), /ENOENT/);
    await assert.rejects(stat(join(tmpDir, 'skills', 'both')), /ENOENT/);
  });

  it('name 校验:同 install,空字符串拒绝', async () => {
    const result = await uninstallSkillTool.execute({ name: '' });
    assert.equal(result.success, false);
  });

  it('classification:capability=write, domain=self', () => {
    assert.equal(uninstallSkillTool.capability, 'write');
    assert.equal(uninstallSkillTool.domain, 'self');
  });
});
