/**
 * echo tool - simple output (for testing)
 */

import type { Tool } from '@agent/policy';

export const echoTool: Tool = {
  name: 'echo',
  description: 'Echo back the input text (test tool)',
  schema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to echo' },
    },
    required: ['message'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const message = params.message as string;
    return {
      success: true,
      output: message,
    };
  },
};
