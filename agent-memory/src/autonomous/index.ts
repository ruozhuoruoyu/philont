/**
 * @agent/memory/autonomous — K8 initiative layer public exports.
 *
 * Usage (server side):
 *   import { startAutonomousLoop, GapDriver, CuriosityDriver, StandardExecutor }
 *     from '@agent/memory';
 *
 * Internal modules:
 *   types       — Driver / Initiative / MemorySnapshot interfaces
 *   initiatives — InitiativeStore (memory_initiatives CRUD)
 *   budget      — BudgetTracker (autonomous_budget three-tier budget)
 *   executor    — StandardExecutor (runs plan tools + single-turn LLM + writes back to memory)
 *   loop        — startAutonomousLoop (tick scheduling + orchestration)
 *   drivers/*   — GapDriver / CuriosityDriver
 */

export type {
  Driver,
  Initiative,
  InitiativeExecutor,
  InitiativeOutcomeRefs,
  InitiativePlanStep,
  InitiativeProposal,
  InitiativeRunResult,
  InitiativeStatus,
  MemorySnapshot,
  ExecutorLlmOutput,
  ExecutorFactProposal,
  ExecutorNoteProposal,
  OutcomeHook,
} from './types.js';

export { InitiativeStore } from './initiatives.js';
export {
  BudgetTracker,
  DEFAULT_BUDGET_CAPS,
  utcDateString,
} from './budget.js';
export type {
  BudgetCaps,
  BudgetReservation,
  DailyUsage,
  PerTickUsage,
} from './budget.js';

export {
  StandardExecutor,
  DEFAULT_TOOL_WHITELIST,
  parseExecutorOutput,
} from './executor.js';
export type {
  InitiativeExecutorOptions,
  ToolRunner,
  ToolRunResult,
} from './executor.js';

export {
  startAutonomousLoop,
} from './loop.js';
export type {
  AutonomousAuditHook,
  AutonomousInterruptKind,
  AutonomousInterruptPayload,
  AutonomousLoopHandle,
  AutonomousLoopOptions,
  InterruptSink,
  TickEvent,
} from './loop.js';

export {
  CuriosityDriver,
  DEFAULT_CURIOSITY_CONFIG,
  extractSpecificTokens,
} from './drivers/curiosity_driver.js';
export type { CuriosityDriverConfig } from './drivers/curiosity_driver.js';

export {
  GapDriver,
  DEFAULT_GAP_CONFIG,
} from './drivers/gap_driver.js';
export type { GapDriverConfig } from './drivers/gap_driver.js';

export {
  PursuitDriver,
  DEFAULT_PURSUIT_CONFIG,
} from './drivers/pursuit_driver.js';
export type { PursuitDriverConfig } from './drivers/pursuit_driver.js';

// K7 → K8 bridge
export {
  collectK7BridgeInitiatives,
  bridgeTaskCommitment,
  bridgeHonesty,
  extractAbsolutePath,
} from './k7_bridge.js';
export type { BridgeInput } from './k7_bridge.js';

// MetaConfigObserver (2026-05-12 Phase 8 M3): meta-layer observer; scans audit events and writes config_rules automatically
export {
  runMetaConfigObserver,
} from './meta_config_observer.js';
export type {
  MetaConfigObserverInput,
  MetaConfigObserverResult,
  ConfigRuleProposal,
  AuditEventLike,
} from './meta_config_observer.js';

// BugDetector (2026-05-12 Phase 8 M4 = 8B): scans audit events and outputs precise bug reports
export {
  runBugDetector,
} from './bug_detector.js';
export type {
  BugDetectorInput,
  BugDetectorResult,
  BugReport,
  BugReportEvidence,
  BugSeverity,
} from './bug_detector.js';

// Pursuit progress writer (2026-05-06): pursuit:* initiative done → writes pursuit progress
export {
  pursuitProgressWriter,
  applyPursuitProgress,
  parsePursuitTargetRef,
  MAX_RESEARCH_ITERATIONS,
} from './pursuit_progress_writer.js';
export type { ApplyResult as PursuitApplyResult } from './pursuit_progress_writer.js';
