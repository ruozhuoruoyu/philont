/**
 * 演示内驱引擎系统（概念验证）
 *
 * 注意：这是一个简化的演示，展示了内驱引擎的核心概念。
 * 完整的引擎集成需要在 Rust 侧的 run_agent_loop 中启动后台任务。
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
  console.log('║          内驱引擎概念演示                                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  console.log('✅ 已实现 3 个核心引擎（Rust 侧）：');
  console.log('   1. CuriosityEngine - 好奇心引擎（检测关键词）');
  console.log('   2. ContextOverflowMonitor - 上下文溢出监控');
  console.log('   3. ValueAlignmentMonitor - 价值一致性监控\n');

  const registry = createToolset({ profile: 'minimal' });

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
      content: '使用 echo 工具输出 "Hello from Drive Engine Demo"'
    },
  ];

  const outcome = await runAgentLoop(
    policy,
    messages,
    '你是一个助手。',
    receiver,
    controller,
    10
  );

  console.log('\n── 结果 ──────────────────────────────────────────');
  if (outcome.outcomeType === 'response') {
    console.log(`✅ ${outcome.text?.slice(0, 100) || '(empty)'}...`);
  } else {
    console.log(`状态: ${outcome.outcomeType}`);
  }

  console.log(`\n── 审计 ──────────────────────────────────────────`);
  console.log(`事件数: ${audit.length}  哈希链: ${audit.verify() ? '✅' : '❌'}`);

  console.log('\n📝 下一步：集成引擎到 run_agent_loop');
  console.log('   - 在 LoopConfig 中添加 DriveRegistry');
  console.log('   - 启动引擎后台任务监听 AgentState');
  console.log('   - 引擎通过 InterruptController 发送信号\n');
}

main().catch(console.error);
