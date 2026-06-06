/**
 * readFile tool - read file contents
 */

import { readFile } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

export const readFileTool: Tool = {
  name: 'readFile',
  description: 'Read the contents of a file',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
    },
    required: ['path'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const path = params.path as string;
    try {
      const content = await readFile(path, 'utf-8');
      return { success: true, output: content };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `Failed to read file: ${error}`,
      };
    }
  },
};
