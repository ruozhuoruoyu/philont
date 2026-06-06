/**
 * end-to-end Demo：三层架构完整演示
 *
 * 层1 agent-core（由 mock-agent-node 模拟 Rust 行为）
 *   └─ interruptChannelJs()  中断通道
 *   └─ runAgentLoop()        中断驱动主循环
 *
 * 层2 agent-policy（TypeScript，真实运行）
 *   └─ withPolicy()          权限检查 + 审计日志装饰器
 *   └─ AuditLog              SHA-256 哈希链
 *
 * 层3 应用层（本文件）
 *   └─ 实现 step() + onInterrupt()
 *   └─ 模拟内驱引擎（DriveEngine）发出 CuriosityTriggered
 *   └─ 模拟外驱（用户 SteerMessage）
 *
 * 切换到真实 Rust 内核：将第一行 import 改为 '@agent/node'
 */

// ── 导入 ─────────────────────────────────────────────────────────────────────

// 已切换到真实 Rust 内核：
// mock 路径: './mock-agent-node.js'
import {
  interruptChannelJs,
  runAgentLoop,
  type JsStepInput,
  type JsStepResult,
  type JsInterruptInput,
  type JsInterruptAction,
  type JsMessage,
} from '@agent/node';

import {
  withPolicy,
  AuditLog,
  createDefaultMatrix,
  type Delegate,
} from '@agent/policy';

// ── 应用层 Delegate ───────────────────────────────────────────────────────────

/**
 * 模拟 LLM Delegate
 *
 * 真实场景下，step() 会调用 Anthropic SDK：
 *   const resp = await anthropic.messages.create({ model: 'claude-opus-4-6', messages, ... });
 */
const appDelegate: Delegate = {
  async step(input: JsStepInput): Promise<JsStepResult> {
    const lastUser = [...input.messages].reverse().find(m => m.role === 'user');
    const content  = lastUser?.content ?? '';

    console.log(
      `  [LLM] iter=${input.iteration} mode=${input.mode} ` +
      `msgs=${input.messages.length} prompt="${content.slice(0, 30)}"`
    );

    // 模拟 LLM 响应（真实场景替换为 Anthropic API 调用）
    await sleep(80); // 模拟网络延迟

    // 第一轮 Normal 模式：continue，让中断信号在下一轮开头被捕获
    // （模拟多步 Agent 行为；真实 LLM 可能第一步就返回工具调用而非最终答案）
    if (input.iteration === 1 && input.mode === 'Normal') {
      return { action: 'continue' };
    }

    if (content.includes('量子')) {
      return {
        action: 'done',
        outcome: {
          outcomeType: 'response',
          text: '量子纠缠（Quantum Entanglement）是量子力学的核心现象：' +
                '两个粒子的状态相互关联，测量其中一个会瞬间影响另一个，' +
                '无论它们相距多远。这正是量子计算机并行计算能力的基础。',
        },
      };
    }

    if (content.includes('探索')) {
      return {
        action: 'done',
        outcome: {
          outcomeType: 'response',
          text: `深入探索：${content.replace('请深入探索：', '')}` +
                ' ——这是一个值得持续研究的方向。',
        },
      };
    }

    return {
      action: 'done',
      outcome: {
        outcomeType: 'response',
        text: `你好！我收到了你的消息："${content}"`,
      },
    };
  },

  async onInterrupt(input: JsInterruptInput): Promise<JsInterruptAction> {
    const { signalType, payload } = input.signal;
    console.log(`  [中断] ${signalType}${payload ? ': ' + payload : ''}`);

    switch (signalType) {
      case 'CuriosityTriggered':
        // 内驱好奇心 → 注入探索方向（NORMAL 级，不打断步骤）
        return { action: 'injectMessage', message: `请深入探索：${payload}` };

      case 'SteerMessage':
        // 外驱引导 → 注入用户消息（HIGH 级，在下一步前处理）
        return { action: 'injectMessage', message: payload ?? '' };

      case 'UserHardStop':
        // 外驱强停（CRITICAL）→ 循环已终止，不会进入此分支
        return { action: 'terminate', reason: 'User requested stop' };

      default:
        return { action: 'continue' };
    }
  },
};

// ── 场景1：基础对话 + 内驱好奇心 ─────────────────────────────────────────────

async function scenarioBasic() {
  console.log('\n' + '═'.repeat(60));
  console.log('场景1：基础对话 + 内驱 CuriosityTriggered');
  console.log('═'.repeat(60));

  const audit  = new AuditLog();
  const policy = withPolicy(appDelegate, {
    permissions: createDefaultMatrix(),
    audit,
  });

  const { controller, receiver } = interruptChannelJs();

  // 模拟内驱引擎：100ms 后检测到"量子"关键词，发出好奇心信号（NORMAL 级）
  setTimeout(() => {
    console.log('\n  [DriveEngine] 检测到「量子」，发出 CuriosityTriggered (NORMAL)');
    controller.sendNormal({ signalType: 'CuriosityTriggered', payload: '量子纠缠' });
  }, 100);

  const messages: JsMessage[] = [
    { role: 'user', content: '给我介绍一下量子计算机的原理' },
  ];

  const outcome = await runAgentLoop(policy, messages, '你是一位量子物理专家', receiver, controller, 5);

  printResult(outcome, audit);
}

// ── 场景2：外驱引导（HIGH 中断）────────────────────────────────────────────

async function scenarioSteer() {
  console.log('\n' + '═'.repeat(60));
  console.log('场景2：外驱 SteerMessage（HIGH 中断改变方向）');
  console.log('═'.repeat(60));

  const audit  = new AuditLog();
  const policy = withPolicy(appDelegate, {
    permissions: createDefaultMatrix(),
    audit,
  });

  const { controller, receiver } = interruptChannelJs();

  // 模拟用户在 loop 运行中途发送新指令（HIGH 级）
  setTimeout(() => {
    console.log('\n  [User] 发送 SteerMessage (HIGH)：改变话题');
    controller.steer('不聊量子了，请介绍一下黑洞');
  }, 50);

  const messages: JsMessage[] = [
    { role: 'user', content: '给我介绍一下量子计算机的原理' },
  ];

  const outcome = await runAgentLoop(policy, messages, null, receiver, controller, 5);

  printResult(outcome, audit);
}

// ── 场景3：外驱强停（CRITICAL 中断）─────────────────────────────────────────

async function scenarioHardStop() {
  console.log('\n' + '═'.repeat(60));
  console.log('场景3：外驱 UserHardStop（CRITICAL 立即终止）');
  console.log('═'.repeat(60));

  const audit  = new AuditLog();
  const policy = withPolicy(appDelegate, {
    permissions: createDefaultMatrix(),
    audit,
  });

  const { controller, receiver } = interruptChannelJs();

  // 模拟用户在第一步完成前发出强停（CRITICAL 级）
  // 由于 step() 需要 80ms，而强停在 30ms 发出，
  // 但 mock 循环在 step await 完成后才检查队列（下一轮迭代开头）
  // 所以强停在第二轮迭代开始时被捕获
  setTimeout(() => {
    console.log('\n  [User] 发送 UserHardStop (CRITICAL)');
    controller.hardStop();
  }, 30);

  const messages: JsMessage[] = [
    { role: 'user', content: '给我写一篇关于量子计算的长文章' },
  ];

  const outcome = await runAgentLoop(policy, messages, null, receiver, controller, 10);

  printResult(outcome, audit);
}

// ── 场景4：频率限制（PolicyDelegate 拦截）───────────────────────────────────

async function scenarioRateLimit() {
  console.log('\n' + '═'.repeat(60));
  console.log('场景4：频率限制（agent-policy 在达到限制后终止）');
  console.log('═'.repeat(60));

  const audit  = new AuditLog();
  // 策略：每分钟最多 2 步
  const policy = withPolicy(appDelegate, {
    permissions:        createDefaultMatrix(),
    audit,
    maxStepsPerMinute:  2,
  });

  const { receiver } = interruptChannelJs();

  // continueDelegate：不停返回 continue，触发多次步骤
  const loopDelegate: Delegate = {
    async step(input) {
      if (input.iteration >= 3) {
        // 第3次步骤会被频率限制器拦截，不会到达这里
        return { action: 'done', outcome: { outcomeType: 'response', text: 'ok' } };
      }
      return { action: 'continue' };
    },
    async onInterrupt() { return { action: 'continue' }; },
  };

  const wrappedLoop = withPolicy(loopDelegate, {
    permissions:       createDefaultMatrix(),
    audit,
    maxStepsPerMinute: 2,
  });

  const messages: JsMessage[] = [{ role: 'user', content: '测试频率限制' }];
  const outcome = await runAgentLoop(wrappedLoop, messages, null, receiver, controller, 10);

  printResult(outcome, audit);
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printResult(outcome: Awaited<ReturnType<typeof runAgentLoop>>, audit: AuditLog) {
  console.log('\n── Outcome ──────────────────────────────────────────');
  if (outcome.outcomeType === 'response') {
    console.log(`✅ Response: "${outcome.text.slice(0, 80)}..."`);
  } else if (outcome.outcomeType === 'interrupted') {
    console.log(`⛔ Interrupted: ${outcome.signalType}`);
  } else if (outcome.outcomeType === 'terminated') {
    console.log(`🛑 Terminated: ${outcome.reason}`);
  } else {
    console.log(`ℹ ${outcome.outcomeType}`);
  }

  console.log('\n── Audit Log ────────────────────────────────────────');
  for (const event of audit.getEvents()) {
    const iter  = event.data['iteration'] != null ? `iter=${event.data['iteration']}` : '      ';
    const extra = event.data['signalType'] ? ` [${event.data['signalType']}]`
                : event.data['action']     ? ` → ${event.data['action']}`
                : '';
    console.log(`  ${event.type.padEnd(20)} ${iter}${extra}`);
  }
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  共 ${audit.length} 条事件  哈希链完整: ${audit.verify() ? '✅' : '❌'}`);
}

// ── 主程序 ────────────────────────────────────────────────────────────────────

console.log('');
console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║          AgentCore-RS  端到端 Demo                        ║');
console.log('║  层1: agent-core  (mock-agent-node → @agent/node)         ║');
console.log('║  层2: agent-policy (withPolicy + AuditLog)                ║');
console.log('║  层3: 应用层 Delegate (模拟 Anthropic LLM 调用)           ║');
console.log('╚═══════════════════════════════════════════════════════════╝');

await scenarioBasic();
await scenarioSteer();
await scenarioHardStop();
await scenarioRateLimit();

console.log('\n✅ 所有场景完成\n');
