/**
 * InitiativeExecutor — executor for running a single initiative.
 *
 * Flow:
 *   1. Call tools in the order defined by Initiative.plan (whitelist enforced; tools not on the whitelist fail immediately)
 *   2. Combine tool outputs + initiative rationale into a prompt, then run a **single-turn** LLM call
 *   3. Parse the structured JSON returned by the LLM (three-level fallback, following reflection.ts pattern)
 *   4. Write back to memory_facts / memory_notes, tagged source='autonomous:<initiative_id>'
 *   5. Return InitiativeRunResult; loop writes it to DB + audits
 *
 * Design notes:
 *   - Tool calls and LLM are decoupled — the driver already decided "what to look up"; LLM only "reads results and writes conclusions"
 *   - Tool whitelist is strict; any write tool is rejected (autonomous v1 is read-only)
 *   - Single-turn LLM; no recursive tool calls (prevents runaway)
 *   - Does not throw; all failures are converted to InitiativeRunResult.status='failed' so loop can persist them
 */

import type Database from 'better-sqlite3';
import type { ExtractorLlmClient } from '../extractor.js';
import type { MemoryStore } from '../store.js';
import type { NotesStore } from '../notes.js';
import type {
  ExecutorFactProposal,
  ExecutorLlmOutput,
  ExecutorNoteProposal,
  Initiative,
  InitiativeExecutor,
  InitiativeRunResult,
} from './types.js';

export const DEFAULT_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  'webSearch',
  'webFetch',
  'fetchUrl',
  'searchNotes',
  'searchSkills',
  'searchKB',
  'getFact',
  'listFacts',
  'readFile',
  // 2026-05-06 K7→K8 bridge: HonestyGate fabricated_size_claim review needs this
  'inspectPath',
  // Same bridge: listDir for verifying "X is in directory" claims
  'listDir',
]);

/**
 * Minimal interface for executor to call tools. Caller provides a concrete implementation.
 *
 * Tool name + params already selected by the driver are passed in directly. Tool runner should:
 *   - Execute and return a success flag + output text
 *   - Not throw (express failure via ok=false + error field)
 *   - Trim output to a reasonable size (< 4KB); compress or truncate overly long results
 */
export interface ToolRunner {
  run(toolName: string, params: unknown): Promise<ToolRunResult>;
}

export interface ToolRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface InitiativeExecutorOptions {
  facts: MemoryStore;
  notes: NotesStore;
  llm: ExtractorLlmClient;
  tools: ToolRunner;
  /** Tool whitelist. See DEFAULT_TOOL_WHITELIST for defaults. */
  toolWhitelist?: ReadonlySet<string>;
  /**
   * Active-research "grant request": callback that checks whether a given gated tool has been authorized by the user (queries GrantStore).
   * Effective whitelist = toolWhitelist ∪ {tools for which isToolGranted returns true}.
   * Passed as a function rather than a static set because authorization is dynamic at runtime
   * (a single shared executor runs across multiple ticks). Default = always unauthorized (pure read-only).
   * Avoids agent-memory depending on agent-policy — only declares the callback shape.
   */
  isToolGranted?: (tool: string) => boolean;
  /** Default namespace for writing back facts. Default 'autonomous'. */
  factNamespace?: string;
  /** Fallback token estimator (used when LLM client doesn't return tokensUsed). Default ceil(text.length * 0.3). */
  tokenEstimator?: (text: string) => number;
  /** Max tokens for single-turn LLM output. Default 600 — forces brief summaries. */
  maxLlmOutputTokens?: number;
  logger?: { log: (m: string) => void; error: (m: string, e?: unknown) => void };
}

export class StandardExecutor implements InitiativeExecutor {
  private readonly facts: MemoryStore;
  private readonly notes: NotesStore;
  private readonly llm: ExtractorLlmClient;
  private readonly tools: ToolRunner;
  private readonly whitelist: ReadonlySet<string>;
  private readonly isToolGranted: (tool: string) => boolean;
  private readonly factNs: string;
  private readonly estimate: (t: string) => number;
  private readonly maxOut: number;
  private readonly log: { log: (m: string) => void; error: (m: string, e?: unknown) => void };

  constructor(opts: InitiativeExecutorOptions) {
    this.facts = opts.facts;
    this.notes = opts.notes;
    this.llm = opts.llm;
    this.tools = opts.tools;
    this.whitelist = opts.toolWhitelist ?? DEFAULT_TOOL_WHITELIST;
    this.isToolGranted = opts.isToolGranted ?? (() => false);
    this.factNs = opts.factNamespace ?? 'autonomous';
    this.estimate =
      opts.tokenEstimator ?? ((t: string) => Math.max(1, Math.ceil(t.length * 0.3)));
    this.maxOut = opts.maxLlmOutputTokens ?? 600;
    this.log = opts.logger ?? {
      log: (m) => console.log(m),
      error: (m, e) => console.error(m, e),
    };
  }

  /** Effective whitelist = base read-only whitelist ∪ currently authorized gated tools. */
  private isAllowed(tool: string): boolean {
    return this.whitelist.has(tool) || this.isToolGranted(tool);
  }

  async run(initiative: Initiative): Promise<InitiativeRunResult> {
    const toolResults: Array<{ tool: string; output: string; ok: boolean }> = [];
    let toolCalls = 0;

    // 1) Run tools in the plan
    const plan = initiative.plan ?? [];
    for (const step of plan) {
      if (!this.isAllowed(step.tool)) {
        return {
          status: 'failed',
          error: `tool "${step.tool}" is not in the autonomous whitelist (read-only toolset + authorized tools)`,
          llmTokensSpent: 0,
          toolCallsSpent: toolCalls,
        };
      }
      try {
        const r = await this.tools.run(step.tool, step.params);
        toolCalls += 1;
        if (r.ok) {
          toolResults.push({ tool: step.tool, output: truncate(r.output, 4000), ok: true });
        } else {
          toolResults.push({
            tool: step.tool,
            output: `(tool failed: ${r.error ?? 'unknown'})`,
            ok: false,
          });
        }
      } catch (e) {
        toolResults.push({
          tool: step.tool,
          output: `(tool threw: ${String(e)})`,
          ok: false,
        });
      }
    }

    // 2) Build prompt → single-turn LLM
    const prompt = renderExecutorPrompt(initiative, toolResults);
    let llmText: string;
    let llmTokens: number;
    try {
      const resp = await this.llm.complete(prompt);
      llmText = resp.text;
      llmTokens = Number.isFinite(resp.tokensUsed) && resp.tokensUsed > 0
        ? resp.tokensUsed
        : this.estimate(prompt) + this.estimate(resp.text);
    } catch (e) {
      return {
        status: 'failed',
        error: `LLM error: ${String(e)}`,
        llmTokensSpent: 0,
        toolCallsSpent: toolCalls,
      };
    }

    // 3) Parse structured output
    const parsed = parseExecutorOutput(llmText);
    if (!parsed.ok) {
      return {
        status: 'failed',
        error: `LLM output parse failed: ${parsed.errors.join('; ')}`,
        llmTokensSpent: llmTokens,
        toolCallsSpent: toolCalls,
      };
    }
    const out = parsed.output;

    // 3.5) Active-research "grant request": LLM determines that continuing to answer this question
    // requires an **unauthorized** gated tool. At this point, do not write facts/notes
    // (no unsupervised side effects = 0: only request, do not act autonomously);
    // initiative is still markDone (no 'suspended' state introduced);
    // pass the request out via OutcomeHook to record in question.pendingTool.
    // If the tool is already in the effective whitelist (authorized upon replay), ignore this field and proceed to write outputs.
    const rt = out.requestedTool;
    if (rt && rt.tool && !this.isAllowed(rt.tool)) {
      return {
        status: 'done',
        outcomeSummary: truncate(
          `[needs-grant] Research blocked: tool ${rt.tool} is required to proceed${rt.why ? ` (${rt.why})` : ''}. Request has been recorded, awaiting user approval in conversation.`,
          500,
        ),
        needsGrant: true,
        requestedTool: { tool: rt.tool, why: rt.why ?? '' },
        llmTokensSpent: llmTokens,
        toolCallsSpent: toolCalls,
      };
    }

    // 4) Write back facts / notes (single-item failures do not affect others)
    const factIds: string[] = [];
    const noteIds: string[] = [];
    const sourceTag = `autonomous:${initiative.id}`;

    for (const f of out.facts) {
      if (!Array.isArray(f.sourceRefs) || f.sourceRefs.length === 0) {
        // Force non-empty sourceRefs to prevent LLM fabrication
        continue;
      }
      const ns = f.namespace && f.namespace.trim() ? f.namespace : this.factNs;
      // self.* is forbidden (SelfDescriptionWriteForbiddenError would be thrown)
      if (ns === 'self') continue;
      try {
        const stored = this.facts.storeFact({
          namespace: ns,
          key: f.key,
          value: {
            ...(f.value && typeof f.value === 'object' ? (f.value as object) : { value: f.value }),
            sourceRefs: f.sourceRefs,
            via: sourceTag,
          },
          confidence: typeof f.confidence === 'number' ? clamp01(f.confidence) : 0.7,
        });
        factIds.push(stored.id);
      } catch (e) {
        this.log.error(`[autonomous] storeFact failed ${ns}.${f.key}`, e);
      }
    }

    for (const n of out.notes) {
      const body = n.body?.trim() ?? '';
      if (body.length === 0) continue;
      try {
        const stored = this.notes.storeNote({
          content: `[${sourceTag}] ${n.title}\n${body}`,
          importance: typeof n.importance === 'number' ? clamp01(n.importance) : 0.4,
        });
        noteIds.push(stored.id);
      } catch (e) {
        this.log.error(`[autonomous] storeNote failed`, e);
      }
    }

    return {
      status: 'done',
      outcomeSummary: truncate(out.summary, 500),
      outcomeRefs: { facts: factIds, notes: noteIds, pursuits: [] },
      questionAnswered: out.questionAnswered === true,
      llmTokensSpent: llmTokens,
      toolCallsSpent: toolCalls,
    };
  }
}

// ── prompt + parser ──────────────────────────────────────────────────────

function renderExecutorPrompt(
  init: Initiative,
  toolResults: Array<{ tool: string; output: string; ok: boolean }>,
): string {
  const toolBlock = toolResults.length === 0
    ? '(no tools were called this turn)'
    : toolResults
        .map((r, i) => `### Tool ${i + 1}: ${r.tool} ${r.ok ? '✓' : '⚠'}\n${r.output}`)
        .join('\n\n');

  return [
    'You are the background research executor for philont\'s autonomous loop.',
    'The previous step has already run the planned tools. Now you need to organize the results into structured output and write them into the agent\'s long-term memory.',
    '',
    '## Current initiative',
    `- targetRef: ${init.targetRef}`,
    `- Trigger rationale: ${init.rationale}`,
    `- driver: ${init.driver} (${init.kind})`,
    '',
    '## Tool call results',
    toolBlock,
    '',
    '## Output format (strict JSON, no other explanations)',
    '```json',
    '{',
    '  "summary": "<= 500 char summary telling yourself how to interpret this output in future turns>",',
    '  "facts": [',
    '    {',
    '      "namespace": "autonomous" or a specific domain like "library.<name>",',
    '      "key": "short stable identifier, e.g. mcp-rfc-7-purpose",',
    '      "value": { any structured value },',
    '      "confidence": 0..1, default 0.7,',
    '      "sourceRefs": ["url or existing note id, at least one; empty arrays will be discarded"]',
    '    }',
    '  ],',
    '  "notes": [',
    '    {',
    '      "title": "short title",',
    '      "body": "detailed content, may include tool references",',
    '      "importance": 0..1, default 0.4',
    '    }',
    '  ],',
    '  "shouldEscalate": true|false,  // true if results are significant enough for the user to see at the next turn',
    '  "questionAnswered": true|false,  // true only if you were researching a specific open question and your findings sufficiently answer it; otherwise false / omit',
    '  "requestedTool": { "tool": "<tool name>", "why": "<why it is strictly necessary>" }  // Only fill when: you cannot continue answering this question with existing read-only tools and must use a tool you don\'t currently have (e.g. run Lean/Z3/Python for verification/computation); otherwise **omit the entire field**',
    '}',
    '```',
    '',
    '## Hard constraints',
    '- sourceRefs for each fact entry must not be empty; empty arrays will be silently discarded (to prevent fabrication)',
    '- If a tool fails, do not fabricate; honestly note "tool returned no result" in summary, and record "to retry" in notes',
    '- Do not reproduce tool raw output in summary; only write "distilled conclusion + recommended next step"',
    '- Do not write facts with namespace="self" (they will be rejected)',
    '- Only fill requestedTool when you are genuinely stuck and cannot proceed without a specific tool; if you can continue with read-only tools, do not fill it (filling it pauses this research thread to wait for user authorization)',
    '',
    '## ⚠ String values must not contain nested ASCII double quotes (breaks JSON parse)',
    '- String values (summary / body / any string inside value) must **never** directly contain ASCII " characters.',
    '- To reference proper nouns or concepts, use instead:',
    '  · Single quotes \'...\'',
    '  · Square brackets [...]',
    '  · Or explicit escaping \\"...\\"',
    '',
    'Wrong (will break parse):',
    '  "summary": "researched the concept of "tool calls""',
    'Correct (choose one):',
    '  "summary": "researched the concept of [tool calls]"',
    '  "summary": "researched the concept of \'tool calls\'"',
    '  "summary": "researched the concept of \\"tool calls\\""',
  ].join('\n');
}

interface ParseOk {
  ok: true;
  output: ExecutorLlmOutput;
}
interface ParseErr {
  ok: false;
  errors: string[];
}

export function parseExecutorOutput(text: string): ParseOk | ParseErr {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, errors: ['empty LLM output'] };
  }

  let raw: unknown = null;
  let parseError: string | null = null;
  try {
    raw = JSON.parse(text.trim());
  } catch (e) {
    parseError = String(e);
  }

  if (!raw) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced && fenced[1]) {
      try {
        raw = JSON.parse(fenced[1].trim());
        parseError = null;
      } catch (e) {
        parseError = String(e);
      }
    }
  }

  if (!raw) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        raw = JSON.parse(text.slice(first, last + 1));
        parseError = null;
      } catch (e) {
        parseError = String(e);
      }
    }
  }

  // Tier 4 fallback: all strict JSON parse attempts failed; use regex to extract the summary field.
  // Occurs when LLM embeds unescaped ASCII quotes inside a string value
  // (e.g. `"summary":"... "tool calls" ..."`).
  // Even if facts/notes are lost, the initiative can at least be markDone
  // to avoid re-proposing the same garbage token within 24h.
  if (!raw) {
    const recovered = recoverSummaryOnly(text);
    if (recovered !== null) {
      raw = recovered;
      parseError = null;
    }
  }

  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      errors: [`cannot parse as JSON object${parseError ? ': ' + parseError : ''}`],
    };
  }

  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  if (!summary) errors.push("missing field 'summary' (string)");

  const factsRaw = obj.facts;
  const facts: ExecutorFactProposal[] = [];
  if (Array.isArray(factsRaw)) {
    for (const f of factsRaw) {
      if (!f || typeof f !== 'object') continue;
      const fo = f as Record<string, unknown>;
      const key = typeof fo.key === 'string' ? fo.key : '';
      if (!key) continue;
      const refs = Array.isArray(fo.sourceRefs)
        ? (fo.sourceRefs.filter((x) => typeof x === 'string') as string[])
        : [];
      facts.push({
        namespace: typeof fo.namespace === 'string' ? fo.namespace : undefined,
        key,
        value: fo.value,
        confidence: typeof fo.confidence === 'number' ? fo.confidence : undefined,
        sourceRefs: refs,
      });
    }
  }

  const notesRaw = obj.notes;
  const notes: ExecutorNoteProposal[] = [];
  if (Array.isArray(notesRaw)) {
    for (const n of notesRaw) {
      if (!n || typeof n !== 'object') continue;
      const no = n as Record<string, unknown>;
      const title = typeof no.title === 'string' ? no.title : '';
      const body = typeof no.body === 'string' ? no.body : '';
      if (!body) continue;
      notes.push({
        title: title || '(no title)',
        body,
        importance: typeof no.importance === 'number' ? no.importance : undefined,
      });
    }
  }

  const shouldEscalate = obj.shouldEscalate === true;
  const questionAnswered = obj.questionAnswered === true;

  // Active-research "grant request": { tool, why }; treated as no request if tool is missing
  let requestedTool: { tool: string; why: string } | undefined;
  const rt = obj.requestedTool;
  if (rt && typeof rt === 'object') {
    const rto = rt as Record<string, unknown>;
    const tool = typeof rto.tool === 'string' ? rto.tool.trim() : '';
    if (tool) {
      requestedTool = { tool, why: typeof rto.why === 'string' ? rto.why : '' };
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    output: { summary, facts, notes, shouldEscalate, questionAnswered, requestedTool },
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '… (truncated)';
}

/**
 * Tier 4 fallback: when all strict JSON parse attempts fail, use regex to extract the summary field.
 *
 * Production scenario: LLM writes unescaped ASCII double-quotes inside summary
 * (e.g. `"tool calls"`). JSON.parse throws SyntaxError at that position.
 * All three prior stages (JSON.parse / fenced / brace-slice) fail.
 * This function attempts to extract the content of `"summary": "..."` from the raw text —
 * even with unescaped internal quotes — to get a usable summary,
 * so the initiative can at least be markDone (facts/notes lost, but avoids re-proposing
 * the same garbage token for 24h).
 *
 * Strategy:
 *   - Find the `"summary":` start marker
 *   - From the next `"`, scan until a position matching `"<whitespace>","facts"` or `"<whitespace>}` close context
 *   - Collect the extracted content raw; replace internal ASCII " with single quotes (to avoid LLM re-misreading)
 *
 * Returns null if not even the summary can be extracted → truly unrecoverable; caller marks it as failed.
 */
function recoverSummaryOnly(text: string): { summary: string; facts: []; notes: []; shouldEscalate: false } | null {
  const summaryMark = text.match(/"summary"\s*:\s*"/);
  if (!summaryMark || summaryMark.index === undefined) return null;
  const valueStart = summaryMark.index + summaryMark[0].length;

  // Scan from valueStart, looking for the first "looks like close" quote:
  // close = `"` followed by (optional whitespace) `,` or `}`.
  let scan = valueStart;
  let closeIdx = -1;
  while (scan < text.length) {
    const ch = text[scan];
    // Skip escaped `\"` (2 characters)
    if (ch === '\\' && scan + 1 < text.length) {
      scan += 2;
      continue;
    }
    if (ch === '"') {
      // Check if what follows looks like a close context
      const tail = text.slice(scan + 1, Math.min(scan + 16, text.length));
      if (/^\s*[,}]/.test(tail)) {
        closeIdx = scan;
        break;
      }
    }
    scan++;
  }

  if (closeIdx === -1 || closeIdx <= valueStart) return null;
  let summary = text.slice(valueStart, closeIdx);
  // Replace internal ASCII " with single quotes (to avoid breaking JSON again when passed to LLM)
  summary = summary.replace(/(?<!\\)"/g, "'");
  // Handle a few escape sequences (\\n / \\t / \\")
  summary = summary
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
  if (summary.trim().length < 5) return null;
  return { summary: summary.slice(0, 1000), facts: [], notes: [], shouldEscalate: false };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// db param is exported for future audit hooks, currently unused
export type _UnusedDb = Database.Database;
