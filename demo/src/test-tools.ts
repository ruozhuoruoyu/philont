/**
 * 工具系统测试示例
 */

import {
  ToolRegistry,
  createDefaultMatrix,
  checkToolPermission,
  AuditLog,
} from '@agent/policy';
import {
  echoTool,
  timeTool,
  readFileTool,
  writeFileTool,
  shellTool,
} from '@agent/tools';

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          工具系统测试                                      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // 1. 创建工具注册表
  const registry = new ToolRegistry();
  registry.register(echoTool);
  registry.register(timeTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(shellTool);

  console.log(`✅ 已注册 ${registry.list().length} 个工具\n`);

  // 2. 权限矩阵
  const matrix = createDefaultMatrix();
  const audit = new AuditLog();

  // 3. 测试工具
  const tests = [
    { name: 'echo', params: { message: 'Hello AgentCore!' } },
    { name: 'time', params: { format: 'iso' } },
    { name: 'writeFile', params: { path: '/tmp/test.txt', content: 'Test content' } },
    { name: 'readFile', params: { path: '/tmp/test.txt' } },
    { name: 'shell', params: { command: 'echo "Shell test"' } },
  ];

  for (const test of tests) {
    console.log(`\n── 测试工具: ${test.name} ──────────────────────────────`);

    // 权限检查
    const classification = registry.classify(test.name);
    if (classification) {
      const allowed = checkToolPermission(matrix, test.name, () => classification);
      console.log(`  权限: ${allowed ? '✅ 允许' : '❌ 拒绝'} (${classification.capability}/${classification.domain})`);

      if (!allowed) {
        audit.append('permission_denied', { toolName: test.name });
        continue;
      }
    }

    // 执行工具
    audit.append('tool_call', { toolName: test.name, params: test.params });
    const result = await registry.execute(test.name, test.params);

    if (result.success) {
      console.log(`  结果: ${result.output.slice(0, 60)}${result.output.length > 60 ? '...' : ''}`);
      console.log(`  耗时: ${result.duration}ms`);
    } else {
      console.log(`  错误: ${result.error}`);
    }
  }

  console.log('\n\n── 审计日志 ────────────────────────────────────────');
  console.log(`事件数: ${audit.length}  哈希链: ${audit.verify() ? '✅' : '❌'}`);
}

main().catch(console.error);
