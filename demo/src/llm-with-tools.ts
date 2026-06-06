/**
 * 带工具调用的 LLM Delegate
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  type JsStepInput,
  type JsStepResult,
  type JsInterruptInput,
  type JsInterruptAction,
  type JsMessage,
} from '@agent/node';
import {
  type Delegate,
  ToolRegistry,
} from '@agent/policy';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export function createLlmDelegate(registry: ToolRegistry): Delegate {
  return {
    async step(input: JsStepInput): Promise<JsStepResult> {
      console.log(`  [LLM] iter=${input.iteration} msgs=${input.messages.length}`);

      // 转换消息格式
      const messages = input.messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      const systemPrompt = input.messages.find(m => m.role === 'system')?.content;

      // 转换工具定义
      const tools = registry.list().map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema,
      }));

      try {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: systemPrompt,
          messages,
          tools,
        });

        // 处理响应
        const content = response.content[0];

        if (!content) {
          return {
            action: 'done',
            outcome: { outcomeType: 'terminated', reason: 'Empty response' },
          };
        }

        // 文本响应
        if (content.type === 'text') {
          console.log(`  [Claude] ${content.text.slice(0, 60)}...`);
          return {
            action: 'done',
            outcome: { outcomeType: 'response', text: content.text },
          };
        }

        // 工具调用
        if (content.type === 'tool_use') {
          console.log(`  [Tool] ${content.name}(${JSON.stringify(content.input).slice(0, 40)}...)`);

          const result = await registry.execute(content.name, content.input as Record<string, unknown>);

          console.log(`  [Result] ${result.success ? '✅' : '❌'} ${result.output.slice(0, 40)}...`);

          // 构造工具结果消息
          const newMessages: JsMessage[] = [
            {
              role: 'assistant',
              content: JSON.stringify(content),
            },
            {
              role: 'user',
              content: result.success ? result.output : `Error: ${result.error}`,
            },
          ];

          return {
            action: 'addMessages',
            addMessages: newMessages,
          };
        }

        return {
          action: 'done',
          outcome: { outcomeType: 'terminated', reason: 'Unknown content type' },
        };
      } catch (error) {
        console.error('  [Error]', error);
        return {
          action: 'done',
          outcome: { outcomeType: 'terminated', reason: String(error) },
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
}
