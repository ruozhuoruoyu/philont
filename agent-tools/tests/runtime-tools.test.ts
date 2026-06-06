import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processTool, shellTool } from '../src/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('process tool', () => {
  it('spawn returns a process id', async () => {
    const r = await processTool.execute({ action: 'spawn', command: 'echo hello' });
    assert.equal(r.success, true);
    assert.ok(r.output.startsWith('Spawned process:'));
  });

  it('status shows output after completion', async () => {
    const spawn = await processTool.execute({
      action: 'spawn',
      command: 'echo A && echo B',
    });
    const pid = spawn.output.replace('Spawned process: ', '').trim();

    // 等进程退出
    await sleep(300);

    const status = await processTool.execute({ action: 'status', processId: pid });
    assert.equal(status.success, true);
    assert.ok(status.output.includes('exited(0)'));
    assert.ok(status.output.includes('A'));
    assert.ok(status.output.includes('B'));
  });

  it('kill terminates a running process', async () => {
    const spawn = await processTool.execute({
      action: 'spawn',
      command: 'sleep 30',
    });
    const pid = spawn.output.replace('Spawned process: ', '').trim();

    await sleep(100);

    const kill = await processTool.execute({ action: 'kill', processId: pid });
    assert.equal(kill.success, true);
    assert.ok(kill.output.includes('SIGTERM'));

    // 轮询状态，最多等 3 秒
    let status = await processTool.execute({ action: 'status', processId: pid });
    for (let i = 0; i < 30 && !status.output.includes('exited'); i++) {
      await sleep(100);
      status = await processTool.execute({ action: 'status', processId: pid });
    }
    assert.ok(status.output.includes('exited'), `process should have exited, got: ${status.output.slice(0, 200)}`);
  });

  it('status on unknown id returns error', async () => {
    const r = await processTool.execute({
      action: 'status',
      processId: 'does-not-exist',
    });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('not found'));
  });

  it('list includes spawned processes', async () => {
    await processTool.execute({ action: 'spawn', command: 'true' });
    const r = await processTool.execute({ action: 'list' });
    assert.equal(r.success, true);
    // 会有之前测试留下的进程，只要不是 "No processes" 就行
    assert.ok(r.output !== 'No processes');
  });

  it('spawn without command returns error', async () => {
    const r = await processTool.execute({ action: 'spawn' });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('command is required'));
  });
});

describe('shell tool', () => {
  it('executes simple command', async () => {
    const r = await shellTool.execute({ command: 'echo hi' });
    assert.equal(r.success, true);
    assert.ok(r.output.includes('hi'));
  });

  it('captures stderr on failure', async () => {
    const r = await shellTool.execute({ command: 'ls /does-not-exist-xyz' });
    assert.equal(r.success, false);
    assert.ok(r.error && r.error.length > 0);
  });

  it('timeout: 显式 timeout 触发 killed + 错误带 hint', async () => {
    // 200ms 超时,sleep 5 命令必然被 SIGTERM 杀。验证两件事:
    //   1. error 里有 killed=true (likely timeout) 信号——LLM 才知道是超时不是命令出错
    //   2. error 里有 hint 提示重试时传更大 timeout——避免反复用同 timeout 撞墙
    const r = await shellTool.execute({ command: 'sleep 5', timeout: 200 });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes('killed=true'), `expect killed=true in error, got: ${r.error}`);
    assert.ok(r.error?.includes('hint:'), `expect hint in error, got: ${r.error}`);
    assert.ok(r.error?.includes('explicitly larger timeout'), `expect actionable hint, got: ${r.error}`);
  });

  it('timeout: 命令快速失败(非超时)→ 不带 hint', async () => {
    // 普通 exit≠0 不应被误标 hint,只有 killed 且耗时接近上限的才提示。
    const r = await shellTool.execute({ command: 'ls /does-not-exist-xyz' });
    assert.equal(r.success, false);
    assert.ok(!r.error?.includes('hint:'), `非超时不应带 hint,got: ${r.error}`);
  });

  it('download sanity: -o 输出文件 < 256 字节 → 警告', async () => {
    // 复刻用户场景:18 字节 JSON 错误体被当下载的 docx,agent 没察觉。
    // 测试隔离:用 fs 预写小文件,shell 命令仅 echo 含 -o 触发 sanity check。
    const { writeFile, unlink } = await import('node:fs/promises');
    const tmpFile = `/tmp/philont-test-tiny-${Date.now()}.docx`;
    await writeFile(tmpFile, '{"code":404}'); // 12 字节
    try {
      const r = await shellTool.execute({
        command: `echo simulated download -o "${tmpFile}"`,
      });
      assert.equal(r.success, true);
      assert.ok(r.output.includes('download sanity'), `expect warning, got: ${r.output}`);
      assert.ok(r.output.includes('12 bytes'), `expect size, got: ${r.output}`);
      assert.ok(r.output.includes('head -c 200'), `expect actionable hint, got: ${r.output}`);
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });

  it('download sanity: 大文件 → 不警告', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const tmpFile = `/tmp/philont-test-large-${Date.now()}.docx`;
    await writeFile(tmpFile, Buffer.alloc(2000, 0x41)); // 2KB
    try {
      const r = await shellTool.execute({
        command: `echo simulated -o "${tmpFile}"`,
      });
      assert.equal(r.success, true);
      assert.ok(!r.output.includes('download sanity'), `2KB 不应触发,got: ${r.output}`);
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });

  it('download sanity: 命令不含 -o → 跳过检查', async () => {
    // 防回归:任何 echo / ls 等普通命令都不应被 sanity 检查触及
    const r = await shellTool.execute({ command: 'echo hello world' });
    assert.equal(r.success, true);
    assert.ok(!r.output.includes('download sanity'), `非 -o 命令不应触发`);
  });
});
