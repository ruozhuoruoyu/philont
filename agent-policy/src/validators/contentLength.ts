/**
 * ContentLength Validator — parameter payload size limits
 *
 * Prevents a single tool call from carrying oversized parameters (e.g. writeFile
 * with 10 GB content, shell with a 100 KB command) that could cause DoS or
 * context overflow.
 *
 * Defaults: entire params JSON serialised ≤ 1 MB; individual fields have their own limits.
 */

import type { Validator, ValidatorContext } from './types.js';
import { pass, deny } from './types.js';

export interface ContentLengthConfig {
  /** Maximum bytes for the entire params JSON serialisation (default 1 MB) */
  maxTotalBytes?: number;
  /** Per-field maximum byte lengths (defaults cover command / body / content / path) */
  fieldMax?: Record<string, number>;
  /** Tool names this validator applies to (empty = all tools) */
  toolNames?: Set<string>;
}

const DEFAULT_FIELD_MAX: Record<string, number> = {
  command: 64 * 1024,     // shell command 64KB
  body: 512 * 1024,       // http body 512KB
  content: 512 * 1024,    // writeFile content 512KB
  path: 4 * 1024,         // path 4KB
  url: 4 * 1024,          // url 4KB
};

function byteLen(v: unknown): number {
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf-8');
  return Buffer.byteLength(JSON.stringify(v ?? null), 'utf-8');
}

export function createContentLengthValidator(config: ContentLengthConfig = {}): Validator {
  const maxTotal = config.maxTotalBytes ?? 1024 * 1024;
  const fieldMax = { ...DEFAULT_FIELD_MAX, ...(config.fieldMax ?? {}) };
  const toolNames = config.toolNames;

  return (ctx: ValidatorContext) => {
    if (toolNames && !toolNames.has(ctx.toolName)) return pass();

    // Total size check
    const totalBytes = byteLen(ctx.params);
    if (totalBytes > maxTotal) {
      return deny(
        'CONTENT_LENGTH_TOTAL',
        `Params too large: ${totalBytes} bytes (limit: ${maxTotal})`,
      );
    }

    // Per-field check
    for (const [field, limit] of Object.entries(fieldMax)) {
      const v = ctx.params[field];
      if (v === undefined) continue;
      const bytes = byteLen(v);
      if (bytes > limit) {
        return deny(
          'CONTENT_LENGTH_FIELD',
          `Field "${field}" too large: ${bytes} bytes (limit: ${limit})`,
        );
      }
    }

    return pass();
  };
}
