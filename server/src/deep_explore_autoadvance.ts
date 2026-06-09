/**
 * Background auto-advance for deep_explore (opt-in per session, default-off globally).
 *
 * When a reasoning session is opted in (deep_explore action=auto_on → reasoning_sessions.auto_advance=1)
 * AND the server flag PHILONT_DEEP_EXPLORE_AUTO_ADVANCE is on, this loop advances that session one round
 * at a time on its own — no user typing "继续" — and proactively reports progress. It stops a session's
 * auto-advance when the session is solved/closed or has been stuck for too long (cross-round
 * no_progress_rounds counter), escalating to the user instead of grinding forever.
 *
 * Rounds run sequentially (a `running` guard + a recursive timer), so there is no overlap and a single
 * 15-min background round never stacks. The round runs inside a `system:auto-advance:<id>` ALS context
 * so effectiveRoundDeadlineMs() picks the longer background cap. The round is invoked directly via
 * advanceSession (not the tool dispatch), so it does not go through the interactive auth gate — the
 * per-session opt-in IS the authorization.
 */
import type { ReasoningStore, ReasoningSession } from '@agent/memory';
import type { ToolResult } from '@agent/policy';

/** Stop auto-advancing a session after this many consecutive no-progress rounds (then escalate). */
const STUCK_STOP = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_AUTO_STUCK_STOP);
  return Number.isInteger(n) && n >= 1 ? n : 3;
})();

/** Global gate. Off by default → the loop never arms → zero behaviour change. */
export function autoAdvanceEnabled(): boolean {
  const v = (process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

export interface AutoAdvanceDeps {
  reasoning: ReasoningStore;
  /** Advance a specific session by one round (deep_explore's advanceSession). */
  advanceSession: (session: ReasoningSession) => Promise<ToolResult>;
  /** Wrap the round in a turn ALS context (server's runInTurnContext) so it gets the background cap. */
  runInContext: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>;
  /** Proactively notify the user. `important` events (stuck/solved) also push to messaging channels. */
  notify: (text: string, opts?: { important?: boolean }) => void;
  /** ms between ticks. Rounds run sequentially regardless; this is the idle poll cadence. Default 30s. */
  intervalMs?: number;
}

export interface AutoAdvanceLoop {
  start: () => void;
  stop: () => void;
  /** Exposed for tests: run one tick synchronously. */
  tickOnce: () => Promise<void>;
}

export function createAutoAdvanceLoop(deps: AutoAdvanceDeps): AutoAdvanceLoop {
  const intervalMs = deps.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;

  async function tickOnce(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      if (!autoAdvanceEnabled()) return;
      const sessions = deps.reasoning.listAutoAdvanceSessions();
      for (const s of sessions) {
        if (stopped) break;

        // Stop condition: stuck too long → pause auto-advance and escalate to the user.
        if (s.noProgressRounds >= STUCK_STOP) {
          deps.reasoning.setAutoAdvance(s.id, false);
          deps.notify(
            `⏸ 自动推进已暂停:"${s.goal.slice(0, 50)}" 连续 ${s.noProgressRounds} 轮无进展(卡住)。` +
              `回复"继续"手动推进,或换个角度重启。`,
            { important: true },
          );
          continue;
        }

        // Advance one round in a background context (system: → longer cap, no user waiting).
        let out: ToolResult | null = null;
        try {
          out = await deps.runInContext(`system:auto-advance:${s.id}`, () => deps.advanceSession(s));
        } catch (e) {
          console.warn(`[auto-advance] round failed for ${s.id}: ${String(e).slice(0, 200)}`);
          continue;
        }
        if (stopped) break;

        const fresh = deps.reasoning.getSession(s.id);
        if (!fresh || fresh.status !== 'active') {
          // Solved / closed → stop and report.
          deps.reasoning.setAutoAdvance(s.id, false);
          deps.notify(
            `✅ 自动推进结束:"${s.goal.slice(0, 50)}" 状态=${fresh?.status ?? 'closed'}。\n${(out?.output ?? '').slice(0, 600)}`,
            { important: true },
          );
        } else if (fresh.noProgressRounds === 0) {
          // The counter reset → this round made progress → milestone (web-ui live; not pushed every round).
          deps.notify(`🔬 自动推进:"${s.goal.slice(0, 40)}"\n${(out?.output ?? '').slice(0, 600)}`);
        }
        // else: no progress this round but not yet at the stuck-stop → stay quiet (avoid spam).
      }
    } catch (e) {
      console.warn('[auto-advance] tick error', e);
    } finally {
      running = false;
    }
  }

  // The recurring driver — separate from the pure tickOnce() so tests can run one tick without
  // leaving a pending timer that keeps the process alive.
  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tickOnce().finally(scheduleNext);
    }, intervalMs);
  }

  return {
    start: () => {
      if (stopped) return;
      if (!autoAdvanceEnabled()) {
        console.log('[auto-advance] disabled (set PHILONT_DEEP_EXPLORE_AUTO_ADVANCE=on to enable opt-in background rounds)');
        return;
      }
      if (timer) return;
      scheduleNext();
      console.log(`[auto-advance] armed (opt-in per session via deep_explore auto_on; tick=${intervalMs}ms, stuck-stop=${STUCK_STOP})`);
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tickOnce,
  };
}
