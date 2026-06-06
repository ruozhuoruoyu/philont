/**
 * agent-policy shared types
 *
 * Correspond one-to-one with the napi-rs auto-generated types from @agent/node.
 * napi-rs converts Rust snake_case to camelCase; field names follow that convention.
 */

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string | null;
  toolName?: string | null;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema string */
  parameters: string;
}

// ── step() input / output ─────────────────────────────────────────────────────

export interface StepInput {
  messages:  Message[];
  tools:     ToolDefinition[];
  iteration: number;
  /** "Normal" | "Quick" */
  mode: string;
}

export type StepResult =
  | { action: 'continue' }
  | { action: 'done';             outcome: LoopOutcome }
  | { action: 'addMessages';      addMessages: Message[] }
  | { action: 'continueWithHint'; expectedMs: number };

// ── loop final outcome ────────────────────────────────────────────────────────

export type LoopOutcome =
  | { outcomeType: 'response';      text: string }
  | { outcomeType: 'interrupted';   signalType: string; signalPayload?: string | null }
  | { outcomeType: 'suspended';     reason: string }
  | { outcomeType: 'terminated';    reason: string }
  | { outcomeType: 'maxIterations' };

// ── Interrupt signal ──────────────────────────────────────────────────────────

export interface AgentInterrupt {
  /** "UserHardStop" | "SteerMessage" | "CuriosityTriggered" | ... */
  signalType: string;
  payload?: string | null;
}

export interface InterruptInput {
  signal:   AgentInterrupt;
  messages: Message[];
}

export type InterruptAction =
  | { action: 'continue' }
  | { action: 'injectMessage'; message: string }
  | { action: 'terminate';     reason: string }
  | { action: 'suspend';       reason: string };

// ── Delegate interface ────────────────────────────────────────────────────────

/** Exactly matches the callback object accepted by run_agent_loop */
export interface Delegate {
  step:        (input: StepInput)     => Promise<StepResult>;
  onInterrupt: (input: InterruptInput) => Promise<InterruptAction>;
}
