/**
 * @agent/policy — Agent policy layer
 *
 * Provides:
 *   - PermissionMatrix  Permission matrix (3×3 capability × domain)
 *   - AuditLog          SHA-256 hash-chain audit log
 *   - withPolicy        PolicyDelegate decorator
 *   - GrantStore        Dynamic grant store (with TTL decay)
 *   - IntentClassifier  User authorisation intent recognition
 */

export type {
  Capability,
  Domain,
  SignalOrigin,
  PermissionMatrix,
  ToolClassification,
} from './matrix.js';

export {
  createDefaultMatrix,
  createReadOnlyMatrix,
  createSandboxMatrix,
  checkPermission,
  checkToolPermission,
} from './matrix.js';

export type { AuditEventType, AuditEvent } from './audit.js';
export { AuditLog } from './audit.js';

export type { PolicyConfig, ToolCheckInput } from './policy.js';
export { withPolicy, createToolChecker } from './policy.js';

export type {
  Message,
  ToolDefinition,
  StepInput,
  StepResult,
  LoopOutcome,
  AgentInterrupt,
  InterruptInput,
  InterruptAction,
  Delegate,
} from './types.js';

export type { Grant } from './grant.js';
export { GrantStore } from './grant.js';

export type { GrantIntent, IntentClassifier } from './intent.js';
export { LLMIntentClassifier, KeywordIntentClassifier } from './intent.js';

export type { Tool, ToolResult } from './tools/types.js';
export { ToolRegistry, RegistryViolationError } from './tools/registry.js';

// Validators (deep defence layer)
export type {
  Validator,
  ValidatorContext,
  ValidatorResult,
  PathAclConfig,
  SsrfConfig,
  DangerousCommandConfig,
  DangerousCommandPattern,
  LeakDetectorConfig,
  LeakPattern,
  LeakAction,
  ChainRunResult,
  DefaultChainOptions,
} from './validators/index.js';
export {
  pass,
  deny,
  mutate,
  requireGrant,
  createPathAclValidator,
  DEFAULT_SENSITIVE_PATHS,
  createSsrfValidator,
  createDangerousCommandValidator,
  DEFAULT_DANGEROUS_PATTERNS,
  createLeakDetector,
  redactOutput,
  scanText,
  DEFAULT_LEAK_PATTERNS,
  ValidatorChain,
  createDefaultChain,
  // S2 validators
  wrapToolWithOutputScan,
  wrapAllToolsWithOutputScan,
  createRateLimitValidator,
  createUrlAllowlistValidator,
  createContentLengthValidator,
  createCommandAllowlistValidator,
  DEFAULT_SAFE_BINS,
} from './validators/index.js';

export type {
  OutputScanOptions,
  RateLimitConfig,
  UrlAllowlistConfig,
  ContentLengthConfig,
  CommandAllowlistConfig,
  CommandAllowEntry,
} from './validators/index.js';

export type { GrantScope } from './grant.js';

// Credential management (zero-exposure injection)
export { SecretStore, createInjectingFetch } from './secrets/index.js';
export type { SecretStoreOptions, InjectingFetchOptions } from './secrets/index.js';
