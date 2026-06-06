/**
 * hash tool - hashing and encoding
 *
 * Supports:
 *   - md5, sha1, sha256, sha512 hashing
 *   - base64 encoding/decoding
 *   - hex encoding/decoding
 */

import { createHash } from 'node:crypto';
import type { Tool } from '@agent/policy';

type Algorithm = 'md5' | 'sha1' | 'sha256' | 'sha512' | 'base64encode' | 'base64decode' | 'hexencode' | 'hexdecode';

export const hashTool: Tool = {
  name: 'hash',
  description: 'Hashing and encoding: md5/sha1/sha256/sha512/base64/hex',
  schema: {
    type: 'object',
    properties: {
      algorithm: {
        type: 'string',
        enum: ['md5', 'sha1', 'sha256', 'sha512', 'base64encode', 'base64decode', 'hexencode', 'hexdecode'],
      },
      input: { type: 'string', description: 'Input text' },
    },
    required: ['algorithm', 'input'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const algorithm = params.algorithm as Algorithm;
    const input = params.input as string;

    try {
      let output: string;
      switch (algorithm) {
        case 'md5':
        case 'sha1':
        case 'sha256':
        case 'sha512':
          output = createHash(algorithm).update(input).digest('hex');
          break;
        case 'base64encode':
          output = Buffer.from(input, 'utf-8').toString('base64');
          break;
        case 'base64decode':
          output = Buffer.from(input, 'base64').toString('utf-8');
          break;
        case 'hexencode':
          output = Buffer.from(input, 'utf-8').toString('hex');
          break;
        case 'hexdecode':
          output = Buffer.from(input, 'hex').toString('utf-8');
          break;
        default:
          return { success: false, output: '', error: `Unknown algorithm: ${algorithm}` };
      }
      return { success: true, output };
    } catch (e) {
      return { success: false, output: '', error: String(e) };
    }
  },
};
