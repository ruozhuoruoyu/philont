/**
 * WeChat admission policy layer — DM / Group allow-or-deny + allowlist matching
 *
 * Does not depend on specific iLink protocol fields; only accepts normalised
 * inbound message shapes.
 * Three-level semantics, following the hermes weixin adapter:
 *   - open       any user/group is allowed
 *   - allowlist  only entries in the list are allowed (default / safest)
 *   - disabled   deny all
 *   - pairing    special pairing mode (user must add the bot first; not implemented
 *                in v1 — treated as disabled)
 *
 * Default policy: DM uses allowlist (only explicitly allowed users can chat),
 * Group uses disabled (avoids chaos in group chats).
 */

export type DmPolicy = 'open' | 'allowlist' | 'disabled' | 'pairing';
export type GroupPolicy = 'open' | 'allowlist' | 'disabled' | 'pairing';

export interface PolicyConfig {
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  /** DM allowlist (empty array under allowlist = deny all). */
  allowedUsers: string[];
  /** Group allowlist (only effective when groupPolicy=allowlist). */
  allowedGroups: string[];
  /** Per-group allow_from (further restricts who can speak in a group); omit = use allowedUsers. */
  groupOverrides?: Record<string, { allowFrom?: string[] }>;
}

export interface InboundContext {
  /** Sending user id (iLink user_id). */
  fromUserId: string;
  /** Group id; empty string indicates a DM. */
  groupId?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/** Default configuration. */
export const DEFAULT_POLICY: PolicyConfig = {
  dmPolicy: 'open',
  groupPolicy: 'open',
  allowedUsers: [],
  allowedGroups: [],
};

/**
 * Check whether an inbound message is allowed to enter the agent loop.
 *
 * Decision tree:
 *   1. groupId empty → DM path, check dmPolicy + allowedUsers
 *   2. groupId non-empty → Group path
 *      2a. groupPolicy=disabled → deny
 *      2b. groupPolicy=open → allow
 *      2c. groupPolicy=allowlist → group must be in allowedGroups, and the speaker:
 *          - if the group has groupOverrides.allowFrom → must be in that list
 *          - otherwise → must be in allowedUsers
 *   3. pairing is treated as disabled (not supported in v1)
 */
export function checkInboundPolicy(
  ctx: InboundContext,
  cfg: PolicyConfig = DEFAULT_POLICY,
): PolicyDecision {
  if (!ctx.fromUserId) {
    return { allowed: false, reason: 'missing fromUserId' };
  }

  const isGroup = Boolean(ctx.groupId);
  const allowedUsers = new Set(cfg.allowedUsers ?? []);

  if (!isGroup) {
    // DM path
    switch (cfg.dmPolicy) {
      case 'open':
        return { allowed: true, reason: 'dm_open' };
      case 'disabled':
      case 'pairing':
        return { allowed: false, reason: `dm_${cfg.dmPolicy}` };
      case 'allowlist':
        if (allowedUsers.has(ctx.fromUserId)) {
          return { allowed: true, reason: 'dm_allowlist_match' };
        }
        return { allowed: false, reason: 'dm_allowlist_miss' };
      default:
        return { allowed: false, reason: `unknown_dm_policy:${cfg.dmPolicy}` };
    }
  }

  // Group path
  const groupId = ctx.groupId!;
  switch (cfg.groupPolicy) {
    case 'open':
      return { allowed: true, reason: 'group_open' };
    case 'disabled':
    case 'pairing':
      return { allowed: false, reason: `group_${cfg.groupPolicy}` };
    case 'allowlist': {
      const allowedGroups = new Set(cfg.allowedGroups ?? []);
      if (!allowedGroups.has(groupId)) {
        return { allowed: false, reason: 'group_allowlist_miss' };
      }
      // Group is in the allowlist; now check the speaker
      const override = cfg.groupOverrides?.[groupId];
      const userPool = override?.allowFrom ? new Set(override.allowFrom) : allowedUsers;
      if (userPool.has(ctx.fromUserId)) {
        return { allowed: true, reason: 'group_allowlist_match' };
      }
      return { allowed: false, reason: 'group_user_not_in_allowlist' };
    }
    default:
      return { allowed: false, reason: `unknown_group_policy:${cfg.groupPolicy}` };
  }
}

/** Parse PolicyConfig from env (used at server startup). */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const dmPolicy = (env.WECHAT_DM_POLICY as DmPolicy) || 'open';
  const groupPolicy = (env.WECHAT_GROUP_POLICY as GroupPolicy) || 'open';
  const allowedUsers = (env.WECHAT_ALLOWED_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedGroups = (env.WECHAT_ALLOWED_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { dmPolicy, groupPolicy, allowedUsers, allowedGroups };
}
