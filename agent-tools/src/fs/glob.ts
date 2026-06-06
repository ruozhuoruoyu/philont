/**
 * glob tool - find files by glob pattern
 *
 * Supported glob syntax:
 *   *        matches any characters (excluding /)
 *   **       matches any path segments (including /)
 *   ?        matches a single character
 *   [abc]    matches a character set
 *   {a,b,c}  matches any one option
 *
 * Examples:
 *   src/**\/*.ts         all ts files
 *   src/*.{js,ts}        js or ts files under src
 *   **\/test_*.py        test_-prefixed py files at any depth
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Tool } from '@agent/policy';

/**
 * Compile a glob pattern into a RegExp
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any path (including /)
        regex += '.*';
        i += 2;
        // consume a trailing /
        if (pattern[i] === '/') i++;
        continue;
      }
      // * matches a single path segment (no /)
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if (c === '[') {
      // Pass character sets through verbatim
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        regex += '\\[';
      } else {
        regex += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (c === '{') {
      // {a,b,c} → (a|b|c)  (unchanged)
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        regex += '\\{';
      } else {
        const options = pattern.slice(i + 1, end).split(',');
        regex += '(' + options.map(o => o.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      }
    } else if ('.+^$()|\\'.includes(c)) {
      // Escape regex special characters
      regex += '\\' + c;
    } else {
      regex += c;
    }
    i++;
  }

  return new RegExp('^' + regex + '$');
}

async function walkDir(
  root: string,
  regex: RegExp,
  maxResults: number,
  skipDirs: Set<string> = new Set(['node_modules', '.git', 'dist', 'build', 'target']),
): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    if (results.length >= maxResults) return;

    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (skipDirs.has(entry)) continue;

      const full = join(current, entry);
      const s = await stat(full).catch(() => null);
      if (!s) continue;

      const rel = relative(root, full);

      if (s.isFile()) {
        if (regex.test(rel)) {
          results.push(full);
        }
      } else if (s.isDirectory()) {
        await walk(full);
      }
    }
  }

  await walk(root);
  return results;
}

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files by glob pattern (supports **, *, ?, {}, [])',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
      cwd: { type: 'string', description: 'Starting directory; defaults to the current directory' },
      maxResults: { type: 'number', description: 'Maximum number of files to return (default 500)' },
    },
    required: ['pattern'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const pattern = params.pattern as string;
    const cwd = (params.cwd as string) || '.';
    const maxResults = (params.maxResults as number) || 500;

    try {
      const regex = globToRegex(pattern);
      const files = await walkDir(cwd, regex, maxResults);

      if (files.length === 0) {
        return { success: true, output: `No files matching "${pattern}"` };
      }

      return {
        success: true,
        output: `Found ${files.length} file(s):\n${files.join('\n')}`,
      };
    } catch (error) {
      return { success: false, output: '', error: `Glob failed: ${error}` };
    }
  },
};
