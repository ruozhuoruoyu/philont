/**
 * 带工具调用的完整示例
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
  console.log('║          LLM + 工具调用示例                                ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // 1. 用自定义 profile 创建工具集（最小 + writeFile）
  const registry = createToolset({
    profile: 'demo',
    customProfiles: {
      demo: { extends: 'minimal', include: ['writeFile'] },
    },
  });

  console.log(`✅ 已注册 ${registry.list().length} 个工具\n`);

  // 2. 创建 delegate
  const llmDelegate = createLlmDelegate(registry);

  // 3. 添加策略层
  const audit = new AuditLog();
  const policy = withPolicy(llmDelegate, {
    permissions: createDefaultMatrix(),
    audit,
    classifyTool: (name) => registry.classify(name),
  });

  // 4. 运行 Agent
  const { controller, receiver } = interruptChannelJs();

  const messages: JsMessage[] = [
    { role: 'user', content: '请使用 echo 工具输出 "Hello from tool!"' },
  ];

  const outcome = await runAgentLoop(
    policy,
    messages,
    '你是一个助手，可以使用工具完成任务。',
    receiver,
    controller,
    10
  );

  console.log('\n── 结果 ──────────────────────────────────────────');
  if (outcome.outcomeType === 'response') {
    console.log(`✅ ${outcome.text}`);
  } else {
    console.log(`❌ ${outcome.outcomeType}`);
  }

  console.log(`\n── 审计 ──────────────────────────────────────────`);
  console.log(`事件数: ${audit.length}  哈希链: ${audit.verify() ? '✅' : '❌'}`);

  for (const event of audit.getEvents()) {
    console.log(`  ${event.type.padEnd(20)} ${JSON.stringify(event.data).slice(0, 50)}`);
  }
}

main().catch(console.error);
