/**
 * autonomous_progress_inject — chat-handler renders two sections in the system prefix:
 *
 *   "## I reviewed my previous commitments (K7→K8 bridge)" — initiatives produced by the k7-bridge driver
 *   "## What I just did on my own (autonomous)"            — initiatives produced by other drivers (Gap/Curiosity)
 *
 * Data source: InitiativeStore.listRecentDone(sinceTs, topK)
 * Only initiatives done after the user's last turn are shown; top-3 per section to prevent prompt bloat.
 *
 * Injection point: inside buildMemoryPrefix, after K3 self.* and before interrupt drainer.
 * Kept separate from buildRoutingInjection — that one is the task-entry system injection.
 */

import type { Initiative, InitiativeStore, PursuitStore, ReasoningStore } from '@agent/memory';

export interface AutonomousProgressInjectOptions {
  /** Only show items with completed_at >= sinceTs. Pass 0 to show all recent. */
  sinceTs?: number;
  /** Maximum number of items to show, default 3. */
  topK?: number;
  /** Max token estimate (rough character limit). Default 1000 chars. */
  maxChars?: number;
}

const K7_BRIDGE_DRIVER = 'k7-bridge';

/**
 * Render the "what I just did on my own" section (autonomous output from non-K7-bridge drivers).
 * Returns an empty string when there is nothing to show (zero token cost).
 */
export function buildAutonomousProgressInjection(
  initiatives: InitiativeStore,
  opts: AutonomousProgressInjectOptions = {},
): string {
  const sinceTs = opts.sinceTs ?? 0;
  const topK = Math.max(1, opts.topK ?? 3);
  const maxChars = opts.maxChars ?? 1000;

  // Filter by driver: **exclude** k7-bridge — those are rendered separately by buildK7BridgeReviewSection
  const recent = initiatives
    .listRecentDone(sinceTs, topK * 3)
    .filter((i) => i.driver !== K7_BRIDGE_DRIVER)
    .slice(0, topK);
  if (recent.length === 0) return '';

  const lines: string[] = ['## 我自己刚做了什么(autonomous)'];
  for (const r of recent) {
    lines.push(renderOne(r));
  }
  const out = lines.join('\n');
  if (out.length > maxChars) {
    return out.slice(0, maxChars) + '… (截断)';
  }
  return out;
}

/**
 * Render the "I verified my previous commitments" section.
 *
 * This section only shows initiatives produced by the k7-bridge driver.
 * Semantics: the K7 gate caught a problem in the previous turn (lying / deflecting /
 * fabricating numbers etc.) → K8 goes and verifies during idle time → feeds the
 * verification result back here so the user sees "I already self-corrected X" in the
 * next conversation.
 *
 * Coexists with the "what I just did" section without overlap: that section is proactive
 * Gap/Curiosity research; this section is post-hoc verification triggered by K7.
 * Both are autonomous, but with different semantics.
 */
export function buildK7BridgeReviewSection(
  initiatives: InitiativeStore,
  opts: AutonomousProgressInjectOptions = {},
): string {
  const sinceTs = opts.sinceTs ?? 0;
  const topK = Math.max(1, opts.topK ?? 3);
  const maxChars = opts.maxChars ?? 800;

  const recent = initiatives
    .listRecentDone(sinceTs, topK * 3)
    .filter((i) => i.driver === K7_BRIDGE_DRIVER)
    .slice(0, topK);
  if (recent.length === 0) return '';

  const lines: string[] = ['## 我自己复核了上一轮的承诺(K7→K8)'];
  for (const r of recent) {
    lines.push(renderOne(r));
  }
  const out = lines.join('\n');
  if (out.length > maxChars) {
    return out.slice(0, maxChars) + '… (截断)';
  }
  return out;
}

/**
 * Render the "## Pending Background Research Approvals" section (proactive research "request permission").
 *
 * Data source = pursuit.openQuestions[status==='open' && pendingTool] — the same location
 * that PursuitDriver replay reads from and closeOpenQuestion cleans up
 * (single source of truth, not stored in three separate places).
 *
 * When the background executor determines "answering this question requires a gated tool",
 * it records the request in the question's pendingTool; this section renders those pending
 * requests for the user to guide them to call grant_research_tool to approve.
 * Returns an empty string when there are no pending requests (zero token cost).
 */
export function buildResearchPendingGrantSection(
  pursuits: PursuitStore,
  rootId: string,
  opts: { topK?: number; maxChars?: number } = {},
): string {
  const topK = Math.max(1, opts.topK ?? 5);
  const maxChars = opts.maxChars ?? 1000;

  const lines: string[] = [];
  for (const p of pursuits.listActive(rootId)) {
    if (!p.isActiveResearch) continue;
    for (const q of p.openQuestions) {
      if (q.status !== 'open' || !q.pendingTool) continue;
      const why = q.pendingTool.why?.trim();
      lines.push(
        `- 研究「${p.title}」需要用 \`${q.pendingTool.tool}\`${why ? ` 来${why}` : ''} —— ` +
          `批准请调 grant_research_tool({ pursuitId: "${p.id}", tool: "${q.pendingTool.tool}" })`,
      );
      if (lines.length >= topK) break;
    }
    if (lines.length >= topK) break;
  }
  if (lines.length === 0) return '';

  const out = ['## 后台研究待批准', ...lines].join('\n');
  if (out.length > maxChars) return out.slice(0, maxChars) + '… (截断)';
  return out;
}

/**
 * Render the "## Deep Reasoning In Progress" section (deep reasoning subsystem, resumable within a turn).
 *
 * Informs the next turn's main LLM (and the user) that there is an active reasoning session
 * that can be continued. Data source = ReasoningStore.listActiveSessions().
 * Returns empty string when there are no active sessions (zero tokens).
 * Renders only the most recent active session's counts + top frontier + goal;
 * maxChars is kept tight to prevent injection budget overflow.
 */
export function buildReasoningProgressSection(
  reasoning: ReasoningStore,
  opts: { maxChars?: number; topFrontier?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 800;
  const topFrontier = Math.max(1, opts.topFrontier ?? 4);

  const session = reasoning.listActiveSessions()[0];
  if (!session) return '';
  const nodes = reasoning.getNodes(session.id);

  const hasChild = new Set<string>();
  for (const n of nodes) if (n.parentId) hasChild.add(n.parentId);
  const frontier = nodes.filter((n) => n.status === 'open' && !hasChild.has(n.id));
  const proved = nodes.filter((n) => n.status === 'proved').length;
  const dead = nodes.filter((n) => n.status === 'dead_end').length;

  const lines: string[] = ['## 进行中的深度推理'];
  lines.push(`- 难题:${session.goal}`);
  lines.push(`- 进展:已证 ${proved} / 待攻(frontier) ${frontier.length} / 死胡同 ${dead}`);
  if (frontier.length) {
    lines.push('- 当前在攻:' + frontier.slice(0, topFrontier).map((n) => n.claim).join(' / '));
  }
  // 2026-06-08: this is background context, NOT a standing instruction. The old imperative line
  // ("要接着推进就调 continue") made the model auto-continue the reasoning session on EVERY turn —
  // even for an unrelated request like "清除定时任务" — running a multi-minute round before (or
  // instead of) doing what the user asked, and (because listActiveSessions is global) pulling a
  // session started in another channel into the current one. Make it explicitly subordinate to the
  // user's current request.
  lines.push(
    '→ 仅为后台进展参考(可能来自其它渠道/会话)。**优先处理用户当前这条消息的实际请求**;' +
    '只有当用户明确要求"继续/推进这项推理"时,才调 deep_explore(action=continue)(它会阻塞当前回合数分钟);' +
    '用户问的是别的事(哪怕无关)就不要擅自续跑。',
  );

  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '… (截断)' : out;
}

function renderOne(i: Initiative): string {
  const summary = (i.outcomeSummary ?? '').trim();
  const refs = i.outcomeRefs;
  const refsLine = refs && (refs.facts.length + refs.notes.length > 0)
    ? ` [产出 ${refs.facts.length}fact/${refs.notes.length}note]`
    : '';
  const ago = i.completedAt ? formatAgo(Date.now() - i.completedAt) : '';
  const head = `- (${i.driver}/${i.kind}) ${i.targetRef}${ago ? ` · ${ago}` : ''}${refsLine}`;
  if (!summary) return head;
  return `${head}\n  ${summary}`;
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return '刚刚';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} 分钟前`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} 小时前`;
  return `${Math.round(ms / (24 * 60 * 60_000))} 天前`;
}
