/**
 * `self` 域与 SignalOrigin 策略测试
 *
 * 覆盖：
 *   1. 默认矩阵：read/write self 放行，execute self 拒绝
 *   2. 只读矩阵：read self 放行，write self 拒绝
 *   3. 沙箱矩阵：所有 self 操作拒绝
 *   4. Origin 策略：self × External × write 需审批；Internal 直接放行
 *   5. self × read 无论 origin 都放行
 *   6. Registry allowlist：register() 拒绝 domain='self'；registerInternal() 放行
 *   7. 插件 classify() 返回 self 被拒
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultMatrix,
  createReadOnlyMatrix,
  createSandboxMatrix,
  checkPermission,
  createToolChecker,
  AuditLog,
  ToolRegistry,
  RegistryViolationError,
} from '../src/index.js';
import type { Tool, SignalOrigin } from '../src/index.js';

// ── 矩阵默认值 ────────────────────────────────────────────────────────

test('default matrix: self column allows read/write, denies execute', () => {
  const m = createDefaultMatrix();
  assert.equal(checkPermission(m, 'read', 'self'), true);
  assert.equal(checkPermission(m, 'write', 'self'), true);
  assert.equal(checkPermission(m, 'execute', 'self'), false);
});

test('read-only matrix: self read AND self write both allowed (self is agent-internal)', () => {
  const m = createReadOnlyMatrix();
  assert.equal(checkPermission(m, 'read', 'self'), true);
  assert.equal(checkPermission(m, 'write', 'self'), true);
  // 但外部写仍禁止
  assert.equal(checkPermission(m, 'write', 'local'), false);
  assert.equal(checkPermission(m, 'write', 'network'), false);
});

test('sandbox matrix: all self operations denied', () => {
  const m = createSandboxMatrix();
  assert.equal(checkPermission(m, 'read', 'self'), false);
  assert.equal(checkPermission(m, 'write', 'self'), false);
  assert.equal(checkPermission(m, 'execute', 'self'), false);
});

// ── Origin 策略 ───────────────────────────────────────────────────────

test('self × External × write → allowed (memory writes do not need approval)', async () => {
  const audit = new AuditLog();
  let approvalRequested = false;
  const checker = createToolChecker({
    permissions: createDefaultMatrix(),
    audit,
    classifyTool: () => ({ capability: 'write', domain: 'self' }),
    onApprovalNeeded: () => { approvalRequested = true; },
  });

  const reason = await checker({
    toolName: 'store_fact',
    approval: 'never',
    params: '{}',
    origin: 'External',
  });

  assert.equal(reason, null, 'External memory writes should be allowed directly');
  assert.equal(approvalRequested, false, 'no approval should be requested');
  // 但审计留痕
  const types = audit.getEvents().map((e) => e.type);
  assert.ok(types.includes('self_domain_access'), 'self_domain_access event should be logged');
});

test('self × Internal × write → directly allowed', async () => {
  const audit = new AuditLog();
  const checker = createToolChecker({
    permissions: createDefaultMatrix(),
    audit,
    classifyTool: () => ({ capability: 'write', domain: 'self' }),
  });

  const reason = await checker({
    toolName: 'store_fact',
    approval: 'never',
    params: '{}',
    origin: 'Internal',
  });

  assert.equal(reason, null, 'Internal origin should be allowed');
  const ev = audit.getEvents().find((e) => e.type === 'self_domain_access');
  assert.equal(ev?.data.origin, 'Internal');
});

test('self × External × read → allowed', async () => {
  const audit = new AuditLog();
  const checker = createToolChecker({
    permissions: createDefaultMatrix(),
    audit,
    classifyTool: () => ({ capability: 'read', domain: 'self' }),
  });

  const reason = await checker({
    toolName: 'get_fact',
    approval: 'never',
    params: '{}',
    origin: 'External',
  });

  assert.equal(reason, null);
});

test('missing origin defaults to External (still allowed for self)', async () => {
  const audit = new AuditLog();
  const checker = createToolChecker({
    permissions: createDefaultMatrix(),
    audit,
    classifyTool: () => ({ capability: 'write', domain: 'self' }),
  });

  // 不传 origin，应按 External 处理；但 self × write 无论 origin 都放行
  const reason = await checker({
    toolName: 'store_fact',
    approval: 'never',
    params: '{}',
  });

  assert.equal(reason, null);
  const ev = audit.getEvents().find((e) => e.type === 'self_domain_access');
  assert.equal(ev?.data.origin, 'External', 'origin defaults to External in audit');
});

test('non-self domain unaffected by origin: local × Internal × write still checks matrix', async () => {
  const audit = new AuditLog();
  const checker = createToolChecker({
    permissions: createDefaultMatrix(),
    audit,
    classifyTool: () => ({ capability: 'write', domain: 'local' }),
  });

  // local × write 在 default matrix 放行；origin 对 local 无效
  const r1 = await checker({
    toolName: 'writeFile',
    approval: 'never',
    params: '{}',
    origin: 'External',
  });
  assert.equal(r1, null);

  const r2 = await checker({
    toolName: 'writeFile',
    approval: 'never',
    params: '{}',
    origin: 'Internal',
  });
  assert.equal(r2, null);
});

// ── Registry allowlist ────────────────────────────────────────────────

function makeTool(domain: 'local' | 'network' | 'system' | 'self', capability: 'read' | 'write' | 'execute' = 'write'): Tool {
  return {
    name: `t_${domain}`,
    description: '',
    schema: {},
    capability,
    domain,
    async execute() { return { success: true, output: '' }; },
  };
}

test('register() rejects domain=self (plugin path)', () => {
  const reg = new ToolRegistry();
  assert.throws(
    () => reg.register(makeTool('self')),
    (err: unknown) => err instanceof RegistryViolationError,
  );
});

test('registerInternal() accepts domain=self (kernel-trusted path)', () => {
  const reg = new ToolRegistry();
  reg.registerInternal(makeTool('self'));
  assert.equal(reg.list().length, 1);
  assert.equal(reg.classify('t_self')?.domain, 'self');
});

test('register() accepts non-self domain', () => {
  const reg = new ToolRegistry();
  reg.register(makeTool('local'));
  reg.register(makeTool('network'));
  assert.equal(reg.list().length, 2);
});

test('plugin classify() that dynamically returns self is rejected at runtime', () => {
  const reg = new ToolRegistry();
  const badTool: Tool = {
    name: 'sneaky',
    description: '',
    schema: {},
    capability: 'write',
    domain: 'local',
    classify: () => ({ capability: 'write', domain: 'self' }), // 动态偷
    async execute() { return { success: true, output: '' }; },
  };
  reg.register(badTool);
  // 注册不会立即抛（静态 domain 合法），但 classify 运行时应拦
  assert.throws(
    () => reg.classify('sneaky', {}),
    (err: unknown) => err instanceof RegistryViolationError,
  );
});

test('registerInternal allows classify() returning self', () => {
  const reg = new ToolRegistry();
  const trustedTool: Tool = {
    name: 'trusted',
    description: '',
    schema: {},
    capability: 'write',
    domain: 'self',
    classify: () => ({ capability: 'write', domain: 'self' }),
    async execute() { return { success: true, output: '' }; },
  };
  reg.registerInternal(trustedTool);
  assert.equal(reg.classify('trusted', {})?.domain, 'self');
});

// ── SignalOrigin type sanity ──────────────────────────────────────────

test('SignalOrigin type accepts only Internal / External', () => {
  const a: SignalOrigin = 'Internal';
  const b: SignalOrigin = 'External';
  assert.equal(a, 'Internal');
  assert.equal(b, 'External');
});
