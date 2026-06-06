/**
 * research_focus tool (2026-05-30 active research loop).
 *
 * domain='self': agent registers "user-delegated ongoing research goals" as an **active research pursuit**.
 * Afterward, the autonomous loop's PursuitDriver will **advance it without waiting for staleness, on every idle tick**
 * (calling read-only tools to research its open questions, writing facts/notes), until all questions are answered / iteration limit reached /
 * this tool's stop command fires.
 *
 * Key constraint (written into description): **only call when user explicitly requests "ongoing/continuous/help me research X"**.
 * Don't create an active research pursuit for ordinary one-time Q&A — that just makes the loop spin and burn budget.
 */

import type { PursuitStore } from './pursuit.js';
import type { MemoryTool } from './tools.js';

export type ResearchTool = MemoryTool;

/**
 * Used for active research "request permission": the minimal interface for writing dynamic authorization.
 * Structurally matches @agent/policy's GrantStore.grant(spec) overload — passing GrantStore directly satisfies this,
 * but here we **do not import** agent-policy (agent-memory does not depend on it), only declare the required shape.
 */
export interface ResearchGrantSink {
  grant(spec: {
    toolName: string;
    capability: 'read' | 'write' | 'execute';
    domain: 'local' | 'network' | 'system' | 'self';
    reason: string;
    ttlMs?: number;
  }): void;
}

/** grant_research_tool default authorization duration: 2 hours (enough for a few background idle ticks, auto-expires). */
export const DEFAULT_RESEARCH_GRANT_TTL_MS = 2 * 60 * 60 * 1000;

const RESEARCH_FOCUS_DESCRIPTION =
  'Register / cancel an **active research goal**: agent continuously investigates in the background (when idle) until questions are answered.\n' +
  '**Strict constraint**: only call when user **explicitly requests ongoing research** (e.g. "keep researching X / always monitor Y / ' +
  'track Z long-term"). Do **not** use for one-time Q&A — just answer ordinary questions directly.\n' +
  '\n' +
  'action="start": create a new active research pursuit.\n' +
  '  - title: research topic (brief)\n' +
  '  - intent: one-sentence statement of the research goal\n' +
  '  - questions: list of specific questions to answer (string[]); loop advances one per tick\n' +
  '  - resolutionCriteria (optional): what counts as "research complete"\n' +
  '  Returns the id of the newly created pursuit.\n' +
  'action="stop": stop an active research (pass pursuitId); pursuit is preserved, just no longer actively driven.';

export const researchFocusTool: Omit<ResearchTool, 'execute'> = {
  name: 'research_focus',
  description: RESEARCH_FOCUS_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop'], description: 'start = create / stop = halt' },
      title: { type: 'string', description: 'action=start: research topic (brief)' },
      intent: { type: 'string', description: 'action=start: one-sentence research goal' },
      questions: {
        type: 'array',
        items: { type: 'string' },
        description: 'action=start: list of specific questions to answer',
      },
      resolutionCriteria: { type: 'string', description: 'action=start optional: completion criteria' },
      pursuitId: { type: 'string', description: 'action=stop: the research pursuit id to stop' },
    },
    required: ['action'],
  },
  capability: 'write',
  domain: 'self',
};

const GRANT_RESEARCH_DESCRIPTION =
  'Approve background active research to use a **currently gated tool** (e.g. running Lean/Z3/Python for verification/computation).\n' +
  '**Only call when the user explicitly approves** a pending request in "background research pending approval" — that section lists "research X needs `<tool>`". Do not grant access proactively; do not call unless the user said to approve.\n' +
  'Authorization is **bounded**: expires automatically after 2 hours by default, and only allows the specified tool name.\n' +
  '  - pursuitId: the research pursuit id the pending request belongs to (shown in pending section)\n' +
  '  - tool: the tool name to authorize (shown in pending section)\n' +
  '  - ttlMs (optional): authorization duration (milliseconds), default 2 hours';

const grantResearchTool: Omit<ResearchTool, 'execute'> = {
  name: 'grant_research_tool',
  description: GRANT_RESEARCH_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      pursuitId: { type: 'string', description: 'Research pursuit id the pending request belongs to' },
      tool: { type: 'string', description: 'Tool name to authorize' },
      ttlMs: { type: 'number', description: 'Optional: authorization duration (ms), default 2 hours' },
    },
    required: ['pursuitId', 'tool'],
  },
  capability: 'write',
  domain: 'self',
};

/**
 * Factory: bind PursuitStore to produce executable research_focus tools.
 * chat-handler injects them via extraInternalTools (domain='self').
 *
 * When grantStore is provided, additionally generates grant_research_tool (for in-conversation authorization of background research to use a gated tool).
 * Without it, only research_focus is produced (e.g. demo / scenarios that don't need authorization).
 */
export function createResearchTools(
  pursuits: PursuitStore,
  grantStore?: ResearchGrantSink,
): ResearchTool[] {
  const tools: ResearchTool[] = [
    {
      ...researchFocusTool,
      async execute(params) {
        const p = params as {
          action?: string;
          title?: string;
          intent?: string;
          questions?: unknown;
          resolutionCriteria?: string;
          pursuitId?: string;
        };

        if (p.action === 'stop') {
          if (typeof p.pursuitId !== 'string' || !p.pursuitId.trim()) {
            return { success: false, output: '', error: 'action=stop requires pursuitId' };
          }
          try {
            pursuits.setActiveResearch(p.pursuitId, false);
            return { success: true, output: `Stopped active research pursuit ${p.pursuitId}` };
          } catch (e) {
            return { success: false, output: '', error: `stop failed: ${String(e)}` };
          }
        }

        if (p.action === 'start') {
          if (typeof p.title !== 'string' || !p.title.trim()) {
            return { success: false, output: '', error: 'action=start requires a non-empty title' };
          }
          if (typeof p.intent !== 'string' || !p.intent.trim()) {
            return { success: false, output: '', error: 'action=start requires a non-empty intent' };
          }
          const questions = Array.isArray(p.questions)
            ? p.questions.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
            : [];
          if (questions.length === 0) {
            return { success: false, output: '', error: 'action=start requires at least one question' };
          }
          const root = pursuits.getDefaultRoot();
          if (!root) {
            return { success: false, output: '', error: 'No root pursuit found; cannot attach research goal' };
          }
          try {
            const pursuit = pursuits.createChild({
              parentPursuitId: root.id,
              title: p.title,
              intent: p.intent,
              origin: 'user',
              stake: 'high', // active research defaults to high stake (user explicitly delegated it)
              openQuestions: questions.map((text) => ({ text })),
              resolutionCriteria: p.resolutionCriteria ?? null,
              isActiveResearch: true,
            });
            return {
              success: true,
              output:
                `Registered active research "${pursuit.title}" (id=${pursuit.id}, ${questions.length} question(s)). ` +
                `Will be driven in the background; stops automatically when all questions are answered.`,
            };
          } catch (e) {
            return { success: false, output: '', error: `start failed: ${String(e)}` };
          }
        }

        return { success: false, output: '', error: `Unknown action: ${String(p.action)}` };
      },
    },
  ];

  if (grantStore) {
    tools.push({
      ...grantResearchTool,
      async execute(params) {
        const p = params as { pursuitId?: string; tool?: string; ttlMs?: number };
        if (typeof p.tool !== 'string' || !p.tool.trim()) {
          return { success: false, output: '', error: 'requires non-empty tool (the tool name to authorize)' };
        }
        if (typeof p.pursuitId !== 'string' || !p.pursuitId.trim()) {
          return { success: false, output: '', error: 'requires pursuitId (the research the pending request belongs to)' };
        }
        const ttlMs =
          typeof p.ttlMs === 'number' && Number.isFinite(p.ttlMs) && p.ttlMs > 0
            ? p.ttlMs
            : DEFAULT_RESEARCH_GRANT_TTL_MS;
        try {
          // gated research tools authorized with execute/system; reason records which research authorized this (auditable).
          // Only write authorization, don't touch initiative/question — driver sees isGranted on next tick and replays.
          grantStore.grant({
            toolName: p.tool,
            capability: 'execute',
            domain: 'system',
            reason: `research:${p.pursuitId}`,
            ttlMs,
          });
          const mins = Math.round(ttlMs / 60000);
          return {
            success: true,
            output: `Authorized background research to use ${p.tool} (valid for ${mins} minutes). Will be used on the next background drive tick.`,
          };
        } catch (e) {
          return { success: false, output: '', error: `grant failed: ${String(e)}` };
        }
      },
    });
  }

  return tools;
}
