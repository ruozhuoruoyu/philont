/**
 * PathAclValidator — file-path access control
 *
 * Intercepts reads/writes to sensitive system paths, preventing attacks such as readFile /etc/shadow.
 *
 * Logic:
 *   1. Extract path fields from tool params (path, from, to, cwd)
 *   2. Normalise to absolute paths (resolve ~, ., ..)
 *   3. Compare against allowList / denyList
 *   4. workspaceOnly mode: only paths under workspaceDir are allowed
 *
 * Reference: OpenClaw project src/agents/tools/media-tool-shared.ts::resolveMediaToolLocalRoots
 */

import { resolve, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Validator, ValidatorContext } from './types.js';
import { pass, deny } from './types.js';

export interface PathAclConfig {
  /** Allow list (glob patterns) — matched entries pass immediately */
  allowList?: string[];
  /** Deny list (glob patterns) — matched entries are rejected */
  denyList?: string[];
  /** Only allow paths under workspaceDir */
  workspaceOnly?: boolean;
  /** Working directory (used with workspaceOnly) */
  workspaceDir?: string;
  /** Set of tool names that require path checks (tools not listed are skipped) */
  toolNames?: Set<string>;
  /** Param field names to check */
  pathFields?: string[];
  /** Override OS detection for glob matching (testing / cross-platform). Default: process.platform. */
  platform?: NodeJS.Platform;
}

/** Default sensitive-path denyList (read and write both denied) */
export const DEFAULT_SENSITIVE_PATHS: string[] = [
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d/**',
  '/etc/passwd-*',
  '/boot/**',
  '/usr/lib/systemd/**',
  '**/.ssh/**',
  '**/.aws/credentials',
  '**/.aws/config',
  '**/.docker/config.json',
  '**/.env',
  '**/.env.*',
  '**/id_rsa',
  '**/id_ed25519',
  '**/id_ecdsa',
  '**/*.pem',
];

/** Default set of tools that require path checks */
const DEFAULT_PATH_TOOLS = new Set([
  'readFile', 'writeFile', 'deleteFile', 'moveFile', 'listDir',
  'grep', 'glob', 'patch',
]);

/** Default field names to check */
const DEFAULT_PATH_FIELDS = ['path', 'from', 'to', 'cwd'];

/**
 * Glob → RegExp compiler (supports **, *, ?)
 *
 * Simplified copy of agent-tools/src/fs/glob.ts (avoids cross-package dependency)
 */
// Platform branch: Windows file systems use backslash separators and are case-INsensitive; POSIX uses
// forward slashes and is case-sensitive. The glob patterns are written with forward slashes, so on
// Windows we normalise backslashes to forward slashes on both pattern and subject and compile the regex
// case-insensitively. Without this, denylist patterns with internal separators (the .ssh and
// .aws/credentials style entries) silently fail to match the backslash paths that path.resolve produces
// on Windows. `isWindows` is threaded from config (default process.platform) so it is testable off-Windows.

/** Normalise a path/pattern for glob matching: forward slashes on Windows, unchanged on POSIX. */
function toMatchForm(s: string, isWindows: boolean): string {
  return isWindows ? s.replace(/\\/g, '/') : s;
}

function globToRegex(pattern: string, isWindows: boolean): RegExp {
  // Expand ~ to homedir, then normalise separators (Windows) so forward-slash patterns match.
  const expanded = pattern.startsWith('~')
    ? homedir() + pattern.slice(1)
    : pattern;
  const src = toMatchForm(expanded, isWindows);

  let regex = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') {
        regex += '.*';
        i += 2;
        if (src[i] === '/') i++;
        continue;
      }
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if ('.+^$()|[]{}\\'.includes(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
    i++;
  }
  // Windows file systems are case-insensitive → match patterns case-insensitively there.
  return new RegExp('^' + regex + '$', isWindows ? 'i' : '');
}

/** Normalise path: expand ~, convert to absolute, eliminate .. */
function normalizePath(p: string, cwd: string = process.cwd()): string {
  let expanded = p;
  if (expanded.startsWith('~')) {
    expanded = homedir() + expanded.slice(1);
  }
  return resolve(cwd, expanded);
}

/** Extract all paths to validate from the tool params */
function extractPaths(params: Record<string, unknown>, fields: string[]): string[] {
  const paths: string[] = [];
  for (const f of fields) {
    const v = params[f];
    if (typeof v === 'string' && v.length > 0) {
      paths.push(v);
    }
  }
  return paths;
}

/** Check whether normalizedPath matches any of the given glob patterns */
function matchesAny(normalizedPath: string, patterns: string[] | undefined, isWindows: boolean): boolean {
  if (!patterns || patterns.length === 0) return false;
  const subject = toMatchForm(normalizedPath, isWindows);
  for (const pat of patterns) {
    const rx = globToRegex(pat, isWindows);
    if (rx.test(subject)) return true;
  }
  return false;
}

/** Check whether path is under workspaceDir (boundary sep prevents prefix confusion) */
function isUnderWorkspace(normalizedPath: string, workspaceDir: string): boolean {
  const ws = resolve(workspaceDir);
  const prefix = ws.endsWith(sep) ? ws : ws + sep;
  return normalizedPath === ws || normalizedPath.startsWith(prefix);
}

/**
 * Create a PathAclValidator
 */
export function createPathAclValidator(config: PathAclConfig = {}): Validator {
  const toolNames = config.toolNames ?? DEFAULT_PATH_TOOLS;
  const fields = config.pathFields ?? DEFAULT_PATH_FIELDS;
  const allowList = config.allowList;
  const denyList = config.denyList ?? DEFAULT_SENSITIVE_PATHS;
  const workspaceOnly = config.workspaceOnly ?? false;
  const workspaceDir = config.workspaceDir;
  const isWindows = (config.platform ?? process.platform) === 'win32';

  return (ctx: ValidatorContext) => {
    // Skip tools that are not file-related
    if (!toolNames.has(ctx.toolName)) return pass();

    const paths = extractPaths(ctx.params, fields);
    if (paths.length === 0) return pass();

    for (const raw of paths) {
      if (!isAbsolute(raw) && !raw.startsWith('~') && !raw.startsWith('.')) {
        // Relative paths (e.g. "file.txt") are resolved under cwd
      }
      const norm = normalizePath(raw);

      // 1. allowList takes priority
      if (matchesAny(norm, allowList, isWindows)) continue;

      // 2. denyList reject
      if (matchesAny(norm, denyList, isWindows)) {
        return deny('PATH_ACL_DENY', `Path denied by ACL: ${norm}`);
      }

      // 3. workspaceOnly mode
      if (workspaceOnly) {
        if (!workspaceDir) {
          return deny('PATH_ACL_NO_WORKSPACE', 'workspaceOnly requires workspaceDir config');
        }
        if (!isUnderWorkspace(norm, workspaceDir)) {
          return deny(
            'PATH_ACL_OUTSIDE_WORKSPACE',
            `Path outside workspace: ${norm} (workspace: ${workspaceDir})`,
          );
        }
      }
    }

    return pass();
  };
}
