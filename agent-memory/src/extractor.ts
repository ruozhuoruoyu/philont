/**
 * SessionExtractor: batch extraction after a session ends
 *
 * Steps:
 *   1. Read the raw conversation from Layer 0
 *   2. Call LLM once, prompting it to output a store_fact / store_note call sequence
 *   3. Parse the response and batch-write
 *
 * Key: the extraction prompt includes namespace conventions to guide the LLM to use standardized keys.
 */

import type { MemoryStore } from './store.js';
import type { NotesStore } from './notes.js';
import type { RawStore } from './raw.js';
import type { CalendarStore } from './calendar.js';
import type { ExtractResult, Fact, FactKind, Note, RawMessage } from './types.js';
import { CONVENTIONAL_NAMESPACES } from './types.js';
import type { MemoryAuditHook } from './audit.js';

// ── LLM client interface ─────────────────────────────────────────────────────

/**
 * Minimal LLM interface: the extractor only needs the ability to "give prompt → get text"
 *
 * Concrete implementations are provided by the caller (Anthropic SDK, OpenAI SDK, Mock, etc.)
 */
export interface ExtractorLlmClient {
  complete(prompt: string): Promise<{
    text: string;
    tokensUsed: number;
  }>;
}

// ── Structure of extraction output (JSON returned by LLM) ──────────────────────────────────

interface ExtractorAction {
  action: 'store_fact' | 'store_note';
  namespace?: string;
  key?: string;
  value?: unknown;
  confidence?: number;
  content?: string;
  importance?: number;
  // v3 time fields (store_fact only; strings are ISO8601, epoch ms also accepted)
  occurred_at?: string | number | null;
  valid_from?: string | number | null;
  valid_until?: string | number | null;
  fact_kind?: 'state' | 'event';
}

/** LLM output may be an ISO8601 string or epoch ms; normalizes to epoch ms. Returns null for invalid values. */
function parseTimeField(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// ── Prompt template ────────────────────────────────────────────────────────

function buildInstructions(currentDate: Date, timezone: string): string {
  const iso = currentDate.toISOString();
  return `You are a memory extraction assistant. Your task is to extract **genuinely worth preserving long-term** information from the conversation below, outputting it as a JSON action sequence.

**Current time**: ${iso}
**User timezone**: ${timezone}

---

## Four-question funnel to determine "whether to record" (core rules)

Each candidate piece of information must pass the following four questions in order — **all must pass before extracting**:

1. **Can it only be obtained from the user?** If it can be inferred from code, git log, or documentation → discard
2. **Does it affect future decisions or outputs?** Pure history / pure description that doesn't influence subsequent behavior → discard
3. **Will it still hold in the foreseeable future?** If it expires quickly → discard; if it must be recorded, use valid_until to specify expiry
4. **Is it different from default behavior?** Preferences consistent with defaults (e.g. "I want clean code") are noise → discard

All pass → record. Regardless of whether the candidate is time, location, person, or preference, the criteria are consistent — **specificity is not a measure of value**.

## Easy-to-miss trigger scenarios (actively capture)

- **Silent acceptance**: user accepted an unconventional approach without objecting = positive feedback; record with store_note
- **Side information in task flow**: constraints, context, deadlines casually mentioned while discussing implementation — most easily missed
- **Style preferences that deviate from default**: verbosity, formatting, comment style — not recording leads to repeated mistakes

## Correction signals (actively capture — most important type)

When user messages show correction tone like "that's not right / should be / don't next time / going forward / no / wrong / that's not what I asked..."
or when the user immediately negates/corrects the assistant's previous response:

- Extract a pair of "wrong behavior → correct behavior"
- **Routing decision**:
  - Can be cleanly compressed to a single-value preference in \`user.preferences.*\` or \`corrections.*\` → store_fact (e.g. "too verbose" → user.preferences.verbosity = "concise")
  - Contextual anti-pattern with "trigger context + steps" → **do not store yourself**, skip it, leave it for Reflector to generate a Skill (e.g. "relative time expressions should be scheduled rather than immediately executed" belongs here)
- Criterion: if expressing it clearly requires "when encountering X / first do A then do B" style conditions and steps → it's an anti-pattern, skip

## Common over-recording (must avoid)

- Precise time/location/names without ongoing constraints behind them (= noise)
- Names of others: only record when they are **gatekeepers / decision-makers / domain owners**; ordinary mentions → skip
- Preferences consistent with default behavior
- Code patterns, architecture, file paths (readable from code)
- Current conversation task progress (that's Task/Plan's responsibility)

---

**Namespace conventions** (follow these as much as possible when deciding to record):
- user.*       User's own information (name, location, preferences.* etc.)
- project.*    Project's persistent facts (repo_url, tech_stack, conventions etc.)
- decisions.*  Decision records, key = topic, value = { choice, rationale }
- skills.*     Skill metadata, key = skill name, value = { description }
- context.*    Temporary/session-level context

**Output format**: Return strictly a JSON array of action objects. No other text, code block markers, or explanations.

## Fact vs Note routing (after passing the funnel, decide which layer)

You can only write to two layers: **Fact** (structured, queryable by namespace.key, overwritable, with time validity) and **Note** (free text, preserves full context). **The Skill layer is handled by a separate reflector — not your responsibility.**

Decide in this order:

1. **Can it be cleanly compressed to \`namespace.key = value\`?** (single subject, single value or simple object, JSON serializable, no critical constraints lost from simplification)
   → **Fact**
   - If it has time attributes, add fact_kind / valid_until / occurred_at
   - Simple preferences (e.g. "no trailing summary" → user.preferences.trailing_summary = false) also go to Fact

2. **Otherwise use Note**, typical scenarios:
   - Silent acceptance ("user accepted single-PR bundling approach without objection")
   - Multi-constraint / contextual preferences ("code should be concise but not sacrifice testability, especially in IO layer")
   - Reasoning/background where structuring would lose information

**Boundary memory**:
- "deploy must run lint first" = statement → **Fact** (project.conventions.*)
- Complete "deploy steps A→B→C" = workflow → **do not write** (leave for Skill layer)

**Format for both action types**:
1. { "action": "store_fact", "namespace": "user", "key": "name", "value": "John", "confidence": 1.0 }
2. { "action": "store_note", "content": "user accepted single-PR bundling approach without objection", "importance": 0.6 }

**Time fields (store_fact only, ISO8601 format with timezone offset)**:
- fact_kind: "state" (continuously true) or "event" (one-time occurrence), default "state"
- occurred_at: the actual time the event occurred (required for event, optional for state)
- valid_from:  when this state became true (recommended for state)
- valid_until: when this state expires (NULL=permanent; must fill for states with clear expiry like "on vacation", "sprint period")

**Relative time must be converted to absolute time**:
- When user says "yesterday", "next Wednesday", "next spring festival" etc., convert to ISO8601 string based on **current time + user timezone**
- Example (current time ${iso}): "review meeting next Monday at 3pm" → occurred_at: "2026-04-20T15:00:00${timezoneOffsetHint(timezone)}"
- If date is uncertain, use the nearest whole hour or 00:00

**Important rules**:
- value must be a JSON serializable value (string, number, boolean, object, array)
- confidence: explicit statement = 1.0, inference = 0.5-0.8
- Better to under-record than over-record: if all candidates are filtered by the funnel, return empty array []

**Conversation content**:
`;
}

/** Timezone offset hint for LLM (hint only; not strictly parsed) */
function timezoneOffsetHint(timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const parts = fmt.formatToParts(new Date());
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    if (tzPart && tzPart.value.startsWith('GMT')) {
      return tzPart.value.replace('GMT', '');
    }
  } catch {
    // Invalid timezone string
  }
  return '+00:00';
}

function buildPrompt(messages: RawMessage[], currentDate: Date, timezone: string): string {
  const dialogue = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n');

  return buildInstructions(currentDate, timezone) + dialogue + '\n\nOutput (strict JSON array):';
}

// ── Parse LLM output ──────────────────────────────────────────────────────

function parseActions(text: string): ExtractorAction[] {
  // Try to strip markdown code block wrapper
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }

  // Try to extract the first JSON array
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x) => x && typeof x === 'object' && typeof x.action === 'string'
    );
  } catch {
    return [];
  }
}

// ── SessionExtractor ───────────────────────────────────────────────────

export interface SessionExtractorOptions {
  /** "Current time" at extraction time; used for relative time conversion. Default new Date() */
  currentDate?: () => Date;
  /** IANA timezone; used for relative time interpretation. Default 'UTC' */
  timezone?: string;
  /** Optional: when an event fact's occurredAt is in the future, mirror it to this CalendarStore */
  calendar?: CalendarStore;
  /**
   * Optional: self-domain write audit hook. When provided, each storeFact/storeNote call
   * records an event with origin='Internal', source='extractor', for post-hoc tracing of internally-driven writes.
   */
  auditHook?: MemoryAuditHook;
}

export class SessionExtractor {
  private readonly currentDate: () => Date;
  private readonly timezone: string;
  private readonly calendar: CalendarStore | undefined;
  private readonly auditHook: MemoryAuditHook | undefined;

  constructor(
    private readonly llm: ExtractorLlmClient,
    private readonly facts: MemoryStore,
    private readonly notes: NotesStore,
    private readonly raw: RawStore,
    options: SessionExtractorOptions = {}
  ) {
    this.currentDate = options.currentDate ?? (() => new Date());
    this.timezone = options.timezone ?? 'UTC';
    this.calendar = options.calendar;
    this.auditHook = options.auditHook;
  }

  /**
   * Extract from session (legacy API, by session_id)
   */
  async extractFromSession(sessionId: string): Promise<ExtractResult> {
    const messages = this.raw.getMessages(sessionId);
    return this.extractFromMessages(messages, sessionId);
  }

  /**
   * K0: Extract by time range (global timeline version).
   * idle_consolidator uses this to advance the cursor, rather than extracting per session at once.
   *
   * @param fromTs  Start time (epoch ms), inclusive
   * @param toTs    End time (epoch ms), inclusive
   */
  async extractFromTimeRange(
    fromTs: number,
    toTs: number,
  ): Promise<ExtractResult> {
    const messages = this.raw.queryTimeline({
      fromTs,
      untilTs: toTs,
      order: 'asc',
      limit: 5_000,
    });
    return this.extractFromMessages(messages, `range:${fromTs}-${toTs}`);
  }

  /**
   * Shared core: receives pre-fetched messages and an audit tag, runs LLM extraction and persists results.
   * tag is used to identify the source in the audit trail (can be sessionId or 'range:from-to').
   */
  private async extractFromMessages(
    messages: RawMessage[],
    tag: string,
  ): Promise<ExtractResult> {
    if (messages.length === 0) {
      return {
        factsStored: 0,
        notesStored: 0,
        llmCostTokens: 0,
        facts: [],
        notes: [],
      };
    }

    // Call LLM (inject current time + timezone into prompt)
    const now = this.currentDate();
    const prompt = buildPrompt(messages, now, this.timezone);
    const { text, tokensUsed } = await this.llm.complete(prompt);

    // Parse
    const actions = parseActions(text);

    // Batch execute
    const facts: Fact[] = [];
    const notes: Note[] = [];

    const nowMs = now.getTime();
    for (const act of actions) {
      if (act.action === 'store_fact') {
        if (!act.namespace || !act.key || act.value === undefined) continue;
        try {
          const kind: FactKind = act.fact_kind === 'event' ? 'event' : 'state';
          const occurredAt = parseTimeField(act.occurred_at);
          const fact = this.facts.storeFact({
            namespace: act.namespace,
            key: act.key,
            value: act.value,
            confidence: act.confidence ?? 1.0,
            factKind: kind,
            occurredAt,
            validFrom: parseTimeField(act.valid_from),
            validUntil: parseTimeField(act.valid_until),
          });
          facts.push(fact);
          this.auditHook?.append('self_domain_write', {
            source: 'extractor',
            origin: 'Internal',
            toolName: 'store_fact',
            sessionId: tag,
            factId: fact.id,
            namespace: act.namespace,
            key: act.key,
            factKind: kind,
          });

          // Mirror: event-type fact + future time → automatically create calendar event
          if (
            this.calendar &&
            kind === 'event' &&
            occurredAt !== null &&
            occurredAt > nowMs
          ) {
            try {
              const title =
                typeof act.value === 'string'
                  ? act.value
                  : `${act.namespace}.${act.key}`;
              const evt = this.calendar.create({
                title,
                startsAt: occurredAt,
                timezone: this.timezone,
                relatedFactId: fact.id,
              });
              this.auditHook?.append('self_domain_write', {
                source: 'extractor',
                origin: 'Internal',
                toolName: 'create_calendar_event',
                sessionId: tag,
                eventId: evt.id,
                relatedFactId: fact.id,
              });
            } catch {
              // Calendar write failure does not block fact storage
            }
          }
        } catch {
          // Skip invalid facts (including valid_until < valid_from)
        }
      } else if (act.action === 'store_note') {
        if (typeof act.content !== 'string' || !act.content) continue;
        try {
          const note = this.notes.storeNote({
            content: act.content,
            importance: act.importance ?? 0.5,
            sessionId: tag.startsWith('range:') ? null : tag,
          });
          notes.push(note);
          this.auditHook?.append('self_domain_write', {
            source: 'extractor',
            origin: 'Internal',
            toolName: 'store_note',
            sessionId: tag,
            noteId: note.id,
          });
        } catch {
          // ignore
        }
      }
    }

    return {
      factsStored: facts.length,
      notesStored: notes.length,
      llmCostTokens: tokensUsed,
      facts,
      notes,
    };
  }
}
