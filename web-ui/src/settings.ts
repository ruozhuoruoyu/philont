/**
 * 设置视图 + 首次运行向导。
 *
 * 走 launcher 控制面(LAUNCHER_BASE):
 *   GET /api/launcher/config   读现有配置(密钥已掩码)
 *   PUT /api/launcher/config   保存(回传掩码值不覆盖真实密钥)
 *   GET /api/launcher/status   agent 运行态
 *   POST /api/launcher/{start,restart,stop}
 *
 * 两种用法:
 *   · 普通设置(wizard=false):全字段按功能区分组,各组可折叠,「保存并重启」。
 *   · 首次向导(wizard=true):未配置时由 app 强制进入,只露「启动配置」核心字段,「保存并启动」。
 * 保存成功且 agent 起来后派发 `configured` 事件,app 据此切回聊天。
 *
 * 字段按**功能区**组织:
 *   启动配置(选供应商→填它的 Key/模型/端点,配完即可启动)/ 网络与时区 / 通用 /
 *   能力开关 / 联网搜索 / 辅助小模型 / 视觉模型 / 通道 / 高级。
 * 启动区不写死某一家:先选 LLM_PROVIDER,再按所选只显示对应字段。
 *
 * 文案中英双语:label/help/options/group 都是 Msg,渲染期用 tr()/t() 按当前语言取词。
 */
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LAUNCHER_BASE } from './config.js';
import { LangController, t, tr, type Msg } from './i18n.js';

type FieldType = 'text' | 'secret' | 'bool' | 'select' | 'number';
type Values = Record<string, string>;
interface Field {
  key: string;
  label: Msg;
  type: FieldType;
  group: string;                        // 稳定 id(中文),显示走 GROUP_LABELS
  placeholder?: Msg | string;           // URL 等中性占位用 string;需双语的用 Msg
  help?: Msg;
  options?: { value: string; label: Msg }[];
  defaultOn?: boolean;                  // bool 字段:配置缺省时视为开
  core?: boolean;                       // 标记「启动必填」项(仅作文档,不再用于过滤)
  showIf?: (v: Values) => boolean;      // 条件显隐(如按 provider / 通道开关)
}

const POLICY_OPTS = [
  { value: 'open', label: { zh: 'open(任何人)', en: 'open (anyone)' } },
  { value: 'allowlist', label: { zh: 'allowlist(白名单)', en: 'allowlist' } },
  { value: 'disabled', label: { zh: 'disabled(禁用)', en: 'disabled' } },
];

/** 当前主模型供应商(留空回退 anthropic)。 */
const prov = (v: Values): string => (v.LLM_PROVIDER || '').toLowerCase() || 'anthropic';
/** 某 bool env 是否为开。 */
const boolOn = (v: Values, key: string): boolean => {
  const x = v[key];
  return x === '1' || (x || '').toLowerCase() === 'true';
};

// 功能区 id → 显示名(双语)。
const GROUP_LABELS: Record<string, Msg> = {
  启动配置: { zh: '启动配置', en: 'Startup' },
  网络与时区: { zh: '网络与时区', en: 'Network & Timezone' },
  通用: { zh: '通用', en: 'General' },
  能力开关: { zh: '能力开关', en: 'Capabilities' },
  联网搜索: { zh: '联网搜索', en: 'Web Search' },
  辅助小模型: { zh: '辅助小模型', en: 'Auxiliary Model' },
  '视觉模型 · 多模态': { zh: '视觉模型 · 多模态', en: 'Vision Model' },
  通道: { zh: '通道', en: 'Channels' },
  高级: { zh: '高级', en: 'Advanced' },
  系统: { zh: '系统', en: 'System' },
};

// 精选「用户该填」字段,按功能区分组。代码里读的 env 有 100+,绝大多数是内部调参不暴露。
const FIELDS: Field[] = [
  // ══ 启动配置:选供应商 + 填它的 Key/模型/端点,配完即可启动 ══
  { key: 'LLM_PROVIDER', label: { zh: '模型供应商', en: 'Model Provider' }, type: 'select', group: '启动配置', core: true,
    options: [
      { value: 'anthropic', label: { zh: 'Anthropic(Claude / DeepSeek anthropic 端点)', en: 'Anthropic (Claude / DeepSeek anthropic endpoint)' } },
      { value: 'openai', label: { zh: 'OpenAI 兼容(DeepSeek / 自建 / 任意兼容端点)', en: 'OpenAI-compatible (DeepSeek / self-hosted / any)' } },
      { value: 'glm', label: { zh: '智谱 GLM', en: 'Zhipu GLM' } },
      { value: 'kimi', label: { zh: 'Kimi(Moonshot)', en: 'Kimi (Moonshot)' } },
      { value: 'minimax', label: { zh: 'MiniMax', en: 'MiniMax' } },
      { value: 'gemini', label: { zh: 'Gemini(Google)', en: 'Gemini (Google)' } },
    ],
    help: { zh: '先选主模型供应商,下面只显示它需要填的项。留空 = Anthropic。', en: 'Pick the main model provider; only its fields show below. Empty = Anthropic.' } },

  // — Anthropic —
  { key: 'ANTHROPIC_API_KEY', label: { zh: 'API Key', en: 'API Key' }, type: 'secret', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'anthropic', help: { zh: '主模型 API Key(Anthropic 协议:Claude 或 DeepSeek anthropic 端点)。', en: 'Main model API key (Anthropic protocol: Claude or DeepSeek anthropic endpoint).' } },
  { key: 'ANTHROPIC_BASE_URL', label: { zh: 'Base URL', en: 'Base URL' }, type: 'text', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'anthropic', placeholder: 'https://api.anthropic.com',
    help: { zh: '默认官方端点。用第三方/自建网关(openrouter、neolink…)时填。', en: 'Defaults to official endpoint. Set for third-party / self-hosted gateways.' } },
  { key: 'ANTHROPIC_MODEL', label: { zh: '模型', en: 'Model' }, type: 'text', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'anthropic', placeholder: 'deepseek-v4-flash', help: { zh: '默认 deepseek-v4-flash。', en: 'Defaults to deepseek-v4-flash.' } },

  // — OpenAI 兼容 —
  { key: 'OPENAI_BASE_URL', label: { zh: 'Base URL', en: 'Base URL' }, type: 'text', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'openai', placeholder: 'https://api.deepseek.com',
    help: { zh: '任意 OpenAI 兼容端点:DeepSeek / 自建 vLLM 等。', en: 'Any OpenAI-compatible endpoint: DeepSeek / self-hosted vLLM, etc.' } },
  { key: 'OPENAI_API_KEY', label: { zh: 'API Key', en: 'API Key' }, type: 'secret', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'openai' },
  { key: 'OPENAI_MODEL', label: { zh: '模型', en: 'Model' }, type: 'text', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'openai', placeholder: 'deepseek-chat' },

  // — 智谱 GLM(端点内置)—
  { key: 'GLM_API_KEY', label: { zh: 'GLM API Key', en: 'GLM API Key' }, type: 'secret', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'glm', help: { zh: '智谱开放平台 open.bigmodel.cn,端点内置无需填。', en: 'Zhipu open.bigmodel.cn; endpoint built-in.' } },
  { key: 'GLM_MODEL', label: { zh: '模型', en: 'Model' }, type: 'text', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'glm', placeholder: 'glm-4-plus' },

  // — Kimi / Moonshot(端点内置)—
  { key: 'KIMI_API_KEY', label: { zh: 'Kimi API Key', en: 'Kimi API Key' }, type: 'secret', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'kimi', help: { zh: 'Moonshot platform.moonshot.cn,端点内置无需填。', en: 'Moonshot platform.moonshot.cn; endpoint built-in.' } },
  { key: 'KIMI_MODEL', label: { zh: '模型', en: 'Model' }, type: 'text', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'kimi', placeholder: 'kimi-k2-0905-preview' },

  // — MiniMax(端点内置)—
  { key: 'MINIMAX_API_KEY', label: { zh: 'MiniMax API Key', en: 'MiniMax API Key' }, type: 'secret', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'minimax' },
  { key: 'MINIMAX_MODEL', label: { zh: '模型', en: 'Model' }, type: 'text', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'minimax', placeholder: 'MiniMax-Text-01' },

  // — Gemini(Google OpenAI 兼容端点内置)—
  { key: 'GEMINI_API_KEY', label: { zh: 'Gemini API Key', en: 'Gemini API Key' }, type: 'secret', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'gemini', help: { zh: 'Google AI Studio,走 OpenAI 兼容端点。', en: 'Google AI Studio, via OpenAI-compatible endpoint.' } },
  { key: 'GEMINI_MODEL', label: { zh: '模型', en: 'Model' }, type: 'text', group: '启动配置', core: true,
    showIf: (v) => prov(v) === 'gemini', placeholder: 'gemini-2.0-flash' },

  // ══ 网络与时区 ══
  // 全局代理由组件特判渲染(开关 + 地址输入),这里只为进分组/收集。
  { key: 'PHILONT_PROXY', label: { zh: '全局代理', en: 'Global Proxy' }, type: 'text', group: '网络与时区',
    placeholder: 'http://127.0.0.1:7890',
    help: { zh: '开启后所有出网(模型 / 搜索 / 抓取 / 通道)都走它。无 NO_PROXY 白名单,国内网关也会走代理。', en: 'When on, ALL outbound traffic (model / search / fetch / channels) routes through it. No NO_PROXY allowlist.' } },
  { key: 'AGENT_TIMEZONE', label: { zh: '时区', en: 'Timezone' }, type: 'text', group: '网络与时区', placeholder: 'Asia/Shanghai',
    help: { zh: '日历 / 定时任务用,IANA 时区名。默认跟随系统。', en: 'For calendar / scheduling. IANA name. Defaults to system.' } },

  // ══ 通用 ══
  { key: 'PHILONT_DOWNLOAD_DIR', label: { zh: '下载目录', en: 'Download Dir' }, type: 'text', group: '通用',
    placeholder: { zh: '留空 = 默认', en: 'empty = default' },
    help: { zh: '抓取 / 下载文件的落地目录。留空用默认:用户主目录下的 .philont/downloads(Windows 为 C:\\Users\\你\\.philont\\downloads)。自定义须填绝对路径,不支持 ~ 缩写。', en: 'Where fetched / downloaded files land. Empty = default: .philont/downloads under your home (Windows: C:\\Users\\you\\.philont\\downloads). To override, use an absolute path; ~ is NOT expanded.' } },
  { key: 'MEMORY_DB_PATH', label: { zh: '记忆数据库', en: 'Memory DB' }, type: 'text', group: '通用',
    placeholder: { zh: '留空 = 默认', en: 'empty = default' },
    help: { zh: 'SQLite 记忆库路径。留空用默认:用户主目录下的 .philont/memory/memory.sqlite。自定义须填绝对路径,不支持 ~ 缩写。', en: 'SQLite memory DB path. Empty = default: .philont/memory/memory.sqlite under your home. To override, use an absolute path; ~ is NOT expanded.' } },
  { key: 'PHILONT_MCP_CONFIG', label: { zh: 'MCP 配置文件', en: 'MCP Config' }, type: 'text', group: '通用',
    placeholder: { zh: '留空 = 默认', en: 'empty = default' },
    help: { zh: '自定义 MCP server 配置文件路径。留空用默认:用户主目录下的 .philont/mcp.json。须填绝对路径,不支持 ~ 缩写。', en: 'Path to a custom MCP server config file. Empty = default: .philont/mcp.json under your home. Use an absolute path; ~ is NOT expanded.' } },
  { key: 'PHILONT_PORT', label: { zh: 'Agent 端口', en: 'Agent Port' }, type: 'number', group: '通用', placeholder: '20266',
    help: { zh: '默认 20266。改了需重启 launcher 才彻底生效。', en: 'Defaults to 20266. Restart the launcher for it to fully take effect.' } },

  // ══ 能力开关 ══
  { key: 'PHILONT_DEEP_EXPLORE', label: { zh: '深度推理', en: 'Deep Reasoning' }, type: 'bool', group: '能力开关', defaultOn: true,
    help: { zh: '复杂任务用 deep_explore 多步推理(扩展思考)。默认开,关掉可省配额。', en: 'deep_explore multi-step reasoning for hard tasks. On by default; turn off to save quota.' } },
  { key: 'PHILONT_MCP_BROWSER', label: { zh: '浏览器自动化', en: 'Browser Automation' }, type: 'bool', group: '能力开关',
    help: { zh: '启用 Playwright 浏览器工具(首次会拉起 MCP;需已装 Playwright)。默认关。', en: 'Enable the Playwright browser tool (spins up MCP on first use; needs Playwright installed). Off by default.' } },

  // ══ 联网搜索(三选一,优先级 Tavily > Serper > Brave)══
  { key: 'TAVILY_API_KEY', label: { zh: 'Tavily Key', en: 'Tavily Key' }, type: 'secret', group: '联网搜索',
    help: { zh: '联网搜索后端,三选一即可,优先级最高。', en: 'Web-search backend. Any one of the three; highest priority.' } },
  { key: 'SERPER_API_KEY', label: { zh: 'Serper Key', en: 'Serper Key' }, type: 'secret', group: '联网搜索' },
  { key: 'BRAVE_SEARCH_API_KEY', label: { zh: 'Brave Key', en: 'Brave Key' }, type: 'secret', group: '联网搜索' },

  // ══ 辅助小模型(四项配齐才生效,省主模型配额)══
  { key: 'AUX_LLM_PROTOCOL', label: { zh: '协议', en: 'Protocol' }, type: 'select', group: '辅助小模型',
    options: [{ value: 'openai', label: { zh: 'openai', en: 'openai' } }, { value: 'anthropic', label: { zh: 'anthropic', en: 'anthropic' } }],
    help: { zh: '可选。配齐协议/端点/Key/模型后,webFetch 蒸馏等杂活走便宜小模型。默认 openai。', en: 'Optional. Once all four are set, chores (webFetch distillation, etc.) use a cheap small model. Defaults to openai.' } },
  { key: 'AUX_LLM_BASE_URL', label: { zh: 'Base URL', en: 'Base URL' }, type: 'text', group: '辅助小模型', placeholder: 'https://api.deepseek.com' },
  { key: 'AUX_LLM_API_KEY', label: { zh: 'Key', en: 'Key' }, type: 'secret', group: '辅助小模型' },
  { key: 'AUX_LLM_MODEL', label: { zh: '模型', en: 'Model' }, type: 'text', group: '辅助小模型', placeholder: 'deepseek-chat' },

  // ══ 视觉模型 · 多模态(主模型不多模态时,vision 工具走这个独立模型)══
  { key: 'VISION_LLM_PROTOCOL', label: { zh: '协议', en: 'Protocol' }, type: 'select', group: '视觉模型 · 多模态',
    options: [{ value: 'openai', label: { zh: 'openai(通义千问-VL / GLM-4V / GPT-4o 等)', en: 'openai (Qwen-VL / GLM-4V / GPT-4o, etc.)' } }, { value: 'anthropic', label: { zh: 'anthropic(Claude)', en: 'anthropic (Claude)' } }],
    help: { zh: '主模型(如 DeepSeek)不多模态时配这个。留空按端点 URL 启发式(默认 openai)。', en: 'Set when the main model (e.g. DeepSeek) is not multimodal. Empty = heuristic by URL (defaults openai).' } },
  { key: 'VISION_LLM_BASE_URL', label: { zh: 'Base URL', en: 'Base URL' }, type: 'text', group: '视觉模型 · 多模态',
    placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'VISION_LLM_API_KEY', label: { zh: 'Key', en: 'Key' }, type: 'secret', group: '视觉模型 · 多模态' },
  { key: 'VISION_LLM_MODEL', label: { zh: '模型', en: 'Model' }, type: 'text', group: '视觉模型 · 多模态', placeholder: 'qwen-vl-max' },

  // ══ 通道 ══
  { key: 'TELEGRAM_ENABLED', label: { zh: '启用 Telegram', en: 'Enable Telegram' }, type: 'bool', group: '通道' },
  { key: 'TELEGRAM_BOT_TOKEN', label: { zh: 'Bot Token', en: 'Bot Token' }, type: 'secret', group: '通道',
    showIf: (v) => boolOn(v, 'TELEGRAM_ENABLED'), help: { zh: '@BotFather 申请。', en: 'Get one from @BotFather.' } },
  { key: 'TELEGRAM_DM_POLICY', label: { zh: 'DM 策略', en: 'DM Policy' }, type: 'select', group: '通道', options: POLICY_OPTS,
    showIf: (v) => boolOn(v, 'TELEGRAM_ENABLED'), help: { zh: '私聊准入。默认 allowlist(白名单,安全)。', en: 'DM access. Defaults to allowlist (safe).' } },
  { key: 'TELEGRAM_ALLOWED_USERS', label: { zh: 'DM 白名单', en: 'DM Allowlist' }, type: 'text', group: '通道',
    showIf: (v) => boolOn(v, 'TELEGRAM_ENABLED'), placeholder: '11111111,22222222',
    help: { zh: 'allowlist 时填:允许私聊的数字用户 id,逗号分隔。', en: 'For allowlist: numeric user ids allowed to DM, comma-separated.' } },
  { key: 'TELEGRAM_GROUP_POLICY', label: { zh: '群组策略', en: 'Group Policy' }, type: 'select', group: '通道', options: POLICY_OPTS,
    showIf: (v) => boolOn(v, 'TELEGRAM_ENABLED'), help: { zh: '群聊准入。默认 disabled。', en: 'Group access. Defaults to disabled.' } },
  { key: 'TELEGRAM_ALLOWED_GROUPS', label: { zh: '群组白名单', en: 'Group Allowlist' }, type: 'text', group: '通道',
    showIf: (v) => boolOn(v, 'TELEGRAM_ENABLED'), placeholder: '-1001234567890',
    help: { zh: 'allowlist 时填:允许的群组 id,逗号分隔。', en: 'For allowlist: allowed group ids, comma-separated.' } },
  { key: 'WECHAT_ENABLED', label: { zh: '启用 WeChat', en: 'Enable WeChat' }, type: 'bool', group: '通道',
    help: { zh: '须先在命令行 npm run wechat:login 扫码。', en: 'First scan-login via `npm run wechat:login`.' } },
  { key: 'WECHAT_DM_POLICY', label: { zh: 'WeChat DM 策略', en: 'WeChat DM Policy' }, type: 'select', group: '通道', options: POLICY_OPTS,
    showIf: (v) => boolOn(v, 'WECHAT_ENABLED'), help: { zh: '私聊准入。默认 allowlist(白名单,安全)—— 留空也按白名单,不填下面的 id 会拦下所有私聊。', en: 'DM access. Defaults to allowlist (safe) — empty still means allowlist, so DMs are blocked until you add an id below.' } },
  { key: 'WECHAT_ALLOWED_USERS', label: { zh: 'DM 白名单', en: 'DM Allowlist' }, type: 'text', group: '通道',
    showIf: (v) => boolOn(v, 'WECHAT_ENABLED'), placeholder: 'o9cq8…@im.wechat',
    help: { zh: 'allowlist 时填:允许私聊的 WeChat 用户 id(完整串,形如 o9cq8…@im.wechat),逗号分隔。被拦时日志 inbound blocked 里的 fromUserId 就是它。', en: 'For allowlist: WeChat user ids allowed to DM (full string like o9cq8…@im.wechat), comma-separated. It is the fromUserId shown in the “inbound blocked” log line.' } },
  { key: 'WECHAT_GROUP_POLICY', label: { zh: 'WeChat 群组策略', en: 'WeChat Group Policy' }, type: 'select', group: '通道', options: POLICY_OPTS,
    showIf: (v) => boolOn(v, 'WECHAT_ENABLED'), help: { zh: '群聊准入。默认 disabled。', en: 'Group access. Defaults to disabled.' } },
  { key: 'WECHAT_ALLOWED_GROUPS', label: { zh: 'WeChat 群组白名单', en: 'WeChat Group Allowlist' }, type: 'text', group: '通道',
    showIf: (v) => boolOn(v, 'WECHAT_ENABLED'),
    help: { zh: 'allowlist 时填:允许的群组 id,逗号分隔。', en: 'For allowlist: allowed group ids, comma-separated.' } },

  // ══ 高级(内部调参,一般不用动)══
  { key: 'PHILONT_LLM_MAX_TOKENS', label: { zh: 'max_tokens', en: 'max_tokens' }, type: 'number', group: '高级', placeholder: '16000',
    help: { zh: '单轮回复 token 上限。', en: 'Token cap for one reply.' } },
  { key: 'PHILONT_GP', label: { zh: 'PARI/GP 路径', en: 'PARI/GP path' }, type: 'text', group: '高级', placeholder: 'gp',
    help: { zh: 'gp 可执行文件路径,默认直接用 gp(需在 PATH 里)。Windows 示例:C:\\Program Files\\PARI64\\gp.exe', en: 'Path to the gp executable (default: gp, must be in PATH). Windows example: C:\\Program Files\\PARI64\\gp.exe' } },
  { key: 'PHILONT_PLAYWRIGHT', label: { zh: 'Playwright CLI 路径', en: 'Playwright CLI path' }, type: 'text', group: '高级', placeholder: 'playwright',
    help: { zh: 'playwright CLI 路径,默认先尝试 playwright 命令再 npx。Windows 示例:C:\\Users\\xxx\\AppData\\Roaming\\npm\\playwright.cmd', en: 'Path to playwright CLI (default: tries playwright command then npx). Windows example: C:\\Users\\xxx\\AppData\\Roaming\\npm\\playwright.cmd' } },
  { key: 'PHILONT_DEEP_EXPLORE_MAX_ITERS', label: { zh: '深推单轮迭代上限', en: 'Deep-reason iters/round' }, type: 'number', group: '高级', placeholder: '40',
    help: { zh: 'deep_explore 单轮 LLM↔工具回合上限(5–100,默认 40)。难题被截断时调高。', en: 'LLM↔tool turns per deep_explore round (5–100, default 40).' } },
  { key: 'PHILONT_DEEP_EXPLORE_TOKEN_BUDGET', label: { zh: '深推 token 预算', en: 'Deep-reason token budget' }, type: 'number', group: '高级', placeholder: '300000',
    help: { zh: '一次推理会话的跨轮 token 预算(默认 300000,最小 50000)。', en: 'Cross-turn token budget per reasoning session (default 300000, min 50000).' } },
  { key: 'PHILONT_DEEP_EXPLORE_ROUND_DEADLINE_MS', label: { zh: '深推单轮墙钟(ms)', en: 'Deep-reason round deadline (ms)' }, type: 'number', group: '高级', placeholder: '720000',
    help: { zh: '单轮推理墙钟预算(默认 720000=12min,最小 30000)。', en: 'Wall-clock per reasoning round (default 720000 = 12min, min 30000).' } },

  // — 自主回路:空闲时主动跑 initiative,靠日 token 上限省钱 —
  { key: 'PHILONT_AUTONOMOUS', label: { zh: '自主回路', en: 'Autonomous Loop' }, type: 'bool', group: '高级', defaultOn: true,
    help: { zh: '空闲时主动跑 initiative(研究 / 补缺口等)。默认开;关掉则完全不自发动作。', en: 'Runs initiatives when idle (research / gap-filling). On by default; off = never self-initiates.' } },
  { key: 'PHILONT_AUTONOMOUS_DAILY_TOKENS', label: { zh: '自主回路日 token 上限', en: 'Autonomous daily tokens' }, type: 'number', group: '高级', placeholder: '0',
    help: { zh: '自主回路每天最多花的 LLM token,到顶就停跑当天剩余 tick(默认 0=无限)。需要控制成本时填正整数。', en: 'Max LLM tokens/day the autonomous loop may spend; once hit it skips the rest of the day (default 0 = unlimited). Set a positive integer to cap costs.' } },
];

const GROUP_ORDER = [
  '启动配置', '网络与时区', '通用', '能力开关',
  '联网搜索', '辅助小模型', '视觉模型 · 多模态', '通道', '高级',
];
const MASK_PREFIX = '••••';

/** provider → 对应「可启动」的 key 字段(与 launcher/env-file.ts 的 PROVIDER_KEY_ENV 对齐)。 */
const PROVIDER_KEY: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  glm: 'GLM_API_KEY',
  kimi: 'KIMI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

@customElement('settings-view')
export class SettingsView extends LitElement {
  /** 向导模式:只露「启动配置」核心字段 + 「保存并启动」。 */
  @property({ type: Boolean }) wizard = false;
  constructor() { super(); new LangController(this); } // 语言切换时自动重渲染

  @state() private values: Values = {};
  @state() private loading = true;
  @state() private saving = false;
  @state() private message = '';
  @state() private error = '';
  @state() private agentState = 'unknown';
  @state() private openGroups: Record<string, boolean> = { 启动配置: true, 网络与时区: true };
  @state() private caps: Record<string, { found: boolean; hint?: string; version?: string }> | null = null;
  @state() private autostart = false;
  @state() private proxyEnabled = false; // 全局代理开关(UI 态:由 PHILONT_PROXY 是否非空派生)

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const [cfgRes, stRes] = await Promise.all([
        fetch(`${LAUNCHER_BASE}/api/launcher/config`),
        fetch(`${LAUNCHER_BASE}/api/launcher/status`),
      ]);
      const cfg = await cfgRes.json();
      const st = await stRes.json();
      this.values = { ...(cfg.values ?? {}) };
      this.proxyEnabled = !!(this.values.PHILONT_PROXY && this.values.PHILONT_PROXY.trim() !== '');
      this.agentState = st.state ?? 'unknown';
    } catch (e) {
      this.error = t(`连不上 launcher(${LAUNCHER_BASE})。请确认 launcher 在运行。`,
        `Can't reach the launcher (${LAUNCHER_BASE}). Make sure it's running.`);
    } finally {
      this.loading = false;
    }
    // 系统区(能力检测 + 开机自启)—— 非向导才加载,失败静默
    if (!this.wizard) {
      try {
        const [capRes, asRes] = await Promise.all([
          fetch(`${LAUNCHER_BASE}/api/launcher/capabilities`),
          fetch(`${LAUNCHER_BASE}/api/launcher/autostart`),
        ]);
        this.caps = await capRes.json();
        this.autostart = !!(await asRes.json()).enabled;
      } catch { /* 忽略 */ }
    }
  }

  private async toggleAutostart(enabled: boolean): Promise<void> {
    try {
      const r = await fetch(`${LAUNCHER_BASE}/api/launcher/autostart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      this.autostart = !!(await r.json()).enabled;
    } catch { /* 忽略 */ }
  }

  private setVal(key: string, v: string): void {
    this.values = { ...this.values, [key]: v };
  }

  private isOn(f: Field): boolean {
    const v = this.values[f.key];
    if (v === undefined || v === '') return !!f.defaultOn;
    return v === '1' || v.toLowerCase() === 'true';
  }

  /** 所选 provider 对应的 key 字段。 */
  private providerKeyField(): string {
    return PROVIDER_KEY[prov(this.values)] ?? 'ANTHROPIC_API_KEY';
  }

  /** 是否已填好所选 provider 的 key —— 决定能否启动 / 切回聊天。 */
  private hasProviderKey(): boolean {
    const v = this.values[this.providerKeyField()];
    return !!(v && v.trim() !== '');
  }

  /** 收集要 PUT 的值:跳过未改动的掩码密钥(发回去 launcher 也会跳,但前端先滤一道)。 */
  private collectPayload(): Values {
    const out: Values = {};
    for (const f of this.visibleFields()) {
      let v = this.values[f.key];
      if (v === undefined) continue;
      if (f.type === 'secret' && v.startsWith(MASK_PREFIX)) continue; // 没改的掩码
      if (f.type === 'bool') v = this.isOn(f) ? '1' : '0';
      out[f.key] = v;
    }
    // 全局代理:开关关 → 清空 PHILONT_PROXY;开 → 用输入的地址(已在上面收进 out)。
    if (!this.proxyEnabled) out.PHILONT_PROXY = '';
    // 防 mock 陷阱:LLM_PROVIDER 留空会回退 mock。已填好 key 就默认钉成 anthropic。
    if ((!out.LLM_PROVIDER || out.LLM_PROVIDER.trim() === '') && this.hasProviderKey()) {
      out.LLM_PROVIDER = 'anthropic';
    }
    return out;
  }

  private async save(restart: boolean): Promise<void> {
    this.saving = true;
    this.message = '';
    this.error = '';
    try {
      const payload = this.collectPayload();
      const res = await fetch(`${LAUNCHER_BASE}/api/launcher/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: payload }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        this.error = (j.errors ?? [j.reason ?? t('保存失败', 'Save failed')]).join(t('；', '; '));
        return;
      }
      // 启动 / 重启 agent
      const action = this.agentState === 'running' ? 'restart' : 'start';
      const r2 = await fetch(`${LAUNCHER_BASE}/api/launcher/${restart ? action : 'start'}`, { method: 'POST' });
      const j2 = await r2.json();
      if (!r2.ok || j2.ok === false) {
        this.error = j2.reason ?? t(`${action} 失败`, `${action} failed`);
        return;
      }
      this.message = restart
        ? (action === 'restart' ? t('已保存并重启 agent ✓', 'Saved & restarted agent ✓') : t('已保存并启动 agent ✓', 'Saved & started agent ✓'))
        : t('已保存 ✓', 'Saved ✓');
      await this.load();
      if (this.hasProviderKey()) {
        this.dispatchEvent(new CustomEvent('configured', { bubbles: true, composed: true }));
      }
    } catch (e) {
      this.error = String(e);
    } finally {
      this.saving = false;
    }
  }

  private async control(action: 'start' | 'stop' | 'restart'): Promise<void> {
    this.message = '';
    this.error = '';
    try {
      const r = await fetch(`${LAUNCHER_BASE}/api/launcher/${action}`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok || j.ok === false) { this.error = j.reason ?? t(`${action} 失败`, `${action} failed`); return; }
      this.message = `${action} ✓`;
      await this.load();
    } catch (e) {
      this.error = String(e);
    }
  }

  /** 当前应展示的字段:向导与设置一样展示全部 env(分功能区块),仅过条件显隐(showIf)。 */
  private visibleFields(): Field[] {
    return FIELDS.filter((f) => !f.showIf || f.showIf(this.values));
  }

  /** 全局代理特判:开关 + (开时)地址输入。 */
  private renderProxy(f: Field) {
    return html`
      <label class="row toggle-row">
        <span class="lbl">${tr(f.label)}</span>
        <input type="checkbox" .checked=${this.proxyEnabled}
          @change=${(e: Event) => { this.proxyEnabled = (e.target as HTMLInputElement).checked; }} />
        <span class="help">${tr(f.help)}</span>
      </label>
      ${this.proxyEnabled ? html`
        <label class="row">
          <span class="lbl">${t('代理地址', 'Proxy URL')}</span>
          <input type="text" .value=${this.values[f.key] ?? ''} placeholder=${tr(f.placeholder)}
            autocomplete="off"
            @input=${(e: Event) => this.setVal(f.key, (e.target as HTMLInputElement).value)} />
        </label>` : null}`;
  }

  private renderField(f: Field) {
    if (f.key === 'PHILONT_PROXY') return this.renderProxy(f);
    const v = this.values[f.key] ?? '';
    const ph = tr(f.placeholder);
    if (f.type === 'bool') {
      return html`
        <label class="row toggle-row">
          <span class="lbl">${tr(f.label)}</span>
          <input type="checkbox" .checked=${this.isOn(f)}
            @change=${(e: Event) => this.setVal(f.key, (e.target as HTMLInputElement).checked ? '1' : '0')} />
          ${f.help ? html`<span class="help">${tr(f.help)}</span>` : null}
        </label>`;
    }
    if (f.type === 'select') {
      return html`
        <label class="row">
          <span class="lbl">${tr(f.label)}</span>
          <select .value=${v} @change=${(e: Event) => this.setVal(f.key, (e.target as HTMLSelectElement).value)}>
            <option value="">${t('(默认)', '(default)')}</option>
            ${f.options!.map((o) => html`<option value=${o.value} ?selected=${o.value === v}>${tr(o.label)}</option>`)}
          </select>
          ${f.help ? html`<span class="help">${tr(f.help)}</span>` : null}
        </label>`;
    }
    return html`
      <label class="row">
        <span class="lbl">${tr(f.label)}</span>
        <input
          type=${f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'}
          .value=${v}
          placeholder=${ph}
          autocomplete="off"
          @input=${(e: Event) => this.setVal(f.key, (e.target as HTMLInputElement).value)} />
        ${f.help ? html`<span class="help">${tr(f.help)}</span>` : null}
      </label>`;
  }

  private renderGroup(group: string) {
    const fields = this.visibleFields().filter((f) => f.group === group);
    if (fields.length === 0) return null;
    const open = !!this.openGroups[group];
    return html`
      <section class="group">
        <button class="group-head" @click=${() => { this.openGroups = { ...this.openGroups, [group]: !open }; }}>
          <span class="caret">${open ? '▾' : '▸'}</span> ${tr(GROUP_LABELS[group])}
        </button>
        ${open ? html`<div class="group-body">${fields.map((f) => this.renderField(f))}</div>` : null}
      </section>`;
  }

  private renderSystem() {
    const capRow = (label: string, key: string) => {
      const c = this.caps?.[key];
      if (!c) return null;
      return html`
        <div class="cap-row">
          <span class="cap-name">${label}</span>
          <span class="cap-state ${c.found ? 'on' : 'off'}">${c.found ? t('✓ 已安装', '✓ installed') : t('✗ 未检测到', '✗ not found')}${c.version ? ` · ${c.version}` : ''}</span>
          ${!c.found && c.hint ? html`<span class="cap-hint">${c.hint}</span>` : null}
        </div>`;
    };
    return html`
      <section class="group">
        <button class="group-head" @click=${() => { this.openGroups = { ...this.openGroups, 系统: !this.openGroups['系统'] }; }}>
          <span class="caret">${this.openGroups['系统'] ? '▾' : '▸'}</span> ${tr(GROUP_LABELS['系统'])}
        </button>
        ${this.openGroups['系统'] ? html`
          <div class="group-body">
            <label class="row toggle-row">
              <span class="lbl">${t('开机自启', 'Auto-start')}</span>
              <input type="checkbox" .checked=${this.autostart}
                @change=${(e: Event) => this.toggleAutostart((e.target as HTMLInputElement).checked)} />
              <span class="help">${t('登录时自动拉起 PHILONT。', 'Launch PHILONT automatically at login.')}</span>
            </label>
            <div class="cap-block">
              <div class="cap-title">${t('可选能力(基础安装不含,按需安装)', 'Optional capabilities (not in the base install)')}</div>
              ${this.caps ? html`
                ${capRow('Python', 'python')}
                ${capRow(t('Z3 求解器(deep_explore 严格验证)', 'Z3 solver (deep_explore strict verify)'), 'z3')}
                ${capRow(t('PARI/GP(deep_explore 数论计算/找反例)', 'PARI/GP (deep_explore number theory / counterexamples)'), 'pari')}
                ${capRow(t('Playwright(浏览器自动化)', 'Playwright (browser automation)'), 'playwright')}
              ` : html`<span class="muted">${t('检测中…', 'detecting…')}</span>`}
            </div>
          </div>` : null}
      </section>`;
  }

  private agentBadge() {
    const map: Record<string, [string, string]> = {
      running: [t('●运行中', '●running'), 'ok'], stopped: [t('●已停止', '●stopped'), 'off'],
      starting: [t('●启动中', '●starting'), 'warn'], stopping: [t('●停止中', '●stopping'), 'warn'],
      crashed: [t('●已崩溃', '●crashed'), 'err'], unknown: [t('●未知', '●unknown'), 'off'],
    };
    const [text, cls] = map[this.agentState] ?? map.unknown;
    return html`<span class="badge ${cls}">${text}</span>`;
  }

  render() {
    if (this.loading) return html`<div class="wrap"><p class="muted">${t('加载配置…', 'Loading config…')}</p></div>`;
    return html`
      <div class="wrap">
        ${this.wizard ? html`
          <h2>${t('欢迎使用 PHILONT', 'Welcome to PHILONT')}</h2>
          <p class="muted">${t('填好「启动配置」即可启动;下面其余功能区都是可选项,现在配或日后在「⚙ 设置」里调整都行。',
            'Fill in “Startup” and you can launch; every section below is optional — set them now or later in ⚙ Settings.')}</p>
        ` : html`
          <div class="head-row">
            <h2>${t('设置', 'Settings')}</h2>
            <div class="agent-ctl">
              ${this.agentBadge()}
              <button class="mini" @click=${() => this.control('restart')} ?disabled=${this.saving}>${t('重启', 'Restart')}</button>
              ${this.agentState === 'running'
                ? html`<button class="mini" @click=${() => this.control('stop')}>${t('停止', 'Stop')}</button>`
                : html`<button class="mini" @click=${() => this.control('start')}>${t('启动', 'Start')}</button>`}
            </div>
          </div>
        `}

        ${GROUP_ORDER.map((g) => this.renderGroup(g))}
        ${this.wizard ? null : this.renderSystem()}

        ${this.error ? html`<div class="banner err">${this.error}</div>` : null}
        ${this.message ? html`<div class="banner ok">${this.message}</div>` : null}

        <div class="actions">
          ${this.wizard
            ? html`<button class="primary" @click=${() => this.save(true)} ?disabled=${this.saving || !this.hasProviderKey()}>
                ${this.saving ? t('保存中…', 'Saving…') : t('保存并启动', 'Save & Launch')}
              </button>`
            : html`
              <button class="primary" @click=${() => this.save(true)} ?disabled=${this.saving}>
                ${this.saving ? t('保存中…', 'Saving…') : t('保存并重启 agent', 'Save & Restart agent')}
              </button>
              <button class="ghost" @click=${() => this.save(false)} ?disabled=${this.saving}>${t('仅保存', 'Save only')}</button>`}
        </div>
      </div>`;
  }

  static styles = css`
    :host { display: block; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 20px 24px 60px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
    h2 { margin: 8px 0 12px; font-size: 20px; color: #1a1a1a; }
    .muted { color: #6b7280; font-size: 14px; }
    .head-row { display: flex; align-items: center; justify-content: space-between; }
    .agent-ctl { display: flex; align-items: center; gap: 8px; }
    .badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
    .badge.ok { color: #16a34a; } .badge.off { color: #6b7280; }
    .badge.warn { color: #d97706; } .badge.err { color: #dc2626; }
    .mini { font-size: 12px; padding: 4px 10px; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; }
    .mini:hover { background: #f5f5f5; }
    .group { border: 1px solid #e5e7eb; border-radius: 10px; margin: 12px 0; overflow: hidden; background: #fff; }
    .group-head { width: 100%; text-align: left; padding: 10px 14px; background: #fafafa; border: none; border-bottom: 1px solid #eee; font-size: 14px; font-weight: 600; cursor: pointer; color: #374151; }
    .group-head:disabled { cursor: default; }
    .caret { display: inline-block; width: 14px; color: #9ca3af; }
    .group-body { padding: 8px 14px 14px; }
    .row { display: grid; grid-template-columns: 130px 1fr; gap: 6px 12px; align-items: center; margin: 10px 0; }
    .toggle-row { grid-template-columns: 130px auto 1fr; }
    .lbl { font-size: 13px; color: #374151; }
    .row input[type=text], .row input[type=password], .row input[type=number], .row select {
      padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; outline: none; width: 100%;
      box-sizing: border-box;
    }
    .row input:focus, .row select:focus { border-color: #1976d2; }
    .row input[type=checkbox] { width: 18px; height: 18px; }
    .help { grid-column: 2 / -1; font-size: 12px; color: #9ca3af; }
    .toggle-row .help { grid-column: 3; }
    .banner { margin: 14px 0; padding: 10px 14px; border-radius: 8px; font-size: 14px; }
    .banner.err { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .banner.ok { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .actions { display: flex; gap: 10px; margin-top: 18px; }
    .primary { padding: 10px 22px; background: #1976d2; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; }
    .primary:disabled { background: #9ca3af; cursor: not-allowed; }
    .ghost { padding: 10px 18px; background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; cursor: pointer; }
    .cap-block { margin-top: 10px; border-top: 1px dashed #e5e7eb; padding-top: 10px; }
    .cap-title { font-size: 12px; color: #6b7280; margin-bottom: 6px; }
    .cap-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
    .cap-name { min-width: 200px; color: #374151; }
    .cap-state.on { color: #16a34a; } .cap-state.off { color: #9ca3af; }
    .cap-hint { flex-basis: 100%; font-size: 12px; color: #9ca3af; padding-left: 200px; }
  `;
}
