/**
 * PushChannel registry — abstraction for active push channels.
 *
 * Parallel design to channels/registry.ts MediaChannel: that one handles passive reply
 * media; this one handles active push text. Both follow the "one-line register" pattern.
 *
 * Known channel implementations:
 *   - server/channels/wechat/index.ts: wraps OutboundQueue.sendText as a PushChannel at startup
 *
 * Future: Telegram / DingTalk / Slack can each register their own OutboundQueue equivalent.
 *
 * Channel name convention:
 *   - Single account: 'wechat:<accountId>' (same prefix as MediaChannel)
 *   - Multi-account: 'wechat:<accountA>' / 'wechat:<accountB>' each register separately
 *   - Email: 'email' (if implemented)
 *
 * Peer is managed by the caller (dispatcher / tool); the channel does not interpret it.
 * Peer examples:
 *   - WeChat DM: userId string
 *   - WeChat group: `group:${groupId}` or similar
 */

export interface PushChannel {
  /** Channel name, used as the PushSubscription.channel field; re-registering the same name overwrites. */
  name: string;

  /** Whether the channel is ready (underlying client is up / credentials are valid). Dispatcher checks before pushing. */
  isReady(): boolean;

  /**
   * Push text to peer. The channel implementation should handle internally:
   *   - Chunking (if text exceeds limit)
   *   - Its own rate-limiting (e.g. WeChat 0.3s per message)
   *   - Failure retries (if necessary)
   *
   * Dispatcher does not repeat these. Dispatcher only handles: subscription check /
   * frequency / quiet hours / deduplication.
   *
   * Implementations should not throw — report failures via ok=false + error string.
   */
  pushText(peer: string, text: string): Promise<PushTextResult>;
}

export interface PushTextResult {
  ok: boolean;
  /** A single push may be split into multiple chunks; record a messageId per chunk */
  messageIds?: string[];
  error?: string;
}

const channels = new Map<string, PushChannel>();

/** Called once when a channel starts. Re-registering the same name overwrites (supports hot token replacement etc.). */
export function registerPushChannel(c: PushChannel): void {
  channels.set(c.name, c);
}

/** Called when a channel stops, to prevent pushing to a shut-down client. */
export function unregisterPushChannel(name: string): void {
  channels.delete(name);
}

/** Exact lookup by name */
export function findPushChannel(name: string): PushChannel | null {
  return channels.get(name) ?? null;
}

/** List all registered channel names (for testing / diagnostics / dispatcher fan-out) */
export function listRegisteredPushChannels(): string[] {
  return Array.from(channels.keys()).sort();
}

/** For testing: clear the registry to prevent cross-test pollution */
export function _resetPushChannelsForTest(): void {
  channels.clear();
}
