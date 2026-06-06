/**
 * withPolicy: PolicyDelegate decorator
 *
 * Decorator pattern: wraps any Delegate and injects around step/onInterrupt:
 *   - Audit logging (each step start/end, each interrupt)
 *   - Permission checking (before tool calls, via createToolChecker for the Rust kernel)
 *   - Rate limiting (optional)
 *
 * Transparent to the application layer: withPolicy(delegate, config) returns the same Delegate interface.
 */

import type {
  Delegate, StepInput, StepResult, InterruptInput, InterruptAction,
} from './types.js';
import type { PermissionMatrix, ToolClassification, SignalOrigin } from './matrix.js';
import { checkToolPermission } from './matrix.js';
import { AuditLog } from './audit.js';
import type { GrantStore } from './grant.js';
import type { ValidatorChain } from './validators/chain.js';

// ── Configuration ─────────────────────────────────────────────────────────────

export interface PolicyConfig {
  /** Permission matrix */
  permissions: PermissionMatrix;
  /** Audit log instance (sharing the same AuditLog allows continuous auditing across multiple loops) */
  audit: AuditLog;
  /**
   * Tool classifier: maps a tool name to capability + domain
   *
   * The second parameter params supports dynamic classification (e.g. http POST → write×network).
   * Returning null means the tool is unknown (allowed by default; only a warning is logged).
   */
  classifyTool?: (toolName: string, params?: Record<string, unknown>) => ToolClassification | null;
  /** Rate limit: maximum steps per minute (unlimited by default) */
  maxStepsPerMinute?: number;
  /** Dynamic grant store (optional): temporary grants can override matrix denials */
  grantStore?: GrantStore;
  /**
   * Approval-needed callback (optional): called when a tool requires approval
   *
   * Used to trigger a HIGH interrupt ApprovalRequired → Suspend → user authorises → resume.
   * Receives toolName and classification info; the application layer decides how to notify
   * the user (WebSocket, CLI, etc.).
   */
  onApprovalNeeded?: (toolName: string, capability: string, domain: string) => void;
  /**
   * Validator chain (optional): deep validation after the matrix check passes
   *
   * Includes pathAcl, SSRF, dangerous commands, leak detection, etc.
   * If not provided, no deep validation is performed (matrix only).
   */
  validatorChain?: ValidatorChain;
}

// ── ToolChecker (called by the Rust kernel via FFI) ────────────────────────────

/** Input type for the on_tool_check callback */
export interface ToolCheckInput {
  toolName: string;
  approval: string;
  params: string;
  /** Signal origin: 'Internal' = framework-internal drive (DriveEngine/post-processor/Scheduler inheriting), 'External' = LLM-initiated call. Default 'External'. */
  origin?: SignalOrigin;
}

/**
 * Create the permission-checking callback for the Rust kernel to call before tool execution
 *
 * Returns null to allow, or a string containing the denial reason.
 * This implements PRE-EXECUTION permission interception, replacing the former POST-EXECUTION recording.
 */
export function createToolChecker(config: PolicyConfig): (input: ToolCheckInput) => Promise<string | null> {
  const { permissions, audit, classifyTool, grantStore, onApprovalNeeded, validatorChain } = config;

  return async (input: ToolCheckInput): Promise<string | null> => {
    const { toolName, approval } = input;
    const origin: SignalOrigin = input.origin ?? 'External';

    // Parse parameters (used for dynamic classification + validator chain + GrantStore pattern matching)
    let parsedParams: Record<string, unknown> = {};
    try {
      if (input.params) parsedParams = JSON.parse(input.params);
    } catch {
      // if params is not JSON, keep empty object
    }

    const classify = (name: string) => classifyTool?.(name, parsedParams) ?? null;

    // 1. Permission matrix check (quick-filter layer)
    //    - Denied and no grant → terminate
    //    - Denied but has grant → log grant override, continue to validator chain (deep defence cannot be bypassed by grant)
    if (classifyTool) {
      const allowed = checkToolPermission(permissions, toolName, classify);

      if (allowed === false) {
        const hasGrant = grantStore?.isGranted(toolName, parsedParams) ?? false;
        if (hasGrant) {
          audit.append('tool_call', { toolName, allowed: true, grantOverride: true });
          // Continue to validator chain; grant cannot bypass deep checks
        } else {
          const cls = classify(toolName);
          if (onApprovalNeeded && cls) {
            audit.append('approval_requested', { toolName, capability: cls.capability, domain: cls.domain });
            onApprovalNeeded(toolName, cls.capability, cls.domain);
          }
          audit.append('permission_denied', { toolName, phase: 'pre_execution', stage: 'matrix' });
          return `Tool '${toolName}' denied by permission matrix`;
        }
      }
    }

    // 1.5 self-domain audit trail: log all self-domain accesses (including External × write)
    //
    // Design decision: self × External × write no longer requires OnApproval.
    // Memory is part of the agent's own state (has a supersede chain, is rollbackable);
    // writing memory based on the current conversation should not need an additional
    // approval gate — if the user is in the conversation, authorisation is already implicit.
    // The origin field is retained for DriveEngine's future differentiated policies and audit tracing.
    if (classifyTool) {
      const cls = classify(toolName);
      if (cls && cls.domain === 'self') {
        audit.append('self_domain_access', {
          toolName,
          capability: cls.capability,
          origin,
        });
      }
    }

    // 2. Validator chain (deep validation layer)
    if (validatorChain) {
      const classification = classifyTool ? classify(toolName) : null;
      const chainResult = await validatorChain.run({
        toolName,
        params: parsedParams,
        classification,
        grants: grantStore,
        audit,
      });

      if (chainResult.action === 'deny') {
        audit.append('permission_denied', {
          toolName,
          phase: 'pre_execution',
          stage: 'validator_chain',
          code: chainResult.code,
          reason: chainResult.reason,
        });
        return chainResult.reason ?? 'denied by validator chain';
      }

      if (chainResult.action === 'require-grant') {
        if (onApprovalNeeded) {
          const cls = classify(toolName);
          audit.append('approval_requested', {
            toolName,
            capability: cls?.capability ?? 'unknown',
            domain: cls?.domain ?? 'unknown',
            grantPattern: chainResult.grantPattern,
            grantScope: chainResult.grantScope,
            reason: chainResult.reason,
          });
          onApprovalNeeded(toolName, cls?.capability ?? 'unknown', cls?.domain ?? 'unknown');
        }

        audit.append('permission_denied', {
          toolName,
          phase: 'pre_execution',
          stage: 'validator_chain',
          code: 'REQUIRE_GRANT',
          grantPattern: chainResult.grantPattern,
          grantScope: chainResult.grantScope,
        });
        return chainResult.reason ?? `Tool '${toolName}' requires grant: ${chainResult.grantPattern}`;
      }
      // pass: continue
    }

    // 3. ApprovalLevel check (tool self-declared as always)
    if (approval === 'always') {
      if (grantStore && grantStore.isGranted(toolName, parsedParams)) {
        audit.append('tool_call', { toolName, allowed: true, approvalGranted: true });
        return null;
      }

      if (onApprovalNeeded) {
        audit.append('approval_requested', { toolName, reason: 'approval_level_always' });
        onApprovalNeeded(toolName, 'unknown', 'unknown');
      }

      audit.append('permission_denied', { toolName, reason: 'requires_approval', phase: 'pre_execution' });
      return `Tool '${toolName}' requires explicit approval`;
    }

    // 4. Allow
    audit.append('tool_call', { toolName, allowed: true });
    return null;
  };
}

// ── Rate limiter ──────────────────────────────────────────────────────────────

class RateLimiter {
  private readonly windowMs = 60_000;
  private readonly timestamps: number[] = [];

  constructor(private readonly maxPerWindow: number) {}

  check(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    // Remove records outside the window
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxPerWindow) return false;
    this.timestamps.push(now);
    return true;
  }
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Wrap a delegate, injecting policy checks and audit logging
 *
 * @example
 * ```typescript
 * const audit = new AuditLog();
 * const delegate = withPolicy(myDelegate, {
 *   permissions: createDefaultMatrix(),
 *   audit,
 *   classifyTool: (name) => toolRegistry[name] ?? null,
 * });
 * const outcome = await runAgentLoop(delegate, messages, null, receiver, 20);
 * console.log('audit events:', audit.length);
 * console.log('chain intact:', audit.verify());
 * ```
 */
export function withPolicy(inner: Delegate, config: PolicyConfig): Delegate {
  const { permissions, audit, classifyTool, maxStepsPerMinute } = config;
  const rateLimiter = maxStepsPerMinute
    ? new RateLimiter(maxStepsPerMinute)
    : null;

  return {
    async step(input: StepInput): Promise<StepResult> {
      // ① Rate-limit check
      if (rateLimiter && !rateLimiter.check()) {
        audit.append('permission_denied', {
          reason: 'rate_limit_exceeded',
          iteration: input.iteration,
        });
        return {
          action: 'done',
          outcome: { outcomeType: 'terminated', reason: 'Rate limit exceeded' },
        };
      }

      // ② Step-start audit
      audit.append('step_start', {
        iteration: input.iteration,
        mode: input.mode,
        messageCount: input.messages.length,
      });

      // ③ Execute the actual step (unchanged)
      const result = await inner.step(input);

      // ④ Step-end audit + tool-call permission check
      if (result.action === 'addMessages' && classifyTool) {
        const toolMessages = result.addMessages.filter(m => m.role === 'tool');
        for (const msg of toolMessages) {
          const toolName = msg.toolName ?? 'unknown';
          const allowed = checkToolPermission(permissions, toolName, classifyTool);

          audit.append('tool_call', {
            toolName,
            allowed: allowed ?? 'unknown',
          });

          if (allowed === false) {
            audit.append('permission_denied', { toolName });
            // Tool already executed (result is in addMessages); log the violation but do not roll back.
            // In strict mode, a return terminated could be placed here.
          }
        }
      }

      audit.append('step_end', {
        iteration: input.iteration,
        action: result.action,
        outcome: result.action === 'done' ? result.outcome.outcomeType : undefined,
      });

      return result;
    },

    async onInterrupt(input: InterruptInput): Promise<InterruptAction> {
      // Interrupt audit (both internal-drive and external-drive signals are logged)
      audit.append('interrupt', {
        signalType:    input.signal.signalType,
        signalPayload: input.signal.payload ?? null,
      });

      // ApprovalRequired → suspend the loop, wait for external authorisation
      if (input.signal.signalType === 'ApprovalRequired') {
        audit.append('approval_suspended', {
          payload: input.signal.payload,
        });
        return {
          action: 'suspend',
          reason: `Approval required: ${input.signal.payload ?? 'unknown tool'}`,
        };
      }

      return inner.onInterrupt(input);
    },
  };
}
