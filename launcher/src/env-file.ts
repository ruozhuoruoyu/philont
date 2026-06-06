/**
 * Read / write / validate / mask ~/.philont/.env.
 *
 * Design notes:
 *  - The launcher owns this file but **preserves user-written comments**: writes
 *    replace existing key lines in-place; new keys are appended; comments and blank
 *    lines are never reordered or deleted.
 *  - Secret-type fields are **masked** on GET (only the last 4 characters are shown);
 *    when the masked value is echoed back on PUT it is **skipped** (not overwritten),
 *    preventing the front-end from washing the real key into a string of dots.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';
import dotenv from 'dotenv';
import { envFilePath, philontHome } from './paths.js';

/** Secret fields that must be masked (hidden on GET; masked echo-back on PUT is skipped). */
const SECRET_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GLM_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'GEMINI_API_KEY',
  'AUX_LLM_API_KEY',
  'VISION_LLM_API_KEY',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'TELEGRAM_BOT_TOKEN',
]);

/**
 * Key env-var for each OpenAI-compatible provider (when LLM_PROVIDER selects it, having
 * that key present means the agent is startable).
 * Kept in sync with the PROVIDERS registry in server/src/llm-adapter.ts.
 */
const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  glm: 'GLM_API_KEY',
  kimi: 'KIMI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/** Mask prefix: values starting with this are treated as "unchanged masked values" and skipped on write. */
const MASK_PREFIX = '••••';

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

/** Mask a secret to ••••xxxx (last 4 characters only); empty value returns empty string. */
export function maskSecret(value: string): string {
  if (!value) return '';
  const tail = value.length > 4 ? value.slice(-4) : '';
  return MASK_PREFIX + tail;
}

function isMaskedValue(value: string): boolean {
  return value.startsWith(MASK_PREFIX);
}

export function ensurePhilontHome(): void {
  if (!existsSync(philontHome)) {
    mkdirSync(philontHome, { recursive: true });
  }
}

/** Read and parse .env; returns an empty object if the file does not exist (rather than throwing). */
export function readConfig(): Record<string, string> {
  if (!existsSync(envFilePath)) return {};
  try {
    return dotenv.parse(readFileSync(envFilePath, 'utf8'));
  } catch (e) {
    console.warn(`[env-file] parse failed ${envFilePath}:`, e);
    return {};
  }
}

/** Read and mask secret fields — for front-end display. Includes a hasKey flag. */
export function readMaskedConfig(): { values: Record<string, string>; hasKey: boolean } {
  const raw = readConfig();
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    values[k] = isSecretKey(k) ? maskSecret(v) : v;
  }
  return { values, hasKey: !!raw.ANTHROPIC_API_KEY };
}

/**
 * Whether the configuration is "startable": the selected provider's key must be present.
 *   - LLM_PROVIDER = openai / glm / kimi / minimax / gemini → corresponding *_API_KEY
 *   - anthropic / unset / other → ANTHROPIC_API_KEY (default main path)
 */
export function isConfigured(): boolean {
  const cfg = readConfig();
  const provider = (cfg.LLM_PROVIDER || '').toLowerCase();
  const keyEnv = PROVIDER_KEY_ENV[provider];
  if (keyEnv) return !!cfg[keyEnv];
  return !!cfg.ANTHROPIC_API_KEY;
}

/**
 * Render a line value.  Newlines / carriage-returns must be converted to literal \n / \r —
 * otherwise the multi-physical-line value would be split by the next updateConfig line
 * scanner (split(/\r?\n/)): the first line matches KEY= and is replaced, and the remaining
 * lines become garbage.
 * Values containing whitespace / # / quotes / $ are wrapped in double quotes (dotenv
 * restores \n back to a real newline inside double quotes).
 */
function renderValue(value: string): string {
  if (value === '') return '';
  // dotenv only unescapes \\ → \ inside double-quoted values.
  // For unquoted values the raw text is used verbatim, so backslashes must NOT be doubled.
  const needsQuotes = /[\s#"'$\n\r]/.test(value);
  if (needsQuotes) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/"/g, '\\"');
    return '"' + escaped + '"';
  }
  return value;
}

/**
 * Update .env in-place: existing active keys have their lines replaced; new keys are
 * appended; comments and blank lines are preserved.
 * Masked values echoed back (starting with ••••) are skipped — the real key is not overwritten.
 * Atomic write: write to a temp file then rename.
 * Returns the list of keys that were actually written (not skipped).
 */
export function updateConfig(updates: Record<string, string>): { written: string[]; skipped: string[] } {
  ensurePhilontHome();
  const raw = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
  const lines = raw.length ? raw.split(/\r?\n/) : [];

  const written: string[] = [];
  const skipped: string[] = [];

  // Filter out "unchanged masked" secret values
  const effective: Record<string, string> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (isSecretKey(k) && isMaskedValue(v)) {
      skipped.push(k);
      continue;
    }
    effective[k] = v;
  }

  const remaining = new Set(Object.keys(effective));

  // First pass: replace existing active key lines in-place (comment lines starting with # are ignored)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m) continue;
    const key = m[1];
    if (remaining.has(key)) {
      lines[i] = `${key}=${renderValue(effective[key])}`;
      written.push(key);
      remaining.delete(key);
    }
  }

  // Second pass: append any remaining new keys to the end
  if (remaining.size > 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    for (const key of remaining) {
      lines.push(`${key}=${renderValue(effective[key])}`);
      written.push(key);
    }
  }

  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';

  const tmp = envFilePath + '.tmp';
  if (!existsSync(dirname(envFilePath))) mkdirSync(dirname(envFilePath), { recursive: true });
  writeFileSync(tmp, out, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, envFilePath); // atomic swap; mode 0600 — file contains secrets

  return { written, skipped };
}

/** Lightweight validation: returns a list of errors (empty = passes). Currently validates required fields and basic formats. */
export function validateConfig(values: Record<string, string>): string[] {
  const errors: string[] = [];
  const key = values.ANTHROPIC_API_KEY;
  if (key !== undefined && !isMaskedValue(key)) {
    if (key.trim() === '') errors.push('ANTHROPIC_API_KEY must not be empty');
  }
  const base = values.ANTHROPIC_BASE_URL;
  if (base && !/^https?:\/\//.test(base)) {
    errors.push('ANTHROPIC_BASE_URL must start with http:// or https://');
  }
  const port = values.PHILONT_PORT;
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    errors.push('PHILONT_PORT must be an integer between 1 and 65535');
  }
  return errors;
}
