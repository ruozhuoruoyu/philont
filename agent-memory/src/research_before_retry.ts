/**
 * ResearchBeforeRetry — general mechanism to ensure "must research before acting after failure".
 *
 * Design motivation (mycox in-practice 2026-05-14):
 *   LLM repeatedly tried vote endpoints (POST /api/posts/<id>/vote / /api/votes/post/<id>
 *   / /api/votes), all 404, **varying approaches but all guessing, never checking the guide**.
 *   in-turn-reflection blocked remaining http in this turn, but schedule resets on next turn →
 *   LLM guesses variations from memory again → hits the same wall.
 *
 * This mechanism: when in-turn-reflection fires, if LLM has not called any research
 * tools this turn, **force LLM to research before acting**.
 *
 * Trigger conditions:
 *   1. in-turn-reflection has fired (same toolName + same errorClass ≥ 2 times)
 *   2. inTurnRecords for this turn contains no research tool calls
 *
 * Interception behavior:
 *   - Next time LLM calls a **business tool** (non-research, non-plan-gate exempt) → reject
 *     + forced guidance reminder (priority: already-fetched guide → list_facts → search_skills →
 *     webFetch fresh)
 *   - LLM calls one research tool → unlock (regardless of success/failure, LLM demonstrates "research" intent)
 *   - Business tool calls proceed normally after unlock, retry allowed
 *
 * Philosophy (mechanism, not policy):
 *   - Mechanism layer enforces "research before action", does not specify **what to research** (LLM decides)
 *   - Does not find answers for LLM (that is LLM's policy)
 *   - General pattern — not just for mycox vote 404, any "guessed without checking" pattern triggers this
 */

/**
 * Research tool whitelist. These tools produce "facts" (persisted files / memory / remote docs),
 * providing decision-making basis for the LLM.
 *
 * Overlaps with but differs from plan-gate exempt rules (Phase 12 changed to capability/domain decisions):
 *   - plan-gate exempt also includes plan_* / task_mode_classify (protocol tools, not research)
 *     + all read tools (via capability) + self×write (via 3×4 consistency)
 *   - This set contains only truly read-only research tools (used for research-before-retry unlock judgment)
 */
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  // File reads
  'readFile',
  'inspectPath',
  'listDir',
  'glob',
  'grep',
  // Network reads
  'webFetch',
  'webSearch',
  // Memory / skill retrieval
  'get_fact',
  'list_facts',
  'search_notes',
  'search_skills',
  'recall_sessions',
]);

/**
 * Check whether a tool is a research tool.
 *
 * env PHILONT_RESEARCH_BEFORE_RETRY_TOOLS="comma,separated" can override the default set,
 * e.g. if some third-party tool should be added to the research whitelist.
 */
export function isResearchTool(toolName: string): boolean {
  const envOverride = process.env.PHILONT_RESEARCH_BEFORE_RETRY_TOOLS?.trim();
  if (envOverride) {
    const custom = new Set(envOverride.split(',').map((s) => s.trim()));
    return custom.has(toolName);
  }
  return RESEARCH_TOOLS.has(toolName);
}

/**
 * Check whether the tool call records in this turn include any research calls.
 * Input is the inTurnRecords maintained by chat-handler.
 */
export function hasResearchCallInTurn(
  records: ReadonlyArray<{ toolName: string }>,
): boolean {
  for (const r of records) {
    if (isResearchTool(r.toolName)) return true;
  }
  return false;
}

/**
 * Generate the interception reminder text.
 *
 * @param failedTool Tool name that triggered in-turn-reflection (e.g. http)
 * @param failedSignature Failure signature (e.g. http:http-404)
 * @param attemptedTool The business tool LLM is about to call (being blocked)
 */
export function buildResearchReminder(
  failedTool: string,
  failedSignature: string,
  attemptedTool: string,
): string {
  return (
    `[Drive ResearchBeforeRetry] This turn you repeatedly failed ${failedTool} (${failedSignature}),` +
    ` but **have not called any research tools** (readFile / webFetch / search_skills / list_facts, etc.).\n\n` +
    `The mechanism is blocking you from calling ${attemptedTool} directly — **you must research first**. Priority order:\n` +
    `\n` +
    `  1. **Already-fetched resources**: Documents you previously webFetched are saved in \`~/.philont/workspace/fetched/\`\n` +
    `     → Call readFile or inspectPath to view the local copy, which may contain the correct endpoint / field definition\n` +
    `\n` +
    `  2. **Historical success paths**: A previous schedule may have already stored the correct solution as a fact / note\n` +
    `     → Call list_facts(namespace='service.*') or search_notes(query) to check\n` +
    `\n` +
    `  3. **Ready-made solutions**: There may be a bundled skill for a similar task\n` +
    `     → Call search_skills(query) to check\n` +
    `\n` +
    `  4. **Fresh fetch**: If none of the above → webFetch the service docs / API spec fresh\n` +
    `\n` +
    `After researching and obtaining key information (quote the actual endpoint/field/syntax you found), retry the business tool.\n` +
    `**Prohibited**: Guessing variations from memory (changing URL pattern / parameter name / method) — hitting the same root cause means guessing won't produce the answer.\n` +
    `\n` +
    `This is an in-turn correction; this reminder is not shown to the user. Set env PHILONT_RESEARCH_BEFORE_RETRY=0 to disable.`
  );
}
