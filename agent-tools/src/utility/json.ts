/**
 * json tool - JSON operations
 */

import type { Tool } from '@agent/policy';

export const jsonTool: Tool = {
  name: 'json',
  description: 'JSON parsing and formatting',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action', enum: ['parse', 'stringify', 'validate'] },
      data: { type: 'string', description: 'Input data' },
    },
    required: ['action', 'data'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const action = params.action as string;
    const data = params.data as string;

    try {
      switch (action) {
        case 'parse':
          return { success: true, output: JSON.stringify(JSON.parse(data), null, 2) };
        case 'stringify':
          return { success: true, output: JSON.stringify(data) };
        case 'validate':
          JSON.parse(data);
          return { success: true, output: 'Valid JSON' };
        default:
          return { success: false, output: '', error: 'Unknown action' };
      }
    } catch (error) {
      return { success: false, output: '', error: String(error) };
    }
  },
};
