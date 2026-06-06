/**
 * Validator (LSM-style) type definitions
 *
 * Validators form the deep-defence layer after PolicyGate.check().
 * Each Validator is a standalone function that receives a context and returns an action.
 * Executed in a chain; the first non-pass action terminates the chain.
 */

import type { ToolClassification } from '../matrix.js';
import type { GrantStore } from '../grant.js';
import type { AuditLog } from '../audit.js';

/** Context available to a validator */
export interface ValidatorContext {
  toolName: string;
  params: Record<string, unknown>;
  classification: ToolClassification | null;
  grants?: GrantStore;
  audit?: AuditLog;
}

/** Validation result */
export type ValidatorResult =
  | { action: 'pass' }
  | { action: 'deny'; reason: string; code: string }
  | { action: 'mutate'; params: Record<string, unknown>; note?: string }
  | { action: 'require-grant'; scope: 'tool' | 'command' | 'path'; pattern: string; reason: string };

/** Validator function signature */
export type Validator = (ctx: ValidatorContext) => Promise<ValidatorResult> | ValidatorResult;

/** Convenience constructor: pass */
export const pass = (): ValidatorResult => ({ action: 'pass' });

/** Convenience constructor: deny */
export const deny = (code: string, reason: string): ValidatorResult => ({
  action: 'deny',
  code,
  reason,
});

/** Convenience constructor: mutate */
export const mutate = (params: Record<string, unknown>, note?: string): ValidatorResult => ({
  action: 'mutate',
  params,
  note,
});

/** Convenience constructor: require-grant */
export const requireGrant = (
  scope: 'tool' | 'command' | 'path',
  pattern: string,
  reason: string,
): ValidatorResult => ({ action: 'require-grant', scope, pattern, reason });
