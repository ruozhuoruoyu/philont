/**
 * LeakDetector — secret/credential leak detection
 *
 * Two scan points:
 *   - Inbound (in the validator chain): checks tool params for secrets, preventing the LLM
 *     from feeding secrets to third-party APIs
 *   - Outbound (redactOutput helper): checks tool output for secrets, returns redacted result to the LLM
 *
 * Actions: Block (reject), Redact (replace with ***), Warn (audit log)
 *
 * Reference: IronClaw project src/safety/leak_detector.rs (algorithm adapted, code rewritten)
 */

import type { Validator, ValidatorContext } from './types.js';
import { pass, deny, mutate } from './types.js';

export type LeakAction = 'block' | 'redact' | 'warn';

export interface LeakPattern {
  id: string;
  regex: RegExp;
  description: string;
  defaultAction: LeakAction;
}

/** Default secret patterns */
export const DEFAULT_LEAK_PATTERNS: LeakPattern[] = [
  // OpenAI
  { id: 'openai_key', regex: /\bsk-[A-Za-z0-9_-]{20,}/g, description: 'OpenAI API key', defaultAction: 'block' },
  { id: 'openai_proj', regex: /\bsk-proj-[A-Za-z0-9_-]{20,}/g, description: 'OpenAI project key', defaultAction: 'block' },

  // Anthropic
  { id: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, description: 'Anthropic API key', defaultAction: 'block' },

  // GitHub
  { id: 'github_pat', regex: /\bghp_[A-Za-z0-9]{36}/g, description: 'GitHub PAT', defaultAction: 'block' },
  { id: 'github_pat_fg', regex: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, description: 'GitHub fine-grained PAT', defaultAction: 'block' },
  { id: 'github_oauth', regex: /\bgho_[A-Za-z0-9]{36}/g, description: 'GitHub OAuth token', defaultAction: 'block' },
  { id: 'github_app', regex: /\bghu_[A-Za-z0-9]{36}/g, description: 'GitHub app token', defaultAction: 'block' },

  // AWS
  { id: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g, description: 'AWS access key', defaultAction: 'block' },
  {
    id: 'aws_secret',
    regex: /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi,
    description: 'AWS secret key',
    defaultAction: 'block',
  },

  // Google
  { id: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}/g, description: 'Google API key', defaultAction: 'block' },

  // Slack
  { id: 'slack_token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, description: 'Slack token', defaultAction: 'block' },
  { id: 'slack_webhook', regex: /\bhooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, description: 'Slack webhook', defaultAction: 'redact' },

  // Stripe
  { id: 'stripe_live', regex: /\bsk_live_[A-Za-z0-9]{24,}/g, description: 'Stripe live key', defaultAction: 'block' },
  { id: 'stripe_test', regex: /\bsk_test_[A-Za-z0-9]{24,}/g, description: 'Stripe test key', defaultAction: 'warn' },

  // npm / pypi
  { id: 'npm_token', regex: /\bnpm_[A-Za-z0-9]{36}/g, description: 'npm token', defaultAction: 'block' },
  { id: 'pypi_token', regex: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]+/g, description: 'PyPI token', defaultAction: 'block' },

  // HuggingFace
  { id: 'hf_token', regex: /\bhf_[A-Za-z0-9]{30,}/g, description: 'HuggingFace token', defaultAction: 'block' },

  // Private key block
  {
    id: 'private_key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
    description: 'PEM private key',
    defaultAction: 'block',
  },

  // Bearer auth header
  {
    id: 'bearer_token',
    regex: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g,
    description: 'Bearer token',
    defaultAction: 'redact',
  },

  // JWT
  {
    id: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    description: 'JWT',
    defaultAction: 'redact',
  },

  // Generic .env KEY=value assignments (containing sensitive keywords)
  {
    id: 'env_secret_assign',
    regex: /\b(?:API_?KEY|SECRET|PASSWORD|ACCESS_?TOKEN|PRIVATE_?KEY)\s*=\s*["']?([A-Za-z0-9_.\-/+=]{16,})["']?/g,
    description: 'env assignment with secret value',
    defaultAction: 'redact',
  },
];

export interface LeakDetectorConfig {
  patterns?: LeakPattern[];
  /** Which fields to scan (recursively searches within values) */
  scanFields?: 'all' | string[];
  /** Action overrides on a hit (keyed by pattern id) */
  actionOverrides?: Record<string, LeakAction>;
}

interface ScanHit {
  patternId: string;
  description: string;
  action: LeakAction;
  match: string;
}

/** Scan a single string and return all hits */
export function scanText(
  text: string,
  patterns: LeakPattern[] = DEFAULT_LEAK_PATTERNS,
  overrides?: Record<string, LeakAction>,
): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const p of patterns) {
    p.regex.lastIndex = 0;
    let m;
    const rx = new RegExp(p.regex.source, p.regex.flags);
    while ((m = rx.exec(text)) !== null) {
      hits.push({
        patternId: p.id,
        description: p.description,
        action: overrides?.[p.id] ?? p.defaultAction,
        match: m[0],
      });
      if (!rx.global) break;
    }
  }
  return hits;
}

function redactString(text: string, patterns: LeakPattern[], overrides?: Record<string, LeakAction>): string {
  let result = text;
  for (const p of patterns) {
    const action = overrides?.[p.id] ?? p.defaultAction;
    if (action !== 'redact' && action !== 'block') continue;
    const rx = new RegExp(p.regex.source, p.regex.flags);
    result = result.replace(rx, '[REDACTED:' + p.id + ']');
  }
  return result;
}

/** Recursively collect all string values */
function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => collectStrings(x, out));
  else if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) {
      collectStrings((v as Record<string, unknown>)[k], out);
    }
  }
  return out;
}

/** Recursively replace all string values */
function redactDeep(v: unknown, patterns: LeakPattern[], overrides?: Record<string, LeakAction>): unknown {
  if (typeof v === 'string') return redactString(v, patterns, overrides);
  if (Array.isArray(v)) return v.map(x => redactDeep(x, patterns, overrides));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object)) {
      out[k] = redactDeep((v as Record<string, unknown>)[k], patterns, overrides);
    }
    return out;
  }
  return v;
}

/**
 * Inbound validator: scans tool parameters
 *
 * block hit → deny
 * redact hit → mutate params (redacted version)
 * warn hit → allow but audit
 */
export function createLeakDetector(config: LeakDetectorConfig = {}): Validator {
  const patterns = config.patterns ?? DEFAULT_LEAK_PATTERNS;
  const overrides = config.actionOverrides;

  return (ctx: ValidatorContext) => {
    const texts = collectStrings(ctx.params);
    const allHits: ScanHit[] = [];
    for (const t of texts) {
      allHits.push(...scanText(t, patterns, overrides));
    }

    if (allHits.length === 0) return pass();

    // Priority: block > redact > warn
    if (allHits.some(h => h.action === 'block')) {
      const ids = [...new Set(allHits.filter(h => h.action === 'block').map(h => h.patternId))];
      return deny(
        'LEAK_BLOCK',
        `Secret detected in params (patterns: ${ids.join(', ')})`,
      );
    }

    if (allHits.some(h => h.action === 'redact')) {
      const redacted = redactDeep(ctx.params, patterns, overrides) as Record<string, unknown>;
      const ids = [...new Set(allHits.filter(h => h.action === 'redact').map(h => h.patternId))];
      return mutate(redacted, `Redacted patterns: ${ids.join(', ')}`);
    }

    // warn only
    ctx.audit?.append('leak_warn', {
      toolName: ctx.toolName,
      patterns: [...new Set(allHits.map(h => h.patternId))],
    });
    return pass();
  };
}

/**
 * Outbound redaction: applies the same rules to tool output (does not block, only replaces)
 *
 * Call from the application layer after tool execution
 */
export function redactOutput(
  text: string,
  patterns: LeakPattern[] = DEFAULT_LEAK_PATTERNS,
  overrides?: Record<string, LeakAction>,
): string {
  return redactString(text, patterns, overrides);
}
