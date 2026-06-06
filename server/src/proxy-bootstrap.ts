/**
 * Global outbound proxy (2026-06) — must be imported after load-env and before any HTTP client
 * is constructed.
 *
 * Background: previously only the Telegram channel supported a proxy (by explicitly passing a
 * dispatcher to fetch). The Anthropic primary model / aux model / webFetch / webSearch /
 * downloadFile / WeChat all used Node's global fetch (backed by undici) without reading any
 * proxy configuration — in restricted networks, those requests would fail because they connect
 * directly.
 *
 * Solution: call `undici.setGlobalDispatcher(new ProxyAgent(url))` early in process startup.
 * Node 20's global fetch uses `getGlobalDispatcher()`, so this intercepts **all** fetch-based
 * outbound paths listed above. Telegram can still override with TELEGRAM_PROXY by passing its
 * own dispatcher (higher priority).
 *
 * Proxy URL source (priority order):
 *   PHILONT_PROXY > HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy > ALL_PROXY > all_proxy
 *
 * Known limitation: undici ProxyAgent does not support NO_PROXY allowlisting — once the global
 * proxy is set, domestic-direct LLM gateways (e.g. DeepSeek) also go through the proxy.
 * Users who need "direct for domestic + proxy only for blocked foreign sites" should temporarily
 * use a direct-connect aux model + proxied primary model, or set only TELEGRAM_PROXY.
 * NO_PROXY routing is deferred (requires a custom host-selective dispatcher).
 */
export {}; // top-level await requires this file to be an ES module (otherwise TS1375)

function pickProxyUrl(): string | undefined {
  return (
    process.env.PHILONT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    undefined
  );
}

const maskProxy = (u: string): string => u.replace(/\/\/[^/@]*@/, '//***@');

const proxyUrl = pickProxyUrl();
if (proxyUrl) {
  // Dynamic import (variable specifier to prevent TS from statically resolving 'undici';
  // provided by the server's runtime dependency).
  // Top-level await: ensures the dispatcher is set before subsequent imports construct HTTP clients.
  try {
    const spec = 'undici';
    const undici = (await import(spec)) as {
      setGlobalDispatcher: (d: unknown) => void;
      ProxyAgent: new (u: string) => unknown;
    };
    undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
    console.log(`[proxy] Global outbound proxy enabled: ${maskProxy(proxyUrl)} (overrides all fetch requests)`);
  } catch (e) {
    console.warn(
      `[proxy] Detected proxy config ${maskProxy(proxyUrl)} but failed to enable it (undici missing?):`,
      (e as { message?: string })?.message ?? e,
    );
  }
} else {
  // No log when no proxy (the normal case) — avoids noise.
}
