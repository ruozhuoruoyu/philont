/**
 * ServiceDriver — digest trigger for active push (2026-05-06 phase C).
 *
 * Replaces the old passive service_dormancy model. That model only rendered a
 * "I haven't served you for X hours" section when the user came back — **the user had
 * to speak first**. The new model reverses this:
 *   - Periodic idle tick (hooked into idle_consolidator)
 *   - Check whether the last assistant message was ≥ N hours ago
 *   - Check whether there are ≥ M done initiatives since the last digest
 *   - If conditions met → render summary → dispatcher.enqueue(digest)
 *
 * digest is the most rate-limited severity (default 4h). The Dispatcher also checks:
 *   - Global PHILONT_PUSH_ENABLED=0 → drop
 *   - Per-(channel, peer) subscription not enabled → drop
 *   - Quiet hours matched → drop
 *   - Less than 4h since last digest → drop
 *   - Same (kind+targetRef) already sent within 24h → drop
 *
 * targetRef uses "service:<dateInDay>"; at most one digest per day.
 */

import type { InitiativeStore, RawStore, Initiative } from '@agent/memory';
import type { PushDispatcher } from './dispatcher.js';

export interface ServiceDriverOptions {
  raw: RawStore;
  initiatives: InitiativeStore;
  dispatcher: PushDispatcher;
  /** How long since the last assistant message before the service is considered dormant. Default 24h */
  dormancyHours?: number;
  /** Minimum number of done initiatives since the last digest before pushing. Default 1 */
  minFindings?: number;
  /** Lower bound on dormancy (< this threshold = not pushed, prevents "false alarm" after 1-2 hours). Default 12h */
  minDormantHoursToConsider?: number;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error: (m: string, e?: unknown) => void };
  /** Clock injection for testing */
  now?: () => number;
}

export interface ServiceTickResult {
  triggered: boolean;
  reason?:
    | 'no_assistant_history'
    | 'not_dormant_enough'
    | 'no_findings'
    | 'enqueued';
  findings: number;
  dormantHours?: number;
  dispatchDelivered?: number;
  dispatchSkipped?: number;
}

const DEFAULT_DORMANCY_HOURS = 24;
const DEFAULT_MIN_DORMANT_HOURS = 12;
const DEFAULT_MIN_FINDINGS = 1;

/**
 * Single tick — determine whether to send a digest. Idempotent: the dispatcher has its own
 * 4h rate-limit + same-day dedup, so multiple calls trigger at most one push.
 */
export async function serviceDriverTick(
  opts: ServiceDriverOptions,
): Promise<ServiceTickResult> {
  const log = opts.logger ?? {
    log: (m) => console.log(`[service-driver] ${m}`),
    warn: (m) => console.warn(`[service-driver] ${m}`),
    error: (m, e) => console.error(`[service-driver] ${m}`, e),
  };
  const now = opts.now?.() ?? Date.now();
  const dormancyHours = opts.dormancyHours ?? DEFAULT_DORMANCY_HOURS;
  const minDormantHours = opts.minDormantHoursToConsider ?? DEFAULT_MIN_DORMANT_HOURS;
  const minFindings = opts.minFindings ?? DEFAULT_MIN_FINDINGS;

  // 1. Timestamp of last assistant reply
  const lastAsst = opts.raw.getLastMessageByRole('assistant');
  if (!lastAsst) {
    return { triggered: false, reason: 'no_assistant_history', findings: 0 };
  }
  const dormantMs = now - lastAsst.timestamp;
  const dormantHoursActual = dormantMs / (60 * 60 * 1000);

  if (dormantHoursActual < minDormantHours) {
    return {
      triggered: false,
      reason: 'not_dormant_enough',
      findings: 0,
      dormantHours: dormantHoursActual,
    };
  }
  if (dormantHoursActual < dormancyHours) {
    // In the [minDormantHours, dormancyHours) half-open interval — not dormant enough to
    // push a digest, but not abnormal either.
    return {
      triggered: false,
      reason: 'not_dormant_enough',
      findings: 0,
      dormantHours: dormantHoursActual,
    };
  }

  // 2. Done initiatives produced since the last assistant message
  const findings = opts.initiatives.listRecentDone(lastAsst.timestamp, 5);
  if (findings.length < minFindings) {
    return {
      triggered: false,
      reason: 'no_findings',
      findings: findings.length,
      dormantHours: dormantHoursActual,
    };
  }

  // 3. Render + enqueue
  const text = renderCheckInText(dormantHoursActual, findings);
  const dayBucket = Math.floor(now / (24 * 60 * 60 * 1000));
  const result = await opts.dispatcher.enqueue({
    severity: 'digest',
    kind: 'service:dormancy-checkin',
    targetRef: `service:checkin:day-${dayBucket}`,
    text,
  });

  log.log(
    `tick triggered: dormant=${dormantHoursActual.toFixed(1)}h findings=${findings.length} ` +
      `delivered=${result.delivered} skipped=${result.skipped.length}`,
  );

  return {
    triggered: true,
    reason: 'enqueued',
    findings: findings.length,
    dormantHours: dormantHoursActual,
    dispatchDelivered: result.delivered,
    dispatchSkipped: result.skipped.length,
  };
}

/**
 * Render the check-in text. Kept to ~800 characters; in a notification context, shorter is better.
 */
export function renderCheckInText(
  dormantHours: number,
  findings: readonly Initiative[],
): string {
  const lines: string[] = [];
  const hoursDisplay =
    dormantHours < 36 ? `${dormantHours.toFixed(1)} 小时` : `${Math.round(dormantHours / 24)} 天`;
  lines.push(`👋 ${hoursDisplay}没聊了。这段时间我自己做了 ${findings.length} 件事:`);
  for (const f of findings.slice(0, 3)) {
    const summary = (f.outcomeSummary ?? '').trim().slice(0, 200);
    const driver = f.driver === 'k7-bridge' ? '自我复核' : f.driver;
    lines.push(`- (${driver}/${f.kind}) ${summary || f.targetRef}`);
  }
  if (findings.length > 3) {
    lines.push(`... 还有 ${findings.length - 3} 条,回话时我可以详细说`);
  }
  lines.push('');
  lines.push('回一句"细说"我就把详情送上;不感兴趣可以回"别推送"取消订阅。');
  return lines.join('\n');
}
