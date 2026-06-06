/**
 * grep tool - search files for a regular expression
 *
 * Supports:
 *   - Regular expression search
 *   - Path filtering (prefix match)
 *   - Case-sensitive / case-insensitive
 *   - Context lines
 *   - Limit on number of matches
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { Tool } from '@agent/policy';

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/** Recursively collect all files under a directory (with filtering) */
async function collectFiles(
  dir: string,
  maxFiles: number,
  extensions?: string[],
  skipDirs: Set<string> = new Set(['node_modules', '.git', 'dist', 'build', 'target']),
): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    if (results.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (skipDirs.has(entry) || entry.startsWith('.git')) continue;

      const full = join(current, entry);
      const s = await stat(full).catch(() => null);
      if (!s) continue;

      if (s.isDirectory()) {
        await walk(full);
      } else if (s.isFile()) {
        if (extensions && !extensions.includes(extname(entry))) continue;
        // Skip binary files (simple heuristic: larger than 1MB)
        if (s.size > 1_000_000) continue;
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search files for a regular expression; returns matching files and line numbers',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression to search for' },
      path: { type: 'string', description: 'Directory or file to search; defaults to the current directory' },
      caseSensitive: { type: 'boolean', description: 'Whether the search is case-sensitive (default true)' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by file extension, e.g. [".ts", ".js"]',
      },
      maxMatches: { type: 'number', description: 'Maximum number of matches to return (default 100)' },
      maxFiles: { type: 'number', description: 'Maximum number of files to scan (default 1000)' },
    },
    required: ['pattern'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const pattern = params.pattern as string;
    const path = (params.path as string) || '.';
    const caseSensitive = (params.caseSensitive as boolean) ?? true;
    const extensions = params.extensions as string[] | undefined;
    const maxMatches = (params.maxMatches as number) || 100;
    const maxFiles = (params.maxFiles as number) || 1000;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (e) {
      return { success: false, output: '', error: `Invalid regex: ${e}` };
    }

    try {
      // Determine the list of files to search
      const s = await stat(path);
      const files = s.isFile()
        ? [path]
        : await collectFiles(path, maxFiles, extensions);

      const matches: GrepMatch[] = [];

      for (const file of files) {
        if (matches.length >= maxMatches) break;

        const content = await readFile(file, 'utf-8').catch(() => null);
        if (content === null) continue;

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxMatches) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matches.push({ file, line: i + 1, text: lines[i].slice(0, 200) });
          }
        }
      }

      if (matches.length === 0) {
        return { success: true, output: `No matches for "${pattern}" in ${files.length} files` };
      }

      const output = matches
        .map((m) => `${m.file}:${m.line}: ${m.text}`)
        .join('\n');

      const summary = `Found ${matches.length} matches${matches.length >= maxMatches ? ' (truncated)' : ''} in ${files.length} files scanned`;
      return { success: true, output: `${summary}\n${output}` };
    } catch (error) {
      return { success: false, output: '', error: `Grep failed: ${error}` };
    }
  },
};
