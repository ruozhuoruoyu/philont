/**
 * askUserQuestion — lets the agent proactively ask the user a question and pause, rather than guessing
 *
 * When to trigger:
 *   - Search returned multiple results requiring disambiguation (e.g. arxiv returns 5 similar papers — which one to download?)
 *   - About to perform an irreversible operation (rm / force-push / delete branch) and needs confirmation
 *   - The user's original prompt is missing a key field, and asking is safer than guessing
 *
 * **Do NOT use** when:
 *   - The user has already implicitly expressed yes/no
 *   - The missing information can be resolved by tools (reading memory / listing files)
 *
 * Behavior contract (execute body only does schema validation):
 *   - chat-handler intercepts this tool call in runToolLoop, renders question + options as a message
 *     to the user, sets pendingQuestion state, then exits the current turn.
 *   - When the user's next message arrives, it is parsed as "option N" or free text and injected
 *     as the tool_result for this tool, continuing the tool loop.
 *   - A digit 1~N from the user matches options[N-1].label; non-digit input is returned as-is if
 *     allowFreeText is set, otherwise the user is prompted to pick again.
 */

import type { Tool } from '@agent/policy';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 9;
const MAX_LABEL_CHARS = 80;

export const askUserQuestionTool: Tool = {
  name: 'askUserQuestion',
  description:
    [
      'Ask the user a multiple-choice question and pause until they reply.',
      'Use when: search returned ambiguous results / about to do something destructive / user prompt is missing a key parameter and asking is safer than guessing.',
      'Do NOT use for yes/no the user already implied, or for info you can read from memory or files.',
      'The user\'s next message becomes this tool\'s result: a digit 1-N picks options[N-1]; otherwise (when allowFreeText=true) the raw text is returned.',
    ].join(' '),
  schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask. Be specific about what you need clarified.',
      },
      options: {
        type: 'array',
        description: `Numbered options the user can pick from (${MIN_OPTIONS}-${MAX_OPTIONS} items).`,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: `Short label, ≤ ${MAX_LABEL_CHARS} chars` },
            description: { type: 'string', description: 'Optional one-line clarification.' },
          },
          required: ['label'],
        },
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
      },
      allowFreeText: {
        type: 'boolean',
        description:
          'If true, accept any reply as a free-text answer instead of forcing a numeric pick. Default false.',
      },
    },
    required: ['question', 'options'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const question = typeof params.question === 'string' ? params.question.trim() : '';
    if (!question) {
      return { success: false, output: '', error: 'question is required and must be a non-empty string' };
    }
    const options = params.options;
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return {
        success: false,
        output: '',
        error: `options must be an array of ${MIN_OPTIONS}-${MAX_OPTIONS} items`,
      };
    }
    for (let i = 0; i < options.length; i++) {
      const o = options[i] as { label?: unknown; description?: unknown } | null;
      if (!o || typeof o !== 'object') {
        return { success: false, output: '', error: `options[${i}] must be an object with a label` };
      }
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      if (!label) {
        return { success: false, output: '', error: `options[${i}].label is required` };
      }
      if (label.length > MAX_LABEL_CHARS) {
        return {
          success: false,
          output: '',
          error: `options[${i}].label exceeds ${MAX_LABEL_CHARS} chars`,
        };
      }
    }
    // chat-handler intercepts this tool; the real side effects (rendering + pausing) happen there.
    // The output returned here is never consumed — runToolLoop exits immediately when this tool is called, without pushing a tool_result.
    return { success: true, output: '__pending_user_response__' };
  },
};

/** Pure function used by chat-handler to render the "❓ question + numbered options" text */
export function renderQuestion(
  question: string,
  options: ReadonlyArray<{ label: string; description?: string }>,
  allowFreeText: boolean,
): string {
  let out = `❓ ${question}\n\n`;
  options.forEach((o, i) => {
    out += `${i + 1}. ${o.label}`;
    if (o.description) out += ` — ${o.description}`;
    out += '\n';
  });
  out += allowFreeText
    ? '\n(reply with the option number, or just type your answer)\n'
    : `\n(reply with a number between 1 and ${options.length})\n`;
  return out;
}

export type ParsedAnswer =
  | { kind: 'option'; index: number; label: string; content: string }
  | { kind: 'freetext'; content: string }
  | { kind: 'reprompt'; message: string };

/**
 * Parse the user's reply:
 *   - Full/half-width digit at the start + within range → option
 *   - Digit at the start but out of range → reprompt (user typo, worth prompting)
 *   - Empty reply → reprompt (no content to parse)
 *   - Any other non-digit content → freetext (regardless of the allowFreeText flag!)
 *
 * 2026-05-07 fix: allowFreeText is no longer used as a gate. Observed in production (WeChat channel):
 * the LLM almost always sets allowFreeText=false, but users in IM almost never reply with a number —
 * they reply in natural language ("the X mentioned earlier" / "that deepseek paper").
 * This caused: reprompt → user answers again → reprompt again → dead loop.
 *
 * New behavior: the parse layer is always permissive — non-empty, non-digit replies are converted to
 * freetext and fed to the LLM to judge "is this a reasonable answer to my question". The LLM is smarter
 * than a regex. allowFreeText now only controls **rendering hint text** ("reply with a number" vs
 * "reply with a number or free text") and no longer gates parsing.
 */
export function parseQuestionAnswer(
  reply: string,
  question: string,
  options: ReadonlyArray<{ label: string; description?: string }>,
  allowFreeText: boolean,
): ParsedAnswer {
  const trimmed = (reply ?? '').trim();

  // Empty reply → reprompt
  if (trimmed.length === 0) {
    return {
      kind: 'reprompt',
      message:
        `Please reply with a number between 1 and ${options.length}.\n` +
        renderQuestion(question, options, allowFreeText),
    };
  }

  // Full-width digits → half-width
  const normalized = trimmed.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0),
  );
  const m = normalized.match(/^(\d+)/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < options.length) {
      const label = options[idx].label;
      return {
        kind: 'option',
        index: idx,
        label,
        content: `User selected option [${idx + 1}]: ${label}`,
      };
    }
    // Digit but out of range — user seems to have picked but chose incorrectly; worth reprompting
    return {
      kind: 'reprompt',
      message:
        `Please choose between 1 and ${options.length}; you replied "${trimmed}".\n` +
        renderQuestion(question, options, allowFreeText),
    };
  }

  // Non-digit content → freetext (regardless of allowFreeText). Let the LLM decide.
  // Even if the LLM originally set allowFreeText=false, this is better than a reprompt dead loop.
  return { kind: 'freetext', content: `User reply (free text): ${trimmed}` };
}
