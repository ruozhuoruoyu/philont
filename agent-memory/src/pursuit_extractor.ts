/**
 * SessionPursuitExtractor: after a session ends, identifies "unclosed investigation topics"
 * from the conversation and proposes shadow-state pursuits.
 *
 * Parallel to SessionExtractor:
 *   - SessionExtractor      produces facts + notes (Layer 2 / Layer 1)
 *   - SessionReflector      produces skills (Layer 3)
 *   - SessionPursuitExtractor produces shadow pursuits (generation layer; requires subsequent evidence
 *     or user confirmation before activation)
 *
 * Pursuits produced here default to shadow state — the agent has a "vaguely tracked topic" but it
 * will not immediately cause the drive to inject during conversation. The reflector advances it to
 * active only when evidence accumulates across sessions or the user explicitly confirms.
 * This is the first safety brake for autonomous behavior.
 */

import type { ExtractorLlmClient } from './extractor.js';
import type { PursuitStore } from './pursuit.js';
import type { RawStore } from './raw.js';
import type { Pursuit, PursuitInput, RawMessage } from './types.js';
import type { MemoryAuditHook } from './audit.js';
import { BOOTSTRAP_ROOT_PURSUIT_ID } from './schema.js';

// ── LLM output structure ──────────────────────────────────────────────────────

interface PursuitProposalAction {
  action: 'propose_pursuit';
  title?: string;
  intent?: string;
  open_questions?: string[];
  stake?: 'low' | 'medium' | 'high';
}

// ── Prompt ─────────────────────────────────────────────────────────────

function buildPrompt(messages: RawMessage[]): string {
  const dialogue = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n');

  return (
    `You are an "intent extractor" for an agent. Your task: scan the completed conversation below,
identify **cross-turn investigation topics that have not been closed**, and propose registering them as pursuits
(in shadow state, to be activated once more evidence accumulates across sessions).

## What counts as an "unclosed investigation topic"

All four conditions must be met to register:

1. **Persistent**: Appeared at least twice in the conversation, or explicitly expressed by the user as "long-term tracking" / "ongoing attention".
2. **Open-ended**: At least one question without a clear answer (open question) — not just a one-time fact like "the user learned X".
3. **Beyond a single task**: Not a task that was completed or abandoned within this session (e.g. "help me write this code" that's done doesn't count).
4. **User-relevant**: The agent's own introspection ("I want to learn X") doesn't count — must be traceable to the user's intent, question, or scenario.

Examples:
- User repeatedly mentions headaches + sleep + work stress, agent has tentatively responded → Register
  pursuit "understand user's headache triggers", open_questions = ["Frequency?", "Trigger factors?"]
- User only asked "what's the weather today" → don't register (one-time, no open question)
- Conversation discussed specific code implementation that was completed → don't register (single task)

## Common false positives (avoid these)

- Registering a one-time task as a pursuit
- Registering something that a fact can fully describe (e.g. user said "my name is John" is not a pursuit)
- Registering a pursuit too broad (e.g. "help the user" — without open_questions it can't drive a drive)

## Output format

Return a strict JSON array. The array may be empty. Each element is a propose_pursuit action:

{
  "action": "propose_pursuit",
  "title": "Understand user's headache pattern",
  "intent": "Identify trigger factors and provide actionable advice",
  "open_questions": ["Frequency of episodes?", "Common triggers?", "Correlation with sleep?"],
  "stake": "medium"
}

- title: human-readable title, 5-15 words
- intent: 1-2 sentence goal statement
- open_questions: 2-5 unresolved questions, one sentence each
- stake: "low" / "medium" / "high", default "medium"

**Prefer to miss rather than over-report**. If no topic meeting all four conditions is found, return an empty array \`[]\`.
Do not output any other text, code block markers, or explanations.

## Conversation

`
    + dialogue
    + '\n\nOutput (strict JSON array):'
  );
}

// ── Parsing ───────────────────────────────────────────────────────────────

function parseProposals(text: string): PursuitProposalAction[] {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PursuitProposalAction =>
        x && typeof x === 'object' && x.action === 'propose_pursuit'
    );
  } catch {
    return [];
  }
}

// ── Public interface ───────────────────────────────────────────────────────

export interface PursuitExtractResult {
  /** Number of shadow pursuits created this run */
  pursuitsProposed: number;
  /** Estimated token cost of the LLM call */
  llmCostTokens: number;
  /** List of newly created pursuits */
  pursuits: Pursuit[];
}

export interface SessionPursuitExtractorOptions {
  auditHook?: MemoryAuditHook;
  /** Default root to assign to (single-agent scenario uses BOOTSTRAP_ROOT_PURSUIT_ID) */
  rootPursuitId?: string;
}

export class SessionPursuitExtractor {
  private readonly auditHook: MemoryAuditHook | undefined;
  private readonly rootId: string;

  constructor(
    private readonly llm: ExtractorLlmClient,
    private readonly pursuits: PursuitStore,
    private readonly raw: RawStore,
    options: SessionPursuitExtractorOptions = {}
  ) {
    this.auditHook = options.auditHook;
    this.rootId = options.rootPursuitId ?? BOOTSTRAP_ROOT_PURSUIT_ID;
  }

  async extractFromSession(sessionId: string): Promise<PursuitExtractResult> {
    const messages = this.raw.getMessages(sessionId);
    return this.extractFromMessagesInternal(messages, sessionId);
  }

  /** K0: propose pursuits by time range (global timeline version) */
  async extractFromTimeRange(fromTs: number, toTs: number): Promise<PursuitExtractResult> {
    const messages = this.raw.queryTimeline({
      fromTs,
      untilTs: toTs,
      order: 'asc',
      limit: 5_000,
    });
    return this.extractFromMessagesInternal(messages, `range:${fromTs}-${toTs}`);
  }

  private async extractFromMessagesInternal(
    messages: ReturnType<RawStore['queryTimeline']>,
    tag: string,
  ): Promise<PursuitExtractResult> {
    if (messages.length < 4) {
      // conversation too short; unlikely to have "cross-turn unclosed topics"
      return { pursuitsProposed: 0, llmCostTokens: 0, pursuits: [] };
    }

    const prompt = buildPrompt(messages);
    const { text, tokensUsed } = await this.llm.complete(prompt);
    const proposals = parseProposals(text);

    const created: Pursuit[] = [];
    for (const p of proposals) {
      if (!p.title || !p.intent) continue;
      try {
        const input: PursuitInput & { parentPursuitId: string } = {
          parentPursuitId: this.rootId,
          title: p.title,
          intent: p.intent,
          origin: 'extractor',
          status: 'shadow', // key: new pursuits default to shadow state
          stake: p.stake ?? 'medium',
          openQuestions: (p.open_questions ?? []).map((q) => ({ text: q })),
        };
        const pursuit = this.pursuits.createChild(input);
        created.push(pursuit);
        this.auditHook?.append('self_domain_write', {
          source: 'extractor',
          origin: 'Internal',
          toolName: 'create_pursuit',
          sessionId: tag,
          pursuitId: pursuit.id,
          status: pursuit.status,
          rootPursuitId: pursuit.rootPursuitId,
        });
      } catch {
        // invalid id or parent not found etc.; skip individual entry without fatal error
      }
    }

    return {
      pursuitsProposed: created.length,
      llmCostTokens: tokensUsed,
      pursuits: created,
    };
  }
}
