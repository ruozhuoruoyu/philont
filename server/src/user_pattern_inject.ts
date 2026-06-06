/**
 * User pattern observation render section + user confirmation detection (2026-05-07)
 *
 * Uses the same "append to system section tail" pattern as failure_recovery_inject, but
 * the data source is the candidate list written by agent-memory to
 * facts.user.patterns.<sig>.
 *
 * Workflow:
 *   1. user_pattern_observer detects candidates in idle tick → writes facts.user.patterns
 *      `{ signature, status: 'pending', occurrences, examples, ... }`
 *   2. On the next user turn, buildMemoryPrefix calls this module → renders the candidate section
 *   3. User sees the section and replies "learn" / "no" → detectPatternConfirmation matches
 *   4. Caller marks the candidate status='confirmed'/'declined' + (on confirm) triggers the
 *      skill-creator flow
 */

import type { MemoryStore, PatternCandidate } from '@agent/memory';

/** Alias: facts store (semantically a subset of MemoryStore — we only use storeFact/getFact/listFacts) */
type FactsStore = MemoryStore;

const PATTERNS_NAMESPACE = 'user.patterns';

export interface PendingPattern {
  signature: string;
  status: 'pending' | 'confirmed' | 'declined' | 'expired';
  candidate: PatternCandidate;
  proposedAt: number;
}

/**
 * Write a PatternCandidate to facts.user.patterns with status='pending'.
 * Repeating with the same signature supersedes the old version (facts are auto-versioned).
 */
export function savePatternCandidate(
  facts: FactsStore,
  candidate: PatternCandidate,
  now: number = Date.now(),
): void {
  facts.storeFact({
    namespace: PATTERNS_NAMESPACE,
    key: candidate.signature,
    value: {
      signature: candidate.signature,
      status: 'pending',
      candidate,
      proposedAt: now,
    } as PendingPattern,
    confidence: 0.7,
  });
}

export function listPendingPatterns(facts: FactsStore): PendingPattern[] {
  const out: PendingPattern[] = [];
  for (const f of facts.listFacts(PATTERNS_NAMESPACE)) {
    const v = f.value as Partial<PendingPattern> | undefined;
    if (!v || typeof v !== 'object') continue;
    if (v.status !== 'pending') continue;
    if (!v.candidate || !v.signature) continue;
    out.push(v as PendingPattern);
  }
  return out.sort((a, b) => b.proposedAt - a.proposedAt);
}

export function markPatternStatus(
  facts: FactsStore,
  signature: string,
  status: 'confirmed' | 'declined' | 'expired',
  now: number = Date.now(),
): boolean {
  const existing = facts.getFact(PATTERNS_NAMESPACE, signature);
  if (!existing) return false;
  const v = existing.value as Partial<PendingPattern> | undefined;
  if (!v || !v.candidate) return false;
  facts.storeFact({
    namespace: PATTERNS_NAMESPACE,
    key: signature,
    value: {
      signature,
      status,
      candidate: v.candidate,
      proposedAt: v.proposedAt ?? now,
      decidedAt: now,
    } as PendingPattern & { decidedAt: number },
    confidence: 1.0,
  });
  return true;
}

export interface UserPatternInjection {
  text: string;
  matched: boolean;
  shownPatterns: PendingPattern[];
}

export function buildUserPatternObservationSection(
  patterns: PendingPattern[],
  opts?: { maxPatterns?: number },
): UserPatternInjection {
  const max = opts?.maxPatterns ?? 2;
  if (patterns.length === 0) {
    return { text: '', matched: false, shownPatterns: [] };
  }
  const shown = patterns.slice(0, max);

  const lines: string[] = [];
  lines.push('\n\n## 💡 我观察到的模式');
  for (const p of shown) {
    const c = p.candidate;
    const exampleLines = c.examples
      .slice(0, 3)
      .map((e) => {
        const date = new Date(e.ts).toISOString().slice(5, 10); // MM-DD
        return `  - ${date} "${e.userMessage.slice(0, 40)}"`;
      })
      .join('\n');
    const tools = c.toolSequence.length > 0
      ? `工具链 [${c.toolSequence.slice(0, 5).join(' → ')}]`
      : '工具链(无具体工具序列)';
    lines.push(`\n**signature: ${p.signature}** — 最近发生 ${c.occurrences} 次类似操作:`);
    lines.push(exampleLines);
    lines.push(`  ${tools}`);
    lines.push(`  关键词: ${c.keywords.slice(0, 5).join(', ')}`);
  }
  lines.push('\n**要不要我学一个 skill 自动化?**');
  lines.push('- 回 "学" / "自动化" / "学吧" / "可以" → 我会调用 skill-creator 写一个 SKILL.md 持久化');
  lines.push('- 回 "不要" / "跳过" → 这条 7 天内不再提');
  lines.push('- 不响应 → 7 天后自动过期(下次重新检测可能再提)');
  return {
    text: lines.join('\n'),
    matched: true,
    shownPatterns: shown,
  };
}

/**
 * Detect whether a user message contains a confirm / decline signal, returning { kind, signature? }.
 *
 * v1 rules:
 *   - Confirm words: learn / sure / automate / yes / ok
 *   - Decline words: no / skip / don't learn / don't need
 *   - Only matches when there is a recent pending pattern (avoids false positives)
 *   - User can explicitly mention a signature ("learn abc123def456" → kind='confirm', signature='abc123def456')
 *   - Otherwise defaults to the most recent entry
 */
export type PatternResponse =
  | { kind: 'none' }
  | { kind: 'confirm'; signature?: string }
  | { kind: 'decline'; signature?: string };

export function detectPatternConfirmation(userMessage: string): PatternResponse {
  if (typeof userMessage !== 'string' || userMessage.length === 0) {
    return { kind: 'none' };
  }
  const t = userMessage.trim().toLowerCase();
  // Explicit signature reference (e.g. "learn abc123def456")
  const sigMatch = userMessage.match(/\b([a-f0-9]{12})\b/i);
  const sig = sigMatch?.[1];

  // Decline first (prevents "don't learn" from being recognised as confirm)
  if (
    /(不要|不学|不用|跳过|不\s*想)/.test(userMessage) ||
    /\b(no|skip|nope|don'?t)\b/.test(t)
  ) {
    return { kind: 'decline', signature: sig };
  }

  // Confirm
  if (
    /(学吧|学一个|学下来|学着|要学|我要学|学习|确认学)/.test(userMessage) ||
    /(自动化|自动跑|帮我自动)/.test(userMessage) ||
    // Very short reply "learn" / "ok" / "yes" on its own
    /^(学|可以|好|是|是的|对|确认)\s*[!.。]?$/.test(userMessage.trim()) ||
    /^(yes|ok|sure|confirm|yep)\b/i.test(t) ||
    // User explicitly mentions signature ("learn abc123def456") — has sig AND contains confirm verb / starts with confirm word
    (sig !== undefined && /(^学\s|学这|学这个|学吧|学一下)/.test(userMessage))
  ) {
    return { kind: 'confirm', signature: sig };
  }

  return { kind: 'none' };
}
