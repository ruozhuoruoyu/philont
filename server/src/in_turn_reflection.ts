/**
 * In-turn failure-driven reflection injection (2026-05-10)
 *
 * Design principle: when the agent fails, its first reaction should be **reflection**,
 * not another retry.
 *
 * The existing mechanism only triggers reflection at turn close / idle tick (reflection.ts);
 * when the agent encounters repeated failures **inside** a turn, the LLM tends to "try
 * again / tweak parameters" and repeat the same mistake. This violates the self-iteration
 * principle: the first reaction should be "did I follow the guide? did I miss a step?"
 *
 * This mechanism: before each LLM call in the main tool loop, scan the accumulated
 * toolResults for the current turn; when same-root-cause failures reach the threshold,
 * inject a one-shot system reminder that forces the agent to pause retrying → call
 * search_skills / use_skill to re-read the flow / store_note to wrap up.
 *
 * Generic — does not care about specific service / skill / tool names; applies to any
 * repeated-failure scenario:
 *   - HTTP API repeated 4xx/5xx
 *   - shell commands repeated cmd-not-found
 *   - get_fact repeatedly not finding a key
 *   - Any same-signature failure cluster
 *
 * Complements reflection.ts (turn close):
 *   - reflection.ts: reflects after a completed turn, generates routing rules / playbooks
 *     (used in the next turn)
 *   - in-turn: **while the turn is in progress**, proactively calls a halt so the LLM
 *     self-corrects immediately (used in the current turn)
 */

import { extractFailureSignature } from '@agent/memory';

/** Single tool call record within a turn (for the detector) */
export interface InTurnToolRecord {
  toolName: string;
  /** Whether the call succeeded */
  success: boolean;
  /** On failure: the error / output text returned by the tool (used for signature extraction); on success: may be empty */
  resultText?: string;
  /**
   * Phase 12 cont (2026-05-17): tool input snapshot; extracted at turn close by
   * ScheduleOutcomeStore summary for http method/url. Only filled for http tools;
   * other tools skip to avoid bloat / privacy issues.
   */
  toolInput?: Record<string, unknown>;
}

export interface InTurnReflectionResult {
  /** Whether a failure pattern was detected that warrants triggering reflection */
  triggered: boolean;
  /** The matched signature (toolName:errorClass:arg) — given to caller for audit on trigger */
  signature?: string;
  /** Number of failures with the same signature */
  count?: number;
  /** Reminder text to show the LLM when reflection is triggered (includes markdown frame) */
  reminder?: string;
}

/**
 * Detect failure patterns within a turn.
 *
 * Algorithm:
 *   1. Extract entries with success=false from records
 *   2. Group by extractFailureSignature(toolName, resultText)
 *   3. Take the count of the largest group; if count ≥ threshold → triggered=true
 *
 * Design choices:
 *   - Full-turn cumulative (no sliding window); turns with dozens of calls are small enough to scan fully
 *   - Single signature match (no multi-signature aggregation) — more precisely captures "same problem"
 *   - **Default threshold 2** — catches "the first repetition", consistent with the self-iteration principle:
 *       - 1 failure: may be transient; LLM naturally pivots without intervention
 *       - 2 failures with same signature: **earliest evidence the LLM is not self-correcting** → intervene
 *       - 3+ failures: reminder already injected (one-shot per turn); do not spam
 *   - Different from turn-close sameRootCauseFailures ≥ 3: that is "whether to reflect on the whole turn
 *     experience" with a looser threshold; mid-turn intervention should be more sensitive (every wasted
 *     retry is expensive)
 */
export function detectInTurnFailurePattern(
  records: InTurnToolRecord[],
  threshold: number = 2,
): InTurnReflectionResult {
  if (records.length === 0) return { triggered: false };

  const groups = new Map<string, number>();
  for (const r of records) {
    if (r.success) continue;
    const sig = extractFailureSignature(r.toolName, r.resultText ?? '');
    if (!sig) continue;
    // 2026-05-26 finding: plan_protocol_gate / in_turn_tool_block /
    // autonomous_blacklist / research_before_retry "mechanism-layer deliberate rejections"
    // were being counted as failures in the same-root-cause clustering; 2 occurrences would
    // trigger in-turn-reflection and lock tools. The mechanism-layer guidance (intended:
    // direct LLM to plan_draft / search_skills) ended up locking tools — self-defeating.
    //
    // These rejections are not the LLM hitting a wall; they are protocol-layer ON-PURPOSE
    // stops. The LLM should self-adapt when it sees this rejection text
    // (signature looks like shell:other:[plan_protocol_gate]...).
    if (
      /:other:\[(plan_protocol_gate|in_turn_tool_block|autonomous_blacklist|research[_-]?before[_-]?retry)\b/i.test(
        sig,
      )
    ) {
      continue;
    }
    groups.set(sig, (groups.get(sig) ?? 0) + 1);
  }

  if (groups.size === 0) return { triggered: false };

  let maxSig = '';
  let maxCount = 0;
  for (const [sig, count] of groups) {
    if (count > maxCount) {
      maxSig = sig;
      maxCount = count;
    }
  }

  if (maxCount < threshold) return { triggered: false };

  return {
    triggered: true,
    signature: maxSig,
    count: maxCount,
    reminder: buildReflectionReminder(maxSig, maxCount),
  };
}

/**
 * Render the system reminder text.
 *
 * Wording principles:
 *   - **Generic** — does not name a specific service / skill / tool (so the pattern works across scenarios)
 *   - **Focus on reflection** — first reaction is to examine, not retry (self-iteration principle)
 *   - **Explicit next step** — choose one of: search_skills / use_skill / store_note
 *   - **One-shot** — reminder text states "only triggered once per turn" to prevent the LLM
 *     from expecting another reminder
 */
function buildReflectionReminder(signature: string, count: number): string {
  return [
    '',
    `[内驱 reflection-trigger] 你刚才在本 turn 内已经 ${count} 次同样失败 (signature=${signature})。`,
    '',
    '**第一反应不应该是"再试一次 / 换参数",而是反思失败类型 — 不同类型对应不同行动。**',
    '',
    '【第 1 步:失败 4 类速判 — 选一个最贴近的】',
    '- **transient**(网络抖动 / 临时超时 / 5xx 服务暂时不可达)',
    '  → 可控等待后重试 1 次,**最多 1 次**;再失败转下面分支',
    '- **auth**(401 / 403 / "key invalid" / "expired token" / "unauthorized")',
    '  → 调 `listCredentialNames` 看 key 是否在;占位符语法是否 `{<name>}` 形式',
    '  → 不要从 fact 里读 `*_prefix` 字段拼当完整 key',
    '- **param**(400 / "missing field X" / "invalid value" / schema 不匹配)',
    '  → 重读工具 description + 你刚才传的 params,对比缺哪个字段 / 类型错',
    '- **method**(404 / "not found" / "method not allowed" / "endpoint does not exist")',
    '  → **路径或方法本身错了**,不是参数能修的;必须查文档重读 URL/method',
    '',
    '【第 2 步:若不能判类型,说明你没真懂这次失败 — 必须查文档再行动】',
    '- `search_skills(<当前任务关键词>)` — 找有没有现成解法',
    '- `list_facts({namespace:"<相关 namespace>"})` — 看历史上同类怎么处理',
    '- `webFetch(guide_ref)` 或 `readFile(guide path)` — 重读指引找漏的步骤',
    '- 若有 SKILL.md:重新 `use_skill` 完整读一遍,检查失败处理表 + Anti-patterns',
    '',
    '【第 3 步:实在阻塞 — 收尾本 turn,不要硬撑】',
    '- `store_note({title:"任务阻塞: ' + signature + '", body:"分析: <你判定的失败类型>;尝试: <做过什么>;还需要: <user 该补的信息>"})`',
    '- body **必须**含"分析 / 尝试 / 还需要"三段(给后续蒸馏用)',
    '- 然后两段式回复 user 说明:做了什么 / 阻塞在哪 / user 该补什么',
    '',
    '**反模式 — 看到不要做**:',
    '- ✗ 继续重试同一调用不改参数',
    '- ✗ 换无关工具撞另一面墙(workspace shell 失败 → 改 bash shell 也撞)',
    '- ✗ 凭印象改 URL / endpoint(没查文档)',
    '',
    '本 turn 只触发一次此提醒,后续仍重蹈覆辙请直接 store_note 收尾。',
    '',
  ].join('\n');
}
