/**
 * Cross-channel media channel registry.
 *
 * **One line of registration per channel**. Any channel that supports sending media
 * (WeChat / Telegram / Slack / DingTalk, etc.) calls `registerMediaChannel({...})`
 * at its own startup entry point. The `replyWithMedia` tool matches a channel via
 * the sessionId and calls its `send()`.
 *
 * Design discipline:
 *   - Registration order is match order; the first channel whose `matches(sid)` returns
 *     true handles the request.
 *   - Each channel is responsible for its own sessionId pattern (e.g. wechat uses the
 *     prefix `wechat:`), avoiding a router table maintained by the registry.
 *   - A web-UI session does not belong to any channel; its sessionId looks like
 *     `pllmccvhn97` (random), no channel's matches will hit, and the tool will return
 *     a clear "this session does not support sending media" error.
 *   - A single channel may register multiple instances (e.g. multiple WeChat accounts),
 *     each matching its own `wechat:<account_a>:` / `wechat:<account_b>:` prefix.
 */

/** Media type, universal across channels. */
export type MediaKind = 'image' | 'file' | 'voice' | 'video';

export interface SendMediaArgs {
  kind: MediaKind;
  /** Local absolute path to the file. */
  path: string;
  /** Filename (optional; typically required for `kind=file`, used as display name on the receiving end). */
  fileName?: string;
}

export interface SendMediaResult {
  /** Channel-defined message id; undefined on failure. */
  messageId?: string;
}

/** Contract for a single channel instance. */
export interface MediaChannel {
  /** Name (used in audit / error messages), e.g. 'wechat:<accountId>'. */
  name: string;
  /** SessionId pattern matching: a hit means this channel handles the request. */
  matches(sessionId: string): boolean;
  /** Send media to the peer corresponding to this sessionId. */
  send(sessionId: string, args: SendMediaArgs): Promise<SendMediaResult>;
}

const channels: MediaChannel[] = [];

/** Called once when the channel starts up. */
export function registerMediaChannel(channel: MediaChannel): void {
  channels.push(channel);
}

/** Deregister (call when the channel stops, to prevent using an already-shut-down client). */
export function unregisterMediaChannel(channel: MediaChannel): void {
  const idx = channels.indexOf(channel);
  if (idx >= 0) channels.splice(idx, 1);
}

/** Find the first channel that matches the current sessionId; returns null if none. */
export function findMediaChannel(sessionId: string): MediaChannel | null {
  for (const c of channels) {
    if (c.matches(sessionId)) return c;
  }
  return null;
}

/** For testing / diagnostics: list the names of currently registered channels. */
export function listRegisteredMediaChannels(): string[] {
  return channels.map((c) => c.name);
}

/** For testing: clear the registry (prevents cross-test pollution). */
export function _resetMediaChannelsForTest(): void {
  channels.length = 0;
}
