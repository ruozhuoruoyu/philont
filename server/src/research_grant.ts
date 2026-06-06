/**
 * research_grant — pure logic for connecting background research "permission requests" to
 * WeChat (independently testable; does not load chat-handler).
 *
 * When background research encounters a gated tool → executor returns needsGrant → chat-handler:
 *   (1) Reconstructs a stable sessionId from the subscribed WeChat DM user, registers a
 *       PendingResearchGrant;
 *   (2) pushDispatcher sends an authorization card (renderResearchGrantPrompt).
 * User replies "agree/deny" in WeChat → decideResearchGrantAction produces a deterministic
 * decision; chat-handler writes grant / cancels request / passes through accordingly.
 *
 * This module contains only pure functions + types; side effects (grant / setQuestionPendingTool
 * / push) remain in chat-handler.
 */

/** Idle-time pending grant (keyed by sessionId; same structure as turn-local pendingAuth but without tool-chain resume). */
export interface PendingResearchGrant {
  pursuitId: string;
  questionId: string;
  tool: string;
  why: string;
  /** Registration timestamp (epoch ms), used for TTL expiry */
  ts: number;
}

/** Render the WeChat authorization card text (aligned with the existing 🔐 auth request style). */
export function renderResearchGrantPrompt(
  title: string,
  tool: string,
  why: string,
  ttlMs: number,
): string {
  return [
    '🔐 后台研究请求授权',
    `研究「${title}」需要用 \`${tool}\` 才能继续${why ? `(${why})` : ''}。`,
    `权限:execute/system · 约 ${Math.round(ttlMs / 60000)} 分钟内有效`,
    '回复「同意」批准 / 「拒绝」拒绝。',
  ].join('\n');
}

/**
 * Reconstruct a stable DM sessionId from a push subscription item (channel + peer).
 *
 * Aligned with each channel's makeSessionId: DM = `<platform>:<accountId>:<userId>`;
 * subscription channel=`<platform>:<accountId>`, peer=userId → sessionId = `${channel}:${peer}`.
 * Supports wechat / telegram — both have the same DM sessionId convention (`${channel}:${peer}`),
 * so "proactive permission requests" registered here work for both channels.
 * Group subscriptions (peer starts with `group:`; "approve" ownership is ambiguous) or unknown
 * channels → return null; not included in routing.
 */
export function reconstructDmSessionId(channel: string, peer: string): string | null {
  if (peer.startsWith('group:')) return null;
  if (channel.startsWith('wechat:') || channel.startsWith('telegram:')) {
    return `${channel}:${peer}`;
  }
  return null;
}

export type ResearchGrantAction = 'grant' | 'deny' | 'expired' | 'passthrough';

/**
 * User reply → deterministic decision.
 *   - No pending          → passthrough (let normal turn flow handle it)
 *   - Pending past TTL    → expired (pass through and clear the stale pending)
 *   - intent=grant        → grant
 *   - intent=deny         → deny
 *   - intent=unclear      → passthrough (do not consume; let LLM handle the pending section)
 */
export function decideResearchGrantAction(
  pending: PendingResearchGrant | undefined,
  intent: 'grant' | 'deny' | 'unclear',
  now: number,
  ttlMs: number,
): ResearchGrantAction {
  if (!pending) return 'passthrough';
  if (now - pending.ts > ttlMs) return 'expired';
  if (intent === 'grant') return 'grant';
  if (intent === 'deny') return 'deny';
  return 'passthrough';
}
