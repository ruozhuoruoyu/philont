/**
 * SsrfValidator — server-side request forgery prevention
 *
 * Blocks HTTP requests targeting internal networks and cloud metadata endpoints.
 * Applies to the http / webFetch / webSearch tools.
 *
 * Check order:
 *   1. URL validity (scheme, format)
 *   2. Hostname blocklist (localhost / metadata.google.internal etc.)
 *   3. Literal IP blocklist (including IPv6-embedded IPv4)
 *   4. Post-DNS second check (anti-TOCTOU; imperfect but blocks the vast majority)
 *
 * Reference: OpenClaw project src/infra/net/ssrf.ts (algorithm adapted, code rewritten)
 */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { Validator, ValidatorContext } from './types.js';
import { pass, deny } from './types.js';

export interface SsrfConfig {
  /** Explicitly allow private-network access (for testing; default false) */
  allowPrivateNetwork?: boolean;
  /** Explicitly allowed hostnames/IPs */
  allowHosts?: string[];
  /** Whether to perform a post-DNS second check (default true) */
  verifyDns?: boolean;
  /** Target tool set (tools not listed are skipped) */
  toolNames?: Set<string>;
  /** URL field names */
  urlFields?: string[];
}

const DEFAULT_SSRF_TOOLS = new Set(['http', 'webFetch', 'webSearch']);
const DEFAULT_URL_FIELDS = ['url'];

/** Hard-coded blocked hostnames */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.aws.amazon.com',
  'instance-data',
  'instance-data.ec2.internal',
]);

/** Dangerous TLD/suffixes — hostnames ending with any of these are always blocked */
const BLOCKED_TLD_SUFFIXES = ['.localhost', '.local', '.internal', '.corp', '.home'];

/**
 * Check whether an IPv4 address falls in a private/special range.
 * Using Node.js net.BlockList would be cleaner, but explicit ranges are unambiguous here.
 */
function isBlockedIPv4(ip: string, allowPrivate: boolean): { blocked: boolean; reason?: string } {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    return { blocked: true, reason: 'malformed IPv4' };
  }
  const [a, b] = parts;

  // Always-blocked ranges (even when allowPrivate=true)
  if (a === 127) return { blocked: true, reason: 'loopback (127/8)' };
  if (a === 0) return { blocked: true, reason: 'unspecified (0/8)' };
  if (a >= 224 && a <= 239) return { blocked: true, reason: 'multicast (224/4)' };
  if (a >= 240) return { blocked: true, reason: 'reserved (240/4)' };
  if (a === 169 && b === 254) return { blocked: true, reason: 'link-local / cloud metadata (169.254/16)' };

  if (allowPrivate) return { blocked: false };

  if (a === 10) return { blocked: true, reason: 'RFC1918 private (10/8)' };
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: 'RFC1918 private (172.16/12)' };
  if (a === 192 && b === 168) return { blocked: true, reason: 'RFC1918 private (192.168/16)' };
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: 'CGNAT (100.64/10)' };
  if (a === 192 && b === 0 && parts[2] === 2) return { blocked: true, reason: 'TEST-NET-1' };
  if (a === 198 && (b === 51 || b === 18 || b === 19)) return { blocked: true, reason: 'TEST-NET-2/benchmark' };
  if (a === 203 && b === 0 && parts[2] === 113) return { blocked: true, reason: 'TEST-NET-3' };

  return { blocked: false };
}

/** Convert the two hex groups of an IPv4-mapped IPv6 address (::ffff:XXXX:YYYY) to dotted-decimal IPv4 */
function ipv6MappedToIPv4(lower: string): string | null {
  // Form A: ::ffff:a.b.c.d (dotted-decimal)
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];

  // Form B: ::ffff:XXXX:YYYY (hex, Node.js normalised form)
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return `${a}.${b}.${c}.${d}`;
  }

  return null;
}

/** Check IPv6 (basic, including embedded IPv4 detection) */
function isBlockedIPv6(ip: string, allowPrivate: boolean): { blocked: boolean; reason?: string } {
  const lower = ip.toLowerCase();

  // Embedded IPv4 mapping (handles both dotted-decimal and hex normalised forms)
  const mapped = ipv6MappedToIPv4(lower);
  if (mapped) {
    const r = isBlockedIPv4(mapped, allowPrivate);
    if (r.blocked) return { blocked: true, reason: `embedded IPv4 (${mapped}) — ${r.reason}` };
    return { blocked: false };
  }

  // Loopback ::1 / unspecified ::
  if (lower === '::1' || lower === '::') return { blocked: true, reason: 'IPv6 loopback/unspecified' };

  // Link-local fe80::/10
  if (/^fe[89ab]/.test(lower)) {
    return { blocked: true, reason: 'IPv6 link-local (fe80::/10)' };
  }

  if (allowPrivate) return { blocked: false };

  // Unique local fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return { blocked: true, reason: 'IPv6 unique local (fc00::/7)' };
  }

  return { blocked: false };
}

function isBlockedHostname(hostname: string): { blocked: boolean; reason?: string } {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) {
    return { blocked: true, reason: `blocked hostname: ${lower}` };
  }
  for (const suffix of BLOCKED_TLD_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { blocked: true, reason: `blocked TLD suffix: ${suffix}` };
    }
  }
  return { blocked: false };
}

/** Composite check (literal hostname/IP) */
function checkLiteralHost(host: string, allowPrivate: boolean): { blocked: boolean; reason?: string } {
  const ipVer = isIP(host);
  if (ipVer === 4) return isBlockedIPv4(host, allowPrivate);
  if (ipVer === 6) return isBlockedIPv6(host, allowPrivate);
  return isBlockedHostname(host);
}

/**
 * Create an SSRF Validator
 */
export function createSsrfValidator(config: SsrfConfig = {}): Validator {
  const allowPrivate = config.allowPrivateNetwork ?? false;
  const allowHosts = new Set((config.allowHosts ?? []).map(s => s.toLowerCase()));
  const verifyDns = config.verifyDns ?? true;
  const toolNames = config.toolNames ?? DEFAULT_SSRF_TOOLS;
  const urlFields = config.urlFields ?? DEFAULT_URL_FIELDS;

  return async (ctx: ValidatorContext) => {
    if (!toolNames.has(ctx.toolName)) return pass();

    for (const field of urlFields) {
      const raw = ctx.params[field];
      if (typeof raw !== 'string' || raw.length === 0) continue;

      // 1. URL format
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return deny('SSRF_INVALID_URL', `Invalid URL in ${field}: ${raw}`);
      }

      // 2. Scheme
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return deny('SSRF_INVALID_SCHEME', `Only http/https allowed, got: ${url.protocol}`);
      }

      // 3. Reject userinfo (prevents confusion attacks)
      if (url.username || url.password) {
        return deny('SSRF_USERINFO', 'URL must not contain userinfo');
      }

      const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
      if (allowHosts.has(host.toLowerCase())) continue;

      // 4. Literal hostname/IP
      const lit = checkLiteralHost(host, allowPrivate);
      if (lit.blocked) {
        return deny('SSRF_LITERAL_BLOCKED', `SSRF blocked (${lit.reason}): ${host}`);
      }

      // 5. Post-DNS second check (hostname only)
      if (verifyDns && isIP(host) === 0) {
        try {
          const resolved = await dns.lookup(host, { all: true });
          for (const entry of resolved) {
            const r = checkLiteralHost(entry.address, allowPrivate);
            if (r.blocked) {
              return deny(
                'SSRF_RESOLVED_BLOCKED',
                `SSRF blocked after DNS (${r.reason}): ${host} → ${entry.address}`,
              );
            }
          }
        } catch (e) {
          // fail-closed: reject on DNS lookup failure
          return deny('SSRF_DNS_FAIL', `DNS lookup failed for ${host}: ${e}`);
        }
      }
    }

    return pass();
  };
}
