/**
 * URL Allowlist Validator — trusted endpoint patterns
 *
 * Complements SSRF protection: SSRF blocks internal networks; the allowlist blocks
 * "untrusted external networks".
 * Typical use cases:
 *   - Agent should only reach specific APIs (github.com, api.openai.com)
 *   - Enterprise environments: only internal API gateways permitted
 *
 * Disabled by default (empty allowList means no restriction). Enabling it switches
 * the validator into allowlist-only mode.
 */

import type { Validator, ValidatorContext } from './types.js';
import { pass, deny } from './types.js';

export interface UrlAllowlistConfig {
  /** List of allowed hostnames; supports *.example.com wildcards */
  allowHosts: string[];
  /** Optional: per-host path prefix restrictions */
  allowPaths?: Record<string, string[]>;
  /** Whether to require HTTPS */
  requireHttps?: boolean;
  /** Tool names this validator applies to */
  toolNames?: Set<string>;
  /** URL field names to inspect */
  urlFields?: string[];
}

const DEFAULT_TOOLS = new Set(['http', 'webFetch', 'webSearch']);
const DEFAULT_FIELDS = ['url'];

function hostMatches(host: string, pattern: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // .example.com
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return false;
}

function pathMatches(path: string, prefixes: string[]): boolean {
  return prefixes.some(p => path.startsWith(p));
}

export function createUrlAllowlistValidator(config: UrlAllowlistConfig): Validator {
  const allowHosts = config.allowHosts.map(h => h.toLowerCase());
  const allowPaths = config.allowPaths ?? {};
  const requireHttps = config.requireHttps ?? false;
  const toolNames = config.toolNames ?? DEFAULT_TOOLS;
  const urlFields = config.urlFields ?? DEFAULT_FIELDS;

  return (ctx: ValidatorContext) => {
    if (!toolNames.has(ctx.toolName)) return pass();
    // Empty allowlist means no restriction (let SSRF validator handle it alone)
    if (allowHosts.length === 0) return pass();

    for (const field of urlFields) {
      const raw = ctx.params[field];
      if (typeof raw !== 'string') continue;

      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return deny('URL_ALLOWLIST_INVALID_URL', `Invalid URL: ${raw}`);
      }

      if (requireHttps && url.protocol !== 'https:') {
        return deny('URL_ALLOWLIST_NOT_HTTPS', `HTTPS required: ${raw}`);
      }

      const host = url.hostname.toLowerCase();
      const matched = allowHosts.find(p => hostMatches(host, p));
      if (!matched) {
        return deny(
          'URL_ALLOWLIST_HOST_BLOCKED',
          `Host not in allowlist: ${host} (allowed: ${allowHosts.join(', ')})`,
        );
      }

      // If path prefixes are configured for this host, the request path must match
      const pathPrefixes = allowPaths[matched] ?? allowPaths[host];
      if (pathPrefixes && pathPrefixes.length > 0) {
        if (!pathMatches(url.pathname, pathPrefixes)) {
          return deny(
            'URL_ALLOWLIST_PATH_BLOCKED',
            `Path not allowed for ${host}: ${url.pathname} (allowed: ${pathPrefixes.join(', ')})`,
          );
        }
      }
    }

    return pass();
  };
}
