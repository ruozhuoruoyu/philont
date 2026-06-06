/**
 * process tool - long-running process management
 *
 * Unlike shell: shell is fire-and-forget synchronous execution;
 * process allows starting background processes and then polling output or terminating.
 *
 * Actions:
 *   - spawn   start a background process, returns processId
 *   - status  query process state + output
 *   - kill    terminate a process
 *   - list    list all active processes
 *
 * Output buffer: ring buffer of 200KB; oldest data is discarded when exceeded.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Tool } from '@agent/policy';
import { POSIX_PREFERRED_SHELL } from '../utils/host.js';

interface ManagedProcess {
  id: string;
  command: string;
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number | null;
}

const MAX_BUFFER = 200 * 1024;

const processes = new Map<string, ManagedProcess>();

function ringBuffer(buf: string, chunk: string): string {
  const combined = buf + chunk;
  if (combined.length > MAX_BUFFER) {
    return combined.slice(combined.length - MAX_BUFFER);
  }
  return combined;
}

function spawnProcess(command: string, cwd?: string): string {
  const id = randomUUID();
  // Cross-platform shell: the original hard-coded 'sh' causes ENOENT on Windows (no sh).
  // Use the shell option — prefer /bin/bash on POSIX (avoids Linux dash), otherwise platform default (POSIX /bin/sh or Windows cmd.exe).
  const proc = spawn(command, {
    cwd: cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: POSIX_PREFERRED_SHELL ?? true,
  });

  const managed: ManagedProcess = {
    id,
    command,
    proc,
    stdout: '',
    stderr: '',
    exitCode: null,
    exitSignal: null,
    startedAt: Date.now(),
    endedAt: null,
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    managed.stdout = ringBuffer(managed.stdout, chunk.toString());
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    managed.stderr = ringBuffer(managed.stderr, chunk.toString());
  });

  proc.on('exit', (code, signal) => {
    managed.exitCode = code;
    managed.exitSignal = signal;
    managed.endedAt = Date.now();
  });

  processes.set(id, managed);
  return id;
}

function isFinished(p: ManagedProcess): boolean {
  return p.endedAt !== null;
}

function formatStatus(p: ManagedProcess, includeOutput = true): string {
  const status = !isFinished(p)
    ? 'running'
    : p.exitSignal
      ? `exited(signal=${p.exitSignal})`
      : `exited(${p.exitCode})`;
  const duration = ((p.endedAt || Date.now()) - p.startedAt) / 1000;
  const lines = [
    `[${p.id}] ${status} (${duration.toFixed(1)}s)`,
    `  command: ${p.command}`,
  ];
  if (includeOutput) {
    if (p.stdout) lines.push(`  stdout:\n${p.stdout.slice(-4000)}`);
    if (p.stderr) lines.push(`  stderr:\n${p.stderr.slice(-4000)}`);
  }
  return lines.join('\n');
}

export const processTool: Tool = {
  name: 'process',
  description: 'Manage long-running background processes (spawn/status/kill/list)',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['spawn', 'status', 'kill', 'list'],
        description: 'Action to perform',
      },
      command: { type: 'string', description: 'The command to run (required for spawn)' },
      cwd: { type: 'string', description: 'Working directory (optional for spawn)' },
      processId: { type: 'string', description: 'Process ID (required for status/kill)' },
    },
    required: ['action'],
  },
  capability: 'execute',
  domain: 'local',
  async execute(params) {
    const action = params.action as string;

    switch (action) {
      case 'spawn': {
        const command = params.command as string;
        if (!command) {
          return { success: false, output: '', error: 'command is required' };
        }
        const cwd = params.cwd as string | undefined;
        const id = spawnProcess(command, cwd);
        return { success: true, output: `Spawned process: ${id}` };
      }

      case 'status': {
        const processId = params.processId as string;
        if (!processId) {
          return { success: false, output: '', error: 'processId is required' };
        }
        const p = processes.get(processId);
        if (!p) {
          return { success: false, output: '', error: `Process not found: ${processId}` };
        }
        return { success: true, output: formatStatus(p) };
      }

      case 'kill': {
        const processId = params.processId as string;
        if (!processId) {
          return { success: false, output: '', error: 'processId is required' };
        }
        const p = processes.get(processId);
        if (!p) {
          return { success: false, output: '', error: `Process not found: ${processId}` };
        }
        if (isFinished(p)) {
          return { success: true, output: `Process ${processId} already exited` };
        }
        p.proc.kill('SIGTERM');
        // Give 500ms for graceful exit, then SIGKILL
        setTimeout(() => {
          if (!isFinished(p)) p.proc.kill('SIGKILL');
        }, 500);
        return { success: true, output: `Sent SIGTERM to ${processId}` };
      }

      case 'list': {
        if (processes.size === 0) {
          return { success: true, output: 'No processes' };
        }
        const lines = Array.from(processes.values()).map((p) => formatStatus(p, false));
        return { success: true, output: lines.join('\n\n') };
      }

      default:
        return { success: false, output: '', error: `Unknown action: ${action}` };
    }
  },
};
