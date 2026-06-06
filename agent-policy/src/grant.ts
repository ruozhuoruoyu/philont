/**
 * GrantStore: dynamic grant storage with TTL decay
 *
 * Supports three grant granularities (scope):
 *   - tool:    authorises the entire tool (original semantics, default)
 *   - command: glob-matches against the command field
 *   - path:    glob-matches against the path/from/to fields
 *
 * Grants are additive: the same tool name can have multiple grants with different scopes.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Capability, Domain } from './matrix.js';

export type GrantScope = 'tool' | 'command' | 'path';

export interface Grant {
  toolName:   string;
  scope:      GrantScope;
  /** pattern: ignored when scope='tool'; for 'command'/'path' it is a glob pattern */
  pattern?:   string;
  capability: Capability;
  domain:     Domain;
  expiresAt:  number;
  reason:     string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Simple glob compiler (supports *, **, ?) */
function globToRegex(pattern: string): RegExp {
  const expanded = pattern.startsWith('~') ? homedir() + pattern.slice(1) : pattern;
  let regex = '';
  let i = 0;
  while (i < expanded.length) {
    const c = expanded[i];
    if (c === '*') {
      if (expanded[i + 1] === '*') {
        regex += '.*';
        i += 2;
        if (expanded[i] === '/') i++;
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
  return new RegExp('^' + regex + '$');
}

function normalizePath(p: string): string {
  const expanded = p.startsWith('~') ? homedir() + p.slice(1) : p;
  return resolve(expanded);
}

export class GrantStore {
  // Indexed by toolName; value is a list of grants
  private grants = new Map<string, Grant[]>();

  /**
   * Add a grant
   *
   * Two calling forms (backward compatible):
   *   grant(toolName, capability, domain, reason, ttlMs?)  — equivalent to scope='tool'
   *   grant({ toolName, scope, pattern, capability, domain, reason, ttlMs? })
   */
  grant(toolName: string, capability: Capability, domain: Domain, reason: string, ttlMs?: number): void;
  grant(spec: {
    toolName: string;
    scope?: GrantScope;
    pattern?: string;
    capability: Capability;
    domain: Domain;
    reason: string;
    ttlMs?: number;
  }): void;
  grant(
    arg: string | {
      toolName: string;
      scope?: GrantScope;
      pattern?: string;
      capability: Capability;
      domain: Domain;
      reason: string;
      ttlMs?: number;
    },
    capability?: Capability,
    domain?: Domain,
    reason?: string,
    ttlMs: number = DEFAULT_TTL_MS,
  ): void {
    let g: Grant;
    if (typeof arg === 'string') {
      g = {
        toolName: arg,
        scope: 'tool',
        capability: capability!,
        domain: domain!,
        expiresAt: Date.now() + ttlMs,
        reason: reason!,
      };
    } else {
      g = {
        toolName: arg.toolName,
        scope: arg.scope ?? 'tool',
        pattern: arg.pattern,
        capability: arg.capability,
        domain: arg.domain,
        expiresAt: Date.now() + (arg.ttlMs ?? DEFAULT_TTL_MS),
        reason: arg.reason,
      };
    }

    const list = this.grants.get(g.toolName) ?? [];
    list.push(g);
    this.grants.set(g.toolName, list);
  }

  /**
   * Check whether there is an unexpired grant
   *
   * @param toolName   Tool name
   * @param params     Tool parameters (optional; used for command/path scope matching)
   * @param scopeMin   Minimum scope requirement:
   *                     'tool'    = accept any scope (default, used by the matrix layer)
   *                     'command' = accept only command/path scope (used by the validator layer)
   *                     'path'    = same as above
   */
  isGranted(
    toolName: string,
    params?: Record<string, unknown>,
    scopeMin: GrantScope = 'tool',
  ): boolean {
    const list = this.grants.get(toolName);
    if (!list || list.length === 0) return false;

    const now = Date.now();
    const active = list.filter(g => g.expiresAt > now);
    if (active.length === 0) {
      this.grants.delete(toolName);
      return false;
    }
    if (active.length !== list.length) {
      this.grants.set(toolName, active);
    }

    for (const g of active) {
      // Validator level does not accept tool-scope (tool-scope can only bypass the matrix)
      if (scopeMin !== 'tool' && g.scope === 'tool') continue;
      if (this.matches(g, params)) return true;
    }
    return false;
  }

  private matches(g: Grant, params?: Record<string, unknown>): boolean {
    if (g.scope === 'tool') return true;
    if (!params || !g.pattern) return false;

    if (g.scope === 'command') {
      const cmd = params.command;
      if (typeof cmd !== 'string') return false;
      return globToRegex(g.pattern).test(cmd);
    }

    if (g.scope === 'path') {
      const rx = globToRegex(g.pattern);
      for (const key of ['path', 'from', 'to', 'cwd']) {
        const v = params[key];
        if (typeof v === 'string' && rx.test(normalizePath(v))) return true;
      }
      return false;
    }

    return false;
  }

  /** Revoke all grants for a tool */
  revoke(toolName: string): void {
    this.grants.delete(toolName);
  }

  /** Return all unexpired grants (for debugging) */
  list(): Grant[] {
    const now = Date.now();
    const out: Grant[] = [];
    for (const [name, list] of this.grants) {
      const active = list.filter(g => g.expiresAt > now);
      if (active.length > 0) {
        out.push(...active);
        if (active.length !== list.length) this.grants.set(name, active);
      } else {
        this.grants.delete(name);
      }
    }
    return out;
  }
}
