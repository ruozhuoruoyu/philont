/**
 * memory tool - simple key-value store
 */

import type { Tool } from '@agent/policy';

// In-memory store
const store = new Map<string, string>();

export const memoryTool: Tool = {
  name: 'memory',
  description: 'Key-value store (read/write memory)',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'delete', 'list'] },
      key: { type: 'string', description: 'Key' },
      value: { type: 'string', description: 'Value (required for set)' },
    },
    required: ['action'],
  },
  capability: 'write',
  domain: 'local',
  async execute(params) {
    const action = params.action as string;
    const key = params.key as string;
    const value = params.value as string;

    switch (action) {
      case 'get':
        if (!key) return { success: false, output: '', error: 'key required' };
        const val = store.get(key);
        return val
          ? { success: true, output: val }
          : { success: false, output: '', error: 'Key not found' };

      case 'set':
        if (!key || !value) return { success: false, output: '', error: 'key and value required' };
        store.set(key, value);
        return { success: true, output: `Stored: ${key}` };

      case 'delete':
        if (!key) return { success: false, output: '', error: 'key required' };
        store.delete(key);
        return { success: true, output: `Deleted: ${key}` };

      case 'list':
        const keys = Array.from(store.keys());
        return { success: true, output: keys.join(', ') || '(empty)' };

      default:
        return { success: false, output: '', error: 'Unknown action' };
    }
  },
};
