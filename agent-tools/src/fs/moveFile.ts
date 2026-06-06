/**
 * moveFile tool - move or rename a file
 */

import { rename } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

export const moveFileTool: Tool = {
  name: 'moveFile',
  description: 'Move or rename a file',
  schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path' },
      to:   { type: 'string', description: 'Destination path' },
    },
    required: ['from', 'to'],
  },
  capability: 'write',
  domain: 'local',
  async execute(params) {
    const from = params.from as string;
    const to   = params.to   as string;
    try {
      await rename(from, to);
      return { success: true, output: `Moved ${from} → ${to}` };
    } catch (error) {
      return { success: false, output: '', error: `Failed to move file: ${error}` };
    }
  },
};
