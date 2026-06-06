/**
 * deleteFile tool - delete a file or directory
 */

import { rm } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

export const deleteFileTool: Tool = {
  name: 'deleteFile',
  description: 'Delete a file or directory (directories are removed recursively)',
  schema: {
    type: 'object',
    properties: {
      path:      { type: 'string',  description: 'File or directory path' },
      recursive: { type: 'boolean', description: 'Whether to delete directories recursively (default false)' },
    },
    required: ['path'],
  },
  capability: 'write',
  domain: 'local',
  async execute(params) {
    const path      = params.path as string;
    const recursive = (params.recursive as boolean) ?? false;
    try {
      await rm(path, { recursive, force: true });
      return { success: true, output: `Deleted: ${path}` };
    } catch (error) {
      return { success: false, output: '', error: `Failed to delete: ${error}` };
    }
  },
};
