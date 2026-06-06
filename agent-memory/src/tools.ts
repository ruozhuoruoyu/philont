/**
 * Memory tools: interface exposed to LLM
 *
 * Design principles:
 *   - Coarse-grained: a single store_fact handles all fact types
 *   - Stateless: each action is independent, does not depend on context
 *   - Deterministic: lookup goes through code paths, not through LLM
 */

import type { MemoryStore } from './store.js';
import type { NotesStore } from './notes.js';
import type { SkillStore } from './skills.js';
import type { CalendarStore } from './calendar.js';
import type { ScheduleStore } from './schedules.js';
import type { RawStore } from './raw.js';
import type { Fact, FactKind, ScheduleActionType } from './types.js';
import { CONVENTIONAL_NAMESPACES } from './types.js';

// ── 2026-05-14: auth prefix mis-storage detector (common weak LLM mistake) ──────────────
// LLM stores "Bearer xxx" / "Authorization: ..." as the value; when later referenced it concatenates to
// "Bearer Bearer xxx" → 401. Intercept at the store_fact / similar tool entry point and prompt to strip prefix.

const AUTH_HEADER_LINE = /^(authorization|x-api-key|x-auth-token|api-key|authentication)\s*:/i;
const AUTH_SCHEME_PREFIX = /^(bearer|token|basic|digest|api[\s_-]?key)\s+/i;

function detectStringValueAuthPrefix(value: string): string | null {
  if (AUTH_HEADER_LINE.test(value)) {
    return (
      `value looks like a full HTTP header line (starts with "${value.slice(0, value.indexOf(':') + 1)}").` +
      `\nvalue should be a bare token / raw data, without the header name + colon.` +
      `\nExample:\n  ❌ value: "Authorization: Bearer sk-xxx"\n  ✅ value: "sk-xxx"`
    );
  }
  const m = AUTH_SCHEME_PREFIX.exec(value);
  if (m) {
    const stripped = value.slice(m[0].length);
    return (
      `value contains auth scheme prefix "${m[0].trim()}", which is HTTP Authorization header syntax and should **not** be stored in a fact value.` +
      `\nThe real data is after stripping the prefix.` +
      `\nExample:\n  ❌ value: "${value.slice(0, 30)}..."\n  ✅ value: "${stripped.slice(0, 30)}..."`
    );
  }
  return null;
}

// ── Time field utilities ───────────────────────────────────────────────────────

/** Normalise ISO8601 string or epoch ms to epoch ms; returns null for invalid input */
function parseTimeField(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** Compose the fact's time metadata into a compact label: `[event@2026-04-22T12:00Z | state 2026-04-22 → ∞ | recorded 2026-04-22T11:30Z]` */
function formatFactTimes(fact: Fact): string {
  const parts: string[] = [];
  if (fact.factKind === 'event') {
    const occ = fact.occurredAt != null ? new Date(fact.occurredAt).toISOString() : '?';
    parts.push(`event@${occ}`);
  } else {
    // state
    const from = fact.validFrom != null ? new Date(fact.validFrom).toISOString() : '?';
    const until = fact.validUntil != null ? new Date(fact.validUntil).toISOString() : '∞';
    parts.push(`state ${from} → ${until}`);
  }
  parts.push(`recorded ${new Date(fact.createdAt).toISOString()}`);
  return `[${parts.join(' | ')}]`;
}

// ── Tool interface (compatible with agent-policy's Tool type) ────────────────────────
//
// All memory tool domains are declared as 'self' — effects are limited to the agent's own persistent state.
// Must be registered via ToolRegistry.registerInternal() (self belongs to the allowlist domain).

export interface MemoryToolResult {
  success: boolean;
  output?: string;
  error?: string;
  data?: unknown;
}

/** Memory tool capability classification */
export type MemoryCapability = 'read' | 'write';
/** Memory tool domain (fixed as self; exported only for type clarity) */
export type MemoryDomain = 'self';

export interface MemoryTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  capability: MemoryCapability;
  domain: MemoryDomain;
  execute: (params: Record<string, unknown>) => Promise<MemoryToolResult>;
}

// ── Tool definitions (schema declarations, not bound to a specific store) ──────────────────────────

export const storeFactTool: Omit<MemoryTool, 'execute'> = {
  name: 'store_fact',
  capability: 'write',
  domain: 'self',
  description:
    'Store a structured fact. Recommended namespace values: ' +
    CONVENTIONAL_NAMESPACES.join('/') +
    '. A new value for the same (namespace, key) automatically overwrites the old value (old value retained for traceability).\n\n' +
    '**When you must call this (proactive memory checklist)**:\n' +
    '- Preferences/dislikes: user says "I like/dislike/hate/love/can\'t stand X" → user.preferences.<topic>\n' +
    '  ⚠️ **Negative preferences are more important to record than positive ones** — not recording leads to awkward future recommendations\n' +
    '- Constraints/restrictions: allergies/no alcohol/no spicy/dietary restrictions → user.constraints.<topic>\n' +
    '- Attributes/identity: name/location/role/age → user.name, user.location, user.role\n' +
    '- Project facts: repo/tech stack/conventions → project.*\n' +
    '- Decisions: topic→{choice, rationale} → decisions.*\n' +
    '- One-time events (meal/meeting/PR submission) → fact_kind=event + occurred_at\n' +
    '- Ongoing states (vacation/sprint period) → fact_kind=state + valid_until\n\n' +
    '**Merging existing values**: For accumulative info like `user.preferences.*`, first use `get_fact` to see the existing value, ' +
    'merge old and new arrays before storing (otherwise new value overwrites old and information is lost).\n\n' +
    '**Time dimension**:\n' +
    '- fact_kind: "state" (ongoing state) or "event" (one-time occurrence); default state\n' +
    '- occurred_at: event time ISO8601 (e.g. 2026-04-22T12:00:00+08:00). Required for event\n' +
    '- valid_from / valid_until: state validity window ISO8601\n' +
    'Relative times ("this noon", "tomorrow") must first be converted to absolute ISO8601 using the "current time" in the system prompt.\n\n' +
    '**Examples**:\n' +
    '- "I don\'t like Japanese and Western food" → store_fact(user, preferences.cuisine, {dislikes:["Japanese food","Western food"]})\n' +
    '- "Allergic to peanuts" → store_fact(user, constraints.allergies, ["peanuts"])\n' +
    '- "Had dumplings for lunch today" → store_fact(user, lunch, "dumplings", fact_kind="event", occurred_at="2026-04-22T12:00:00+08:00")\n' +
    '- "Review meeting next Monday at 3pm" → store_fact(project, review_meeting, "review meeting", fact_kind="event", occurred_at="2026-04-28T15:00:00+08:00")',
  schema: {
    type: 'object',
    required: ['namespace', 'key', 'value'],
    properties: {
      namespace: {
        type: 'string',
        description: 'Namespace, e.g. user / project / decisions',
      },
      key: {
        type: 'string',
        description: 'Fact key. For event facts with time semantics, use a stable key (e.g. lunch not lunch_today), distinguishing occurrences via occurred_at',
      },
      value: {
        description: 'Fact value; can be a string, number, object, or array',
      },
      confidence: {
        type: 'number',
        description: 'Confidence 0-1, default 1.0',
        minimum: 0,
        maximum: 1,
      },
      fact_kind: {
        type: 'string',
        enum: ['state', 'event'],
        description: 'state = ongoing state; event = one-time occurrence. Default state',
      },
      occurred_at: {
        type: 'string',
        description: 'Actual time the event occurred (ISO8601 with timezone, e.g. 2026-04-22T12:00:00+08:00). Should be filled for event type',
      },
      valid_from: {
        type: 'string',
        description: 'When this state became true (ISO8601 with timezone)',
      },
      valid_until: {
        type: 'string',
        description: 'When this state expires (ISO8601 with timezone). E.g. "on vacation this week" → Friday 23:59',
      },
    },
  },
};

export const getFactTool: Omit<MemoryTool, 'execute'> = {
  name: 'get_fact',
  capability: 'read',
  domain: 'self',
  description:
    'Exact lookup of a fact by namespace + key. Zero LLM cost deterministic lookup. ' +
    'Returns value with full time metadata (record/occur/validity), useful for determining "when did this fact apply".',
  schema: {
    type: 'object',
    required: ['namespace', 'key'],
    properties: {
      namespace: { type: 'string' },
      key: { type: 'string' },
    },
  },
};

export const listFactsTool: Omit<MemoryTool, 'execute'> = {
  name: 'list_facts',
  capability: 'read',
  domain: 'self',
  description:
    'List all active facts in a namespace. Each entry includes time labels (record/occur/validity), ' +
    'useful for accurately answering time-related questions like "recently", "yesterday", "this week".',
  schema: {
    type: 'object',
    required: ['namespace'],
    properties: {
      namespace: { type: 'string' },
    },
  },
};

export const searchNotesTool: Omit<MemoryTool, 'execute'> = {
  name: 'search_notes',
  capability: 'read',
  domain: 'self',
  description:
    'Full-text search in text notes. Use only when get_fact/list_facts cannot find the needed information.',
  schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search keywords' },
      limit: { type: 'number', description: 'Maximum results to return, default 5' },
    },
  },
};

export const searchSkillsTool: Omit<MemoryTool, 'execute'> = {
  name: 'search_skills',
  capability: 'read',
  domain: 'self',
  description:
    'Search existing reusable skills (action patterns extracted from past sessions). ' +
    'Includes positive skills (kind=positive) and anti-pattern lessons (kind=negative). ' +
    'When facing a task similar to past ones, search here first.',
  schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Describe the current task in natural language' },
      limit: { type: 'number', description: 'Maximum results to return, default 5' },
      include_negative: {
        type: 'boolean',
        description: 'Whether to include anti-pattern lessons, default true. Set false to return only positive skills.',
      },
    },
  },
};

export const useSkillTool: Omit<MemoryTool, 'execute'> = {
  name: 'use_skill',
  capability: 'read',
  domain: 'self',
  description:
    'Retrieve the full action template for a skill by name, and automatically increment use count. ' +
    'The returned action_template is a set of markdown steps that you should follow in order.',
  schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Skill name (slug)' },
    },
  },
};

// ── Calendar / scheduled task tools ──────────────────────────────────────────────

export const createCalendarEventTool: Omit<MemoryTool, 'execute'> = {
  name: 'create_calendar_event',
  capability: 'write',
  domain: 'self',
  description:
    'Create a future calendar event. Used for "meeting next Wednesday", "deadline on April 20", etc. ' +
    'Time fields must be ISO8601 with timezone offset (e.g. 2026-04-22T15:00:00+08:00).',
  schema: {
    type: 'object',
    required: ['title', 'starts_at', 'timezone'],
    properties: {
      title: { type: 'string', description: 'Event title' },
      starts_at: { type: 'string', description: 'ISO8601 start time' },
      ends_at: { type: 'string', description: 'ISO8601 end time (optional)' },
      rrule: {
        type: 'string',
        description:
          'iCalendar RRULE for recurrence. MVP supports FREQ=DAILY/WEEKLY + INTERVAL/COUNT/UNTIL.',
      },
      timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Shanghai' },
    },
  },
};

export const listUpcomingTool: Omit<MemoryTool, 'execute'> = {
  name: 'list_upcoming',
  capability: 'read',
  domain: 'self',
  description: 'List calendar events (including recurring expansions) and scheduled tasks in the upcoming period.',
  schema: {
    type: 'object',
    properties: {
      window_days: {
        type: 'number',
        description: 'How many days ahead, default 7',
      },
    },
  },
};

export const cancelScheduleTool: Omit<MemoryTool, 'execute'> = {
  name: 'cancel_schedule',
  capability: 'write',
  domain: 'self',
  description:
    'Cancel/delete a registered scheduled task. Use when user says "cancel reminder" / "stop reminding me" / "stop X reminder". ' +
    'Provide at least one of name or id. When using name, fuzzy matching is supported (any task name containing the substring). ' +
    'Do NOT use schedule_reminder to "cancel" — that just creates a meaningless new task.',
  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Task name or substring (e.g. "drink water"). Cancels all enabled tasks whose name contains this substring.',
      },
      id: {
        type: 'string',
        description: 'Task UUID (exact match). Mutually exclusive with name.',
      },
    },
  },
};

export const recallSessionsTool: Omit<MemoryTool, 'execute'> = {
  name: 'recall_sessions',
  capability: 'read',
  domain: 'self',
  description:
    'Recall past conversations. Full-text search in Layer 0 raw messages by keyword (+ optional time range), ' +
    'returns a list of matching sessions. Each session includes the summary generated at session end and top matching message snippets.\n' +
    'Typical use cases:\n' +
    '- User asks "last time / previously / last week / a few days ago we discussed X" → call this first, then answer\n' +
    '- You need to reference past decisions, where a previous run left off, how a problem was solved before\n' +
    '- search_notes / list_facts returns nothing, but user insists the topic was discussed\n' +
    'Before calling, consider: can list_facts / get_fact / search_notes find it? If yes, prefer those (lower cost).',
  schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Keywords; searches message content via FTS + LIKE dual path',
      },
      since: {
        type: 'string',
        description: 'Lower time bound (ISO8601 with timezone), default unbounded',
      },
      until: {
        type: 'string',
        description: 'Upper time bound (ISO8601 with timezone), default unbounded',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of sessions to return, default 5',
      },
    },
  },
};

export const scheduleReminderTool: Omit<MemoryTool, 'execute'> = {
  name: 'schedule_reminder',
  capability: 'write',
  domain: 'self',
  description:
    'Set up a scheduled task. Must correctly combine time + action type.\n' +
    '\n' +
    '## Time (choose one)\n' +
    '- [One-time] User says "in X minutes/hours", "tomorrow at X", "at a specific time" → use `at` (ISO8601)\n' +
    '- [Recurring] User says "every X", "every interval X", "daily/hourly/every minute" → use `interval_ms` (milliseconds)\n' +
    '  Common values: 2min=120000, 5min=300000, 10min=600000, 30min=1800000, 1hr=3600000, 1day=86400000\n' +
    '\n' +
    '## Action type action_type (choose one, **required reading**)\n' +
    '- `prompt` (default): **only sends a text reminder** to the user at trigger time. For "remind me to do X" passive notifications.\n' +
    '- `autonomous_turn`: **starts a real chat turn** at trigger time; agent automatically executes the action described in message.\n' +
    '  Use for: **recurring service heartbeat / monitoring / autonomous task execution**.\n' +
    '  message should be **complete execution instructions** (e.g. "call endpoint per facts.service.X.api to vote/comment").\n' +
    '\n' +
    '## Decision guide\n' +
    '- User says "remind me / don\'t forget / tell me when" → action_type=prompt\n' +
    '- User says "execute every X / run / automatically / heartbeat / monitor" → action_type=autonomous_turn\n' +
    '\n' +
    'Tasks with the same name automatically replace the old one (prevents repeated triggers).',
  schema: {
    type: 'object',
    required: ['name', 'message'],
    properties: {
      name: { type: 'string', description: 'Task name (same name replaces old task)' },
      message: {
        type: 'string',
        description:
          'action_type=prompt: reminder text (shown to user).\n' +
          'action_type=autonomous_turn: instructions for agent to execute at trigger time (write complete steps, including facts namespace / credential placeholders etc.).',
      },
      at: {
        type: 'string',
        description:
          'ISO8601 time for one-time trigger (e.g. 2026-04-20T15:00:00+08:00). Mutually exclusive with interval_ms.',
      },
      interval_ms: {
        type: 'number',
        description:
          'Interval for recurring reminders (milliseconds). First trigger at now + interval_ms. Must use when user says "every X". Mutually exclusive with at.',
      },
      action_type: {
        type: 'string',
        enum: ['prompt', 'autonomous_turn'],
        description:
          'prompt (default) only sends text reminder; autonomous_turn starts a real chat turn to auto-execute. ' +
          'Recurring service heartbeat / monitoring / autonomous tasks must use autonomous_turn.',
      },
      project: {
        type: 'string',
        description:
          '[Phase 13.5] Project association (kebab-case, e.g. "mycox"). **Strongly recommended** for ' +
          'long-lived agent role (register/onboard/integration) type schedules: ' +
          'when the scheduled session triggers, the mechanism layer automatically injects ' +
          '~/.philont/projects/<project>/plan.md (accumulated Operational Knowledge / Lessons / Recent Runs) ' +
          'into the prefix, so the LLM sees cross-fire cumulative experience and does not start from scratch each fire.\n' +
          'Not provided = generic reminder, no plan.md attached.',
      },
    },
  },
};

// ── 工厂函数：绑定 store 生成可执行 tools ──────────────────────────────

export function createMemoryTools(
  facts: MemoryStore,
  notes: NotesStore,
  skills?: SkillStore,
  calendar?: CalendarStore,
  schedules?: ScheduleStore,
  raw?: RawStore,
): MemoryTool[] {
  const tools: MemoryTool[] = [
    {
      ...storeFactTool,
      async execute(params) {
        try {
          const p = params as {
            namespace: string;
            key: string;
            value: unknown;
            confidence?: number;
            fact_kind?: string;
            occurred_at?: string | number | null;
            valid_from?: string | number | null;
            valid_until?: string | number | null;
          };
          if (typeof p.namespace !== 'string' || !p.namespace) {
            return { success: false, error: 'namespace must be a non-empty string' };
          }
          if (typeof p.key !== 'string' || !p.key) {
            return { success: false, error: 'key must be a non-empty string' };
          }
          // 2026-05-14: key shape detection — weak LLMs often store header lines / paths / etc. as key.
          if (/[\s:\r\n]/.test(p.key)) {
            return {
              success: false,
              error:
                `key '${p.key.slice(0, 50)}' contains spaces / colons / newlines — you may have accidentally stored a header line / full path / sentence.` +
                `\nkey should be a **short slug** (snake_case / kebab-case, no spaces), e.g.:` +
                `\n  ✅ "mycox_api_key" / "user.preferences.theme" / "service-config"` +
                `\n  ❌ "Authorization: Bearer ..." / "please remember my key is" / "endpoint url"` +
                `\nvalue is where real content goes. Retry: store_fact({namespace:"X", key:"<pure-slug>", value:"<real-content>"})`,
            };
          }
          // 2026-05-14:value 是 string 时,检测 auth prefix 错存(同 saveCredential)。
          // value 可能是任何类型(object/array/number),只 string 才检查。
          if (typeof p.value === 'string') {
            const prefixErr = detectStringValueAuthPrefix(p.value);
            if (prefixErr) {
              return {
                success: false,
                error: prefixErr,
              };
            }
          }
          const factKind: FactKind = p.fact_kind === 'event' ? 'event' : 'state';
          const fact = facts.storeFact({
            namespace: p.namespace,
            key: p.key,
            value: p.value,
            confidence: p.confidence,
            factKind,
            occurredAt: parseTimeField(p.occurred_at),
            validFrom: parseTimeField(p.valid_from),
            validUntil: parseTimeField(p.valid_until),
          });
          return {
            success: true,
            output: `Stored ${p.namespace}.${p.key} ${formatFactTimes(fact)}`,
            data: fact,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    },
    {
      ...getFactTool,
      async execute(params) {
        try {
          const { namespace, key } = params as { namespace: string; key: string };
          const fact = facts.getFact(namespace, key);
          if (!fact) {
            return {
              success: false,
              error: `Not found: ${namespace}.${key}`,
            };
          }
          return {
            success: true,
            output: `${JSON.stringify(fact.value)} ${formatFactTimes(fact)}`,
            data: fact,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    },
    {
      ...listFactsTool,
      async execute(params) {
        try {
          const { namespace } = params as { namespace: string };
          const list = facts.listFacts(namespace);
          return {
            success: true,
            output: list
              .map((f) => `${f.namespace}.${f.key} = ${JSON.stringify(f.value)}  ${formatFactTimes(f)}`)
              .join('\n'),
            data: list,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    },
    {
      ...searchNotesTool,
      async execute(params) {
        try {
          const { query, limit } = params as { query: string; limit?: number };
          const results = notes.search(query, limit ?? 5);
          return {
            success: true,
            output: results.map((n) => `- ${n.content}`).join('\n'),
            data: results,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    },
  ];

  // 仅在提供 SkillStore 时启用技能工具
  if (skills) {
    tools.push({
      ...searchSkillsTool,
      async execute(params) {
        try {
          const { query, limit, include_negative } = params as {
            query: string;
            limit?: number;
            include_negative?: boolean;
          };
          const includeNeg = include_negative !== false; // 默认 true
          let results = skills.search(query, limit ?? 5);
          if (!includeNeg) {
            results = results.filter((s) => s.kind !== 'negative');
          }
          if (results.length === 0) {
            return { success: false, error: 'No matching skills found' };
          }
          return {
            success: true,
            output: results
              .map((s) => {
                const tag = s.kind === 'negative' ? '⚠️ [avoid] ' : '';
                return `- ${tag}**${s.name}** (used ${s.useCount} times): ${s.description}\n  trigger keywords: ${s.triggerKeywords.join(', ')}`;
              })
              .join('\n'),
            data: results,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    });

    tools.push({
      ...useSkillTool,
      async execute(params) {
        try {
          const { name } = params as { name: string };
          const skill = skills.getByName(name);
          if (!skill) {
            return { success: false, error: `Skill '${name}' does not exist` };
          }
          skills.incrementUseCount(name);
          return {
            success: true,
            output:
              `# Skill: ${skill.name}\n` +
              `${skill.description}\n\n` +
              `## Action Template\n${skill.actionTemplate}`,
            data: skill,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    });
  }

  // 日历工具(需要 CalendarStore)
  if (calendar) {
    tools.push({
      ...createCalendarEventTool,
      async execute(params) {
        try {
          const { title, starts_at, ends_at, rrule, timezone } = params as {
            title: string;
            starts_at: string;
            ends_at?: string;
            rrule?: string;
            timezone: string;
          };
          const startsAtMs = Date.parse(starts_at);
          if (!Number.isFinite(startsAtMs)) {
            return { success: false, error: 'starts_at is not a valid ISO8601 string' };
          }
          const endsAtMs = ends_at ? Date.parse(ends_at) : undefined;
          if (ends_at && !Number.isFinite(endsAtMs)) {
            return { success: false, error: 'ends_at is not a valid ISO8601 string' };
          }
          const event = calendar.create({
            title,
            startsAt: startsAtMs,
            endsAt: endsAtMs ?? null,
            rrule: rrule ?? null,
            timezone,
          });
          return {
            success: true,
            output: `Created calendar event '${title}' @ ${new Date(startsAtMs).toISOString()}`,
            data: event,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    });

    tools.push({
      ...listUpcomingTool,
      async execute(params) {
        try {
          const { window_days } = params as { window_days?: number };
          const days = Math.max(1, Math.min(90, window_days ?? 7));
          const now = Date.now();
          const events = calendar.upcoming(days * 86_400_000, now);
          const scheduleLines = schedules
            ? schedules
                .list({ enabledOnly: true })
                .filter((s) => s.nextRunAt <= now + days * 86_400_000)
                .map(
                  (s) =>
                    `- [task] ${s.name} @ ${new Date(s.nextRunAt).toISOString()} (${s.actionType})`
                )
            : [];
          const eventLines = events.map(
            (e) =>
              `- [event] ${e.title} @ ${new Date(e.occurrenceStartsAt).toISOString()} ` +
              `(${e.timezone}${e.rrule ? `, ${e.rrule}` : ''})`
          );
          const lines = [...eventLines, ...scheduleLines];
          return {
            success: true,
            output:
              lines.length > 0 ? lines.join('\n') : `No events in the next ${days} days`,
            data: { events, schedules: schedules?.list({ enabledOnly: true }) ?? [] },
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    });
  }

  // 定时任务工具(需要 ScheduleStore)
  if (schedules) {
    tools.push({
      ...scheduleReminderTool,
      async execute(params) {
        try {
          const { name, message, at, interval_ms, action_type, project } = params as {
            name: string;
            message: string;
            at?: string;
            interval_ms?: number;
            action_type?: 'prompt' | 'autonomous_turn';
            project?: string;
          };
          // Phase 13.5:project 字段(kebab-case)校验
          let projectClean: string | null = null;
          if (typeof project === 'string' && project.trim()) {
            const v = project.trim();
            if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(v)) {
              return {
                success: false,
                error:
                  `schedule_reminder: project must be kebab-case (lowercase alphanumeric + hyphens, ` +
                  `2-60 chars, no leading/trailing hyphens), got "${v}"`,
              };
            }
            projectClean = v;
          }
          if (!at && !interval_ms) {
            return {
              success: false,
              error: 'Must provide at (one-time) or interval_ms (recurring)',
            };
          }
          // 解析 action_type:default 'prompt'(向后兼容)。
          // autonomous_turn 让 schedule 到点起一个真 chat turn 跑工具,而不是
          // 只发文本提醒。心跳 / 监控 / 自主任务必须用这个。
          const actionType: ScheduleActionType =
            action_type === 'autonomous_turn' ? 'autonomous_turn' : 'prompt';
          const now = Date.now();
          let nextRunAt: number;
          let cronExpr: string | null = null;
          if (at) {
            const ms = Date.parse(at);
            if (!Number.isFinite(ms)) {
              return { success: false, error: 'at is not a valid ISO8601 string' };
            }
            nextRunAt = ms;
          } else {
            if (!(interval_ms! > 0)) {
              return { success: false, error: 'interval_ms must be a positive number' };
            }
            nextRunAt = now + interval_ms!;
            cronExpr = `interval:${interval_ms}`;
          }
          // 同名 enabled 任务视为被替代,先禁用(保留历史)
          const replaced = schedules
            .list({ enabledOnly: true })
            .filter((s) => s.name === name);
          for (const old of replaced) {
            schedules.setEnabled(old.id, false);
          }
          // payload 形态依 action_type:
          //   prompt → { message }(scheduler 只 emit reminder 文本)
          //   autonomous_turn → { prompt, replyChannel: 'silent' }
          //     (scheduler 起 chat turn,prompt 字段是给 agent 看的执行指令)
          const payload: Record<string, unknown> =
            actionType === 'autonomous_turn'
              ? { prompt: message, replyChannel: 'silent' }
              : { message };
          const schedule = schedules.create({
            name,
            cronExpr,
            nextRunAt,
            actionType,
            payload,
            project: projectClean,
          });
          const kind = cronExpr ? `recurring(${cronExpr})` : 'one-time';
          const replacedMsg = replaced.length
            ? ` (replaced ${replaced.length} old task(s) with the same name)`
            : '';

          // 启发式警告:若 LLM 传了近期一次性 at 且 message 含"每/每隔",
          // 大概率传错了参数(应该是 interval_ms)。提示 LLM 复核。
          let suggestion = '';
          if (!cronExpr && at) {
            const delta = nextRunAt - now;
            const looksPeriodic = /每|每隔|every|each/i.test(message);
            if (looksPeriodic && delta <= 60 * 60_000 /* ≤1 hour */) {
              suggestion =
                ` ⚠ Detected "every/each" in message, but this task is [one-time] and will fire only once. ` +
                `If user wants recurring reminders, **immediately call this tool again** ` +
                `using the interval_ms parameter (e.g. every 2 min=120000, every hour=3600000).`;
            }
          }
          const actionTag = actionType === 'autonomous_turn' ? '🤖 autonomous' : '🔔 prompt';
          return {
            success: true,
            output:
              `Scheduled task '${name}' [${kind}, ${actionTag}], first run @ ${new Date(nextRunAt).toISOString()}${replacedMsg}${suggestion}`,
            data: schedule,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    });

    tools.push({
      ...cancelScheduleTool,
      async execute(params) {
        try {
          const { name, id } = params as { name?: string; id?: string };
          if (!name && !id) {
            return {
              success: false,
              error: 'Must provide name (fuzzy match) or id (exact) — at least one required',
            };
          }
          const all = schedules.list();
          const targets = all.filter((s) => {
            if (id && s.id === id) return true;
            if (name && s.name.includes(name)) return true;
            return false;
          });
          if (targets.length === 0) {
            return {
              success: false,
              error: `No matching task found (name='${name ?? ''}' id='${id ?? ''}').` +
                ` Currently enabled tasks: ` +
                (all.filter((s) => s.enabled).map((s) => s.name).join(', ') ||
                'none'),
            };
          }
          for (const t of targets) {
            schedules.delete(t.id);
          }
          return {
            success: true,
            output: `Cancelled ${targets.length} task(s): ${targets.map((t) => t.name).join(', ')}`,
            data: { cancelledIds: targets.map((t) => t.id) },
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    });
  }

  // 会话回溯(需要 RawStore)
  if (raw) {
    tools.push({
      ...recallSessionsTool,
      async execute(params) {
        try {
          const { query, since, until, limit } = params as {
            query: string;
            since?: string | number;
            until?: string | number;
            limit?: number;
          };
          if (typeof query !== 'string' || !query.trim()) {
            return { success: false, error: 'query must be a non-empty string' };
          }
          const sinceMs = parseTimeField(since);
          const untilMs = parseTimeField(until);
          const lim = Math.max(1, Math.min(20, limit ?? 5));
          const hits = raw.searchMessages(query, {
            since: sinceMs ?? undefined,
            until: untilMs ?? undefined,
            limit: lim * 6,
          });
          if (hits.length === 0) {
            // 2026-05-10:0 命中是正常状态(非失败),返 success=true 防 agent
            // 在 autonomous turn 误以为是 bug 反复重试。实战观察 mycox 心跳
            // 跑 recall_sessions 4+ 次都是 0 命中(全新 session),被算成
            // 失败拉低 same-root-cause 触发反思,完全混淆诊断。
            return {
              success: true,
              output: `No past sessions matching "${query}" (0 hits). Try search_notes / list_facts to look up facts rather than conversation records.`,
              data: [],
            };
          }
          // 按 session_id 聚合(保留命中顺序,即时间倒排)
          const bySession = new Map<string, typeof hits>();
          for (const m of hits) {
            const arr = bySession.get(m.sessionId) ?? [];
            arr.push(m);
            bySession.set(m.sessionId, arr);
          }
          const aggregated = Array.from(bySession.entries())
            .map(([sid, msgs]) => {
              const top = msgs.slice(0, 3);
              const session = raw.getSession(sid);
              const summary = notes.getNoteById(`session-summary-${sid}`);
              return {
                sessionId: sid,
                startedAt: session?.startedAt ?? top[0].timestamp,
                endedAt: session?.endedAt ?? null,
                summary: summary?.content ?? null,
                topHits: top.map((m) => ({
                  role: m.role,
                  timestamp: m.timestamp,
                  snippet: m.content.slice(0, 200),
                })),
              };
            })
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, lim);

          const outputLines = aggregated.map((s) => {
            const startIso = new Date(s.startedAt).toISOString();
            const endFrag = s.endedAt
              ? ` - ${new Date(s.endedAt).toISOString()}`
              : ' (not closed)';
            const summaryFrag = s.summary
              ? `\n  summary: ${s.summary}`
              : '\n  (no summary)';
            const hitsFrag = s.topHits
              .map((h) => `    [${h.role}] ${h.snippet}`)
              .join('\n');
            return `- session=${s.sessionId} @ ${startIso}${endFrag}${summaryFrag}\n  hits:\n${hitsFrag}`;
          });

          return {
            success: true,
            output: outputLines.join('\n\n'),
            data: aggregated,
          };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    });
  }

  return tools;
}
