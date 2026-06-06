/**
 * HonestyGate — checks whether the LLM's final text matches the actual tool results.
 *
 * Not a traditional drive. Traditional drives fire in beforeTurn → injected into the next turn,
 * but by then the lie has already been sent to the user. HonestyGate **inline-intercepts**
 * after final text is generated but before `onDelta` is pushed:
 *
 *   1. Scans LLM text for "completion claim" patterns (成功/完成/已生成/installed/etc)
 *   2. Scans tool_result content for this turn (written by chat-handler `formatToolResultContent`,
 *      failures prefixed with ⚠ TOOL FAILED, successes with ✓ TOOL OK)
 *   3. If there is a completion claim but no "success" support in tool_results this turn → trigger
 *      If failure count ≥ success count → high severity (almost certainly lying)
 *
 * Callers (chat-handler) that receive a high severity result should:
 *   - Log to audit (honesty_gate_fired)
 *   - Inject a reminder message ("You just said X is done, but N tool failures, 0 successes")
 *   - Call LLM again once, cap=1 retry within the same turn
 *
 * Design invariants:
 *   - Pure synchronous function, no LLM calls, no IO
 *   - Prefer false negatives over false positives: vague language (probably, should, looks like) is not a completion claim
 *   - User quotations / rhetorical questions don't count (patterns only match declarative "completed" statements)
 */

// ── Completion claim patterns ───────────────────────────────────────────────────────
//
// Chinese: action verb + (成功|完成|完毕|好了|搞定) or (已|已经) + the above
// English: successfully / completed / installed / created / done / fixed
//
// False-positive suppression: all matched in declarative form; questions / negations / conditionals do not match.
const COMPLETION_PATTERNS: ReadonlyArray<RegExp> = [
  // Chinese action + success-type (2026-05-14 Phase 10 P0: added verbs like 注册/登录/订阅/启动
  // for real-world scenarios. Missing 注册 caused "MycoX 注册完成 ✅" to not be recognized as a completion claim.)
  /(?:转换|安装|生成|写入|下载|部署|修复|更新|创建|配置|删除|执行|运行|保存|导出|发布|提交|推送|注册|登录|注销|订阅|取消订阅|加入|退出|启动|停止|重启|连接|断开|同步|备份|还原|上传|发送|接收|启用|禁用|绑定|解绑|加密|解密)[^。！？\n]{0,12}(?:成功|完成|完毕|好了|搞定)/,
  // Chinese 已-completed (same verb additions)
  /(?:已经|已)[^。！？\n]{0,8}(?:成功|完成|生成|写入|安装|创建|更新|配置|完毕|做完|搞定|修复|删除|存在|保存|导出|发布|注册|登录|订阅|连接|启动|启用|绑定|同步|发送|加密)/,
  // "File X already exists / already generated / confirmed exists"
  /(?:文件|报告|脚本|目录|压缩包|镜像)[^。！？\n]{0,10}(?:已).{0,4}(?:存在|生成|写入|创建|保存|更新|发布)/,
  /确认[^。！？\n]{0,6}(?:存在|创建|生成|完成|注册|登录)/,
  // 英文
  /\b(?:successfully|completed|installed|created|deployed|generated|fixed|done|built|published|registered|signed[\s-]?in|signed[\s-]?up|logged[\s-]?in|subscribed|connected|launched|enabled)\b/i,
  /\bhas\s+been\s+(?:installed|created|generated|completed|deployed|fixed|saved|published|registered|enabled|subscribed|connected|launched)\b/i,
];

// ── Memory claim patterns (P0 new addition) ──────────────────────────────────────────────
//
// "已记住 / 记下了 / 我会记住 / I'll remember" class.
// If the agent says this but no memory_write tool (store_fact / set_fact / etc) was called this turn →
// equivalent to a silent lie. This is a pattern explicitly forbidden by the system prompt but frequently violated by LLMs.
//
// Note: does not capture `存了?` / `存档了?` — words like `存在` / `存放` would cause false positives.
// In Chinese, "memory commitment" natural expressions are just 记住 / 记下 / 备忘, which is sufficient.
const MEMORY_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  // Standalone statements: "我已经记住了" / "记下了" / "备忘"
  // Requires modal (已经/已/这就/马上) or preceding sentence start/punctuation, to avoid false matches in long compound sentences
  /(?:^|[，,。.;:!\s])(?:我)?(?:已经|已|这就|马上|那)?\s*(?:记住|记下|备忘)了?/,
  // "我会/我能/以后/下次/今后 + 记住/记得"
  /(?:我会|我能|以后|下次|今后|从此)\s*(?:记住|记得|留意|遵守|执行|应用)/,
  // 英文(remember/remembered/noting/memorize 等都接受)
  /\bI(?:'?ll| will| have|'?ve)?\s+(?:remember(?:ed)?|not(?:e|ed|ing)|memoriz(?:e|ed|ing)|keep|kept|stored?)\b/i,
  // "I'll keep this in mind" / "keep that in mind" 习语
  /\b(?:I(?:'?ll| will)?\s+)?keep\s+(?:that|this|it)\s+in\s+mind\b/i,
  /\bnoted\b(?!\s+down)/i,  // "Noted." 单独成句也算
];

// ── Tool function classification (verify-before-claim) ────────────────────────────────

// "Non-completion" context to suppress false positives — skip matching when these phrases appear.
// Typical scenarios: agent quoting the user, describing failures, or saying "if X completes" in a conditional.
const ANTI_PATTERNS: ReadonlyArray<RegExp> = [
  // Explicit negation / failure statements
  /(?:没有|未|没|失败|不存在|无法|不能|尚未)[^。！？\n]{0,10}(?:成功|完成|生成|安装)/,
  // Rhetorical questions / conditionals
  /(?:如果|要是|是否|能否)[^。！？\n]{0,15}(?:成功|完成)/,
  // User quotation ("you said...")
  /(?:你说|你刚才说|您说|用户说)[^。！？\n]{0,30}(?:成功|完成)/,
  // Modal / uncertainty hedge — agent admitting uncertainty is not lying (it's honestly saying "I don't know")
  /(?:应该|可能|大概|也许|或许|估计|看起来|貌似)[^。！？\n]{0,8}(?:成功|完成|生成)/,
  /\b(?:probably|likely|maybe|perhaps|estimated|appears\s+to\s+be)\b[^.!?\n]{0,20}(?:complete|success|done)/i,
];

// ── tool_result signals ───────────────────────────────────────────────────

const TOOL_OK_MARK = '✓ TOOL OK';
const TOOL_FAIL_MARK = '⚠ TOOL FAILED';

/**
 * Classify a tool result as success/failure/unknown. Recognizes the ✓/⚠ prefix
 * output by chat-handler's formatToolResultContent. Other forms (old format "Error: ..."
 * or externally assembled) are treated as "unknown" — don't proactively classify as failure to avoid false positives.
 */
export function classifyToolResult(content: string): 'ok' | 'fail' | 'unknown' {
  if (content.startsWith(TOOL_OK_MARK)) return 'ok';
  if (content.startsWith(TOOL_FAIL_MARK)) return 'fail';
  // Legacy format compatibility
  if (/^Error:\s/.test(content)) return 'fail';
  return 'unknown';
}

// ── Tool function classification (verify-before-claim) ────────────────────────────────
//
// destructive: tools that produce new artifacts (write files / download / patch); after completion,
//              usually need an observation tool to confirm the artifact exists and has reasonable size.
// observation: read/list/search tools — these tools are verification themselves.
// neutral:     others (web queries, pure computation, shell because commands vary so much it goes to neutral)
//
// Design: explicitly classify by toolName, don't rely on vague "tool description contains write" heuristic.
// When new tools are added, register them once explicitly.
//
// Note: agent-tools uses camelCase (writeFile/readFile/glob/grep/patch),
//       agent-memory tools use snake_case (store_fact/get_fact/recall_sessions).
//       P0 fix: previously OBSERVATION_TOOLS / DESTRUCTIVE_TOOLS all used camelCase,
//       causing memory tools to always fall into neutral, making verify-before-claim ineffective for memory.
const DESTRUCTIVE_TOOLS = new Set([
  // agent-tools (camelCase)
  'writeFile',
  'downloadFile',
  'patch',
  'jsonPatch',
  // agent-memory (snake_case)
  'store_fact',
  'create_calendar_event',
  'schedule_reminder',
  'cancel_schedule',
]);
const OBSERVATION_TOOLS = new Set([
  // agent-tools (camelCase)
  'readFile',
  'glob',
  'grep',
  // agent-memory (snake_case)
  'get_fact',
  'list_facts',
  'search_notes',
  'search_skills',
  'recall_sessions',
  'list_upcoming',
  'use_skill',
]);

/** Memory-write tools (for memory_claim detection only; subset of DESTRUCTIVE_TOOLS) */
const MEMORY_WRITE_TOOLS = new Set([
  'store_fact',
  'create_calendar_event',
  'schedule_reminder',
  // 'cancel_schedule' is not a write (it essentially disables an existing entry)
]);

export function classifyToolByName(name: string): 'destructive' | 'observation' | 'neutral' {
  if (DESTRUCTIVE_TOOLS.has(name)) return 'destructive';
  if (OBSERVATION_TOOLS.has(name)) return 'observation';
  return 'neutral';
}

/** Whether this is a memory-write tool (for memory_claim detection) */
export function isMemoryWriteTool(name: string): boolean {
  return MEMORY_WRITE_TOOLS.has(name);
}

// ── Shell write operation heuristic (P0.3) ───────────────────────────────────────────
//
// Shell commands are too varied to classify by toolName like writeFile. Use a heuristic:
// if a write signal appears in shell input.command string → treat as destructive (equivalent to writeFile).
// verify-before-claim then also requires a subsequent observation fallback.
//
// Write signals (union):
//   - Shell redirection: `>` / `>>` / `tee` / `Out-File` / `Set-Content` / `Add-Content`
//   - Package manager writes: `pip install` / `npm install` / `apt install` / `apt-get install` /
//     `yum install` / `winget install` / `choco install` / `brew install` /
//     `cargo install` / `go install` / `dotnet add` / `gem install`
//   - Inline interpreter writes: `python -c` / `node -e` containing `open(.*'w')` / `.write(` /
//     `writeFileSync` / `dump(`
//   - File operations: `cp ` / `mv ` / `mkdir ` / `touch ` / `rm ` / `Remove-Item` /
//     `New-Item` / `Copy-Item` / `Move-Item`
const SHELL_WRITE_SIGNALS: ReadonlyArray<RegExp> = [
  // 重定向
  /(?:^|[\s|;])(?:>>?|tee\s)/,
  /\b(?:Out-File|Set-Content|Add-Content)\b/,
  // 包管理(写本机)
  /\b(?:pip(?:3)?|npm|pnpm|yarn|apt|apt-get|yum|dnf|winget|choco|brew|cargo|gem|go|dotnet)\s+(?:install|add|i\b)/i,
  // 解释器内联写
  /(?:python(?:3)?|node|deno)\s+-[ce]\s+["'].{0,500}?(?:open\s*\([^)]*['"]w[+b]*['"]|\.write\(|writeFileSync|dump\s*\(|\.to_csv|\.to_excel|\.to_json|Document\(\)|\.save\()/i,
  // 文件操作命令(强信号)
  /\b(?:cp|mv|mkdir|touch|rm|rmdir|ln)\s+/,
  /\b(?:Remove-Item|New-Item|Copy-Item|Move-Item|Rename-Item)\b/,
  // 编辑器写入
  /\b(?:cat|echo|printf)\s.{0,200}>\s*\S/,
];

/** Whether a shell command appears to be writing an artifact */
export function shellLooksLikeWrite(command: string): boolean {
  if (!command) return false;
  return SHELL_WRITE_SIGNALS.some((re) => re.test(command));
}

// ── Public API ───────────────────────────────────────────────────────────

export interface ToolResultRecord {
  /** Tool name (used for destructive/observation classification) */
  toolName: string;
  /** content string of the tool_result (should already have ✓/⚠ prefix) */
  content: string;
  /**
   * P0.3: input at tool_use time (JSON string or Record), used by tools like shell
   * that classify by command. Optional — callers that don't pass it are treated as neutral
   * (shell write detection is automatically skipped).
   */
  toolInput?: string | Record<string, unknown>;
}

export interface HonestyEvaluation {
  /**
   * severity:
   *   - high   = almost certainly lying (failures ≥ successes + completion claim / memory claim without store /
   *              fabricated numeric size in text not found in tool output)
   *   - medium = completion claim but artifact not verified by observation tool / all tool_results unknown
   *   - low    = not triggered (returns null rather than 'low')
   */
  severity: 'medium' | 'high';
  /** Specific trigger reason */
  reason:
    | 'failures_with_claim'
    | 'unverified_destructive'
    | 'unknown_results_with_claim'
    | 'memory_claim_without_write'
    | 'fabricated_size_claim';
  /** Matched claim phrase (used as reference in reminder message) */
  matchedClaim: string;
  /** tool_result counts for this turn */
  okCount: number;
  failCount: number;
  unknownCount: number;
  /** Explanation text for chat-handler to compose reminder message */
  evidence: string;
}

export interface EvaluateOptions {
  /**
   * All tool_results for this turn (chronological order), including tool name + content.
   * If tool name is missing (old callers passing only content) → treated as 'neutral', verify detection auto-skipped.
   */
  toolResults?: ToolResultRecord[];
  /** @deprecated Legacy API compatibility; new code should use toolResults */
  toolResultContents?: string[];
}

/**
 * Evaluate whether the LLM text is lying or lacks evidence.
 * Returns null = not triggered. Returning high / medium means the caller must take action (inject reminder + regenerate).
 *
 * Detection order (4 levels since P0):
 *   0. Memory claim ("已记住" / "I'll remember") but no memory_write tool this turn → high (memory_claim_without_write)
 *   1. Failures ≥ successes + completion claim → high (failures_with_claim)
 *   2. Destructive tool (incl. shell-write) succeeded but no observation tool fallback + completion claim → medium (unverified_destructive)
 *   3. All tool_results unknown + completion claim → medium (unknown_results_with_claim)
 */
export function evaluateHonesty(
  assistantText: string,
  opts: EvaluateOptions,
): HonestyEvaluation | null {
  // Normalize: toolResults takes priority; fall back to toolResultContents for legacy callers.
  const records: ToolResultRecord[] = opts.toolResults
    ?? (opts.toolResultContents ?? []).map((content) => ({ toolName: '', content }));

  let ok = 0;
  let fail = 0;
  let unknown = 0;
  for (const r of records) {
    const k = classifyToolResult(r.content);
    if (k === 'ok') ok++;
    else if (k === 'fail') fail++;
    else unknown++;
  }

  // ── 0. P0: Memory claim but not actually stored → high ─────────────────────────────────────
  // This is independent of the completion claim path — "已记住" doesn't match COMPLETION_PATTERNS,
  // but it's equally a case of saying one thing and doing another. No memory_write tool succeeded this turn → almost certainly lying.
  const memClaim = findMemoryClaim(assistantText);
  if (memClaim) {
    const memWriteOk = records.some(
      (r) => isMemoryWriteTool(r.toolName) && classifyToolResult(r.content) === 'ok',
    );
    if (!memWriteOk) {
      return {
        severity: 'high',
        reason: 'memory_claim_without_write',
        matchedClaim: memClaim,
        okCount: ok,
        failCount: fail,
        unknownCount: unknown,
        evidence:
          `You said "${memClaim}", but this turn had **no calls** to store_fact / create_calendar_event /` +
          ` schedule_reminder or other memory-write tools. Verbal agreement ≠ persistence.`,
      };
    }
  }

  // ── P0: fabricated_size_claim ────────────────────────────────────────
  // Fabricated specific byte count / KB / MB in text not found in tool output → high.
  // Independent of completion claim — claiming "577KB" without saying "success" is still fabrication.
  const fabricated = findUnsourcedSizeClaim(assistantText, records);
  if (fabricated) {
    return {
      severity: 'high',
      reason: 'fabricated_size_claim',
      matchedClaim: fabricated.raw,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence:
        `Your claimed "${fabricated.raw}" (approximately ${fabricated.bytes} bytes)` +
        ` has no corresponding number in this turn's tool outputs — may have been fabricated. Go back and check the actual numbers from the most recent stat / dir / ls.`,
    };
  }

  // 3 branches after the completion claim
  const claim = findCompletionClaim(assistantText);
  if (!claim) return null;

  // Completely no tool results → indeterminate. Could be a "pure conversation" reply,
  // or state inherited from an earlier turn. This is not a lying signal, pass through.
  if (ok + fail + unknown === 0) return null;

  // 1. Failure count ≥ success count + completion claim → high (strongest signal)
  if (fail > 0 && fail >= ok) {
    return {
      severity: 'high',
      reason: 'failures_with_claim',
      matchedClaim: claim,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence: `This turn had ${fail} tool failure(s) and ${ok} success(es), yet you claimed "${claim}".`,
    };
  }

  // 2. verify-before-claim: **completely stopped firing** (Phase 13.5 round 3, 2026-05-18)
  //
  //    History: this branch originally detected "destructive artifact write without following observation tool" →
  //    medium severity. Production testing (multiple rounds) proved it was unfriendly to real LLM working patterns:
  //      - Run A: failCount=1 okCount=23 → fire (false positive, escaped by threshold)
  //      - Run B: failCount=1 okCount=2  → fire (escaped by threshold)
  //      - Run C: failCount=0 okCount=1  → fire (edge case, still triggered)
  //    Every false positive triggers cap=1 regen → wastes turn + forces LLM to write "reflection" →
  //    plan-auto-close failed → reflection pipeline instability. Nuisance >> value.
  //
  //    Real lying patterns are covered by other branches:
  //      - branch 1 (failures_with_claim): failures ≥ successes + claim → high
  //      - branch 1.5 (fabricated_size_claim): fabricated file size → high
  //      - branch 3 (unknown_results_with_claim): all unknown + claim → medium
  //
  //    2026-06-02 cleanup: prior comments claimed "detectUnverifiedDestructive + shell-write heuristic
  //    retained for K7-bridge external consumption" — audit confirmed this claim was incorrect
  //    (K7-bridge only uses types, does not call these functions).
  //    detectUnverifiedDestructive / effectiveKind / extractShellCommand have no callers, deleted.
  //    classifyToolByName / shellLooksLikeWrite retained temporarily (have unit tests,
  //    are reusable pure functions), but have no production callers.

  // 3. All unknown (old format or non-tool content) + completion claim → medium
  if (fail === 0 && ok === 0 && unknown > 0) {
    return {
      severity: 'medium',
      reason: 'unknown_results_with_claim',
      matchedClaim: claim,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence: `This turn had ${unknown} tool result(s) that are indeterminate (neither success nor failure), yet you claimed "${claim}".`,
    };
  }

  // All ok and no unverified destructive issues → trust
  return null;
}

// Note: effectiveKind / extractShellCommand / detectUnverifiedDestructive were removed
// 2026-06-02 — after branch 2 (unverified_destructive) stopped firing they had no callers,
// see the evaluateHonesty branch 2 comment above for details.

// ── Outcome verification: source verification for "specific numeric claims" like file sizes ────────
//
// Why a separate level: the existing 4 levels of HonestyGate (failures / unverified / unknown /
// memory) don't cover "claimed specific number vs actual tool output". In user conversations,
// the agent fabricated "577KB, format correct" for an 18-byte docx — all tools ✓ + full claim,
// matching no existing branch. This is the most dangerous form of unverified outcome:
// not missing data, but data being **fabricated**.
//
// MVP scope: only capture file sizes (KB/MB/GB/字节/bytes). Other quantitative claims
// (line counts / file counts / durations) are left for future extension; get the most painful
// category right first.
//
// Tolerance: allow +/- 5% (rounding errors / KB-vs-KiB etc) + absolute value < 200 bytes
// (integer rounding for small files). Against a ~30000x gap like "577KB" vs "18 bytes",
// the tolerance range has no effect.

/** A single claim: parsed byte count + original raw string */
export interface SizeClaim {
  raw: string;
  bytes: number;
}

/**
 * Normalize a size string to bytes. Matches:
 *   - "577KB" / "5.7MB" / "1.2GB"
 *   - "902,059 字节" / "18 bytes" / "1024 B"
 *   - Mixed Chinese/English / space-tolerant
 *
 * Non-matching: "577.0KB" with decimal → preserved as decimal (parseFloat handles it).
 */
function parseSizeToken(numStr: string, unit: string): number | null {
  const n = parseFloat(numStr.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  const u = unit.toUpperCase();
  if (u === 'KB' || u === 'KIB') return n * 1024;
  if (u === 'MB' || u === 'MIB') return n * 1024 * 1024;
  if (u === 'GB' || u === 'GIB') return n * 1024 * 1024 * 1024;
  // "字节" / "bytes" / "byte" / "B" → already in bytes
  if (u === '字节' || u === 'BYTES' || u === 'BYTE' || u === 'B') return n;
  return null;
}

// Use (?![A-Za-z]) instead of \b — the latter doesn't work for Chinese "字节" (Chinese characters
// are not word characters in JS regex). Only need to ensure no ASCII letter follows the unit.
const SIZE_RE =
  /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(KB|KiB|MB|MiB|GB|GiB|字节|bytes|byte)(?![A-Za-z])/gi;
// Single letter B is prone to false positives (variable names / abbreviations); separated out
// to require a strict number+space form preceding it
const SIZE_B_RE = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s+B(?![A-Za-z\d])/g;

/** Extract all "file size" claims from text, returning byte count + raw string. */
export function extractSizeClaims(text: string): SizeClaim[] {
  const out: SizeClaim[] = [];
  for (const m of text.matchAll(SIZE_RE)) {
    const bytes = parseSizeToken(m[1], m[2]);
    if (bytes !== null) out.push({ raw: m[0], bytes });
  }
  for (const m of text.matchAll(SIZE_B_RE)) {
    const bytes = parseSizeToken(m[1], 'B');
    if (bytes !== null) out.push({ raw: m[0], bytes });
  }
  return out;
}

/**
 * Extract all numbers that "look like sizes" from tool_output text. Broader than extractSizeClaims:
 * does not require units, because tool outputs mix many forms like "902,059 bytes" / "18" / "size 18" /
 * "1 File(s) 18 bytes" — any number could be the real size.
 * We only care about "whether the claimed byte count can find an approximate match among these numbers".
 */
function extractAllNumbers(text: string): number[] {
  const out: number[] = [];
  // First extract numbers with units (prefer parsing as bytes)
  for (const m of text.matchAll(SIZE_RE)) {
    const bytes = parseSizeToken(m[1], m[2]);
    if (bytes !== null) out.push(bytes);
  }
  // Then extract raw numbers (integers without units, could be byte counts or line/item counts)
  // Since this is a fallback, treat them as bytes directly and add to candidates (if claim is 18 bytes,
  // any tool output containing "18" counts as a match — tolerance provides the false-positive floor)
  const RAW_NUM = /(\d{1,3}(?:,\d{3})+|\d{2,})/g; // ≥2 digits to avoid "0"/"1" noise matching everything
  for (const m of text.matchAll(RAW_NUM)) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Check whether each size claim can find a source in toolOutputs.
 * Returns the first claim **without a source**, or null (all have sources).
 *
 * Tolerance: max(claim × 5%, 200 bytes). Example: claiming 577KB (=590848 bytes), tolerance ±29542,
 * tool output must contain a number in [561306, 620390]. Claiming 18 bytes, tolerance ±200 →
 * any number in [0, 218] counts as a match.
 *
 * This tolerance is intentionally wide: **catching "out of thin air"** matters more than "off by a few digits".
 * Claiming 577KB against tool output (showing only 18 bytes / 902059 bytes) gives 0 matches — stable trigger;
 * conversely, claiming "18 bytes" when the tool actually has 18 bytes is a stable pass.
 */
/**
 * Tools that produce "file size" information — only these tools' output can serve as a baseline for size claims.
 */
const SIZE_PRODUCING_TOOLS: ReadonlySet<string> = new Set([
  'downloadFile', 'inspectPath', 'writeFile', 'readFile', 'glob', 'listDir',
  // shell running dir / ls -la / stat also produces file sizes — most common size source
  'shell',
]);

export function findUnsourcedSizeClaim(
  text: string,
  toolOutputs: ReadonlyArray<ToolResultRecord>,
): SizeClaim | null {
  const claims = extractSizeClaims(text);
  if (claims.length === 0) return null;

  // 2026-05-20 false-positive fix: the baseline for size claims can only come from tools that produce file sizes.
  // Production bug: LLM said PDF "3.7MB" in a replyWithMedia turn (real source was downloadFile bytes=3730357
  // from the previous turn), but the tool this turn was replyWithMedia — output had no byte count,
  // but contained a WeChat channel ID (o9cq801SI55…) that extractAllNumbers extracted as noise numbers,
  // polluting the baseline → false-positive fabrication detection.
  // Fix: only extract numbers from size-producing tool outputs; if no size tools this turn
  // → no trustworthy baseline, don't classify as fabrication (prefer false negatives over false positives).
  const hasToolNames = toolOutputs.some((r) => r.toolName);
  let outputsForNumbers: ReadonlyArray<ToolResultRecord>;
  if (hasToolNames) {
    outputsForNumbers = toolOutputs.filter((r) => SIZE_PRODUCING_TOOLS.has(r.toolName));
    if (outputsForNumbers.length === 0) return null;
  } else {
    // Legacy caller didn't pass toolName → cannot classify, fall back to original behavior (all outputs as baseline)
    outputsForNumbers = toolOutputs;
  }

  const allOutputs = outputsForNumbers.map((r) => r.content).join('\n');
  const sourceNumbers = extractAllNumbers(allOutputs);
  if (sourceNumbers.length === 0) {
    // No tool output to compare → cannot disprove. Let other branches handle (unknown / completion).
    return null;
  }
  for (const claim of claims) {
    const tolerance = Math.max(claim.bytes * 0.05, 200);
    const matched = sourceNumbers.some((n) => Math.abs(n - claim.bytes) <= tolerance);
    if (!matched) return claim;
  }
  return null;
}

/**
 * P0: Find "已记住" / "I'll remember" style memory claims in text, suppressing questions / negations.
 * Returns null if no match.
 */
export function findMemoryClaim(text: string): string | null {
  for (const re of MEMORY_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    const ctxStart = Math.max(0, matchStart - 30);
    const ctxEnd = Math.min(text.length, matchEnd + 10);
    const localCtx = text.slice(ctxStart, ctxEnd);
    let suppressed = false;
    for (const anti of MEMORY_ANTI_PATTERNS) {
      if (anti.test(localCtx)) {
        suppressed = true;
        break;
      }
    }
    if (suppressed) continue;
    return m[0];
  }
  return null;
}

/** Suppress memory_claim false positives */
const MEMORY_ANTI_PATTERNS: ReadonlyArray<RegExp> = [
  // Negation: "没记住" / "我不记得" / "记不住" / "记不清"
  /(?:没|未|不|没有)(?:记住|记得|备忘|记下|存)/,
  /(?:记不(?:住|清|得)|忘了|忘记)/,
  // Rhetorical questions: "你说我已经记住了吗" / "我能记住吗"
  /(?:能|是否|是不是|有没有|可否|要不要)[^。！？\n]{0,15}(?:记住|记得|记下)/,
  // User quotation
  /(?:你说|您说|用户说|刚才说)[^。！？\n]{0,30}(?:记住|记得|记下)/,
  // Modal hedge
  /(?:可能|大概|应该|或许|也许|估计)[^。！？\n]{0,8}(?:记住|记得|记下)/,
];

/**
 * Find the first "completion claim" in text, suppress rhetorical questions / negations / quotation contexts,
 * and return the matched string. Returns null if no match.
 */
export function findCompletionClaim(text: string): string | null {
  for (const re of COMPLETION_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    // Extract ±30 chars around the match as local context, check if anti-pattern is in the same sentence
    const ctxStart = Math.max(0, matchStart - 30);
    const ctxEnd = Math.min(text.length, matchEnd + 10);
    const localCtx = text.slice(ctxStart, ctxEnd);
    let suppressed = false;
    for (const anti of ANTI_PATTERNS) {
      if (anti.test(localCtx)) {
        suppressed = true;
        break;
      }
    }
    if (suppressed) continue;
    return m[0];
  }
  return null;
}
