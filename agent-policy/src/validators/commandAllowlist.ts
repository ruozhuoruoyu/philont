/**
 * Command Allowlist Validator — safe-bins allowlist
 *
 * Complements dangerousCommands:
 *   - dangerousCommands: blocklist — intercepts dangerous patterns
 *   - commandAllowlist: allowlist — permits only the listed binaries
 *
 * Better suited to enterprise / high-security environments: explicitly authorise
 * the tools that may be used; everything else is denied.
 *
 * Reference: OpenClaw project safe-bins list (jq / cut / uniq / head / tail / tr / wc, etc.)
 */

import type { Validator, ValidatorContext } from './types.js';
import { pass, deny } from './types.js';

export interface CommandAllowEntry {
  /** Binary name (without path) */
  bin: string;
  /** Allowed argv flag prefixes; empty = allow any flag */
  allowFlags?: string[];
  /** Denied flags (take priority over allowFlags) */
  denyFlags?: string[];
  /** Maximum number of argv arguments */
  maxArgs?: number;
}

export interface CommandAllowlistConfig {
  allow: CommandAllowEntry[];
  toolNames?: Set<string>;
  commandFields?: string[];
  /** Whether to allow pipes / redirects (& | > < and other shell metacharacters) */
  allowShellMeta?: boolean;
}

const DEFAULT_TOOLS = new Set(['shell', 'process']);
const DEFAULT_FIELDS = ['command'];

/** Simple shell tokenise (does not handle spaces inside quotes, but sufficient here) */
function tokenize(cmd: string): string[] {
  // Treat quoted blocks as a single token
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|\S+/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[0]);
  }
  return tokens;
}

function hasShellMeta(cmd: string): boolean {
  return /[|&;<>`$(){}]/.test(cmd);
}

export function createCommandAllowlistValidator(config: CommandAllowlistConfig): Validator {
  const toolNames = config.toolNames ?? DEFAULT_TOOLS;
  const commandFields = config.commandFields ?? DEFAULT_FIELDS;
  const allowShellMeta = config.allowShellMeta ?? false;
  const byBin = new Map(config.allow.map(e => [e.bin, e]));

  return (ctx: ValidatorContext) => {
    if (!toolNames.has(ctx.toolName)) return pass();

    for (const field of commandFields) {
      const cmd = ctx.params[field];
      if (typeof cmd !== 'string') continue;

      if (!allowShellMeta && hasShellMeta(cmd)) {
        return deny(
          'COMMAND_ALLOWLIST_SHELL_META',
          `Shell metacharacters not allowed: ${cmd.slice(0, 80)}`,
        );
      }

      const tokens = tokenize(cmd);
      if (tokens.length === 0) continue;

      const bin = tokens[0]!;
      const binName = bin.split('/').pop()!;
      const entry = byBin.get(binName) ?? byBin.get(bin);
      if (!entry) {
        return deny(
          'COMMAND_ALLOWLIST_BIN_BLOCKED',
          `Binary not in allowlist: ${binName} (allowed: ${[...byBin.keys()].join(', ')})`,
        );
      }

      if (entry.maxArgs !== undefined && tokens.length - 1 > entry.maxArgs) {
        return deny(
          'COMMAND_ALLOWLIST_TOO_MANY_ARGS',
          `Too many args for ${binName}: ${tokens.length - 1} (max: ${entry.maxArgs})`,
        );
      }

      // Check each flag
      for (let i = 1; i < tokens.length; i++) {
        const arg = tokens[i]!;
        if (!arg.startsWith('-')) continue; // not a flag

        if (entry.denyFlags?.some(df => arg === df || arg.startsWith(df + '='))) {
          return deny(
            'COMMAND_ALLOWLIST_FLAG_DENIED',
            `Flag "${arg}" denied for ${binName}`,
          );
        }

        if (entry.allowFlags && entry.allowFlags.length > 0) {
          const ok = entry.allowFlags.some(af => arg === af || arg.startsWith(af));
          if (!ok) {
            return deny(
              'COMMAND_ALLOWLIST_FLAG_NOT_ALLOWED',
              `Flag "${arg}" not in allowlist for ${binName} (allowed: ${entry.allowFlags.join(', ')})`,
            );
          }
        }
      }
    }

    return pass();
  };
}

/** Default read-only safe-bins set */
export const DEFAULT_SAFE_BINS: CommandAllowEntry[] = [
  { bin: 'ls', allowFlags: ['-l', '-a', '-h', '-la', '-lh', '-lah'], maxArgs: 3 },
  { bin: 'cat' },
  { bin: 'head', allowFlags: ['-n'] },
  { bin: 'tail', allowFlags: ['-n', '-f'] },
  { bin: 'wc', allowFlags: ['-l', '-w', '-c'] },
  { bin: 'grep', allowFlags: ['-i', '-n', '-r', '-v', '-E'], denyFlags: ['-f', '--file'] },
  { bin: 'find', allowFlags: ['-name', '-type', '-size', '-mtime'], denyFlags: ['-exec', '-delete'] },
  { bin: 'echo' },
  { bin: 'pwd' },
  { bin: 'whoami' },
  { bin: 'date' },
  { bin: 'uname' },
];
