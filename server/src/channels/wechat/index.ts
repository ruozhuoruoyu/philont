/**
 * WeChat channel server mount entry point
 *
 * Responsibilities:
 *   - On startup: load credentials → start ILinkClient + OutboundQueue + ILinkGateway
 *   - Bridge: gateway receives inbound text → build stable sessionId → call handleChatSend
 *   - Outbound: onDelta buffers all chunks; on final flush, calls OutboundQueue.sendText
 *     (WeChat does not support streaming; 0.3s rate-limit + 4000-char chunking handled by OutboundQueue)
 *   - Auth: onAuthRequest → forward the "🔐 …" message directly to WeChat. pendingAuth is
 *     maintained by chat-handler per sessionId; user's next "agree/yes" is recognised as a reply
 *
 * sessionId convention:
 *   `wechat:<accountId>:<userId>` (DM)
 *   `wechat:<accountId>:group:<groupId>:<userId>` (group)
 *
 * Enable:
 *   WECHAT_ENABLED=1 npm run dev
 *   (optionally set WECHAT_ACCOUNT_ID; otherwise resolveDefaultAccountId is used)
 */

import {
  readCredentials,
  resolveDefaultAccountId,
  type WeChatCredentials,
} from './state.js';
import { ILinkClient } from './client.js';
import {
  ILinkGateway,
  type InboundEvent,
  type GatewayLogger,
} from './gateway.js';
import {
  OutboundQueue,
  type RawSender,
} from './outbound.js';
import {
  policyFromEnv,
  type PolicyConfig,
} from './policy.js';
import {
  registerMediaChannel,
  unregisterMediaChannel,
} from '../registry.js';
import { createWeChatMediaChannel } from './media_channel.js';
import {
  registerPushChannel,
  unregisterPushChannel,
  type PushChannel,
} from '../../push/channel.js';
import { recordAttachment } from '../recent_attachments.js';
import { extractUserSection, recordFilterCall } from '../../output_section_filter.js';
import { runConscienceGate } from '../../conscience_gate.js';
import { renderForWeChat, renderAuthPromptForWeChat } from './wechat_render.js';

/** AuthRequest structure from chat-handler (provided by handleChatSend) */
export type AuthRequestPayload = {
  toolName: string;
  capability: string;
  domain: string;
  input: unknown;
  clarification?: string;
};

/** Injected handleChatSend from chat-handler; avoids hard-dependency import cycles */
export type ChatSendFn = (
  sessionId: string,
  userMessage: string,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequestPayload) => void,
  onStatus?: (text: string) => void,
  /**
   * 2026-05-19 three-stream separation: Tier 3/4 detail event callback (optional).
   * WeChat does **not** pass this — it naturally filters out tool details / internal markers.
   * Only web-ui consumes it.
   */
  onTrace?: (ev: unknown) => void,
) => Promise<unknown>;

export interface MountOptions {
  /** Required: server's own handleChatSend (import { handleChatSend } then pass here) */
  chatSend: ChatSendFn;
  /** Explicit accountId; if not provided, resolveDefaultAccountId is used */
  accountId?: string;
  /** Explicit policy; if not provided, policyFromEnv is used */
  policy?: PolicyConfig;
  logger?: GatewayLogger;
}

/**
 * Start the WeChat gateway. Returns the ILinkGateway instance; caller can call stop() to shut down.
 *
 * Non-blocking: `await startWeChatGateway` returns immediately.
 * The gateway starts its loop in the background via setImmediate; the server main flow continues.
 */
export async function startWeChatGateway(opts: MountOptions): Promise<ILinkGateway> {
  const accountId = opts.accountId ?? resolveDefaultAccountId();
  if (!accountId) {
    throw new Error(
      'wechat: 没找到可用 accountId。请先跑 `npm run wechat:login` 扫码登录,' +
        '或显式设置 WECHAT_ACCOUNT_ID。',
    );
  }

  const creds = readCredentials(accountId);
  if (!creds) {
    throw new Error(`wechat: accountId=${accountId} 凭证不存在(应在 ~/.philont/wechat/accounts/${accountId}/credentials.json)`);
  }

  const policy = opts.policy ?? policyFromEnv();
  const logger = opts.logger ?? defaultLogger();

  const client = new ILinkClient({ baseUrl: creds.baseUrl, token: creds.token });
  // Outbound RawSender: bridges OutboundQueue's (to, text) calls to client.sendText
  //
  // **Hard timeout 25s**: even though client.sendText has a 30s internal default, an extra
  // Promise.race layer guards against cases where the underlying transport (undici connection
  // pool contention / iLink server long enqueue) bypasses the inner timer. A sendmessage hang
  // of 5+ minutes requiring ctrl+C to unblock was observed; this is the safety net.
  // **Log visibility**: log before and after sending so that even if it hangs, the log shows
  // exactly which step it is stuck at.
  const SEND_HARD_TIMEOUT_MS = 25_000;
  const rawSender: RawSender = async (to, text) => {
    const startedAt = Date.now();
    logger.info('outbound sender starting', { to, len: text.length });
    try {
      const r = await Promise.race([
        client.sendText(to, text),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`outbound hard timeout after ${SEND_HARD_TIMEOUT_MS}ms`)),
            SEND_HARD_TIMEOUT_MS,
          ),
        ),
      ]);
      const dur = Date.now() - startedAt;
      if (r.ret === 0) {
        logger.info('outbound sender ok', { to, durationMs: dur, messageId: r.message_id });
        return { ok: true, messageId: r.message_id };
      }
      // -14 token expired: not handled here; the gateway's long-poll will also catch it
      logger.warn(`sendText ret=${r.ret} errmsg=${r.errmsg ?? ''}`, { to, durationMs: dur });
      return { ok: false };
    } catch (e) {
      const dur = Date.now() - startedAt;
      logger.error(`sendText threw: ${String(e)}`, { to, durationMs: dur });
      return { ok: false };
    }
  };
  const outbound = new OutboundQueue(rawSender);

  const dispatch = makeDispatcher({
    accountId: creds.accountId,
    chatSend: opts.chatSend,
    outbound,
    logger,
  });

  const gw = new ILinkGateway({
    credentials: creds,
    client,
    policy,
    logger,
    dispatch,
    // Cross-channel "recently uploaded" tracking: record each successfully saved inbound
    // attachment to the singleton immediately. chat-handler reads it at the top of the
    // next-turn prefix so the LLM does not need to glob the disk for files.
    onAttachment: (att) => {
      recordAttachment({
        channel: `wechat:${creds.accountId}`,
        kind: att.kind,
        filename: att.filename,
        path: att.path,
        fromUser: att.fromUser,
        ts: Date.now(),
      });
    },
  });

  // Register with the cross-channel media registry — from this point on, any replyWithMedia
  // tool call whose sessionId starts with `wechat:<accountId>:` will be routed here.
  // In multi-account scenarios, each account registers its own instance (channelName includes accountId).
  const mediaChannel = createWeChatMediaChannel({ accountId, client });
  registerMediaChannel(mediaChannel);
  logger.info('wechat media channel registered', { name: mediaChannel.name });

  // 2026-05-06 phase C: wrap OutboundQueue.sendText as a PushChannel and register it.
  // PushDispatcher uses the channel name (`wechat:<accountId>`) to find this instance
  // during fan-out pushes and calls pushText(peer, text). peer = wechat userId (DM) or
  // `group:<groupId>` (group).
  const pushChannelName = `wechat:${creds.accountId}`;
  const pushChannel: PushChannel = {
    name: pushChannelName,
    isReady: () => true, // gateway is running, client is set up
    async pushText(peer, text) {
      try {
        const r = await outbound.sendText(peer, text);
        return {
          ok: r.chunksSent > 0,
          messageIds: r.messageIds,
          ...(r.chunksSent === 0 ? { error: 'all chunks deduped or failed' } : {}),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
  registerPushChannel(pushChannel);
  logger.info('wechat push channel registered', { name: pushChannelName });

  // Start loop in background; does not block server startup
  void gw.start().catch((e) => {
    logger.error(`gateway crashed: ${String(e)}`, { accountId });
  });

  // Graceful shutdown: bind once to SIGINT/SIGTERM to call stop() and deregister channels
  const stopOnSignal = () => {
    unregisterMediaChannel(mediaChannel);
    unregisterPushChannel(pushChannelName);
    void gw.stop();
  };
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);

  logger.info(`wechat gateway scheduled`, {
    accountId,
    baseUrl: creds.baseUrl,
    policy: { dm: policy.dmPolicy, group: policy.groupPolicy },
  });

  return gw;
}

/** Build InboundDispatcher: inbound → handleChatSend → buffer → outbound */
function makeDispatcher(opts: {
  accountId: string;
  chatSend: ChatSendFn;
  outbound: OutboundQueue;
  logger: GatewayLogger;
}): (e: InboundEvent) => Promise<void> {
  const { accountId, chatSend, outbound, logger } = opts;

  return async (event: InboundEvent) => {
    if (!event.text) {
      logger.info('inbound has no text content (媒体?), 跳过', {
        from: event.fromUserId,
      });
      return;
    }

    // Stable sessionId: same user across multiple turns reuses the same sessionId so that
    // chat-handler's pendingAuth (yes/no follow-up) can work across inbound events.
    const sessionId = makeSessionId(accountId, event);
    const replyTo = event.groupId || event.fromUserId;

    const buffer: string[] = [];
    const onDelta = (chunk: string) => {
      if (chunk) buffer.push(chunk);
    };

    // 2026-05-19: onAuthRequest deferred-send strategy.
    // Previous behaviour: onAuthRequest fires → outbound.sendText immediately → user sees the
    // auth request, then immediately after sees the LLM's partial text (turn-end fullText flush).
    // Two separate messages made it unclear whether the bot was "talking to itself" or
    // "asking for auth".
    //
    // New behaviour: auth request is **cached as pendingAuthPrompt**; dispatcher flushes in
    // a fixed order at the end:
    //   1. Send fullText first (LLM reasoning, as context/preamble)
    //   2. Send pendingAuthPrompt last (auth request as the visually final message, prominent and not buried)
    let pendingAuthPrompt: string | null = null;
    const onAuthRequest = (req: AuthRequestPayload) => {
      pendingAuthPrompt = renderAuthPromptForWeChat(req);
    };

    // 2026-05-07 #5: intermediate status push (reduce "waiting anxiety" caused by WeChat's lack of streaming)
    // Throttle: same text within 30s in the same turn is not re-sent; any status push must be
    // at least 4s apart. OutboundQueue already handles chunk-level dedup + 0.3s rate-limit;
    // this adds a semantic throttle layer to prevent the LLM calling webSearch 5 times rapidly
    // and flooding the user.
    const STATUS_MIN_INTERVAL_MS = 4_000;
    const STATUS_DEDUP_WINDOW_MS = 30_000;
    const recentStatus = new Map<string, number>(); // text → last send timestamp
    let lastStatusAt = 0;
    const onStatus = (text: string) => {
      if (!text || text.trim().length === 0) return;
      const now = Date.now();
      // Global throttle (prevent burst)
      if (now - lastStatusAt < STATUS_MIN_INTERVAL_MS) return;
      // Per-text throttle (prevent same tool name flooding)
      const lastSeen = recentStatus.get(text);
      if (lastSeen !== undefined && now - lastSeen < STATUS_DEDUP_WINDOW_MS) return;
      lastStatusAt = now;
      recentStatus.set(text, now);
      void outbound.sendText(replyTo, text).catch((e) => {
        logger.error(`onStatus relay failed: ${String(e)}`, { replyTo, text });
      });
    };

    try {
      await chatSend(sessionId, event.text, onDelta, onAuthRequest, onStatus);
    } catch (e) {
      logger.error(`chatSend threw: ${String(e)}`, { sessionId, from: event.fromUserId });
      // Send a fallback to the user to avoid a completely silent failure
      void outbound.sendText(
        replyTo,
        `抱歉,刚才出错了:${truncate(String((e as any)?.message ?? e), 200)}`,
      );
      return;
    }

    const fullText = buffer.join('').trim();

    // ── flush order (2026-05-19) ───────────────────────────────────────
    // 1. Send LLM reasoning first (filtered through `## For User` + WeChat markdown conversion)
    // 2. Send pendingAuthPrompt last (auth request as final visual item, prominent, not buried)
    //
    // fullText empty + no pending auth = chat-handler was a pure tool-call turn; send nothing
    // fullText empty + has pending auth = send auth request directly (no reasoning prefix)
    if (fullText.length > 0) {
      // Two-stage filter: LLM system prompt contracts output as `## For User` + `## Work Log`;
      // WeChat only forwards the former. If the LLM violates the contract, fallback takes
      // the last non-empty paragraph (fallback hit rate goes to metric; persistently high
      // means the prompt contract has weakened or been crowded out by drives/honesty reminders).
      const filtered = extractUserSection(fullText);
      recordFilterCall(filtered.usedSection);
      let sectioned = filtered.text || fullText; // if filter also empty → fall back to raw
      if (!filtered.usedSection) {
        logger.info('output_filter fallback (no `## 给用户` section)', {
          sessionId,
          fullLen: fullText.length,
          fallbackLen: sectioned.length,
        });
      }

      // Conscience gate (L3 send-to-human exit; no-op unless PHILONT_CONSCIENCE_GATE is on, fail-open).
      const verdict = await runConscienceGate(sectioned);
      if (!verdict.allow) {
        logger.info('conscience_gate withheld outbound', { sessionId, reason: verdict.reason });
        sectioned = '(本条回复被安全审查拦下,未发送。)';
      }

      // WeChat markdown conversion: table → bullet, strip **bold** / ### h, inline `code` → 「code」
      const rendered = renderForWeChat(sectioned).trim();

      if (rendered.length > 0) {
        try {
          const r = await outbound.sendText(replyTo, rendered);
          logger.info('outbound sent', {
            replyTo,
            chunks: r.chunksSent,
            deduped: r.chunksDeduped,
            sectionHit: filtered.usedSection,
          });
        } catch (e) {
          logger.error(`outbound.sendText failed: ${String(e)}`, { replyTo });
        }
      }
    } else {
      logger.info('chatSend produced no text', { sessionId, hasAuthPrompt: !!pendingAuthPrompt });
    }

    // Last: send auth request (always the final message — prominent and not buried by later messages)
    if (pendingAuthPrompt) {
      try {
        await outbound.sendText(replyTo, pendingAuthPrompt);
      } catch (e) {
        logger.error(`auth prompt sendText failed: ${String(e)}`, { replyTo });
      }
    }
  };
}

function makeSessionId(accountId: string, e: InboundEvent): string {
  if (e.groupId) {
    return `wechat:${accountId}:group:${e.groupId}:${e.fromUserId}`;
  }
  return `wechat:${accountId}:${e.fromUserId}`;
}

function truncate(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

function defaultLogger(): GatewayLogger {
  return {
    info: (m, meta) => console.log(`[wechat] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[wechat] ${m}`, meta ?? ''),
    error: (m, meta) => console.error(`[wechat] ${m}`, meta ?? ''),
  };
}
