import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ToolRegistry } from '@agent/policy';
import { loadPlugins, invokeHook, WorkerSandbox } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/tests/sandbox.test.js → .../tests/sandbox-fixtures
const FIXTURES = join(__dirname, '..', '..', 'tests', 'sandbox-fixtures');

describe('WorkerSandbox: good plugin', () => {
  before(() => {
    process.env.ALLOWED_VAR = 'world';
    process.env.SECRET_TOKEN = 'should-not-leak';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.OPENAI_API_KEY = 'sk-secret';
  });

  after(() => {
    delete process.env.ALLOWED_VAR;
    delete process.env.SECRET_TOKEN;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('loads plugin and registers tools via RPC proxy', async () => {
    const registry = new ToolRegistry();
    const result = await loadPlugins({
      registry,
      sources: [{ label: 'fix', path: FIXTURES }],
      silent: true,
    });
    // 至少一个沙箱插件加载成功
    const good = result.loaded.find(p => p.manifest.id === 'goodworker');
    assert.ok(good, 'goodworker should load');
    const tool = registry.get('goodworker.echo');
    assert.ok(tool);
    assert.equal(tool.description, 'echoes input');
  });

  it('executes tool in worker and returns result', async () => {
    const registry = new ToolRegistry();
    await loadPlugins({
      registry,
      sources: [{ label: 'fix', path: FIXTURES }],
      silent: true,
    });
    const tool = registry.get('goodworker.echo')!;
    const r = await tool.execute({ text: 'hi' });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('echo(hi)'));
    assert.ok(r.output.includes('env_seen=world'), 'declared env should be visible');
  });

  it('invokeHook triggers worker-side handler', async () => {
    const registry = new ToolRegistry();
    const result = await loadPlugins({
      registry,
      sources: [{ label: 'fix', path: FIXTURES }],
      silent: true,
    });
    const good = result.loaded.find(p => p.manifest.id === 'goodworker')!;
    // hook 代理通过 RPC 调用 worker 内 handler
    await invokeHook([good], 'on_session_start', { foo: 'bar' });
    // 无 throw 即视为成功
    assert.ok(true);
  });
});

describe('WorkerSandbox: malicious plugin blocked', () => {
  it('env-stealer cannot read undeclared env vars', async () => {
    process.env.SECRET_TOKEN = 'should-not-leak';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.OPENAI_API_KEY = 'sk-secret';

    const registry = new ToolRegistry();
    await loadPlugins({
      registry,
      sources: [{ label: 'fix', path: FIXTURES }],
      silent: true,
    });

    const tool = registry.get('envstealer.steal');
    assert.ok(tool);
    const r = await tool.execute({});
    const parsed = JSON.parse(r.output);
    assert.equal(parsed.secret_token, null, 'SECRET_TOKEN must not leak');
    assert.equal(parsed.aws_key, null, 'AWS key must not leak');
    assert.equal(parsed.openai_key, null, 'OPENAI key must not leak');
    // 但 PATH 这类基础 env 可能在（由 WorkerSandbox 放入）
    assert.ok(!parsed.envKeys.includes('SECRET_TOKEN'));
    assert.ok(!parsed.envKeys.includes('AWS_SECRET_ACCESS_KEY'));

    delete process.env.SECRET_TOKEN;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.OPENAI_API_KEY;
  });
});

describe('WorkerSandbox: crash isolation', () => {
  it('crashing tool does not crash main, registry survives', async () => {
    const registry = new ToolRegistry();
    const result = await loadPlugins({
      registry,
      sources: [{ label: 'fix', path: FIXTURES }],
      silent: true,
    });

    const crashTool = registry.get('spawner.crash');
    assert.ok(crashTool);

    // 这会让 worker process.exit(42)，主线程收到 exit event 后拒绝 pending RPC
    await assert.rejects(
      () => crashTool.execute({}),
      /Worker exited with code 42|Worker exited/,
    );

    // 其他已加载插件仍可工作
    const echo = registry.get('goodworker.echo');
    if (echo) {
      const r = await echo.execute({ text: 'still alive' });
      assert.equal(r.success, true);
    }
  });
});

describe('WorkerSandbox: RPC timeout', () => {
  it('tool exceeding rpcTimeoutMs is rejected', async () => {
    const registry = new ToolRegistry();
    await loadPlugins({
      registry,
      sources: [{ label: 'fix', path: FIXTURES }],
      silent: true,
      workerSandboxOptions: { rpcTimeoutMs: 500 },
    });

    const slow = registry.get('spawner.slow');
    assert.ok(slow);
    const start = Date.now();
    await assert.rejects(() => slow.execute({}), /timeout/);
    const elapsed = Date.now() - start;
    // 应该在 1000ms 内 timeout（不是等 60s）
    assert.ok(elapsed < 2000, `rejected too slowly: ${elapsed}ms`);
  });
});
