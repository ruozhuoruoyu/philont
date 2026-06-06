/**
 * 权限矩阵演示：展示 3x3 矩阵如何控制工具访问
 *
 * 新增：事前拦截模式（createToolChecker）
 * 对比：事后记录 vs 事前拦截
 *
 *          local   network   system
 * read       ✓        ✓        ✗
 * write      ✓        ✗        ✗
 * execute    ✗        ✗        ✗
 */

import {
  createDefaultMatrix,
  checkToolPermission,
  createToolChecker,
  AuditLog,
  type PermissionMatrix
} from '@agent/policy';
import { createToolset } from '@agent/tools';

// 用自定义 profile 覆盖 4 种能力×域组合
const registry = createToolset({
  profile: 'matrix-demo',
  customProfiles: {
    'matrix-demo': {
      tools: ['readFile', 'writeFile', 'http', 'shell'],
    },
  },
});

// ── 场景 1：传统事后检查 ─────────────────────────────────────────────────────

async function testPostExecution() {
  const matrix = createDefaultMatrix();

  console.log('场景 1：事后检查（原方式）\n' + '='.repeat(50));

  const tests = [
    { tool: 'readFile',  params: { path: './test.txt' } },
    { tool: 'writeFile', params: { path: './test.txt', content: 'hello' } },
    { tool: 'http',      params: { url: 'https://example.com' } },
    { tool: 'shell',     params: { command: 'ls' } },
  ];

  for (const test of tests) {
    const allowed = checkToolPermission(matrix, test.tool, (name) => registry.classify(name));
    console.log(`\n${test.tool}: ${allowed ? '✅ 允许' : '❌ 拒绝'}`);

    if (allowed) {
      const result = await registry.execute(test.tool, test.params);
      console.log(`  结果: ${result.success ? '成功' : '失败'}`);
    }
  }
}

// ── 场景 2：事前拦截（新方式，供 Rust 内核 FFI 调用）────────────────────────

async function testPreExecution() {
  const audit = new AuditLog();
  const matrix = createDefaultMatrix();

  console.log('\n\n场景 2：事前拦截（createToolChecker）\n' + '='.repeat(50));
  console.log('模拟 Rust 内核在工具执行前调用 checker\n');

  const checker = createToolChecker({
    permissions: matrix,
    audit,
    classifyTool: (name) => registry.classify(name),
  });

  const tests = [
    { toolName: 'readFile',  approval: 'never',  params: '{"path":"./test.txt"}' },
    { toolName: 'writeFile', approval: 'never',  params: '{"path":"./test.txt","content":"hello"}' },
    { toolName: 'http',      approval: 'never',  params: '{"url":"https://example.com"}' },
    { toolName: 'shell',     approval: 'never',  params: '{"command":"ls"}' },
    { toolName: 'unknown',   approval: 'always', params: '{}' },
  ];

  for (const test of tests) {
    const denial = await checker(test);
    if (denial === null) {
      console.log(`${test.toolName}: ✅ 放行（工具可以执行）`);
    } else {
      console.log(`${test.toolName}: ❌ 拒绝 — ${denial}`);
      console.log(`  ↳ 工具未执行，LLM 收到 "Permission denied" 错误`);
    }
  }

  // 展示审计日志
  console.log(`\n审计日志: ${audit.length} 条事件`);
  const events = audit.getEvents();
  for (const evt of events) {
    console.log(`  [${evt.type}] ${JSON.stringify(evt.data)}`);
  }

  // 验证链完整性
  console.log(`\n审计链完整性: ${audit.verify() ? '✅ 完好' : '❌ 已篡改'}`);
}

// 运行
await testPostExecution();
await testPreExecution();
console.log('\n✅ 权限矩阵测试完成\n');
