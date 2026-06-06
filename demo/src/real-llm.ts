/**
 * 真实 LLM 调用示例
 * 使用 Anthropic Claude API
 */

import Anthropic from '@anthropic-ai/sdk';
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

// ── Anthropic Client ──────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── LLM Delegate ──────────────────────────────────────────────────────────────

const llmDelegate: Delegate = {
  async step(input: JsStepInput): Promise<JsStepResult> {
    console.log(`  [LLM] iter=${input.iteration} mode=${input.mode} msgs=${input.messages.length}`);

    // 转换消息格式
    const messages = input.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const systemPrompt = input.messages.find(m => m.role === 'system')?.content;

    try {
      // 调用 Claude API
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });

      const text = response.content[0]?.type === 'text'
        ? response.content[0].text
        : '';

      console.log(`  [Claude] ${text.slice(0, 60)}...`);

      return {
        action: 'done',
        outcome: {
          outcomeType: 'response',
          text,
        },
      };
    } catch (error) {
      console.error('  [Error]', error);
      return {
        action: 'done',
        outcome: {
          outcomeType: 'terminated',
          reason: String(error),
        },
      };
    }
  },

  async onInterrupt(input: JsInterruptInput): Promise<JsInterruptAction> {
    const { signalType, payload } = input.signal;
    console.log(`  [中断] ${signalType}${payload ? ': ' + payload : ''}`);

    if (signalType === 'SteerMessage') {
      return { action: 'injectMessage', message: payload ?? '' };
    }

    return { action: 'continue' };
  },
};

// ── 主程序 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║          真实 Claude API 调用示例                          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const audit = new AuditLog();
  const policy = withPolicy(llmDelegate, {
    permissions: createDefaultMatrix(),
    audit,
  });

  const { controller, receiver } = interruptChannelJs();

  const messages: JsMessage[] = [
    { role: 'user', content: '用一句话解释什么是量子纠缠' },
  ];

  const outcome = await runAgentLoop(
    policy,
    messages,
    '你是一位物理学家，擅长用简洁的语言解释复杂概念。',
    receiver,
    controller,
    5
  );

  console.log('\n── 结果 ──────────────────────────────────────────');
  if (outcome.outcomeType === 'response') {
    console.log(`✅ ${outcome.text}`);
  } else {
    console.log(`❌ ${outcome.outcomeType}`);
  }

  console.log(`\n── 审计 ──────────────────────────────────────────`);
  console.log(`事件数: ${audit.length}  哈希链: ${audit.verify() ? '✅' : '❌'}`);
}

main().catch(console.error);
