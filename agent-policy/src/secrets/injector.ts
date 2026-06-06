/**
 * Injecting fetch wrapper — zero-exposure credential injection
 *
 * Usage:
 *   const injectFetch = createInjectingFetch(store, allowed);
 *   // Tool code:
 *   injectFetch('https://api.github.com/user', {
 *     headers: { 'Authorization': 'Bearer {GITHUB_TOKEN}' },
 *   });
 *   // The host, before sending:
 *   //   1. Identifies the placeholder {GITHUB_TOKEN}
 *   //   2. Retrieves the plaintext from SecretStore
 *   //   3. Substitutes it
 *   //   4. Leak-scans the injected request (prevents reverse misuse)
 *   //   5. Sends the request
 *
 * Key invariants:
 *   - Plaintext values never appear in tool code
 *   - store.get() is only called within this module, never exposed to tools
 */

import type { SecretStore } from './store.js';
import { scanText, DEFAULT_LEAK_PATTERNS } from '../validators/leakDetector.js';

/**
 * Recognise `{SECRET_ID}` placeholders. IDs may contain letters, digits,
 * underscores, and hyphens.
 *
 * 2026-05-15: added `-` support. SecretStore keys are typically kebab-case
 * (`mycox-api-key` / `slack-bot-token`). After seeing the names returned by
 * listCredentialNames, the LLM tends to write `{mycox-api-key}` directly (a
 * perfectly reasonable form). The previous PLACEHOLDER_RE did not allow `-`,
 * so the whole thing failed to match and was sent literally → upstream 401.
 *
 * Abstract examples like `{<credential-name>}` contain `<`, which is outside the
 * character set, so they still do not match (the LLM cannot accidentally use an
 * example literally). The original kebab fallback path (`{MYCOX_API_KEY}` →
 * kebab) is preserved.
 */
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

export interface InjectingFetchOptions {
  /**
   * Allowlist of secret IDs.
   * Placeholders not in this list are left as-is (not substituted, for easier debugging).
   * Defaults to allowing all IDs present in the store.
   */
  allowedSecrets?: Set<string>;
  /** Whether to scan the raw user input for secrets before injection (prevents LLM from embedding sk-xxx directly) */
  scanPreInject?: boolean;
  /** Whether to scan the request after injection (prevents credentials from leaking back via placeholder misuse) */
  scanPostInject?: boolean;
  /** Audit callback: invoked on each injection */
  onInject?: (info: { secretIds: string[]; url: string }) => void;
}

/**
 * Replace placeholders in a string
 *
 * 2026-05-10: added kebab-case fallback to resolve placeholder naming mismatches:
 *   - Keys in SecretStore are typically kebab-case (`mycox-api-key` / `slack_bot_token`)
 *   - PLACEHOLDER_RE only allowed `[A-Za-z_][A-Za-z0-9_]*` (no `-`), so the LLM
 *     had to write `{MYCOX_API_KEY}` (uppercase + `-`→`_`)
 *   - A direct `store.has("MYCOX_API_KEY")` then misses (store key is `mycox-api-key`)
 *     → placeholder sent literally → API 401
 *
 * Root cause of 30+ HTTP 401 failures in the mycox heartbeat integration.
 * Fallback chain:
 *   1. Direct lookup by id (backward-compatible; works when store uses all-uppercase keys)
 *   2. On miss: id.toLowerCase().replace(/_/g, '-') (common kebab-case form)
 *   3. On miss: id.toLowerCase() (all-lowercase snake_case)
 *
 * The allowed allowlist is checked against the original id (as written by the LLM),
 * not the resolved store key form.
 */
function resolveSecretKey(
  id: string,
  store: SecretStore,
): string | null {
  if (store.has(id)) return id;
  const kebab = id.toLowerCase().replace(/_/g, '-');
  if (kebab !== id && store.has(kebab)) return kebab;
  const lower = id.toLowerCase();
  if (lower !== id && lower !== kebab && store.has(lower)) return lower;
  return null;
}

function replacePlaceholders(
  input: string,
  store: SecretStore,
  allowed: Set<string> | null,
  seen: Set<string>,
): string {
  return input.replace(PLACEHOLDER_RE, (full, id: string) => {
    if (allowed && !allowed.has(id)) return full;
    const resolvedKey = resolveSecretKey(id, store);
    if (!resolvedKey) return full;
    const value = store.get(resolvedKey);
    if (value === undefined) return full;
    seen.add(id);
    return value;
  });
}

/** Deep-replace all string values within an object */
function replaceDeep(
  v: unknown,
  store: SecretStore,
  allowed: Set<string> | null,
  seen: Set<string>,
): unknown {
  if (typeof v === 'string') return replacePlaceholders(v, store, allowed, seen);
  if (Array.isArray(v)) return v.map(x => replaceDeep(x, store, allowed, seen));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object)) {
      out[k] = replaceDeep((v as Record<string, unknown>)[k], store, allowed, seen);
    }
    return out;
  }
  return v;
}

/** Normalise headers (object / Headers instance / array) into a plain Record */
function headersToRecord(h: unknown): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(h)) {
    const out: Record<string, string> = {};
    for (const e of h) {
      if (Array.isArray(e) && e.length === 2) out[String(e[0])] = String(e[1]);
    }
    return out;
  }
  if (typeof h === 'object') return { ...(h as Record<string, string>) };
  return {};
}

/**
 * Create a fetch wrapper with credential injection
 *
 * Behaviour:
 *   - {SECRET_ID} placeholders in the input URL / headers / body are replaced with plaintext values
 *   - Unknown / disallowed placeholders are left as-is (to aid debugging)
 *   - Optional pre-inject scan: if the input already contains a real secret pattern (e.g. sk-xxx),
 *     the request is rejected (prevents the LLM from embedding a value it retrieved)
 *   - Optional post-inject scan: if the injected URL or body contains additional recognisable secret
 *     patterns, a warning is emitted
 */
export function createInjectingFetch(
  store: SecretStore,
  options: InjectingFetchOptions = {},
): typeof fetch {
  const {
    allowedSecrets,
    scanPreInject = true,
    scanPostInject = false,
    onInject,
  } = options;

  const allowedSet = allowedSecrets ?? null;

  return async function injectingFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url0 = typeof input === 'string' || input instanceof URL
      ? String(input)
      : (input as Request).url;

    const headers0 = headersToRecord(init?.headers);
    const bodyIsString = typeof init?.body === 'string';
    const body0 = bodyIsString ? (init!.body as string) : '';

    // Pre-inject: scan the raw user input for secrets
    if (scanPreInject) {
      const combined = [url0, ...Object.values(headers0), body0].join('\n');
      // 1. Common secret patterns (sk-xxx / ghp_xxx / AKIA... and other known service prefixes)
      const hits = scanText(combined, DEFAULT_LEAK_PATTERNS);
      if (hits.some(h => h.action === 'block')) {
        const ids = [...new Set(hits.filter(h => h.action === 'block').map(h => h.patternId))];
        throw new Error(`Pre-inject leak detected (${ids.join(', ')}); tool must use {PLACEHOLDER} only`);
      }
      // 2. Prefix of secrets already in this SecretStore (2026-05-15: in the mycox heartbeat
      //    integration the LLM treated api_key_prefix as the full key; DEFAULT_LEAK_PATTERNS
      //    cannot catch project-specific secret shapes, so SecretStore.detectPrefixLeak is
      //    used as a fallback).
      const prefixLeaks = store.detectPrefixLeak(combined);
      if (prefixLeaks.length > 0) {
        const ids = [...new Set(prefixLeaks.map(p => p.id))];
        const examples = prefixLeaks.slice(0, 3).map(p => `${p.id}(prefix '${p.prefix}…')`).join(', ');
        throw new Error(
          `Pre-inject leak detected: secret prefix in outbound request — ${examples}. ` +
          `LLM is using a truncated/prefix value as the full credential. ` +
          `Use placeholder syntax instead: e.g. "Authorization: Bearer {${ids[0]}}",` +
          `host will substitute the full secret at send time. ` +
          `Call \`listCredentialNames\` to see available placeholders.`
        );
      }
    }

    const injected = new Set<string>();
    const url = replacePlaceholders(url0, store, allowedSet, injected);
    const headers = replaceDeep(headers0, store, allowedSet, injected) as Record<string, string>;
    const body = bodyIsString
      ? replacePlaceholders(body0, store, allowedSet, injected)
      : init?.body;

    if (onInject && injected.size > 0) {
      onInject({ secretIds: [...injected], url });
    }

    // Post-inject: scan for extra secrets (e.g. placeholder assembled incorrectly)
    if (scanPostInject && injected.size > 0) {
      const combined = [url, ...Object.values(headers), typeof body === 'string' ? body : ''].join('\n');
      const hits = scanText(combined, DEFAULT_LEAK_PATTERNS);
      // Injected IDs will naturally trigger hits — that is expected; but if hits > injected count,
      // there is a secret present that did not come from a placeholder.
      if (hits.length > injected.size) {
        // Log only; do not block (leave the decision to the host)
      }
    }

    // 2026-05-15: post-inject scan for unresolved placeholder residue.
    // The LLM wrote the wrong placeholder name (`{MYCOX_SECRET}` but SecretStore
    // has `mycox-api-key`), and the fallback chain (kebab/lower) also failed to
    // match → placeholder sent literally → upstream 401.
    //
    // 2026-05-17 upgrade (mycox `{Absorption}` typo in production): changed from
    // warn-only to fail-fast.  The LLM cannot see console warnings; it only sees
    // the upstream 401 and keeps retrying, eventually triggering the in-turn-
    // reflection tool lock.  Throwing causes the error to surface in the tool
    // result, so the LLM clearly sees "wrong placeholder — available ids: X / Y / Z".
    //
    // 2026-05-17 follow-up (production false positive): scope limited to
    // **URL + headers only**, body is not scanned.  When the LLM POSTed a new
    // article, the body contained legitimate template strings like `{cost-of-error}`
    // and `{High-Status}`, which were falsely flagged as credential typos and caused
    // the whole request to be rejected.  Credentials appear in URL / Authorization
    // headers 99% of the time; body credentials are rare (OAuth forms, etc.) and
    // the false-positive risk from body template strings is high.
    //
    // The residue regex is strict enough (requires letter start + ≥ 3 chars + alnum/_/-):
    // GraphQL `{ user { name } }` (contains spaces) and JSON `{"k":"v"}` (contains :)
    // do not match.  If you have a legitimate `{templating}` use case that must not
    // be injected, set PHILONT_INJECTOR_RESIDUE_BLOCK=0 to revert to warn-only.
    const PLACEHOLDER_RESIDUE_RE = /\{[A-Za-z_][A-Za-z0-9_-]{2,}\}/g;
    const residueText = [url, ...Object.values(headers)].join('\n');
    const residue = residueText.match(PLACEHOLDER_RESIDUE_RE);
    if (residue && residue.length > 0) {
      const unique = [...new Set(residue)];
      const available = store.list();
      const msg =
        `Unknown credential placeholder(s) ${unique.join(', ')} — not in SecretStore. ` +
        `Available ids: ${available.length > 0 ? available.join(', ') : '(none — call saveCredential first)'}. ` +
        `If you meant Bearer auth, use header like \`Authorization: Bearer {${available[0] ?? '<your-cred-id>'}}\`. ` +
        `Placeholder syntax: \`{<name>}\` resolves case-insensitively + kebab/snake fallback.`;
      if (process.env.PHILONT_INJECTOR_RESIDUE_BLOCK === '0') {
        console.warn(`[injector] residue (warn-only): ${msg}`);
      } else {
        console.warn(`[injector] residue → fail-fast: ${msg}`);
        throw new Error(msg);
      }
    }

    return fetch(url, { ...init, headers, body });
  };
}
