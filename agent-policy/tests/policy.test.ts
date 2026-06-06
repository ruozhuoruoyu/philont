/**
 * agent-policy 集成测试
 * 运行：npx tsx --test tests/policy.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditLog,
  createDefaultMatrix,
  createReadOnlyMatrix,
  checkPermission,
  withPolicy,
} from '../src/index.js';
import type { Delegate, StepInput, ToolClassification } from '../src/index.js';

// ── 测试工具 ──────────────────────────────────────────────────────────────────

function makeInput(iteration = 1): StepInput {
  return {
    messages:  [{ role: 'user', content: '你好' }],
    tools:     [],
    iteration,
    mode:      'Normal',
  };
}

/** 简单 delegate：直接返回文本响应 */
const echoDelegate: Delegate = {
  async step(input) {
    return {
      action: 'done',
      outcome: { outcomeType: 'response', text: `iter ${input.iteration}` },
    };
  },
  async onInterrupt() {
    return { action: 'continue' };
  },
};

// ── PermissionMatrix 测试 ─────────────────────────────────────────────────────

describe('PermissionMatrix', () => {
  it('默认矩阵：read.local = true', () => {
    const m = createDefaultMatrix();
    assert.equal(checkPermission(m, 'read', 'local'), true);
  });

  it('默认矩阵：write.network = false', () => {
    const m = createDefaultMatrix();
    assert.equal(checkPermission(m, 'write', 'network'), false);
  });

  it('默认矩阵：execute.local = false', () => {
    const m = createDefaultMatrix();
    assert.equal(checkPermission(m, 'execute', 'local'), false);
  });

  it('只读矩阵：write.local = false', () => {
    const m = createReadOnlyMatrix();
    assert.equal(checkPermission(m, 'write', 'local'), false);
  });
});

// ── AuditLog 测试 ─────────────────────────────────────────────────────────────

describe('AuditLog', () => {
  it('空日志验证通过', () => {
    const log = new AuditLog();
    assert.equal(log.verify(), true);
  });

  it('追加事件后哈希链完整', () => {
    const log = new AuditLog();
    log.append('step_start', { iteration: 1 });
    log.append('step_end',   { iteration: 1, action: 'done' });
    assert.equal(log.verify(), true);
    assert.equal(log.length, 2);
  });

  it('篡改任意字段导致验证失败', () => {
    const log = new AuditLog();
    log.append('step_start', { iteration: 1 });
    log.append('step_end',   { iteration: 1 });

    // 直接篡改私有数组（测试专用反射）— 先转 unknown 再转 mutable
    const events = log.getEvents() as unknown as Array<{ type: string }>;
    events[0]!.type = 'tampered';

    assert.equal(log.verify(), false);
  });

  it('每条事件的 prevHash 指向前一条 hash', () => {
    const log = new AuditLog();
    const e1 = log.append('loop_start');
    const e2 = log.append('step_start', { iteration: 1 });
    assert.equal(e2.prevHash, e1.hash);
  });
});

// ── withPolicy 测试 ───────────────────────────────────────────────────────────

describe('withPolicy', () => {
  it('正常步骤：审计日志记录 step_start + step_end', async () => {
    const audit    = new AuditLog();
    const delegate = withPolicy(echoDelegate, {
      permissions: createDefaultMatrix(),
      audit,
    });

    await delegate.step(makeInput(1));

    const types = audit.getEvents().map(e => e.type);
    assert.deepEqual(types, ['step_start', 'step_end']);
    assert.equal(audit.verify(), true);
  });

  it('中断：审计日志记录 interrupt', async () => {
    const audit    = new AuditLog();
    const delegate = withPolicy(echoDelegate, {
      permissions: createDefaultMatrix(),
      audit,
    });

    await delegate.onInterrupt({
      signal:   { signalType: 'CuriosityTriggered', payload: '量子' },
      messages: [],
    });

    assert.equal(audit.getEvents()[0]?.type, 'interrupt');
    assert.equal(audit.getEvents()[0]?.data['signalType'], 'CuriosityTriggered');
  });

  it('频率限制：超出后返回 terminated', async () => {
    const audit    = new AuditLog();
    const delegate = withPolicy(echoDelegate, {
      permissions:        createDefaultMatrix(),
      audit,
      maxStepsPerMinute:  2,
    });

    await delegate.step(makeInput(1));
    await delegate.step(makeInput(2));
    const result = await delegate.step(makeInput(3));  // 第 3 次，超限

    assert.equal(result.action, 'done');
    assert(result.action === 'done' && result.outcome.outcomeType === 'terminated');
    assert.equal(audit.verify(), true);
  });

  it('工具调用权限：已知工具被分类并记录', async () => {
    const audit = new AuditLog();
    const addMsgDelegate: Delegate = {
      async step() {
        return {
          action: 'addMessages',
          addMessages: [
            { role: 'assistant', content: '' },
            { role: 'tool', content: 'result', toolName: 'read_file', toolCallId: '1' },
          ],
        };
      },
      async onInterrupt() { return { action: 'continue' }; },
    };

    const classify = (name: string): ToolClassification | null =>
      name === 'read_file' ? { capability: 'read', domain: 'local' } : null;

    const delegate = withPolicy(addMsgDelegate, {
      permissions: createDefaultMatrix(),
      audit,
      classifyTool: classify,
    });

    await delegate.step(makeInput(1));

    const toolEvent = audit.getEvents().find(e => e.type === 'tool_call');
    assert(toolEvent !== undefined, 'tool_call 事件应被记录');
    assert.equal(toolEvent.data['toolName'], 'read_file');
    assert.equal(toolEvent.data['allowed'], true);
    assert.equal(audit.verify(), true);
  });
});
