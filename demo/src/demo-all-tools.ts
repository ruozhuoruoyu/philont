/**
 * 测试所有 8 个工具
 */

import {
  interruptChannelJs,
  runAgentLoop,
  type JsMessage,
} from '@agent/node';
import {
  withPolicy,
  AuditLog,
  createDefaultMatrix,
} from '@agent/policy';
import { createToolset } from '@agent/tools';
import { createLlmDelegate } from './llm-with-tools.js';

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║          完整工具系统演示（full profile）                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // 使用工厂直接创建并填充注册表
  const registry = createToolset({ profile: 'full' });

  console.log(`✅ 已注册 ${registry.list().length} 个工具: ${registry.list().map(t => t.name).join(', ')}\n`);

  const llmDelegate = createLlmDelegate(registry);
  const audit = new AuditLog();
  const policy = withPolicy(llmDelegate, {
    permissions: createDefaultMatrix(),
    audit,
    classifyTool: (name) => registry.classify(name),
  });

  const { controller, receiver } = interruptChannelJs();

  const messages: JsMessage[] = [
    {
      role: 'user',
      content: '使用 echo 工具输出 "Hello World"'
    },
  ];

  const outcome = await runAgentLoop(
    policy,
    messages,
    '你是一个助手，可以使用多个工具完成复杂任务。',
    receiver,
    controller,
    20
  );

  console.log('\n── 结果 ──────────────────────────────────────────');
  if (outcome.outcomeType === 'response') {
    console.log(`✅ ${outcome.text.slice(0, 200)}...`);
  } else {
    console.log(`❌ ${outcome.outcomeType}`);
  }

  console.log(`\n── 审计 ──────────────────────────────────────────`);
  console.log(`事件数: ${audit.length}  哈希链: ${audit.verify() ? '✅' : '❌'}`);
}

main().catch(console.error);
