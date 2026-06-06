import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StdioTransport } from '../src/transport/stdio.js';

describe('StdioTransport robustness', () => {
  it('连接不存在的命令时 connect() reject,而非未处理 error 事件 crash 进程', async () => {
    // 回归:之前 connect() 不监听子进程 'error',spawn ENOENT(如 Windows 上找不到
    // npx)会变成未处理 'error' 事件直接 crash 整个 server。修复后应优雅 reject。
    const t = new StdioTransport(
      { transport: 'stdio', command: 'philont-no-such-command-xyz-123', args: [] },
      3000,
    );
    await assert.rejects(() => t.connect());
    // 清理(proc 可能已为 null,close 应安全)
    await t.close();
  });
});
