/**
 * git tool - common read-only git operations
 *
 * For safety, only read-only actions are supported by default: status, diff, log, branch, show.
 * Write operations (add/commit/push) are left to the shell tool, which requires higher privileges.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '@agent/policy';

const execAsync = promisify(exec);

type GitAction = 'status' | 'diff' | 'log' | 'branch' | 'show' | 'blame';

interface ActionSpec {
  args: (params: Record<string, unknown>) => string[];
  readonly: boolean;
}

const ACTIONS: Record<GitAction, ActionSpec> = {
  status: {
    readonly: true,
    args: () => ['status', '--short', '--branch'],
  },
  diff: {
    readonly: true,
    args: (p) => {
      const args = ['diff'];
      if (p.cached) args.push('--cached');
      if (p.ref) args.push(String(p.ref));
      if (p.path) args.push('--', String(p.path));
      return args;
    },
  },
  log: {
    readonly: true,
    args: (p) => {
      const limit = (p.limit as number) || 10;
      const args = ['log', `--max-count=${limit}`, '--oneline', '--decorate'];
      if (p.path) args.push('--', String(p.path));
      return args;
    },
  },
  branch: {
    readonly: true,
    args: () => ['branch', '--list', '--all'],
  },
  show: {
    readonly: true,
    args: (p) => ['show', String(p.ref || 'HEAD'), '--stat'],
  },
  blame: {
    readonly: true,
    args: (p) => {
      if (!p.path) throw new Error('blame requires path');
      return ['blame', '--line-porcelain', String(p.path)];
    },
  },
};

export const gitTool: Tool = {
  name: 'git',
  description: 'Read-only git operations (status/diff/log/branch/show/blame)',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'diff', 'log', 'branch', 'show', 'blame'],
        description: 'Action',
      },
      cwd: { type: 'string', description: 'Repository directory; defaults to the current directory' },
      ref: { type: 'string', description: 'commit/branch/tag (for diff/show)' },
      path: { type: 'string', description: 'File path filter' },
      cached: { type: 'boolean', description: 'diff: compare the staging area (default false)' },
      limit: { type: 'number', description: 'log: maximum number of commits (default 10)' },
    },
    required: ['action'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const action = params.action as GitAction;
    const cwd = (params.cwd as string) || process.cwd();

    const spec = ACTIONS[action];
    if (!spec) {
      return { success: false, output: '', error: `Unknown git action: ${action}` };
    }

    let args: string[];
    try {
      args = spec.args(params);
    } catch (e) {
      return { success: false, output: '', error: String(e) };
    }

    // Simple shell argument escaping
    const cmd = 'git ' + args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
      });
      // Truncate large output
      const output = (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).slice(0, 50_000);
      return { success: true, output: output || '(empty output)' };
    } catch (error: any) {
      return {
        success: false,
        output: error.stdout || '',
        error: error.stderr || String(error),
      };
    }
  },
};
