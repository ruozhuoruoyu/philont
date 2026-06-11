/**
 * @agent/memory — structured memory layer
 *
 * Core principle: the LLM should not read memory text; it should call the memory API.
 * Decouple deterministic lookup from the LLM path; reduce cost from O(tokens × calls) to O(function calls).
 *
 * Three layers:
 *   Layer 0 (RawStore):    raw conversation log, append-only
 *   Layer 1 (NotesStore):  text fallback, FTS5 search
 *   Layer 2 (MemoryStore): structured facts, KV + namespace
 */

import Database from 'better-sqlite3';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { initSchema } from './schema.js';
import { MemoryStore } from './store.js';
import { NotesStore } from './notes.js';
import { RawStore } from './raw.js';
import { ActionLog } from './actions.js';
import { SkillStore } from './skills.js';
import { AccessLog } from './accessLog.js';
import { CalendarStore } from './calendar.js';
import { ScheduleStore } from './schedules.js';
import { PlanStore } from './plans.js';
import { PursuitStore } from './pursuit.js';
import { DriveConfigStore } from './drive_config.js';
import { DriveOutcomeStore } from './drive_outcome.js';
import { RoutingRuleStore } from './routing_rules.js';
import { ConfigRuleStore } from './config_rules.js';
import { PushSubscriptionStore } from './push_subscriptions.js';
import { ReasoningStore } from './reasoning.js';
import { ScheduleOutcomeStore } from './schedule_outcomes.js';
import { PlanFileStore } from './plan_files.js';
import { BackupRunner, type BackupConfig } from './backup.js';

export { MemoryStore } from './store.js';
export { NotesStore } from './notes.js';
export { RawStore } from './raw.js';
export { ActionLog } from './actions.js';
export {
  extractFailureSignature,
  countSameRootCauseFailures,
  groupFailures,
} from './failure_signatures.js';
export type { FailureCounted } from './failure_signatures.js';
export { SkillStore, scoreSkill } from './skills.js';
export type { SkillChangeEvent } from './skills.js';
export {
  nextMaturity,
  isCallableMaturity,
  maturityCaveat,
  parseMaturity,
  CONFIRMED_MIN_SUCCESS,
  STABLE_MIN_SUCCESS,
  STABLE_MAX_FAILURE_RATIO,
  DEPRECATED_CONSECUTIVE_FAILURES,
  DEPRECATED_RATIO_MIN_SUCCESS,
  DEPRECATED_FAILURE_RATIO,
} from './skill_maturity.js';
export type { MaturityComputeInput } from './skill_maturity.js';
export {
  RoutingRuleStore,
  nextConfidence,
  confidenceRank,
  isActiveConfidence,
  confidenceCaveat,
  parseConfidence,
  extractKeywords,
  keywordOverlap,
  specificity,
} from './routing_rules.js';
export {
  ConfigRuleStore,
  CONFIG_SCOPES,
  isConfigScope,
} from './config_rules.js';
export type {
  ConfigRule,
  ConfigRuleInput,
  ConfigConfidence,
  ConfigScope,
  ConfigSource,
  ConfigRuleChangeEvent,
} from './config_rules.js';
export { PushSubscriptionStore } from './push_subscriptions.js';
export { ReasoningStore, ReasoningNodeNotFoundError } from './reasoning.js';
export type {
  ReasoningSession,
  ReasoningNode,
  ReasoningSessionStatus,
  ReasoningNodeKind,
  ReasoningNodeStatus,
} from './reasoning.js';
export type { PushSubscription, SubscribeInput as PushSubscribeInput } from './push_subscriptions.js';
export type {
  RoutingRule,
  RoutingRuleInput,
  RoutingConfidence,
  RoutingRuleChangeEvent,
  ConfidenceComputeInput,
} from './routing_rules.js';
export {
  parseReflectionOutput,
  applyReflection,
  shouldTriggerReflection,
  renderReflectionPrompt,
} from './reflection.js';
export type {
  ReflectionAttempt,
  ReflectionLearning,
  RoutingRuleLearning,
  SkillRefineLearning,
  PlaybookLearning,
  NewSkillLearning,
  PlanRevisionLearning,
  ReflectionOutput,
  ParseResult as ReflectionParseResult,
  ApplyContext as ReflectionApplyContext,
  ApplyResult as ReflectionApplyResult,
  ReflectionTriggerInput,
  ReflectionTriggerDecision,
} from './reflection.js';
export { AccessLog } from './accessLog.js';
export {
  scoreMemory,
  namespaceTauDays,
  isPinned,
  PIN_SENTINEL,
  DEFAULT_TAU_DAYS,
  DEFAULT_FORGET_THRESHOLD,
} from './decay.js';
export type { ScorableMemory } from './decay.js';
export { CalendarStore } from './calendar.js';
export type { OccurrenceEvent } from './calendar.js';
export { ScheduleStore, computeNextRun } from './schedules.js';
export { PlanStore } from './plans.js';
// M5(2026-05-15) removed: INNER_LOOP_MAX / OUTER_LOOP_MAX constants have no callers
export {
  tokenize as planTokenize,
  jaccard as planJaccard,
  coverage as planCoverage,
  missingTokens as planMissingTokens,
} from './text_tokenize.js';
export {
  createPlanTools,
} from './plan_tools.js';
export type { PlanToolsDeps, PlanCloseSignals } from './plan_tools.js';
// plan_aux_llm.ts fully removed (2026-05-15, M2 Phase 11): aux LLM re-review nested trap proved ineffective in testing
export {
  FetchedResourceStore,
  defaultBaseDir as fetchedResourcesDefaultDir,
  fileNameFromUrl,
  fileNameFromLocalPath,
  isMimeBinary,
  inferExtFromUrl,
} from './fetched_resources.js';
export type {
  FetchedResource,
  PutInput as FetchedResourcePutInput,
  FetchedResourceStoreOptions,
} from './fetched_resources.js';
export {
  createTaskModeTools,
  InMemoryTaskModeStore,
} from './task_mode.js';
export type {
  TaskMode,
  TaskModeStore,
  TaskModeToolsDeps,
} from './task_mode.js';
export {
  ScheduleOutcomeStore,
  extractScheduleIdFromSession,
  summarizeTurnTrace,
  simplifyUrlPattern,
  renderScheduleOutcomesSection,
} from './schedule_outcomes.js';
export type {
  ScheduleOutcome,
  ScheduleOutcomeInput,
  ScheduleOutcomeKind,
  ToolCallTrace,
} from './schedule_outcomes.js';
export {
  PlanFileStore,
  defaultProjectsBaseDir,
} from './plan_files.js';
export type {
  PlanFileInitial,
  RunEntry as PlanFileRunEntry,
  PlanFileStoreOptions,
} from './plan_files.js';
export {
  PursuitStore,
  InvalidPursuitIdError,
  ConstitutionOnNonRootError,
  PursuitNotFoundError,
  loadConstitution,
} from './pursuit.js';
export type { LoadedConstitution } from './pursuit.js';
export {
  DriveConfigStore,
  InvalidDriveIdError,
  DriveConfigNotFoundError,
} from './drive_config.js';
export { DriveOutcomeStore } from './drive_outcome.js';
export { BOOTSTRAP_ROOT_PURSUIT_ID, GLOBAL_TIMELINE_SESSION_ID } from './schema.js';
export { DEFAULT_CONSTITUTION_VALUES, DEFAULT_CONSTITUTION_RED_LINES } from './constitution_defaults.js';
export { inferOriginFromCreatedBy } from './types.js';
export { startScheduler } from './scheduler.js';
export type { SchedulerHandle, SchedulerOptions } from './scheduler.js';
export { SessionExtractor } from './extractor.js';
export { SessionReflector } from './reflector.js';
export { SelfReflector } from './self_reflector.js';
export type {
  SelfReflectResult,
  SelfReflectorOptions,
} from './self_reflector.js';
export { SelfDescriptionWriteForbiddenError } from './store.js';
export type { SelfFactValue } from './store.js';
export { Compactor } from './compactor.js';
export { TimelineRetriever } from './timeline.js';
export type {
  TimelineMessage,
  RetrieveOptions as TimelineRetrieveOptions,
  RetrieveResult as TimelineRetrieveResult,
} from './timeline.js';
export { startIdleConsolidator } from './idle_consolidator.js';
export type {
  IdleConsolidatorOptions,
  IdleConsolidatorHandle,
  ConsolidationRange,
} from './idle_consolidator.js';
export { SessionPursuitExtractor } from './pursuit_extractor.js';
export type {
  SessionPursuitExtractorOptions,
  PursuitExtractResult,
} from './pursuit_extractor.js';
export { SessionDriveReflector, scoreOutcome } from './drive_reflector.js';
export type {
  DriveReflectResult,
  SessionDriveReflectorOptions,
} from './drive_reflector.js';
export {
  TsDriveRuntime,
} from './drive_runtime.js';
export {
  TsTaskCommitmentDrive,
  detectTaskHandoff,
  isPolicyRefusal,
  isDeliveredResult,
  isPureOpenQuestion,
} from './kernel_drives.js';
export {
  evaluateHonesty,
  findCompletionClaim,
  findOrderClaim,
  classifyToolResult,
} from './honesty_gate.js';
export type { HonestyEvaluation, EvaluateOptions as HonestyEvaluateOptions } from './honesty_gate.js';
export {
  detectHalfFinishedTurn,
  findCommitmentPhrase,
} from './half_finished_gate.js';
export type {
  HalfFinishedDetection,
  DetectHalfFinishedOptions,
} from './half_finished_gate.js';
export { evaluateEmptyConclusion } from './empty_conclusion_gate.js';
export { evaluateOutputFormat } from './output_format_gate.js';
export type {
  OutputFormatInput,
  OutputFormatResult,
} from './output_format_gate.js';
export {
  RESEARCH_TOOLS,
  isResearchTool,
  hasResearchCallInTurn,
  buildResearchReminder,
} from './research_before_retry.js';
export type {
  EmptyConclusionResult,
  EmptyConclusionInput,
  EmptyConclusionReason,
} from './empty_conclusion_gate.js';
export { detectTimeRetrospectiveQuery } from './recall_trigger.js';
export { verifySelfSummaryIntegrity } from './self_summary_integrity.js';
export type { SelfSummaryIntegrity, IntegrityDeps as SelfSummaryIntegrityDeps } from './self_summary_integrity.js';
// Tier 2 signal system
export { computeCommitmentPressure } from './signals/commitment_pressure.js';
export type {
  CommitmentPressureBreakdown,
  CommitmentPressureContributor,
  CommitmentPressureOptions,
} from './signals/commitment_pressure.js';
export { signalState } from './signals/state.js';
export { computeServiceDormancy } from './signals/service_dormancy.js';
export type {
  ServiceDormancyBreakdown,
  ServiceDormancyInput,
  ServiceDormancyOptions,
} from './signals/service_dormancy.js';
// Predictive pre-action (2026-05-29): deadline pursuit → scheduled soft wakeup.
export {
  projectPursuitWakeup,
  buildPursuitPreactionPrompt,
  reconcilePredictiveWakeups,
} from './predictive_wakeup.js';
export type { PredictiveWakeupOpts, ReconcileResult } from './predictive_wakeup.js';
export {
  InterruptMapper,
  DEFAULT_THRESHOLDS,
} from './signals/interrupt_mapper.js';
export type {
  InterruptControllerLike,
  InterruptLevel,
  InterruptMapperConfig,
  SignalThresholds,
  FireRecord,
} from './signals/interrupt_mapper.js';
export type {
  TsTaskCommitmentDriveConfig,
  HandoffMatch,
} from './kernel_drives.js';

// K8 initiative layer (autonomous loop)
export {
  startAutonomousLoop,
  InitiativeStore,
  BudgetTracker,
  DEFAULT_BUDGET_CAPS,
  utcDateString,
  StandardExecutor,
  DEFAULT_TOOL_WHITELIST,
  parseExecutorOutput,
  CuriosityDriver,
  DEFAULT_CURIOSITY_CONFIG,
  GapDriver,
  DEFAULT_GAP_CONFIG,
  PursuitDriver,
  DEFAULT_PURSUIT_CONFIG,
  extractSpecificTokens,
  // K7 → K8 bridge (2026-05-06)
  collectK7BridgeInitiatives,
  bridgeTaskCommitment,
  bridgeHonesty,
  extractAbsolutePath,
  // Pursuit progress writer(2026-05-06)
  pursuitProgressWriter,
  applyPursuitProgress,
  parsePursuitTargetRef,
  MAX_RESEARCH_ITERATIONS,
  // MetaConfigObserver(2026-05-12 Phase 8 M3)
  runMetaConfigObserver,
  // BugDetector(2026-05-12 Phase 8 M4)
  runBugDetector,
} from './autonomous/index.js';
export type {
  AutonomousAuditHook,
  AutonomousInterruptKind,
  AutonomousInterruptPayload,
  AutonomousLoopHandle,
  AutonomousLoopOptions,
  BudgetCaps,
  BudgetReservation,
  CuriosityDriverConfig,
  DailyUsage,
  Driver,
  ExecutorFactProposal,
  ExecutorLlmOutput,
  ExecutorNoteProposal,
  GapDriverConfig,
  PursuitDriverConfig,
  Initiative,
  InitiativeExecutor,
  InitiativeExecutorOptions,
  InitiativeOutcomeRefs,
  InitiativePlanStep,
  InitiativeProposal,
  InitiativeRunResult,
  InitiativeStatus,
  InterruptSink,
  MemorySnapshot,
  PerTickUsage,
  TickEvent,
  ToolRunner,
  ToolRunResult,
  BridgeInput,
  PursuitApplyResult,
  OutcomeHook,
  MetaConfigObserverInput,
  MetaConfigObserverResult,
  ConfigRuleProposal,
  BugDetectorInput,
  BugDetectorResult,
  BugReport,
  BugReportEvidence,
  BugSeverity,
} from './autonomous/index.js';
export type {
  TsDriveEngine,
  DriveRuntimeState,
  DriveProposal,
  FiredDrive,
  TurnObservations,
  TsDriveRuntimeOptions,
  TsToolCallSummary,
  RecentMessage,
} from './drive_runtime.js';
export type { ExtractorLlmClient, SessionExtractorOptions } from './extractor.js';
export type {
  Fact,
  FactInput,
  FactKind,
  Note,
  NoteInput,
  RawSession,
  RawMessage,
  RawMessageInput,
  Action,
  ActionInput,
  Skill,
  SkillInput,
  SkillMaturity,
  ExtractResult,
  ReflectResult,
  ConventionalNamespace,
  CompactorMessage,
  CompactorConfig,
  CompactionResult,
  CalendarEvent,
  CalendarEventInput,
  Schedule,
  ScheduleInput,
  ScheduleActionType,
  ScheduleCreatedBy,
  Plan,
  PlanInput,
  PlanStatus,
  PlanStep,
  PlanStepStatus,
  PlanReview,
  AccessLogEntry,
  AccessLogInput,
  AccessTargetType,
  Pursuit,
  PursuitInput,
  PursuitStatus,
  PursuitOrigin,
  PursuitStake,
  OpenQuestion,
  OpenQuestionStatus,
  ProgressMarker,
  ConstitutionFields,
  DriveConfig,
  DriveConfigInput,
  DriveConfigStatus,
  DriveKind,
  EffectivenessStats,
  DriveOutcome,
  DriveOutcomeInput,
} from './types.js';
export { CONVENTIONAL_NAMESPACES } from './types.js';
export {
  storeFactTool,
  getFactTool,
  listFactsTool,
  searchNotesTool,
  searchSkillsTool,
  useSkillTool,
  createCalendarEventTool,
  listUpcomingTool,
  scheduleReminderTool,
  cancelScheduleTool,
  createMemoryTools,
} from './tools.js';
export {
  subscribePushTool,
  unsubscribePushTool,
  createPushTools,
} from './push_tools.js';
export type { PushTool } from './push_tools.js';
export {
  researchFocusTool,
  createResearchTools,
  DEFAULT_RESEARCH_GRANT_TTL_MS,
} from './research_tools.js';
export type { ResearchTool, ResearchGrantSink } from './research_tools.js';
export { importSkills } from './skillImport.js';
export type { ImportableSkill, ImportOptions, ImportResult } from './skillImport.js';
export {
  ensureBundledRoutingRule,
  shouldAutoRouteSkill,
  AUTO_BUNDLED_PREFIX,
} from './routing_bundled.js';
export type { MemoryAuditHook } from './audit.js';
export { InMemoryAuditHook } from './audit.js';
export { resolveDefaultMemoryPath, migrateLegacyMemoryDb } from './paths.js';
export type { MigrationResult } from './paths.js';
export { BackupRunner } from './backup.js';
export type { BackupConfig } from './backup.js';

// User behavior observation (2026-05-07) — path 7 autonomous learning pathway
export {
  detectRecurringUserPatterns,
  extractPatternKeywords,
} from './user_pattern_observer.js';
export type {
  PatternCandidate,
  DetectOptions as PatternDetectOptions,
} from './user_pattern_observer.js';

export interface OpenMemoryDbOptions {
  /** Pass BackupConfig to enable periodic local backups (default 6h × 28 copies) */
  backup?: BackupConfig;
}

/**
 * Recovery result when the memory database was opened.
 * - `none`: database is healthy (or brand new), opened normally.
 * - `restored-from-backup`: original database was corrupted; restored from a backup.
 * - `fresh-after-corruption`: original database was corrupted with no available backup; started with empty database.
 *
 * Consumers (e.g. server) can use this to inform the user/agent about how much learning was lost,
 * consistent with philont's "honesty" principle — the system must also be honest about its own state.
 */
export type MemoryDbRecovery =
  | { kind: 'none' }
  | {
      kind: 'restored-from-backup';
      /** Backup filename used for recovery */
      backupFile: string;
      /** Milliseconds since the backup was taken; -1 if unparseable from filename */
      backupAgeMs: number;
      /** Path prefix where the corrupted file was quarantined (main DB + -wal + -shm) */
      quarantined: string;
    }
  | { kind: 'fresh-after-corruption'; quarantined: string };

export interface MemoryHandle {
  db: Database.Database;
  facts: MemoryStore;
  notes: NotesStore;
  raw: RawStore;
  actions: ActionLog;
  skills: SkillStore;
  access: AccessLog;
  calendar: CalendarStore;
  schedules: ScheduleStore;
  /** v17: complex task protocol plan persistence (2026-05-11) */
  plans: PlanStore;
  /** v7: Pursuit layer (agent identity + soul core) */
  pursuits: PursuitStore;
  /** v7: declarative drive configuration */
  driveConfigs: DriveConfigStore;
  /** v7: drive firing persistence */
  driveOutcomes: DriveOutcomeStore;
  /** v12: routing rule store (reflection-distilled input condition → skill decision rules) */
  routingRules: RoutingRuleStore;
  /** v18: config rule store (Phase 8 self-modifying config layer, 2026-05-12) */
  configRules: ConfigRuleStore;
  /** v14: proactive push subscriptions (opt-in state) */
  pushSubscriptions: PushSubscriptionStore;
  /** v21: run trace for repeated schedule firings (2026-05-17) */
  scheduleOutcomes: ScheduleOutcomeStore;
  /** v22 Phase 13 (2026-05-17): per-project plan.md work notes (LLM-perspective accumulation layer) */
  planFiles: PlanFileStore;
  /** v25 (2026-05-31): reasoning tree for the deep reasoning subsystem (session + sub-question nodes) */
  reasoning: ReasoningStore;
  /** Whether this open triggered corruption recovery; `none` means database is healthy */
  recovery: MemoryDbRecovery;
  /** Stop backup timer and close DB connection; idempotent */
  close(): void;
}

/** Unified connection pragmas for the memory database — applied to both new and recovered databases. */
const MEMORY_PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
] as const;

function applyPragmas(db: Database.Database): void {
  for (const p of MEMORY_PRAGMAS) db.pragma(p);
}

/** PRAGMA quick_check — faster than integrity_check, sufficient for page-level corruption detection. */
function isHealthy(db: Database.Database): boolean {
  try {
    return db.pragma('quick_check', { simple: true }) === 'ok';
  } catch {
    return false;
  }
}

/**
 * Try to open and verify a SQLite file.
 * Healthy (or brand new empty file) → return connection with pragmas applied; corrupted / error on open → return null.
 */
function tryOpenVerified(dbPath: string): Database.Database | null {
  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch {
    return null;
  }
  try {
    applyPragmas(db);
    if (!isHealthy(db)) {
      db.close();
      return null;
    }
    return db;
  } catch {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Backup files in the backup directory, sorted by filename descending (filename contains ISO timestamp, lexicographic = chronological), newest first. */
function listBackupFiles(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  try {
    return readdirSync(backupDir)
      .filter((n) => n.startsWith('memory-') && n.endsWith('.sqlite'))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch {
    return [];
  }
}

/** Parse "milliseconds since now" from backup filename `memory-YYYYMMDDTHHmmss.sqlite`; returns null if unparseable. */
function backupAgeMs(backupName: string): number | null {
  const m = backupName.match(
    /^memory-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.sqlite$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ts = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(ts) ? null : Date.now() - ts;
}

/** Rename and quarantine the corrupted main database + WAL + SHM, preserving evidence and freeing the original path. Returns the quarantine path prefix. */
function quarantineCorruptDb(dbPath: string): string {
  const tag = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '');
  const prefix = `${dbPath}.corrupt-${tag}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (!existsSync(src)) continue;
    try {
      renameSync(src, prefix + suffix);
    } catch (e) {
      console.warn(`[memory] failed to quarantine corrupted file ${src}:`, e);
    }
  }
  return prefix;
}

/**
 * Automatic recovery when the memory database is corrupted: quarantine corrupted file →
 * try backups in reverse chronological order → start with empty database if all fail.
 * Never throws, never silent — every step console.errors, making "how much was lost" visible.
 */
function recoverMemoryDb(
  dbPath: string,
  backupDir: string
): { db: Database.Database; recovery: MemoryDbRecovery } {
  console.error(`[memory] ⚠ memory db corrupted: ${dbPath} —— starting auto-recovery`);

  const quarantined = quarantineCorruptDb(dbPath);
  console.error(
    `[memory] corrupted files quarantined to ${quarantined}{,-wal,-shm} (kept for later salvage)`
  );

  for (const name of listBackupFiles(backupDir)) {
    const backupPath = join(backupDir, name);
    try {
      copyFileSync(backupPath, dbPath);
    } catch (e) {
      console.warn(`[memory] failed to copy backup ${name}, trying an earlier one:`, e);
      continue;
    }
    const db = tryOpenVerified(dbPath);
    if (db) {
      const ageMs = backupAgeMs(name);
      const ageHint =
        ageMs != null
          ? ` —— backup is about ${Math.round(ageMs / 3_600_000)} hours old; learning from this period has been lost`
          : '';
      console.error(`[memory] ✓ recovered from backup: ${name}${ageHint}`);
      return {
        db,
        recovery: {
          kind: 'restored-from-backup',
          backupFile: name,
          backupAgeMs: ageMs ?? -1,
          quarantined,
        },
      };
    }
    console.warn(`[memory] backup ${name} is also corrupted, continuing to try earlier backups`);
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  console.error(
    `[memory] ⚠ no usable backup —— starting with an empty memory db. ` +
      `Historical memory (facts/skills/plans/routing_rules/reflections) is all lost; ` +
      `corrupted files are kept at ${quarantined}*, salvageable later with sqlite3 .recover.`
  );
  const db = new Database(dbPath);
  applyPragmas(db);
  return { db, recovery: { kind: 'fresh-after-corruption', quarantined } };
}

/**
 * Open or create the memory database.
 *
 * Behavior:
 *   - Enables WAL + foreign_keys + synchronous=NORMAL + busy_timeout=5000
 *   - Real file paths (not :memory:) are chmod'd to 0o600; WAL/SHM files alongside as well
 *   - Optional options.backup starts a background periodic backup
 *   - Runs PRAGMA quick_check on open; if corrupted, auto-recovers (quarantine → fallback backup → empty database),
 *     never silently crashes, never silently clears; result is in the returned `recovery` field
 *
 * @param dbPath SQLite file path; ':memory:' means in-memory database (for testing)
 */
export function openMemoryDb(
  dbPath: string,
  options: OpenMemoryDbOptions = {}
): MemoryHandle {
  const isMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:');

  let db: Database.Database;
  let recovery: MemoryDbRecovery = { kind: 'none' };

  if (isMemory) {
    db = new Database(dbPath);
    applyPragmas(db);
  } else {
    const verified = tryOpenVerified(dbPath);
    if (verified) {
      db = verified;
    } else {
      // Corrupted (or error on open) → auto-recover: quarantine → fallback backup → empty database
      const backupDir = options.backup?.dir ?? join(dirname(dbPath), 'backups');
      const result = recoverMemoryDb(dbPath, backupDir);
      db = result.db;
      recovery = result.recovery;
    }
  }

  initSchema(db);

  // Only chmod real files; ':memory:' for in-memory DB is not a file path
  if (!isMemory) {
    tightenPermissions(dbPath);
  }

  let backup: BackupRunner | null = null;
  if (options.backup && !isMemory) {
    backup = new BackupRunner(db, dbPath, options.backup);
    backup.start();
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backup?.stop();
    try {
      // Merge WAL back into main database before clean shutdown, reducing chance of inconsistent WAL on abnormal exit
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* checkpoint failure is non-fatal */
    }
    try {
      db.close();
    } catch (e) {
      console.warn('[memory] db.close failed:', e);
    }
  };

  return {
    db,
    recovery,
    facts: new MemoryStore(db),
    notes: new NotesStore(db),
    raw: new RawStore(db),
    actions: new ActionLog(db),
    skills: new SkillStore(db),
    access: new AccessLog(db),
    calendar: new CalendarStore(db),
    schedules: new ScheduleStore(db),
    plans: new PlanStore(db),
    pursuits: new PursuitStore(db),
    driveConfigs: new DriveConfigStore(db),
    driveOutcomes: new DriveOutcomeStore(db),
    routingRules: new RoutingRuleStore(db),
    configRules: new ConfigRuleStore(db),
    pushSubscriptions: new PushSubscriptionStore(db),
    scheduleOutcomes: new ScheduleOutcomeStore(db),
    planFiles: new PlanFileStore(),
    reasoning: new ReasoningStore(db),
    close,
  };
}

/** Set the main DB file and WAL/SHM (if present) to 0o600 */
function tightenPermissions(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (!existsSync(p)) continue;
    try {
      chmodSync(p, 0o600);
    } catch {
      // May fail on non-POSIX (Windows), non-fatal
    }
  }
}
