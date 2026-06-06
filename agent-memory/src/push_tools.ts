/**
 * subscribePush / unsubscribePush tools (2026-05-06 phase C).
 *
 * domain='self': the agent manages its own state of "which channels it wants to be notified on".
 *
 * Key: the tool description must explicitly tell the LLM **not to call it unless the user explicitly requests it**.
 * Notification fatigue is the worst UX failure mode; LLM should only call subscribePush when the user
 * says something like "notify me / remind me / tell me proactively".
 */

import type { PushSubscriptionStore } from './push_subscriptions.js';
import type { MemoryTool } from './tools.js';

/**
 * Push subscription tools share the same shape as MemoryTool (both domain='self' + simple schema); reuse the type.
 */
export type PushTool = MemoryTool;

const SUBSCRIBE_DESCRIPTION =
  'Enable proactive push for a specified channel + peer.\n' +
  '**Strict constraint**: Only call when the user **explicitly requests** proactive notifications ' +
  '(e.g. "notify me / remind me / tell me if something happens"). Never enable during normal conversation — notification fatigue is the worst UX failure.\n' +
  '\n' +
  'channel: the subscription platform, e.g. "wechat:&lt;accountId&gt;" / "telegram:&lt;botId&gt;".\n' +
  'peer: the recipient id within the channel (WeChat userId / group id / email address, etc.).\n' +
  'Optional quietStartHour / quietEndHour: quiet hours (0-23 integer, half-open interval [start, end)), ' +
  'midnight-crossing supported (e.g. 22 → 7 means silent from 22:00 to 06:59 next day).\n' +
  'Idempotent: subscribing the same (channel, peer) again will update the config rather than create a new entry.';

export const subscribePushTool: Omit<PushTool, 'execute'> = {
  name: 'subscribePush',
  description: SUBSCRIBE_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Push platform channel name, e.g. "wechat:abc123"',
      },
      peer: {
        type: 'string',
        description: 'Recipient id within the channel',
      },
      quietStartHour: {
        type: 'integer',
        description: 'Quiet hours start (0-23). Optional.',
        minimum: 0,
        maximum: 23,
      },
      quietEndHour: {
        type: 'integer',
        description: 'Quiet hours end (0-23). Must be provided together with quietStartHour.',
        minimum: 0,
        maximum: 23,
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone, e.g. "Asia/Shanghai". Defaults to UTC if not provided.',
      },
      digestMinIntervalMs: {
        type: 'integer',
        description: 'Minimum interval between digest pushes (ms), default 4h (14_400_000)',
      },
      urgentMinIntervalMs: {
        type: 'integer',
        description: 'Minimum interval between urgent pushes (ms), default 1h (3_600_000)',
      },
    },
    required: ['channel', 'peer'],
  },
  capability: 'write',
  domain: 'self',
};

export const unsubscribePushTool: Omit<PushTool, 'execute'> = {
  name: 'unsubscribePush',
  description:
    'Cancel the proactive push subscription for a specified (channel, peer). Soft-delete — enabled=0 but record is kept for history lookup.\n' +
    'Call when the user says "stop notifying me / unsubscribe / turn off reminders".',
  schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Push platform channel name' },
      peer: { type: 'string', description: 'Recipient id within the channel' },
    },
    required: ['channel', 'peer'],
  },
  capability: 'write',
  domain: 'self',
};

/**
 * Factory: binds PushSubscriptionStore to produce executable tools. chat-handler feeds them in
 * via extraInternalTools when registering the toolset (because domain='self').
 */
export function createPushTools(store: PushSubscriptionStore): PushTool[] {
  return [
    {
      ...subscribePushTool,
      async execute(params) {
        const p = params as {
          channel?: string;
          peer?: string;
          quietStartHour?: number;
          quietEndHour?: number;
          timezone?: string;
          digestMinIntervalMs?: number;
          urgentMinIntervalMs?: number;
        };
        if (typeof p.channel !== 'string' || !p.channel.trim()) {
          return { success: false, output: '', error: 'channel must be a non-empty string' };
        }
        if (typeof p.peer !== 'string' || !p.peer.trim()) {
          return { success: false, output: '', error: 'peer must be a non-empty string' };
        }
        try {
          const sub = store.subscribe({
            channel: p.channel,
            peer: p.peer,
            quietStartHour: p.quietStartHour,
            quietEndHour: p.quietEndHour,
            timezone: p.timezone,
            digestMinIntervalMs: p.digestMinIntervalMs,
            urgentMinIntervalMs: p.urgentMinIntervalMs,
          });
          return {
            success: true,
            output:
              `Subscribed to ${sub.channel} / ${sub.peer}. Digest interval ${Math.round(sub.digestMinIntervalMs / 60_000)}min,` +
              ` urgent interval ${Math.round(sub.urgentMinIntervalMs / 60_000)}min` +
              (sub.quietStartHour !== null
                ? `, quiet hours ${sub.quietStartHour}-${sub.quietEndHour}${sub.timezone ? ` (${sub.timezone})` : ' (UTC)'}`
                : ''),
          };
        } catch (e) {
          return { success: false, output: '', error: `subscribePush failed: ${String(e)}` };
        }
      },
    },
    {
      ...unsubscribePushTool,
      async execute(params) {
        const p = params as { channel?: string; peer?: string };
        if (typeof p.channel !== 'string' || !p.channel.trim()) {
          return { success: false, output: '', error: 'channel must be a non-empty string' };
        }
        if (typeof p.peer !== 'string' || !p.peer.trim()) {
          return { success: false, output: '', error: 'peer must be a non-empty string' };
        }
        const ok = store.unsubscribe(p.channel, p.peer);
        if (!ok) {
          return {
            success: false,
            output: '',
            error: `No subscription found for ${p.channel} / ${p.peer} (may have already been unsubscribed)`,
          };
        }
        return { success: true, output: `Unsubscribed from ${p.channel} / ${p.peer}` };
      },
    },
  ];
}
