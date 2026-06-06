/**
 * writeFile tool - write to a file
 */

import { writeFile } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

export const writeFileTool: Tool = {
  name: 'writeFile',
  description: 'Write contents to a file',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File contents' },
    },
    required: ['path', 'content'],
  },
  capability: 'write',
  domain: 'local',
  async execute(params) {
    const path = params.path as string;
    const content = params.content as string;
    try {
      await writeFile(path, content, 'utf-8');
      return { success: true, output: `Wrote ${content.length} bytes to ${path}` };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `Failed to write file: ${error}`,
      };
    }
  },
};
