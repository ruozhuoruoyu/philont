/**
 * 预填示例记忆数据，便于 dashboard 演示
 *
 * 用法：MEMORY_DB_PATH=./memory.sqlite npx tsx scripts/seed-memory.ts
 */

import { openMemoryDb } from '@agent/memory';

const dbPath = process.env.MEMORY_DB_PATH || './memory.sqlite';
const memory = openMemoryDb(dbPath);

console.log(`填充示例数据到 ${dbPath}\n`);

// ── 用户事实 ───────────────────────────────────────────────────────────
memory.facts.storeFact({ namespace: 'user', key: 'name', value: '张三' });
memory.facts.storeFact({ namespace: 'user', key: 'city', value: '北京' });
memory.facts.storeFact({ namespace: 'user', key: 'role', value: 'Rust developer' });
memory.facts.storeFact({
  namespace: 'user',
  key: 'preferences',
  value: { editor: 'vscode', shell: 'zsh', tabs_or_spaces: 'spaces' },
});

// ── 项目事实 ───────────────────────────────────────────────────────────
memory.facts.storeFact({ namespace: 'project', key: 'name', value: 'philont' });
memory.facts.storeFact({ namespace: 'project', key: 'language', value: 'Rust + TypeScript' });
memory.facts.storeFact({
  namespace: 'project',
  key: 'repo_url',
  value: 'github.com/acme/philont',
});
memory.facts.storeFact({
  namespace: 'project',
  key: 'tech_stack',
  value: ['Rust', 'tokio', 'TypeScript', 'SQLite', 'napi-rs'],
});

// ── 决策记录 ───────────────────────────────────────────────────────────
memory.facts.storeFact({
  namespace: 'decisions',
  key: 'memory_storage',
  value: {
    choice: 'SQLite + namespace KV',
    rationale: '轻量、无外部依赖、足够灵活',
    decided_at: '2026-04-12',
  },
});
memory.facts.storeFact({
  namespace: 'decisions',
  key: 'sandbox_strategy',
  value: {
    choice: 'Process-level via subprocess',
    rationale: '提供真正的内存隔离，超时可强制 kill',
  },
});

// ── 技能 ───────────────────────────────────────────────────────────────
memory.skills.createSkill({
  name: 'rust-build-and-test',
  description: '构建并测试 Rust 项目：先 release 编译，再跑测试',
  triggerKeywords: ['部署', '构建', '测试', 'deploy', 'build', 'test', 'rust'],
  actionTemplate:
    '# Rust 项目构建测试流程\n\n' +
    '1. 执行 `cargo build --release`\n' +
    '2. 如果构建失败，定位错误并报告\n' +
    '3. 构建成功后执行 `cargo test`\n' +
    '4. 报告失败的 test name\n' +
    '5. 全部通过返回构建产物路径',
});

memory.skills.createSkill({
  name: 'git-status-and-push',
  description: '检查 git 状态并推送到远程',
  triggerKeywords: ['git', 'push', '推送', 'commit'],
  actionTemplate:
    '# Git 推送流程\n\n' +
    '1. `git status` 查看修改\n' +
    '2. `git diff` 确认变更内容\n' +
    '3. 如果有未跟踪文件，询问用户\n' +
    '4. `git add` + `git commit -m "..."`\n' +
    '5. `git push`',
});
memory.skills.incrementUseCount('git-status-and-push');
memory.skills.incrementUseCount('git-status-and-push');
memory.skills.incrementUseCount('git-status-and-push');

memory.skills.createSkill({
  name: 'debug-typescript-error',
  description: '诊断 TypeScript 编译错误并提供修复建议',
  triggerKeywords: ['typescript', 'tsc', 'type error', '类型错误'],
  actionTemplate:
    '# TypeScript 错误诊断\n\n' +
    '1. 运行 `npx tsc --noEmit` 收集所有错误\n' +
    '2. 按错误码分类（TS2307 模块、TS2322 类型、TS2339 属性...）\n' +
    '3. 对每个错误读相关文件\n' +
    '4. 提供具体修复建议',
});
memory.skills.incrementUseCount('debug-typescript-error');

// ── 笔记 ───────────────────────────────────────────────────────────────
memory.notes.storeNote({
  content: '用户讨论了 Rust borrow checker 的痛点，倾向用 owned 类型避免生命周期复杂化',
  importance: 0.7,
});
memory.notes.storeNote({
  content: '项目采用 module-per-feature 结构，每个特性独立目录',
  importance: 0.8,
});
memory.notes.storeNote({
  content: '上次会话中讨论了缓存策略，决定使用 prompt cache 而非自建缓存',
  importance: 0.9,
});

// ── 一个示例会话 ───────────────────────────────────────────────────────
const session = memory.raw.startSession();
memory.raw.appendMessage({
  sessionId: session.id,
  role: 'user',
  content: '帮我看看项目当前状态',
});
memory.raw.appendMessage({
  sessionId: session.id,
  role: 'assistant',
  content: '好的，正在检查...',
});
memory.actions.log({
  sessionId: session.id,
  toolName: 'shell',
  params: { command: 'git status' },
  result: 'On branch main, nothing to commit',
  success: true,
});
memory.raw.endSession(session.id);

// ── 输出 ───────────────────────────────────────────────────────────────
console.log('✅ 示例数据填充完成');
console.log(`  - 事实: ${memory.facts.count()}`);
console.log(`  - 技能: ${memory.skills.count()}`);
console.log(`  - 笔记: ${memory.notes.count()}`);
console.log(`  - 动作: ${memory.actions.count()}`);
console.log(`  - 会话: ${memory.raw.listRecentSessions().length}`);
console.log(`\n现在可以启动 server 并访问 dashboard：`);
console.log(`  cd server && npm run dev`);
console.log(`  cd web-ui && npm run dev`);
