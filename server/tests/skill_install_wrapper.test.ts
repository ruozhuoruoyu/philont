/**
 * skill_install_wrapper 单测
 *
 * 验证:install/uninstallSkill 包装后,execute 边界即"装入完成且 SkillStore 已可见"边界。
 * 这条不变量是 P0 bug "用户对话里 installSkill ✓ → use_skill ⚠ 不存在" 的根治契约。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@agent/policy';
import { wrapSkillToolWithReload } from '../src/skill_install_wrapper.js';

function makeFakeTool(opts: {
  success: boolean;
  output?: string;
  error?: string;
  onExecute?: () => void;
}): Tool {
  return {
    name: 'fakeTool',
    description: 'fake',
    schema: { type: 'object', properties: {} },
    capability: 'write',
    domain: 'self',
    async execute() {
      opts.onExecute?.();
      if (opts.success) {
        return { success: true, output: opts.output ?? 'ok' };
      }
      return { success: false, output: '', error: opts.error ?? 'fail' };
    },
  };
}

test('wrapSkillToolWithReload: success → reload 被调用一次', async () => {
  let reloadCalls = 0;
  const wrapped = wrapSkillToolWithReload(
    makeFakeTool({ success: true }),
    async () => { reloadCalls++; },
  );
  const r = await wrapped.execute({});
  assert.equal(r.success, true);
  assert.equal(r.output, 'ok');
  assert.equal(reloadCalls, 1);
});

test('wrapSkillToolWithReload: 失败 → reload 不调用', async () => {
  let reloadCalls = 0;
  const wrapped = wrapSkillToolWithReload(
    makeFakeTool({ success: false, error: 'name 不合法' }),
    async () => { reloadCalls++; },
  );
  const r = await wrapped.execute({});
  assert.equal(r.success, false);
  assert.equal(r.error, 'name 不合法');
  assert.equal(reloadCalls, 0);
});

test('wrapSkillToolWithReload: reload 抛错 → 原 result 不变', async () => {
  // 不变量:文件已写盘成功,reload 失败属于运行环境问题。LLM 不该看到自相矛盾的
  // ⚠ + 文件已存在状态;只在 console 留 warn 给运维。
  const wrapped = wrapSkillToolWithReload(
    makeFakeTool({ success: true, output: '已装入' }),
    async () => { throw new Error('SkillStore 挂了'); },
  );
  const r = await wrapped.execute({});
  assert.equal(r.success, true);
  assert.equal(r.output, '已装入');
});

test('wrapSkillToolWithReload: reload 在原 execute 之后跑(顺序保证)', async () => {
  // 关键时序:execute 必须先于 reload —— 文件得先写盘,reload 才能从 fs 拿到新内容。
  // 否则 reload 跑早一步 → 看到旧文件 → DB 状态没刷 → 同 turn use_skill 还是失败。
  const events: string[] = [];
  const wrapped = wrapSkillToolWithReload(
    makeFakeTool({
      success: true,
      onExecute: () => { events.push('execute'); },
    }),
    async () => { events.push('reload'); },
  );
  await wrapped.execute({});
  assert.deepEqual(events, ['execute', 'reload']);
});

test('wrapSkillToolWithReload: schema/capability/domain 透传不丢', async () => {
  // 包装不能改 tool 元信息 —— policyGate 靠 capability×domain 决策,丢任何字段都触发权限错位。
  const original = makeFakeTool({ success: true });
  const wrapped = wrapSkillToolWithReload(original, async () => {});
  assert.equal(wrapped.name, original.name);
  assert.equal(wrapped.description, original.description);
  assert.equal(wrapped.capability, original.capability);
  assert.equal(wrapped.domain, original.domain);
  assert.deepEqual(wrapped.schema, original.schema);
});

// ── 端到端集成:这条测试直接复现用户报告的 bug 场景 ─────────────────────
// "installSkill ✓ → 立即 use_skill ⚠ 不存在",修好后应当 SkillStore.getByName ≠ null。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb, importSkills } from '@agent/memory';
import { installSkillTool, loadSkills } from '@agent/tools';

test('集成:installSkill execute 后 SkillStore 立即可见(P0 bug 复现)', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'philont-skill-install-'));
  const origCwd = process.cwd();
  process.chdir(tmpRoot);
  // openMemoryDb(':memory:') 间接拿到 SkillStore,避免 server 包直接 import
  // better-sqlite3(它只是 @agent/memory 的传递依赖,不在 server.dependencies)。
  const memory = openMemoryDb(':memory:');
  try {
    // 复刻 chat-handler 的 reloadSkillsFromDisk 简化版:扫 cwd → importSkills
    const reload = async () => {
      const parsed = await loadSkills(process.cwd(), []);
      if (parsed.length > 0) {
        importSkills(memory.skills, parsed, { onConflict: 'replace' });
      }
    };

    const wrapped = wrapSkillToolWithReload(installSkillTool, reload);

    const skillContent = `---
name: pdf-to-word-camscanner
description: 用 CamScanner API 将 PDF 转 Word
---

# 步骤
1. upload_file
2. convert_pdf
3. download_file
`;

    const result = await wrapped.execute({
      name: 'pdf-to-word-camscanner',
      content: skillContent,
    });

    assert.equal(result.success, true);

    // P0 不变量:execute 返回后 SkillStore 必须可查 —— 不依赖 fs.watch debounce
    const skill = memory.skills.getByName('pdf-to-word-camscanner');
    assert.ok(skill, 'SkillStore.getByName 应当返回非 null —— 这正是 P0 bug 的契约');
    assert.equal(skill!.name, 'pdf-to-word-camscanner');
    assert.match(skill!.actionTemplate, /upload_file/);
  } finally {
    process.chdir(origCwd);
    memory.close();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
