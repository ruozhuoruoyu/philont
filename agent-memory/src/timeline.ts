/**
 * TimelineRetriever — K0: global timeline retriever for LLM working context.
 *
 * Design philosophy: the agent is a continuous "individual"; LLM conversation history should not
 * be cut by ws session. Before each LLM call, retrieve fragments from the raw layer's global timeline:
 *
 *   - **Recency section**: the most recent N messages (by timestamp DESC), filled until approaching budget.
 *   - **Keyword recall section**: uses the current user message as the query, FTS5 hits on old messages, supplements context.
 *
 * The raw layer only stores text (user / assistant final replies), not tool_use / tool_result blocks,
 * so the retriever always returns { role, content: string } form — no need to worry about
 * tool_use_id pairing completeness. Tool call details are per-turn working memory and are not preserved across turns.
 *
 * Performance: all queries use SQLite indexes (idx_raw_messages_timestamp + FTS5 trigram);
 * a single retrieve() call is expected to take < 50ms on a 100K message database.
 */

import type { RawStore } from './raw.js';
import type { RawMessage } from './types.js';

/**
 * Output message — not bound to a specific LLM SDK; consumer (server/chat-handler) casts to
 * Anthropic.MessageParam as the fields are fully compatible.
 */
export interface TimelineMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Persistence time (epoch ms), for deduplication / sorting reference by consumer */
  timestamp: number;
}

export interface RetrieveOptions {
  /** Recency section token budget, default 80_000 */
  recentBudgetTokens?: number;
  /** Recall section token budget, default 40_000; this section does not exist when query is empty */
  recallBudgetTokens?: number;
  /** Current user message text, used for keyword recall. Empty string / not provided → skip recall section */
  recallQuery?: string;
  /** Maximum messages in Recency section (guards against memory explosion in extreme cases), default 500 */
  recentLimitMessages?: number;
  /** Maximum candidates scanned in recall section (then loaded within budget), default 50 */
  recallLimitCandidates?: number;
  /**
   * Token estimation function, defaults to character count × 0.6.
   * Consistent with the estimator in server/src/message-budget.ts so that
   * retriever budget selection does not deviate too far from actual LLM cost.
   */
  estimator?: (text: string) => number;
  /**
   * 2026-05-09: restrict recall to these sessionIds. Both recency section and recall section are filtered.
   * Default (not provided) → global recall (behaviour unchanged).
   *
   * Autonomous turns (server sessionId='system:scheduled:*') should pass
   * `[sessionId]` to cut cross-session contamination: K0 timeline defaults to global, but
   * user/assistant conversations from a wechat session being accidentally triggered by
   * short_answer_binding would cause heartbeat self-termination (happened in production mycox onboarding).
   */
  restrictToSessionIds?: string[];
}

export interface RetrieveResult {
  messages: TimelineMessage[];
  /** Total token estimate including recency + recall */
  totalTokens: number;
  /** Actual number of messages taken from recency section */
  recencyCount: number;
  /** Actual number of messages taken from recall section */
  recallCount: number;
}

// K8 tuning (2026-04-27): old defaults of 80K + 40K + 500 caused the most recent 3 key messages to be
// buried in hundreds of irrelevant old history (reproduced in testing: "let me just say it then" was
// treated as a fresh greeting). New defaults make the most recent ~10-15 turns clearly visible; keyword
// recall degrades to supplementary. Hard limit: Claude's attention recall on long contexts decays noticeably;
// 12K tokens is the empirical sweet spot.
const DEFAULTS = {
  recentBudgetTokens: 8_000,
  recallBudgetTokens: 4_000,
  recentLimitMessages: 30,
  recallLimitCandidates: 10,
};

/** role in the raw layer is 'system' | 'user' | 'assistant' | 'tool'; mapped to LLM binary roles */
function normalizeRole(role: RawMessage['role']): TimelineMessage['role'] | null {
  if (role === 'user' || role === 'tool') return 'user';
  if (role === 'assistant') return 'assistant';
  // 'system' does not enter the timeline — system prompt is assembled by chat-handler itself
  return null;
}

function rawToTimeline(m: RawMessage): TimelineMessage | null {
  const role = normalizeRole(m.role);
  if (!role) return null;
  return { role, content: m.content, timestamp: m.timestamp };
}

function defaultEstimator(text: string): number {
  return Math.ceil(text.length * 0.6);
}

export class TimelineRetriever {
  constructor(private readonly raw: RawStore) {}

  /**
   * Retrieve: recency section + keyword section.
   *
   * The returned messages array is sorted in chronological order (earliest → latest);
   * consumer can directly concatenate into `[systemPrompt, ...messages, currentUserInput]` to feed LLM.
   */
  retrieve(opts: RetrieveOptions = {}): RetrieveResult {
    const recentBudget = opts.recentBudgetTokens ?? DEFAULTS.recentBudgetTokens;
    const recallBudget = opts.recallBudgetTokens ?? DEFAULTS.recallBudgetTokens;
    const recentLimit = opts.recentLimitMessages ?? DEFAULTS.recentLimitMessages;
    const recallLimit = opts.recallLimitCandidates ?? DEFAULTS.recallLimitCandidates;
    const estimate = opts.estimator ?? defaultEstimator;
    const query = (opts.recallQuery ?? '').trim();

    // ── Recency section: take the newest N messages by timestamp DESC, then reverse to chronological order ──
    const recentDesc = this.raw.queryTimeline({
      order: 'desc',
      limit: recentLimit,
      sessionIds: opts.restrictToSessionIds,
    });

    let recentTokens = 0;
    const recentChosen: RawMessage[] = [];
    // Traverse newest to oldest, fill until approaching budget
    for (const m of recentDesc) {
      const t = estimate(m.content);
      if (recentChosen.length > 0 && recentTokens + t > recentBudget) break;
      recentChosen.push(m);
      recentTokens += t;
    }
    // Reverse → chronological order
    recentChosen.reverse();

    const recentIds = new Set(recentChosen.map((m) => m.id));
    const recentEarliestTs = recentChosen.length > 0
      ? recentChosen[0].timestamp
      : Number.POSITIVE_INFINITY;

    // ── Recall section: use query to find old messages in FTS5, exclude those already in recency section ──
    //
    // Note: cannot use timestamp boundary for dedup — multiple appends within the same ms cause all
    // messages to share a timestamp; boundary filtering would mistakenly exclude the whole batch of
    // "old messages". Use id-based dedup instead.
    const recallChosen: RawMessage[] = [];
    let recallTokens = 0;
    if (query.length >= 2 && recallBudget > 0) {
      const candidates = this.raw.searchMessages(query, {
        limit: recallLimit,
        sessionIds: opts.restrictToSessionIds,
      });
      // searchMessages returns timestamp DESC; we sort ascending by timestamp before loading
      candidates.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
      for (const m of candidates) {
        if (recentIds.has(m.id)) continue;
        const t = estimate(m.content);
        if (recallChosen.length > 0 && recallTokens + t > recallBudget) break;
        recallChosen.push(m);
        recallTokens += t;
      }
    }

    // ── Merge: recall section (older, chronological) + recency section (recent, chronological) ──
    const messages: TimelineMessage[] = [];
    for (const m of recallChosen) {
      const tm = rawToTimeline(m);
      if (tm) messages.push(tm);
    }
    // Insert a separator between the two sections to let LLM know a period of time was skipped
    if (recallChosen.length > 0 && recentChosen.length > 0) {
      messages.push({
        role: 'user',
        content: '[—— 旧记忆与近期对话之间 ——]',
        timestamp: recentEarliestTs - 1,
      });
    }
    for (const m of recentChosen) {
      const tm = rawToTimeline(m);
      if (tm) messages.push(tm);
    }

    return {
      messages,
      totalTokens: recentTokens + recallTokens,
      recencyCount: recentChosen.length,
      recallCount: recallChosen.length,
    };
  }
}
