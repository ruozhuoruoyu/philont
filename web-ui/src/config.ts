/**
 * 运行时地址解析 —— web-ui 同时要连两个后端:
 *   · launcher 控制面(配置 / 启停 / 状态):打包形态下 serve 本页面的就是它(同源);
 *     vite dev(5173)下它在 20267。
 *   · agent server(chat WS + memory/autonomous API):端口默认 20266,可被 PHILONT_PORT
 *     改;真实端口从 launcher 的 /status 拿。
 *
 * 用 location.hostname 而非 'localhost' —— 这样从局域网另一台设备(手机)打开也能连对
 * 后端(浏览器 + 小 launcher 形态白赚的局域网访问)。
 */
const loc = typeof location !== 'undefined' ? location : ({ hostname: 'localhost', port: '', protocol: 'http:', host: 'localhost' } as Location);
const host = loc.hostname || 'localhost';

// vite dev server 跑在 5173,此时 launcher 是独立的 20267;否则(launcher 自己 serve)同源。
const isViteDev = loc.port === '5173';
export const LAUNCHER_BASE = isViteDev ? `http://${host}:20267` : `${loc.protocol}//${loc.host}`;

let agentPort = 20266;
let portPromise: Promise<number> | null = null;

/** 从 launcher 拿 agent 真实端口(默认 20266)。缓存;launcher 连不上则退回默认。 */
export async function resolveAgentPort(): Promise<number> {
  if (!portPromise) {
    portPromise = (async () => {
      try {
        const r = await fetch(`${LAUNCHER_BASE}/api/launcher/status`, { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          if (Number.isInteger(j?.port) && j.port > 0) agentPort = j.port;
        }
      } catch {
        /* launcher 不可达(如不经 launcher 直跑 agent)→ 用默认 20266 */
      }
      return agentPort;
    })();
  }
  return portPromise;
}

export function agentHttpBase(): string {
  return `http://${host}:${agentPort}`;
}
export function agentWsBase(): string {
  return `ws://${host}:${agentPort}`;
}
