/**
 * Short-answer binding heuristic
 *
 * Problem: the agent asks a question in turn N; in turn N+1 the user answers "yes"; but in
 * turn N+1 the agent treats it as a new topic (askUserQuestion three-choice, completely
 * ignoring the user's answer). This module detects "whether the last assistant message has
 * an unclosed question" at the server's inbound pre-processing point, then injects an explicit
 * hint to guide the LLM to interpret the input as a reply first, and adds a guard on the
 * askUserQuestion path to reject follow-up questions.
 *
 * Design:
 *   - Heuristic only looks at the last 200 characters (questions are usually at the end);
 *     avoids false positives from rhetorical questions or questions in the body text
 *   - Does not distinguish short vs long user responses: always injects; cost is only a
 *     few dozen tokens
 *   - tool_use / tool_result form assistant messages (content is an array) are skipped;
 *     only string-content "natural language" messages are examined
 *   - Injected copy explicitly guides the LLM: **prefer** to interpret as a reply to the
 *     previous question; only switch to a new topic if clearly confirmed; must not silently
 *     discard the user's previous answer
 */

/** If these punctuation marks appear in the last few characters, it is almost certainly a question */
const QUESTION_MARK_RE = /[?？]/;

/** Common Chinese and English question phrases, as a supplement to question marks (some LLM output lacks question marks but is semantically a question) */
const QUESTION_PATTERNS: RegExp[] = [
  // Chinese explicit question words
  /请回复/, /请告诉/, /请回答/, /请说明/, /请确认/, /请选择/,
  /要不要/, /是否/, /还是/, /哪个/, /哪一/, /哪些/, /哪种/,
  /告诉我/, /可以吗/, /是吗/, /对吗/, /好吗/, /行吗/,
  /怎么(?:办|样|做)/, /如何处理/, /需要(?:我|你)/,
  // English
  /\bdo you\b/i, /\bwould you\b/i, /\bcan you\b/i, /\bcould you\b/i,
  /\bwhich\b/i, /\bwhat (?:do|should|would)\b/i,
  /\bare you\b/i, /\bwill you\b/i,
];

/** Number of trailing characters to examine */
const TAIL_CHARS = 200;

/** Max length of the snippet extracted from the question tail to show the LLM */
const SNIPPET_MAX = 100;

export interface QuestionDetectResult {
  hasQuestion: boolean;
  /** Context snippet of "what you just asked" to show the LLM */
  snippet: string;
}

/**
 * Detect whether an assistant text contains an unclosed question.
 *
 * Note: this function only checks **structure** (trailing question mark / question phrase),
 * not **semantics** (whether it truly requires a user answer vs. a rhetorical question).
 * Semantic judgment is left to the LLM; our goal is to minimise missed detections.
 */
export function detectUnclosedQuestion(text: unknown): QuestionDetectResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { hasQuestion: false, snippet: '' };
  }
  const trimmed = text.trim();
  const tail = trimmed.slice(-TAIL_CHARS);

  if (QUESTION_MARK_RE.test(tail)) {
    // Find the last sentence containing a question mark
    const segments = tail.split(/[。.\n!！]+/).map((s) => s.trim()).filter(Boolean);
    let last = segments[segments.length - 1] ?? tail;
    if (!QUESTION_MARK_RE.test(last) && segments.length >= 2) {
      // The last segment is sometimes "please reply with a number 1-3" etc.;
      // walk backwards to find the segment containing the question mark
      for (let i = segments.length - 1; i >= 0; i--) {
        if (QUESTION_MARK_RE.test(segments[i])) {
          last = segments[i];
          break;
        }
      }
    }
    return { hasQuestion: true, snippet: last.slice(0, SNIPPET_MAX) };
  }

  for (const pat of QUESTION_PATTERNS) {
    const m = tail.match(pat);
    if (m && typeof m.index === 'number') {
      const start = Math.max(0, m.index - 30);
      const surround = tail.slice(start, m.index + 60).trim();
      return { hasQuestion: true, snippet: surround.slice(0, SNIPPET_MAX) };
    }
  }

  return { hasQuestion: false, snippet: '' };
}

/**
 * Walk messages[] in reverse to find the most recent "natural language assistant" message
 * (skipping tool_use array-form messages). Returns its string content, or null if absent.
 *
 * @param messages Message array
 * @param startBefore Only look at messages with index < startBefore; defaults to the end
 */
export function findLastAssistantText(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  startBefore?: number,
): string | null {
  const start = startBefore ?? messages.length;
  for (let i = start - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string' && m.content.trim().length > 0) {
      return m.content;
    }
  }
  return null;
}

/**
 * Walk messages[] in reverse to find the most recent "natural language user" message
 * (skipping tool_results array-form messages). Returns its string content, or null if absent.
 *
 * Companion to findLastAssistantText; used by the askUserQuestion guard to retrieve the
 * user's previous reply.
 */
export function findLastUserText(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  startBefore?: number,
): string | null {
  const start = startBefore ?? messages.length;
  for (let i = start - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string' && m.content.trim().length > 0) {
      return m.content;
    }
  }
  return null;
}

/**
 * Render the binding context to inject into the system section.
 * Follows the same format as recall_trigger injection in chat-handler.ts (`## ⚠️` heading).
 */
export function renderBindingContext(
  priorQuestionSnippet: string,
  userReply: string,
): string {
  const reply = userReply.trim().slice(0, 200);
  return (
    `\n\n## ⚠️ 上一轮你问的问题尚未明确闭合\n` +
    `[你问: ${priorQuestionSnippet}]\n` +
    `[本轮 user 答: ${reply}]\n` +
    `请**优先**把 user 此次回应解读为对你上一问的回答并直接执行;` +
    `若确实是新话题,先显式说明你在切换话题再切换。**不要**默默丢掉 user 上一个答复。`
  );
}

/**
 * Rejection message shown to the LLM when the askUserQuestion guard fires.
 * Must contain the original question snippet + user reply so the LLM can rewrite on the
 * next iteration.
 */
export function renderAskGuardRejection(
  priorQuestionSnippet: string,
  userReply: string,
): string {
  const reply = userReply.trim().slice(0, 200);
  return (
    `[ask_guard] 拒绝调用 askUserQuestion:你上一轮已问过 "${priorQuestionSnippet}",` +
    `user 已回复 "${reply}"。请先消化这个回复并直接给出答复 / 执行,` +
    `不要二次追问。如果 user 回复确实未答你的问题,在文本里先复述你的原问 + 解释为何还需追问,` +
    `而不是直接 askUserQuestion。`
  );
}
