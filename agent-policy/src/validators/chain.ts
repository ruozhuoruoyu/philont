/**
 * ValidatorChain — LSM-style validator stack
 *
 * Semantics:
 *   - pass:          continue to the next validator
 *   - deny:          terminate immediately, return denial
 *   - mutate:        replace ctx.params with new params and continue to the next validator
 *   - require-grant: check GrantStore; terminate if not authorised
 *
 * Design principles:
 *   - A single chain run is sequential; no concurrency between validators
 *   - Mutated params are forwarded to subsequent validators (pipeline behaviour)
 *   - Every step is audited
 */

import type { Validator, ValidatorContext, ValidatorResult } from './types.js';

export interface ChainRunResult {
  /** Final action */
  action: 'pass' | 'deny' | 'require-grant';
  /** Denial reason (when action !== pass) */
  reason?: string;
  /** Denial code (when action !== pass) */
  code?: string;
  /** Pattern for require-grant */
  grantPattern?: string;
  grantScope?: 'tool' | 'command' | 'path';
  /** Final params after any mutations (may have been modified by multiple validators) */
  params: Record<string, unknown>;
  /** Record of each step */
  steps: Array<{ validator: string; result: ValidatorResult }>;
}

export class ValidatorChain {
  private validators: Array<{ name: string; fn: Validator }> = [];

  /** Register a validator (executed in registration order) */
  register(name: string, fn: Validator): this {
    this.validators.push({ name, fn });
    return this;
  }

  /** Clear all validators (for testing) */
  clear(): this {
    this.validators = [];
    return this;
  }

  /** List of registered validator names */
  list(): string[] {
    return this.validators.map(v => v.name);
  }

  /**
   * Execute all validators in sequence
   */
  async run(ctx: ValidatorContext): Promise<ChainRunResult> {
    let currentParams = ctx.params;
    const steps: ChainRunResult['steps'] = [];

    for (const { name, fn } of this.validators) {
      const stepCtx: ValidatorContext = { ...ctx, params: currentParams };
      const result = await fn(stepCtx);
      steps.push({ validator: name, result });

      ctx.audit?.append('validator_step', {
        toolName: ctx.toolName,
        validator: name,
        action: result.action,
        ...(result.action === 'deny' ? { code: result.code, reason: result.reason } : {}),
        ...(result.action === 'require-grant' ? { scope: result.scope, pattern: result.pattern } : {}),
      });

      if (result.action === 'deny') {
        return {
          action: 'deny',
          reason: result.reason,
          code: result.code,
          params: currentParams,
          steps,
        };
      }

      if (result.action === 'require-grant') {
        // Check grant against the scope required by the validator (tool-scope does not satisfy command/path requirements)
        const granted = ctx.grants?.isGranted(ctx.toolName, ctx.params, result.scope);
        if (!granted) {
          return {
            action: 'require-grant',
            reason: result.reason,
            code: 'REQUIRE_GRANT',
            grantPattern: result.pattern,
            grantScope: result.scope,
            params: currentParams,
            steps,
          };
        }
        // Already granted: continue
        continue;
      }

      if (result.action === 'mutate') {
        currentParams = result.params;
        continue;
      }

      // pass: continue
    }

    return {
      action: 'pass',
      params: currentParams,
      steps,
    };
  }
}

/**
 * Create the default chain
 *
 * Order: pathAcl → ssrf → dangerousCommands → leakDetector
 * Config for each validator is supplied by the caller.
 */
export interface DefaultChainOptions {
  pathAcl?: Validator;
  ssrf?: Validator;
  dangerousCommands?: Validator;
  leakDetector?: Validator;
  /** Additional validators (appended after the defaults) */
  extra?: Array<{ name: string; fn: Validator }>;
}

export function createDefaultChain(options: DefaultChainOptions = {}): ValidatorChain {
  const chain = new ValidatorChain();
  if (options.pathAcl) chain.register('pathAcl', options.pathAcl);
  if (options.ssrf) chain.register('ssrf', options.ssrf);
  if (options.dangerousCommands) chain.register('dangerousCommands', options.dangerousCommands);
  if (options.leakDetector) chain.register('leakDetector', options.leakDetector);
  for (const e of options.extra ?? []) chain.register(e.name, e.fn);
  return chain;
}

