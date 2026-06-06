import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig, defaultPlaywrightServer } from '../src/loader.js';

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-loader-'));
  const p = join(dir, 'mcp.json');
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('loadMcpConfig', () => {
  it('返回空列表当无文件无 browser flag', () => {
    const servers = loadMcpConfig({ configPath: '/nonexistent/mcp.json', env: {} });
    assert.equal(servers.length, 0);
  });

  it('PHILONT_MCP_BROWSER=1 注入 Playwright 浏览器服务器', () => {
    const servers = loadMcpConfig({ configPath: '/nonexistent', env: { PHILONT_MCP_BROWSER: '1' } });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'browser');
    assert.equal(servers[0].capability, 'execute');
    assert.equal(servers[0].domain, 'network');
  });

  it('enableBrowser 选项等价于 env flag', () => {
    const servers = loadMcpConfig({ configPath: '/nonexistent', env: {}, enableBrowser: true });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'browser');
  });

  it('解析 { servers: [...] } 格式', () => {
    const p = tmpFile(JSON.stringify({
      servers: [{ name: 'foo', transport: { transport: 'stdio', command: 'echo' } }],
    }));
    const servers = loadMcpConfig({ configPath: p, env: {} });
    rmSync(p, { force: true });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'foo');
  });

  it('解析裸数组格式', () => {
    const p = tmpFile(JSON.stringify([
      { name: 'bar', transport: { transport: 'sse', url: 'http://x' } },
    ]));
    const servers = loadMcpConfig({ configPath: p, env: {} });
    rmSync(p, { force: true });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'bar');
  });

  it('损坏 JSON 不抛,返回空(配合 browser flag 仍注入)', () => {
    const p = tmpFile('{ this is not json');
    const servers = loadMcpConfig({ configPath: p, env: { PHILONT_MCP_BROWSER: '1' } });
    rmSync(p, { force: true });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'browser');
  });

  it('跳过缺 name/transport 的非法条目', () => {
    const p = tmpFile(JSON.stringify({
      servers: [
        { name: 'ok', transport: { transport: 'stdio', command: 'x' } },
        { name: 'no-transport' },
        { transport: { transport: 'stdio', command: 'y' } },
      ],
    }));
    const servers = loadMcpConfig({ configPath: p, env: {} });
    rmSync(p, { force: true });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'ok');
  });

  it('文件已声明 browser 时 flag 不重复追加', () => {
    const p = tmpFile(JSON.stringify({
      servers: [{ name: 'browser', transport: { transport: 'stdio', command: 'custom-browser' } }],
    }));
    const servers = loadMcpConfig({ configPath: p, env: { PHILONT_MCP_BROWSER: '1' } });
    rmSync(p, { force: true });
    assert.equal(servers.length, 1);
    assert.equal((servers[0].transport as { command: string }).command, 'custom-browser');
  });
});

describe('defaultPlaywrightServer', () => {
  it('是本地 stdio + execute + network', () => {
    const s = defaultPlaywrightServer();
    assert.equal(s.transport.transport, 'stdio');
    assert.equal(s.capability, 'execute');
    assert.equal(s.domain, 'network');
    assert.equal((s.transport as { command: string }).command, 'npx');
  });
});
