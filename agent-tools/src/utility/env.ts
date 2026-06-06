/**
 * env tool - read environment variables (with security filtering)
 *
 * Variables containing sensitive keywords (TOKEN/KEY/SECRET/PASSWORD, etc.) are masked by default;
 * the user must explicitly pass unmask: true to read them.
 */

import type { Tool } from '@agent/policy';

const SENSITIVE_PATTERNS = /(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE|AUTH)/i;

function maskValue(value: string): string {
  if (value.length <= 4) return '***';
  return value.slice(0, 2) + '***' + value.slice(-2);
}

export const envTool: Tool = {
  name: 'env',
  description: 'Read environment variables (sensitive variables are masked by default)',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'list'],
        description: 'get=read one, list=list matching',
      },
      name: { type: 'string', description: 'Variable name (required for get mode)' },
      prefix: { type: 'string', description: 'Filter prefix (optional for list mode)' },
      unmask: { type: 'boolean', description: 'Whether to return raw values of sensitive variables (default false)' },
    },
    required: ['action'],
  },
  capability: 'read',
  domain: 'system',
  async execute(params) {
    const action = params.action as string;
    const unmask = (params.unmask as boolean) || false;

    if (action === 'get') {
      const name = params.name as string;
      if (!name) return { success: false, output: '', error: 'name required' };
      const value = process.env[name];
      if (value === undefined) {
        return { success: false, output: '', error: `${name} is not set` };
      }
      const output = (!unmask && SENSITIVE_PATTERNS.test(name)) ? maskValue(value) : value;
      return { success: true, output };
    }

    if (action === 'list') {
      const prefix = (params.prefix as string) || '';
      const lines: string[] = [];
      for (const [name, value] of Object.entries(process.env)) {
        if (prefix && !name.startsWith(prefix)) continue;
        if (value === undefined) continue;
        const display = (!unmask && SENSITIVE_PATTERNS.test(name)) ? maskValue(value) : value;
        lines.push(`${name}=${display}`);
      }
      lines.sort();
      return { success: true, output: lines.join('\n') || '(no match)' };
    }

    return { success: false, output: '', error: `Unknown action: ${action}` };
  },
};
