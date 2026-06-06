import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFile, watchSkillDir } from '../src/skills/loader.js';

describe('parseSkillFile', () => {
  it('parses YAML frontmatter and markdown body', () => {
    const content = `---
name: code-review
description: Review code for quality and bugs
version: 1.0.0
---

# Code Review

## When to Use
- User asks for a code review
- User shares a pull request

## Instructions
1. Read the code carefully
2. Check for bugs and security issues
3. Suggest improvements`;

    const skill = parseSkillFile(content, '/skills/code-review.md');
    assert.equal(skill.name, 'code-review');
    assert.equal(skill.description, 'Review code for quality and bugs');
    assert.equal(skill.version, '1.0.0');
    assert.deepEqual(skill.triggerKeywords, [
      'User asks for a code review',
      'User shares a pull request',
    ]);
    assert.ok(skill.actionTemplate.includes('Read the code carefully'));
    assert.equal(skill.sourcePath, '/skills/code-review.md');
  });

  it('parses tags array in frontmatter', () => {
    const content = `---
name: test-skill
description: A test skill
metadata:
  tags: [testing, automation]
---

Body content`;

    const skill = parseSkillFile(content, '/skills/test.md');
    assert.equal(skill.name, 'test-skill');
    // metadata.tags captured as top-level metadata key
    assert.ok(skill.metadata);
  });

  it('handles missing frontmatter', () => {
    const content = `# Just a Markdown File

Some content here.`;

    const skill = parseSkillFile(content, '/skills/plain.md');
    assert.equal(skill.name, 'plain');
    assert.equal(skill.description, '');
    assert.equal(skill.actionTemplate, content.trim());
  });

  it('handles empty trigger keywords section', () => {
    const content = `---
name: no-triggers
description: Skill without triggers
---

# No Triggers

## Instructions
Just do it.`;

    const skill = parseSkillFile(content, '/skills/no-triggers.md');
    assert.deepEqual(skill.triggerKeywords, []);
  });

  it('uses filename as fallback name', () => {
    const content = `---
description: No name field
---

Content`;

    const skill = parseSkillFile(content, '/skills/my-skill.md');
    assert.equal(skill.name, 'my-skill');
  });

  it('handles CRLF line endings (Windows git checkout)', () => {
    // Windows git 默认 core.autocrlf=true 把 LF 转成 CRLF。
    // 历史 bug:parseFrontmatter regex 写死 \n,CRLF 文件 frontmatter 不匹配
    // → 9 个 bundled SKILL.md 全部 fallback 到 basename='SKILL' 互相覆盖。
    const lf = `---
name: crlf-test
description: testing CRLF
---

# CRLF Test

## When to Use
- testing line endings

## Instructions
do thing`;
    const crlf = lf.replace(/\n/g, '\r\n');

    const skill = parseSkillFile(crlf, '/x/SKILL.md');
    assert.equal(skill.name, 'crlf-test', 'CRLF 文件 frontmatter 必须能解析,name 不能 fallback 到 SKILL');
    assert.equal(skill.description, 'testing CRLF');
    assert.deepEqual(skill.triggerKeywords, ['testing line endings']);
  });

  it('extracts source field from frontmatter (v10)', () => {
    const content = `---
name: ext
description: from clawhub
source: clawhub:ext@1.2.3
---

## When to Use
- when

## Instructions
do`;

    const skill = parseSkillFile(content, '/x/ext.md');
    assert.equal(skill.source, 'clawhub:ext@1.2.3');
    // source 不应进 metadata
    assert.equal(skill.metadata?.source, undefined);
  });

  it('source 缺省 → null', () => {
    const content = `---
name: local
description: hand-written
---

## When to Use
- x

## Instructions
y`;
    const skill = parseSkillFile(content, '/x/local.md');
    assert.equal(skill.source, null);
  });

  it('rejects actionTemplate > hard cap (prompt 预算保护)', () => {
    // 默认 hard cap 64KB → 用 70KB body 触发 reject。断言去耦具体数字
    // (cap 现 env 可配),只验证 "超过 N 字节" 形态。
    const huge = 'x'.repeat(70000);
    const content = `---
name: huge
description: too big
---

## When to Use
- huge

## Instructions
${huge}`;
    assert.throws(
      () => parseSkillFile(content, '/x/huge.md'),
      /actionTemplate exceeds \d+ bytes/,
    );
  });

  it('accepts actionTemplate near but under hard cap', () => {
    // ~30KB,远超原 8KB 阈值 + 超 32KB 旧 cap,验证 64KB 新 cap 下
    // 常见多步骤 / 方法论 skill(quality-management 44KB)能加载
    const filler = 'x'.repeat(30000);
    const content = `---
name: edge
description: near cap
---

## When to Use
- edge

## Instructions
${filler}`;
    const skill = parseSkillFile(content, '/x/edge.md');
    assert.ok(skill.actionTemplate.length > 30000);
  });

  it('warns(不 reject)on actionTemplate > 16KB warn 阈值', () => {
    // 17KB:超 warn(16KB),未到 reject(64KB hard cap),应正常加载
    const filler = 'x'.repeat(17000);
    const content = `---
name: warning-zone
description: warn but load
---

## When to Use
- warn

## Instructions
${filler}`;
    const skill = parseSkillFile(content, '/x/warn.md');
    assert.ok(skill);
    assert.ok(skill.actionTemplate.length > 16384);
  });
});

describe('profiles', () => {
  it('filterByProfile returns correct tools', async () => {
    const { filterByProfile, builtinTools } = await import('../src/index.js');
    const minimal = filterByProfile(builtinTools, 'minimal');
    const names = minimal.map(t => t.name);
    assert.ok(names.includes('echo'));
    assert.ok(names.includes('readFile'));
    assert.ok(!names.includes('shell'));
    assert.ok(!names.includes('writeFile'));
  });

  it('full profile returns all tools', async () => {
    const { filterByProfile, builtinTools } = await import('../src/index.js');
    const full = filterByProfile(builtinTools, 'full');
    assert.equal(full.length, builtinTools.length);
  });

  it('custom profile extends builtin', async () => {
    const { resolveProfile } = await import('../src/index.js');
    const names = resolveProfile('research', {
      research: { extends: 'readonly', include: ['shell'] },
    });
    assert.ok(names!.includes('readFile'));
    assert.ok(names!.includes('shell'));
  });

  it('custom profile with exclude removes tools', async () => {
    const { resolveProfile } = await import('../src/index.js');
    const names = resolveProfile('safe-coding', {
      'safe-coding': { extends: 'coding', exclude: ['shell', 'process'] },
    });
    assert.ok(names!.includes('readFile'));
    assert.ok(names!.includes('writeFile'));
    assert.ok(!names!.includes('shell'));
    assert.ok(!names!.includes('process'));
  });

  it('custom profile tools field replaces entirely', async () => {
    const { resolveProfile } = await import('../src/index.js');
    const names = resolveProfile('just-time', {
      'just-time': { tools: ['time'] },
    });
    assert.deepEqual(names, ['time']);
  });

  it('detects circular references', async () => {
    const { resolveProfile } = await import('../src/index.js');
    assert.throws(() => {
      resolveProfile('a', {
        a: { extends: 'b' },
        b: { extends: 'a' },
      });
    }, /Circular/);
  });
});

describe('new tools', () => {
  it('git tool is registered', async () => {
    const { builtinTools } = await import('../src/index.js');
    const git = builtinTools.find(t => t.name === 'git');
    assert.ok(git);
    assert.equal(git.capability, 'read');
  });

  it('jsonPatch applies RFC 6902 ops', async () => {
    const { jsonPatchTool } = await import('../src/index.js');
    const r = await jsonPatchTool.execute({
      document: '{"a":1,"b":{"c":2}}',
      operations: [
        { op: 'replace', path: '/a', value: 10 },
        { op: 'add', path: '/b/d', value: 3 },
      ],
    });
    assert.equal(r.success, true);
    const parsed = JSON.parse(r.output);
    assert.equal(parsed.a, 10);
    assert.equal(parsed.b.d, 3);
  });

  it('hash tool computes sha256', async () => {
    const { hashTool } = await import('../src/index.js');
    const r = await hashTool.execute({ algorithm: 'sha256', input: 'hello' });
    assert.equal(r.success, true);
    assert.equal(r.output, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('env tool masks sensitive names by default', async () => {
    const { envTool } = await import('../src/index.js');
    process.env.FAKE_API_KEY = 'abcdefghij';
    const r = await envTool.execute({ action: 'get', name: 'FAKE_API_KEY' });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('***'));
    assert.ok(!r.output.includes('abcdefghij'));
    delete process.env.FAKE_API_KEY;
  });
});

describe('watchSkillDir', () => {
  it('triggers onChange with debounce when a new skill file appears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'philont-skill-watch-'));
    try {
      let fires = 0;
      const handle = watchSkillDir(dir, () => { fires++; }, 50);

      // 快速连续多次写入应只触发一次 debounced 回调
      await writeFile(join(dir, 'a.md'), '# a');
      await writeFile(join(dir, 'b.md'), '# b');
      await writeFile(join(dir, 'c.md'), '# c');

      // 等 debounce 窗口过去
      await new Promise((r) => setTimeout(r, 200));

      handle.close();
      assert.ok(fires >= 1, `至少触发一次,实际 ${fires}`);
      assert.ok(fires <= 2, `debounce 应聚合成一两次,实际 ${fires}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns no-op handle for non-existent directory', () => {
    const nonExistent = join(tmpdir(), 'does-not-exist-' + Date.now());
    const handle = watchSkillDir(nonExistent, () => {});
    // 不应抛错,close 可调用
    handle.close();
  });
});

describe('loadSkills 多目录与优先级', () => {
  it('扫描 <workdir>/skills/ 路径(openclaw 上游约定)', async () => {
    const { loadSkills } = await import('../src/skills/loader.js');
    const workdir = await mkdtemp(join(tmpdir(), 'philont-loadskills-'));
    try {
      // 在 openclaw 风格目录写一个 skill
      await mkdir(join(workdir, 'skills', 'foo'), { recursive: true });
      await writeFile(
        join(workdir, 'skills', 'foo', 'SKILL.md'),
        '---\nname: foo\ndescription: from skills/\n---\n## When to Use\n- f\n## Instructions\nf',
        'utf-8',
      );

      const skills = await loadSkills(workdir);
      const foo = skills.find((s) => s.name === 'foo');
      assert.ok(foo, '应从 <workdir>/skills/ 加载到 foo');
      assert.equal(foo.description, 'from skills/');
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('.philont/skills/ 优先级高于 skills/(同名覆盖)', async () => {
    const { loadSkills } = await import('../src/skills/loader.js');
    const workdir = await mkdtemp(join(tmpdir(), 'philont-loadskills-'));
    try {
      // 同 name "dup" 在两个目录都存在
      await mkdir(join(workdir, 'skills', 'dup'), { recursive: true });
      await writeFile(
        join(workdir, 'skills', 'dup', 'SKILL.md'),
        '---\nname: dup\ndescription: from skills/\n---\n## When to Use\n- a\n## Instructions\nx',
        'utf-8',
      );
      await mkdir(join(workdir, '.philont', 'skills', 'dup'), { recursive: true });
      await writeFile(
        join(workdir, '.philont', 'skills', 'dup', 'SKILL.md'),
        '---\nname: dup\ndescription: from .philont/skills/\n---\n## When to Use\n- b\n## Instructions\ny',
        'utf-8',
      );

      const skills = await loadSkills(workdir);
      const dup = skills.find((s) => s.name === 'dup');
      assert.ok(dup);
      assert.equal(dup.description, 'from .philont/skills/', '.philont/skills/ 应覆盖 skills/');
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('解析失败的 SKILL.md(超 hard cap)被跳过,不影响其他 skill 加载', async () => {
    const { loadSkills } = await import('../src/skills/loader.js');
    const workdir = await mkdtemp(join(tmpdir(), 'philont-loadskills-'));
    try {
      // 一个超大 skill(70KB,超 64KB hard cap),一个正常 skill
      await mkdir(join(workdir, '.philont', 'skills', 'huge'), { recursive: true });
      const huge = 'x'.repeat(70000);
      await writeFile(
        join(workdir, '.philont', 'skills', 'huge', 'SKILL.md'),
        `---\nname: huge\n---\n${huge}`,
        'utf-8',
      );
      await mkdir(join(workdir, '.philont', 'skills', 'small'), { recursive: true });
      await writeFile(
        join(workdir, '.philont', 'skills', 'small', 'SKILL.md'),
        '---\nname: small\ndescription: ok\n---\n## When to Use\n- x\n## Instructions\ny',
        'utf-8',
      );

      const skills = await loadSkills(workdir);
      const names = skills.map((s) => s.name).sort();
      assert.ok(names.includes('small'), 'small 应正常加载');
      assert.ok(!names.includes('huge'), 'huge 因超 64KB hard cap 应被跳过');
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});

// ── 2026-05-09 v15:when_to_use 字段 ────────────────────────────────────

describe('parseSkillFile when_to_use', () => {
  it('frontmatter 显式 when_to_use 字段优先', () => {
    const content = `---
name: a
description: x
when_to_use: 用户说 register 或 onboard 类请求
---

# A

## When to Use
- 这段在 frontmatter 已显式给场景时不会作为 fallback
- 仍解析为 triggerKeywords

## Body
abc`;
    const s = parseSkillFile(content, '/x.md');
    assert.equal(s.whenToUse, '用户说 register 或 onboard 类请求');
    // triggerKeywords 仍从正文提取(独立)
    assert.equal(s.triggerKeywords.length, 2);
  });

  it('frontmatter 无 when_to_use → fallback 提取正文 ## When to Use 段', () => {
    const content = `---
name: a
description: x
---

# A

## When to Use
- 用户给文档 URL
- 用户说 follow this doc`;
    const s = parseSkillFile(content, '/x.md');
    assert.match(s.whenToUse, /用户给文档 URL/);
    assert.match(s.whenToUse, /用户说 follow this doc/);
  });

  it('frontmatter 和正文都没有 → 空串', () => {
    const content = `---
name: a
description: x
---

# A

Body without When to Use section.`;
    const s = parseSkillFile(content, '/x.md');
    assert.equal(s.whenToUse, '');
  });

  it('frontmatter when_to_use 空字符串 → 仍 fallback 正文', () => {
    const content = `---
name: a
description: x
when_to_use:
---

## When to Use
- fallback works`;
    const s = parseSkillFile(content, '/x.md');
    // fallback 提取正文
    assert.match(s.whenToUse, /fallback works/);
  });

  it('when_to_use 不进 metadata(标准字段)', () => {
    const content = `---
name: a
description: x
when_to_use: scenario text
extraField: foo
---

body`;
    const s = parseSkillFile(content, '/x.md');
    assert.equal(s.whenToUse, 'scenario text');
    // metadata 不该含 when_to_use 但应含 extraField
    assert.ok(s.metadata, 'metadata 存在');
    assert.equal((s.metadata as Record<string, unknown>).extraField, 'foo');
    assert.ok(!('when_to_use' in (s.metadata ?? {})), 'when_to_use 不应进 metadata');
  });
});
