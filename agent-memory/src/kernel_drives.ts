/**
 * Kernel Drives — philont species-layer character drives (K7 turn-time QC).
 *
 * These drives are **not optional** — they are core character QC for the philont agent, triggered turn-time:
 *   - TaskCommitmentDrive (competitiveness): exhaust all tool-reachable options before giving up, don't hand tasks back to users casually
 *   - HonestyGate / EmptyConclusionGate: see honesty_gate.ts / empty_conclusion_gate.ts
 *
 * **Historical note**: there was previously a TsCuriosityDrive (triggering "encourage LLM to look it up" based on user message tokens),
 * removed 2026-05-06. Curiosity is re-implemented in the K8 initiative layer (autonomous/drivers/curiosity_driver.ts)
 * — that layer actually runs tools at idle-time, not just advising the LLM turn-time.
 *
 * Architectural position (see plan /root/.claude/plans/philont-iterative-haven.md Phase K2):
 *   - These drives should ideally live in the Rust compile-time kernel, exposed to TS via agent-node FFI
 *   - Currently implemented in TS, but the **logic** is language-agnostic — core algorithms are 1:1 portable to Rust
 *   - Callers remain TsDriveRuntime.beforeTurn, interface is TsDriveEngine
 *   - Do NOT attach to memory_drive_configs declarative queue — this is kernel, not user-configurable
 */

import type {
  DriveProposal,
  DriveRuntimeState,
  RecentMessage,
  TsDriveEngine,
} from './drive_runtime.js';

// ══════════════════════════════════════════════════════════════════════════
// Pattern table (bilingual Chinese/English)
// ══════════════════════════════════════════════════════════════════════════

/**
 * HANDOFF patterns — detect "subject=user + action verb" structure.
 * Each requires "user performing action" combination, not just keywords, to reduce false positives.
 */
const HANDOFF_PATTERNS_ZH: RegExp[] = [
  // "你可以(自己)?X 下载/运行/..."
  /你可以(?:自己|手动)?[^。\n]{0,30}?(下载|运行|执行|安装|打开|复制|粘贴|查看|尝试|试试)/,
  // "请你/您(自己|手动|直接)X 运行/..."
  /(?:请|麻烦)(?:你|您)?(?:自己|手动|直接)[^。\n]{0,30}?(试|运行|执行|下载|查看|尝试)/,
  // "建议(你|您)?(自己|手动|直接)...执行/运行/完成"
  /建议(?:你|您)?(?:自己|手动|直接)?[^。\n]{0,30}?(执行|运行|完成|下载|尝试)/,
  // "我(无法|没法|没有办法)...(完成|做|下载|获取)" — capability abandonment (policy refusal is in whitelist)
  /我(?:无法|没法|没有办法|做不到|不能)[^。\n]{0,30}?(完成|做|下载|获取|执行|帮你)/,
  // "(需要|得|应该)(你|您)(自己|手动)"
  /(?:需要|得|应该)(?:你|您)(?:自己|手动)/,
  // Give commands for user to copy (curl/wget/git clone/pip install/npm install)
  /(?:你可以用|请运行|可以执行|命令[:：])[^。\n]{0,60}?(curl|wget|git\s+clone|pip\s+install|npm\s+install)/,
  // Pre-emptive handoff: "需要你(确认|检查|查看|提供) X" — kicking permission/input-type
  // problems to the user before trying tools (PDF→Word case "需要你确认是否有 winget 权限").
  // Negative lookahead excludes reasonable ask-back: "需要你确认下结果/输出/工具/返回值"
  /需要你(确认|检查|查看|提供)(?!.{0,30}(?:工具|结果|输出|返回值|代码效果))/,
];

const HANDOFF_PATTERNS_EN: RegExp[] = [
  // you (can|could|should|may) (just )?try/run/download/execute/copy
  /\byou (?:can|could|should|may)\s+(?:just\s+)?(try|run|download|execute|copy|do)\b/i,
  // feel free to run/try/download/do
  /\bfeel free to\s+(run|try|download|do|execute)\b/i,
  // I (can|cannot|can't|won't|am unable to) do/complete/download/fetch/run
  /\bI (?:can'?t|cannot|won'?t|am unable to|'?m unable to)\s+(do|complete|download|fetch|run|help)\b/i,
  // please run/execute/try this/the following
  /\bplease (?:run|execute|try)\s+(?:this|the following|it)\b/i,
  // it's up to you to
  /\bit'?s up to you to\b/i,
];

/**
 * Policy refusal whitelist (overrides handoff detection).
 * When the assistant says "I can't do X because of policy/safety/ethics", this is legitimate refusal, not giving up.
 */
const POLICY_REFUSAL_PATTERNS: RegExp[] = [
  /(违反|违背|涉及|触犯)(政策|安全|伦理|法律|规定|条款)/,
  /我(不(会|能)帮(你|您)?)?做(违法|危险|攻击|破坏)/,
  /这是?(越权|违规|不合规|不合适)/,
  /\b(policy|safety|ethical?|illegal|unauthorized|violates?|against (?:our )?guidelines|not allowed|forbidden)\b/i,
];

/**
 * Delivered result whitelist (overrides handoff detection).
 * When the assistant has already delivered the key artifact and is only asking the user to do a non-core follow-up step, this is not giving up.
 * Criteria: message contains "已(经)?成功/完成/为你..." completion marker, or contains absolute path / file:// artifact evidence.
 */
const DELIVERED_RESULT_PATTERNS: RegExp[] = [
  /(已(?:经)?(?:成功|为你|帮你)?(?:下载|保存|生成|创建|写入|执行|完成))/,
  /(文件(?:已)?(?:保存|写)(?:到|在|于))/,
  /\b(saved to|written to|created|downloaded to|wrote to|generated at|file[s]? (?:is|are) at)\b/i,
];

/** Absolute path / file:// heuristic: presence is treated as "artifact already exists" */
const ABSOLUTE_PATH_HINT = /(?:[/]tmp[/]|[/]home[/]|[A-Z]:\\|file:[/][/])[\S]+/i;

/**
 * "Excuse" for capability abandonment — the policy refusal whitelist only blocks handoff detection
 * when these excuses are **absent** (meaning the agent says "I can't do it" without giving a policy reason;
 * that counts as capability abandonment and should be pushed).
 */
function isPolicyRefusal(text: string): boolean {
  for (const re of POLICY_REFUSAL_PATTERNS) if (re.test(text)) return true;
  return false;
}

function isDeliveredResult(text: string): boolean {
  for (const re of DELIVERED_RESULT_PATTERNS) if (re.test(text)) return true;
  if (ABSOLUTE_PATH_HINT.test(text)) return true;
  return false;
}

/**
 * Pure clarification question whitelist: ends with question mark and contains no handoff verb → don't trigger TaskCommitment.
 *
 * Pure questions (without the tone of handing work back to the user) are handled naturally by the LLM; let them pass.
 */
function isPureOpenQuestion(text: string): boolean {
  const trimmed = text.trim();
  const endsInQ = /[?？]\s*$/.test(trimmed);
  if (!endsInQ) return false;
  // Also has handoff pattern → not a pure question, trigger
  for (const re of [...HANDOFF_PATTERNS_ZH, ...HANDOFF_PATTERNS_EN]) {
    if (re.test(trimmed)) return false;
  }
  return true;
}

/**
 * Core detection: returns the first matched handoff pattern (with category and matched snippet), null if no match.
 * Exported for testing.
 */
export interface HandoffMatch {
  language: 'zh' | 'en';
  patternIndex: number;
  snippet: string; // matched key snippet
  verb: string; // extracted action verb (from capture group)
}

export function detectTaskHandoff(text: string): HandoffMatch | null {
  for (let i = 0; i < HANDOFF_PATTERNS_ZH.length; i++) {
    const m = text.match(HANDOFF_PATTERNS_ZH[i]);
    if (m) {
      return {
        language: 'zh',
        patternIndex: i,
        snippet: m[0],
        verb: m[1] ?? '',
      };
    }
  }
  for (let i = 0; i < HANDOFF_PATTERNS_EN.length; i++) {
    const m = text.match(HANDOFF_PATTERNS_EN[i]);
    if (m) {
      return {
        language: 'en',
        patternIndex: i,
        snippet: m[0],
        verb: m[1] ?? '',
      };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// Recent user task extraction — search backward from lastAssistantIdx for user messages as taskHint
// ══════════════════════════════════════════════════════════════════════════

/** Find the most recent user message before the assistant message, take first 40 chars as task hint */
function findPriorUserTask(
  msgs: RecentMessage[],
  lastAssistantIdx: number,
): string | null {
  // Skip drive-injected "内驱 XXX" messages to prevent self-loops
  const isDriveInjection = (s: string): boolean =>
    /^\(?内驱[ \w-]*\)?/.test(s) || /^\[内驱/.test(s) || /^\(Drive\s/.test(s) || /^\[Drive\s/.test(s);
  for (let i = lastAssistantIdx - 1; i >= 0 && i >= lastAssistantIdx - 6; i--) {
    if (msgs[i].role !== 'user') continue;
    const content = msgs[i].content.trim();
    if (isDriveInjection(content)) continue;
    return content.slice(0, 40);
  }
  return null;
}

function buildInjection(
  taskHint: string | null,
  match: HandoffMatch | null,
): string {
  // K9 Path B: upgrade "don't hand back" negation to a "standard decision tree of exhausting all options".
  // LLM given concrete steps vs "pick one and execute immediately" is more actionable, reducing repeat handoff probability.
  const what = taskHint ? `"${taskHint}"` : 'this task';
  const verbHint = match?.verb ? ` (you just told me to "${match.verb}")` : '';
  return (
    `(Drive TaskCommitment)${verbHint} Last turn you handed ${what} back to the user, but this looks like a task that tools can handle.\n\n` +
    `**Standard decision tree — exhaust all options before giving up**:\n` +
    `  1. What was the failure reason last time? Read the most recent ⚠ TOOL FAILED error:\n` +
    `     - "command not found" → switch tool / command (grep → rg, curl → webFetch, python → node)\n` +
    `     - "permission denied" → try a different path (/tmp/ vs ~/), or use readFile instead of shell\n` +
    `     - "no such file" → use glob / readDir to find the actual path first, don't guess\n` +
    `     - "404 / DNS error" → switch source / different keywords in webSearch\n` +
    `     - timeout → break into smaller requests / add a limit\n` +
    `  2. List 2-3 reasonable paths **not yet tried**, then execute the most promising one immediately.\n` +
    `  3. **Only** when all reasonable paths have been proven to fail by tool results, report to the user that you are unable to proceed — and specifically state which paths were tried and why each failed.\n` +
    `  4. When **should** you ask the user (not giving up — genuinely needing external input): missing credentials / missing business constraints / multiple equally valid options for the user to choose. In these cases, explicitly say "I need X to continue".`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TsTaskCommitmentDrive
// ══════════════════════════════════════════════════════════════════════════

export interface TsTaskCommitmentDriveConfig {
  /** Cooldown time (ms). Default 90_000 (90s) — TaskCommitment injection is heavier than regular drives, should be more conservative. */
  cooldownMs: number;
  /** Assistant messages too short are not detected (noise reduction). Default 8 characters */
  minMessageLen: number;
}

/**
 * Competitiveness drive. Detects when the agent handed back a "tool-reachable task" to the user last turn →
 * internally drives an injection of "think of another way", pushing the LLM to not give up next turn.
 *
 * Trigger conditions (all must be satisfied):
 *   1. Most recent assistant message length ≥ minMessageLen
 *   2. After that assistant message there are **only** user messages (this turn's userMessage),
 *      with no new assistant follow-up
 *   3. That assistant message matches a HANDOFF pattern (Chinese or English)
 *   4. Not a policy refusal (whitelist override)
 *   5. Not a delivered result (whitelist override)
 *   6. Not a pure clarification question (let through, handled naturally by LLM)
 *   7. Dedup: not the same assistant message (lastHandoffSeen hash comparison)
 *   8. Cooldown not triggered (lastFiredAt + cooldownMs <= now)
 */
export class TsTaskCommitmentDrive implements TsDriveEngine {
  readonly kind = 'taskCommitment';
  readonly name = 'TsTaskCommitmentDrive';

  private lastFiredAt: number | null = null;
  private lastHandoffSeen: string | null = null;
  private pendingHandoffHash: string | null = null;

  constructor(
    public readonly id: string,
    private readonly config: TsTaskCommitmentDriveConfig = {
      cooldownMs: 90_000,
      minMessageLen: 8,
    },
  ) {}

  evaluate(state: DriveRuntimeState): DriveProposal | null {
    const msgs = state.recentMessages;
    if (msgs.length < 2) return null;

    // 1. Most recent assistant message
    let lastAsstIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        lastAsstIdx = i;
        break;
      }
    }
    if (lastAsstIdx < 0) return null;
    const lastAsstText = msgs[lastAsstIdx].content;
    if (lastAsstText.length < this.config.minMessageLen) return null;

    // 2. Must have user messages after (this turn), and no assistant follow-up yet
    const tail = msgs.slice(lastAsstIdx + 1);
    if (tail.length === 0) return null;
    if (tail.some((m) => m.role === 'assistant')) return null;

    // 3. Core detection
    const match = detectTaskHandoff(lastAsstText);
    if (!match) return null;

    // 4-6. Whitelists
    if (isPolicyRefusal(lastAsstText)) return null;
    if (isDeliveredResult(lastAsstText)) return null;
    if (isPureOpenQuestion(lastAsstText)) return null;

    // 7. Dedup (by message start hash)
    const hash = lastAsstText.slice(0, 80);
    if (hash === this.lastHandoffSeen) return null;

    // 8. Cooldown
    if (
      this.lastFiredAt !== null &&
      Date.now() - this.lastFiredAt < this.config.cooldownMs
    ) {
      return null;
    }

    // Prepare injection
    const taskHint = findPriorUserTask(msgs, lastAsstIdx);
    this.pendingHandoffHash = hash;

    return {
      injectMessage: buildInjection(taskHint, match),
      utility: 0.6, // heavier than CuriosityDrive (0.55), lighter than PursuitIntegrity (0.9)
      triggerSnapshot: {
        lastAssistantHead: lastAsstText.slice(0, 200),
        matchedLanguage: match.language,
        matchedPattern: match.patternIndex,
        matchedVerb: match.verb,
        matchedSnippet: match.snippet,
        taskHint,
      },
    };
  }

  onFired(_outcomeId: string): void {
    this.lastFiredAt = Date.now();
    if (this.pendingHandoffHash) {
      this.lastHandoffSeen = this.pendingHandoffHash;
      this.pendingHandoffHash = null;
    }
  }
}

// Internal helper functions for testing (exported but not core API)
export { isPolicyRefusal, isDeliveredResult, isPureOpenQuestion };

