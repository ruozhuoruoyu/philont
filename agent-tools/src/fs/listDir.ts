/**
 * listDir tool - list directory contents
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '@agent/policy';

export const listDirTool: Tool = {
  name: 'listDir',
  description: 'List the contents of a directory',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
    },
    required: ['path'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const dir = params.path as string;
    try {
      const entries = await readdir(dir);
      const lines = await Promise.all(entries.map(async (name) => {
        const s = await stat(join(dir, name)).catch(() => null);
        const type = s?.isDirectory() ? 'd' : 'f';
        return `[${type}] ${name}`;
      }));
      return { success: true, output: lines.join('\n') };
    } catch (error) {
      return { success: false, output: '', error: `Failed to list dir: ${error}` };
    }
  },
};
