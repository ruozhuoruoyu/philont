/**
 * patch tool - structured file editing
 *
 * Safer than writeFile: replaces content by exact string match, avoiding accidental overwrites.
 *
 * Operation modes:
 *   - replace  find oldText in the file and replace with newText (must match exactly)
 *   - prepend  insert at the beginning of the file
 *   - append   append at the end of the file
 *
 * Protection mechanisms:
 *   - oldText must appear exactly once (avoid accidental replacement)
 *   - empty string oldText is rejected
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

type PatchMode = 'replace' | 'prepend' | 'append';

export const patchTool: Tool = {
  name: 'patch',
  description: 'Structured file editing (exact string replace/insert); safer than writeFile',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      mode: {
        type: 'string',
        enum: ['replace', 'prepend', 'append'],
        description: 'Operation mode: replace / prepend (insert at start) / append (at end)',
      },
      oldText: { type: 'string', description: 'Text to replace (required for replace mode; must be unique)' },
      newText: { type: 'string', description: 'New text' },
    },
    required: ['path', 'mode', 'newText'],
  },
  capability: 'write',
  domain: 'local',
  async execute(params) {
    const path = params.path as string;
    const mode = params.mode as PatchMode;
    const oldText = params.oldText as string | undefined;
    const newText = params.newText as string;

    if (newText === undefined || newText === null) {
      return { success: false, output: '', error: 'newText is required' };
    }

    try {
      let content: string;
      try {
        content = await readFile(path, 'utf-8');
      } catch (e) {
        if (mode === 'replace') {
          return { success: false, output: '', error: `File not found: ${path}` };
        }
        content = '';
      }

      let updated: string;

      switch (mode) {
        case 'replace': {
          if (!oldText) {
            return { success: false, output: '', error: 'oldText is required for replace mode' };
          }
          // Check how many times oldText appears
          const occurrences = content.split(oldText).length - 1;
          if (occurrences === 0) {
            return {
              success: false,
              output: '',
              error: `oldText not found in ${path}. Read the file first to check exact content.`,
            };
          }
          if (occurrences > 1) {
            return {
              success: false,
              output: '',
              error: `oldText appears ${occurrences} times in ${path}. Provide more context to make it unique.`,
            };
          }
          updated = content.replace(oldText, newText);
          break;
        }
        case 'prepend':
          updated = newText + content;
          break;
        case 'append':
          updated = content + newText;
          break;
        default:
          return { success: false, output: '', error: `Unknown mode: ${mode}` };
      }

      await writeFile(path, updated, 'utf-8');
      const delta = updated.length - content.length;
      return {
        success: true,
        output: `Patched ${path} (${mode}): ${delta >= 0 ? '+' : ''}${delta} bytes`,
      };
    } catch (error) {
      return { success: false, output: '', error: `Patch failed: ${error}` };
    }
  },
};
