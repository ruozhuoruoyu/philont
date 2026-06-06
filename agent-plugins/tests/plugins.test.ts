import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ToolRegistry } from '@agent/policy';
import {
  validateManifest,
  discoverPlugins,
  loadPlugins,
  invokeHook,
} from '../src/index.js';

// 由 tsc 输出到 dist/tests/，需要回溯到 dist/ 再到工程根 tests/fixtures
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/tests/plugins.test.js → .../tests/fixtures (2 levels up)
const FIXTURES_DIR = join(__dirname, '..', '..', 'tests', 'fixtures');

describe('validateManifest', () => {
  it('accepts valid manifest', () => {
    const result = validateManifest({
      id: 'my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.manifest?.id, 'my-plugin');
  });

  it('rejects missing required fields', () => {
    const result = validateManifest({ name: 'Foo' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"id"')));
    assert.ok(result.errors.some((e) => e.includes('"version"')));
  });

  it('rejects invalid id format', () => {
    const result = validateManifest({
      id: 'Bad_ID',
      name: 'X',
      version: '1.0.0',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('id')));
  });

  it('validates requiresEnv type', () => {
    const result = validateManifest({
      id: 'p',
      name: 'P',
      version: '1.0',
      requiresEnv: 'NOT_AN_ARRAY',
    });
    assert.equal(result.valid, false);
  });
});

describe('discoverPlugins', () => {
  it('finds plugins with plugin.json', async () => {
    const found = await discoverPlugins([
      { label: 'test', path: FIXTURES_DIR },
    ]);
    const names = found.map((p) => p.pluginDir.split(/[/\\]/).pop());
    assert.ok(names.includes('hello-plugin'));
    assert.ok(names.includes('bad-manifest'));
  });

  it('ignores directories without plugin.json', async () => {
    const found = await discoverPlugins([
      { label: 'test', path: FIXTURES_DIR },
    ]);
    const names = found.map((p) => p.pluginDir.split(/[/\\]/).pop());
    assert.ok(!names.includes('empty-dir'));
  });

  it('handles non-existent source gracefully', async () => {
    const found = await discoverPlugins([
      { label: 'missing', path: '/does/not/exist' },
    ]);
    assert.deepEqual(found, []);
  });
});

describe('loadPlugins', () => {
  it('loads valid plugin and registers tools', async () => {
    const registry = new ToolRegistry();
    const result = await loadPlugins({
      registry,
      sources: [{ label: 'test', path: FIXTURES_DIR }],
      silent: true,
    });

    assert.equal(result.loaded.length, 1);
    assert.equal(result.loaded[0].manifest.id, 'hello');

    // Tool should be registered with plugin prefix
    const tool = registry.get('hello.greet');
    assert.ok(tool);
    assert.equal(tool.capability, 'read');
  });

  it('reports failed plugins without crashing others', async () => {
    const registry = new ToolRegistry();
    const result = await loadPlugins({
      registry,
      sources: [{ label: 'test', path: FIXTURES_DIR }],
      silent: true,
    });

    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].error.includes('Invalid manifest'));
  });

  it('executes plugin tool correctly', async () => {
    const registry = new ToolRegistry();
    await loadPlugins({
      registry,
      sources: [{ label: 'test', path: FIXTURES_DIR }],
      silent: true,
    });

    const tool = registry.get('hello.greet')!;
    const result = await tool.execute({ name: 'World' });
    assert.equal(result.success, true);
    assert.ok(result.output.includes('Hello, World!'));
    assert.ok(result.output.includes('hello'));
  });

  it('invokes hooks on loaded plugins', async () => {
    const registry = new ToolRegistry();
    const config = { hello: {} as Record<string, unknown> };
    const result = await loadPlugins({
      registry,
      sources: [{ label: 'test', path: FIXTURES_DIR }],
      configs: { 'hello-plugin': config.hello },
      silent: true,
    });

    await invokeHook(result.loaded, 'on_session_start', {});
    await invokeHook(result.loaded, 'on_session_start', {});

    assert.equal(config.hello.__startCount, 2);
  });

  it('passes pluginId and pluginDir to ctx', async () => {
    const registry = new ToolRegistry();
    const result = await loadPlugins({
      registry,
      sources: [{ label: 'test', path: FIXTURES_DIR }],
      silent: true,
    });

    // Execute tool, it echoes back ctx.pluginId
    const tool = registry.get('hello.greet')!;
    const output = (await tool.execute({ name: 'X' })).output;
    assert.ok(output.includes('plugin hello'));
  });
});
