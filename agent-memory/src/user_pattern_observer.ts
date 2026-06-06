/**
 * User pattern observer (2026-05-07)
 *
 * Observes repeated user request patterns across turns → detects "operation chains" and
 * proposes converting them into skills. This is the detection layer for path 7 (user behaviour
 * observation) of the autonomous learning pipeline.
 *
 * Design: pure functions, no LLM calls, no DB writes. The idle_consolidator hook calls this
 * function; once the candidate list is received, the caller decides whether to write it to
 * facts.self.user_patterns or elsewhere.
 *
 * Algorithm:
 *   1. Fetch the raw timeline for the past N days (role='user') → segment into turn boundaries
 *   2. Extract features per turn:
 *      - Keyword set (Chinese: 2-gram sliding window + English words, stopwords removed)
 *      - Tool sequence (tool_name entries from the actions table within the turn's time window)
 *   3. Cross-turn clustering: keyword Jaccard ≥ 0.5 AND tool sequence edit distance ≤ 1
 *   4. Cluster size ≥ minOccurrences → candidate
 *
 * Out of scope (v1):
 *   - LLM semantic clustering (pure heuristics are sufficient)
 *   - Cross-channel patterns (single-user perspective)
 *   - Automatic skill writing (user confirmation required)
 */

import { createHash } from 'node:crypto';
import type { RawStore } from './raw.js';
import type { ActionLog } from './actions.js';
import type { Action, RawMessage } from './types.js';

export interface PatternCandidate {
  /** sha12(sorted keywords + tool sequence) — stable id, used as a facts namespace sub-key */
  signature: string;
  /** Number of occurrences (turns with the same signature) */
  occurrences: number;
  /** Representative examples (up to 3), in reverse chronological order */
  examples: Array<{
    ts: number;
    userMessage: string;     // First 100 characters
    toolSequence: string[];
  }>;
  /** Common keywords (used for rendering) */
  keywords: string[];
  /** Common tool sequence */
  toolSequence: string[];
  firstSeenTs: number;
  lastSeenTs: number;
  /** Human-readable rationale for the match */
  rationale: string;
}

const STOP_WORDS_ZH = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没', '看',
  '好', '自', '这', '那', '里', '后', '能', '下', '过', '想', '些', '可',
  '把', '吗', '啊', '吧', '呢', '让', '给', '帮',
]);
const STOP_WORDS_EN = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'that', 'this', 'and',
  'or', 'but', 'for', 'with', 'on', 'at', 'by', 'as', 'be', 'do', 'have',
  'i', 'you', 'me', 'my', 'your', 'we', 'us', 'our', 'they', 'them',
  'please', 'thanks',
]);

/**
 * Extract keywords:
 *   - English words (consecutive [a-zA-Z0-9_-] runs) → all lowercase, stopwords removed, length ≥ 2
 *   - Chinese runs → 2-gram sliding window (simple and blunt, no tokenizer dependency), single-char stopwords removed
 */
export function extractPatternKeywords(text: string, maxKeywords = 8): Set<string> {
  if (typeof text !== 'string') return new Set();
  const out = new Set<string>();

  // English / numeric tokens
  const enTokens = text.toLowerCase().match(/[a-z0-9_][a-z0-9_-]*/gi) ?? [];
  for (const t of enTokens) {
    const low = t.toLowerCase();
    if (low.length < 2) continue;
    if (STOP_WORDS_EN.has(low)) continue;
    out.add(low);
    if (out.size >= maxKeywords) return out;
  }

  // Chinese runs → 2-gram
  const zhSegments = text.match(/[一-龥]+/g) ?? [];
  for (const seg of zhSegments) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const bigram = seg.slice(i, i + 2);
      // Discard bigrams where both characters are stopwords (noise)
      if (STOP_WORDS_ZH.has(bigram[0]) && STOP_WORDS_ZH.has(bigram[1])) continue;
      out.add(bigram);
      if (out.size >= maxKeywords) return out;
    }
  }
  return out;
}

/**
 * Extract a tool sequence from an actions array (already in ascending time order), merging adjacent duplicates.
 */
function extractToolSequence(actions: Action[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    if (out.length === 0 || out[out.length - 1] !== a.toolName) {
      out.push(a.toolName);
    }
  }
  return out;
}

/**
 * Jaccard similarity; empty set vs empty set = 0 (avoids false-positive clustering).
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Edit distance (Levenshtein); returns ≤ 1 when sequences are identical or differ in length by ≤ 1
 */
function editDistance<T>(a: T[], b: T[]): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 5) return 999; // early reject
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

interface TurnFeature {
  ts: number;
  userMessage: string;
  keywords: Set<string>;
  toolSequence: string[];
}

/**
 * Segment turns: each user message starts a new turn; that turn's tool calls are the
 * actions between the user message's timestamp and the next user message (or toTs).
 */
function buildTurnFeatures(
  userMessages: RawMessage[],
  actions: Action[],
  toTs: number,
): TurnFeature[] {
  const turns: TurnFeature[] = [];
  // userMessages passed in ascending time order
  // actions already in ascending time order (getByRange uses ASC)
  let actionIdx = 0;
  for (let i = 0; i < userMessages.length; i++) {
    const um = userMessages[i];
    const turnStart = um.timestamp;
    const turnEnd = i + 1 < userMessages.length ? userMessages[i + 1].timestamp : toTs;
    const turnActions: Action[] = [];
    while (actionIdx < actions.length && actions[actionIdx].timestamp < turnEnd) {
      if (actions[actionIdx].timestamp >= turnStart) {
        turnActions.push(actions[actionIdx]);
      }
      actionIdx++;
    }
    const keywords = extractPatternKeywords(um.content);
    const toolSequence = extractToolSequence(turnActions);
    if (keywords.size === 0) continue; // No keywords = meaningless turn, skip
    turns.push({
      ts: turnStart,
      userMessage: um.content.slice(0, 100),
      keywords,
      toolSequence,
    });
  }
  return turns;
}

export interface DetectOptions {
  raw: RawStore;
  actions: ActionLog;
  windowDays?: number;        // default 30
  minOccurrences?: number;    // default 3
  minKeywordOverlap?: number; // default 0.5
  maxToolSeqEditDist?: number;// default 1
  maxCandidates?: number;     // default 5
  now?: number;
}

export function detectRecurringUserPatterns(opts: DetectOptions): PatternCandidate[] {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? 30;
  const minOcc = opts.minOccurrences ?? 3;
  const minOverlap = opts.minKeywordOverlap ?? 0.5;
  const maxEdit = opts.maxToolSeqEditDist ?? 1;
  const maxCandidates = opts.maxCandidates ?? 5;
  const fromTs = now - windowDays * 86_400_000;

  // 1. Fetch the past N days of user messages + all actions
  const allMessages = opts.raw.queryTimeline({
    fromTs, untilTs: now, limit: 5000, order: 'asc',
  });
  const userMessages = allMessages.filter((m) => m.role === 'user');
  if (userMessages.length < minOcc) return [];

  const allActions = opts.actions.getByRange(fromTs, now);

  // 2. Segment turns → extract features
  const turns = buildTurnFeatures(userMessages, allActions, now);
  if (turns.length < minOcc) return [];

  // 3. Simple clustering: any two turns within the same cluster satisfy the similarity criteria
  const clusters: TurnFeature[][] = [];
  for (const t of turns) {
    let placed = false;
    for (const c of clusters) {
      // Compare against the **first** turn in the cluster (no transitive closure needed; coarse-grained is fine)
      const first = c[0];
      if (
        jaccard(t.keywords, first.keywords) >= minOverlap &&
        editDistance(t.toolSequence, first.toolSequence) <= maxEdit
      ) {
        c.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([t]);
  }

  // 4. Filter clusters with ≥ minOcc turns, convert to PatternCandidate
  const candidates: PatternCandidate[] = [];
  for (const c of clusters) {
    if (c.length < minOcc) continue;
    // Common keywords = intersection of all turns' keyword sets
    const commonKeywords = new Set(c[0].keywords);
    for (let i = 1; i < c.length; i++) {
      for (const k of [...commonKeywords]) {
        if (!c[i].keywords.has(k)) commonKeywords.delete(k);
      }
    }
    // Common tool sequence = the first turn's sequence (all satisfy edit≤1)
    const commonToolSeq = c[0].toolSequence;
    const sortedKeywords = [...commonKeywords].sort();
    const signature = createHash('sha256')
      .update(sortedKeywords.join('|'))
      .update('\0')
      .update(commonToolSeq.join(','))
      .digest('hex')
      .slice(0, 12);

    const sortedTurns = [...c].sort((a, b) => b.ts - a.ts); // newest first
    const examples = sortedTurns.slice(0, 3).map((t) => ({
      ts: t.ts,
      userMessage: t.userMessage,
      toolSequence: t.toolSequence,
    }));

    candidates.push({
      signature,
      occurrences: c.length,
      examples,
      keywords: sortedKeywords.slice(0, 5),
      toolSequence: commonToolSeq,
      firstSeenTs: Math.min(...c.map(t => t.ts)),
      lastSeenTs: Math.max(...c.map(t => t.ts)),
      rationale:
        `${c.length} similar operations in the past ${windowDays} days, keywords [${sortedKeywords.slice(0,3).join(',')}], ` +
        `tool chain [${commonToolSeq.slice(0,5).join('→') || 'no tools'}]`,
    });
  }

  // 5. Sort by occurrences descending, take top maxCandidates
  candidates.sort((a, b) => b.occurrences - a.occurrences);
  return candidates.slice(0, maxCandidates);
}
