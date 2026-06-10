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
    `[drive reflection-trigger] You have just failed the same way ${count} times within this turn (signature=${signature}).`,
    '',
    '**Your first reaction should NOT be "try again / tweak the params" — reflect on the failure TYPE; different types call for different actions.**',
    '',
    '[Step 1: snap-classify the failure into 1 of 4 types — pick the closest]',
    '- **transient** (network jitter / temporary timeout / 5xx service briefly unreachable)',
    '  → wait briefly and retry ONCE, **at most once**; if it fails again, go to a branch below',
    '- **auth** (401 / 403 / "key invalid" / "expired token" / "unauthorized")',
    '  → call `listCredentialNames` to check the key exists; check the placeholder is the `{<name>}` form',
    '  → do NOT read a `*_prefix` field from a fact and splice it as the full key',
    '- **param** (400 / "missing field X" / "invalid value" / schema mismatch)',
    '  → re-read the tool description + the params you just sent; compare which field is missing / mistyped',
    '- **method** (404 / "not found" / "method not allowed" / "endpoint does not exist")',
    '  → **the path or method itself is wrong**, params cannot fix it; you MUST check the docs and re-read the URL/method',
    '',
    '[Step 2: if you cannot classify the type, you do not truly understand this failure — consult the docs before acting]',
    '- `search_skills(<keywords of the current task>)` — is there a ready-made solution?',
    '- `list_facts({namespace:"<relevant namespace>"})` — how were similar cases handled before?',
    '- `webFetch(guide_ref)` or `readFile(guide path)` — re-read the guide for the step you missed',
    '- If there is a SKILL.md: `use_skill` again and read it fully — check the failure-handling table + Anti-patterns',
    '',
    '[Step 3: if genuinely blocked — wrap up this turn, do not grind on]',
    '- `store_note({title:"task blocked: ' + signature + '", body:"analysis: <the failure type you determined>; tried: <what you did>; still need: <info the user must supply>"})`',
    '- the body **must** contain the three parts "analysis / tried / still need" (for later distillation)',
    '- then reply to the user in the two-section format: what you did / where it is blocked / what the user should supply',
    '',
    '**Anti-patterns — do NOT do these:**',
    '- ✗ keep retrying the same call without changing the params',
    '- ✗ switch to an unrelated tool and hit another wall (workspace shell failed → bash shell hits it too)',
    '- ✗ change the URL / endpoint from memory (without checking the docs)',
    '',
    'This reminder fires only once per turn; if you keep repeating the same mistake, just store_note and wrap up.',
    '',
  ].join('\n');
}
