/**
 * Validators (deep-defence layer)
 *
 * Architecture:
 *   PolicyGate.check()
 *     ├─ 3×3 matrix (fast filter)
 *     └─ ValidatorChain (deep validation)
 *          ├─ pathAcl
 *          ├─ ssrf
 *          ├─ dangerousCommands
 *          └─ leakDetector
 */

export type {
  Validator,
  ValidatorContext,
  ValidatorResult,
} from './types.js';
export { pass, deny, mutate, requireGrant } from './types.js';

export { createPathAclValidator, DEFAULT_SENSITIVE_PATHS } from './pathAcl.js';
export type { PathAclConfig } from './pathAcl.js';

export { createSsrfValidator } from './ssrf.js';
export type { SsrfConfig } from './ssrf.js';

export {
  createDangerousCommandValidator,
  DEFAULT_DANGEROUS_PATTERNS,
} from './dangerousCommands.js';
export type {
  DangerousCommandConfig,
  DangerousCommandPattern,
} from './dangerousCommands.js';

export {
  createLeakDetector,
  redactOutput,
  scanText,
  DEFAULT_LEAK_PATTERNS,
} from './leakDetector.js';
export type {
  LeakDetectorConfig,
  LeakPattern,
  LeakAction,
} from './leakDetector.js';

export { ValidatorChain, createDefaultChain } from './chain.js';
export type { ChainRunResult, DefaultChainOptions } from './chain.js';

// New validators (S2 phase)
export {
  wrapToolWithOutputScan,
  wrapAllToolsWithOutputScan,
} from './outputLeakDetector.js';
export type { OutputScanOptions } from './outputLeakDetector.js';

export { createRateLimitValidator } from './rateLimit.js';
export type { RateLimitConfig } from './rateLimit.js';

export { createUrlAllowlistValidator } from './urlAllowlist.js';
export type { UrlAllowlistConfig } from './urlAllowlist.js';

export { createContentLengthValidator } from './contentLength.js';
export type { ContentLengthConfig } from './contentLength.js';

export {
  createCommandAllowlistValidator,
  DEFAULT_SAFE_BINS,
} from './commandAllowlist.js';
export type {
  CommandAllowlistConfig,
  CommandAllowEntry,
} from './commandAllowlist.js';
