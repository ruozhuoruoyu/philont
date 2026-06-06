/**
 * SelfReflector — mechanism implementation for emergent identity.
 *
 * Periodically (at finalize time) synthesizes facts accumulated by the agent — skills,
 * active pursuits, tool usage, etc. — and uses an LLM to produce a first-person self-description
 * with sourceRefs, written into the `self.*` namespace of memory_facts.
 *
 * Key rules:
 *   1. self.* can only be written via MemoryStore.updateSelfFact(caller='self-reflector')
 *      — ordinary storeFact calls are rejected with SelfDescriptionWriteForbiddenError
 *   2. Every conclusion must carry sourceRefs (referencing real skill/pursuit/drive ids)
 *      to prevent the LLM from "fabricating self-identity"
 *   3. When materials are insufficient, return a placeholder description directly; do not force-construct one
 *
 * The emergent identity design is described in `philont-iterative-haven.md` Phase K3.
 */

import type { MemoryStore } from './store.js';
import type { SkillStore } from './skills.js';
import type { PursuitStore } from './pursuit.js';
import type { ActionLog } from './actions.js';
import type { DriveOutcomeStore } from './drive_outcome.js';
import type { ExtractorLlmClient } from './extractor.js';
import type { MemoryAuditHook } from './audit.js';
import { BOOTSTRAP_ROOT_PURSUIT_ID } from './schema.js';

// ── prompt ───────────────────────────────────────────────────────────────

const SELF_REFLECT_INSTRUCTIONS = `You are generating a **first-person self-description** for a philont AI agent.

Based on the materials provided below — skills accumulated by the agent, active pursuits, recent tool usage, etc. — summarize "what it has become".

**Hard rules:**
1. First person, present perfect ("I have...") or present tense ("I tend to...")
2. **Each conclusion must map to a specific item in the materials (sourceRefs)**; do not fabricate
3. Do not exaggerate. Few materials → say "I am still getting to know myself"; many materials → faithfully summarize
4. Output strict JSON; do not wrap in markdown code blocks; no extra text

**Output schema:**
{
  "summary": "2-3 sentence first-person self-description",
  "strengths": ["specific strength 1", "specific strength 2"],
  "growth_edges": ["something still being learned 1"],
  "source_refs": ["skill:<skill-name>", "pursuit:<pursuit-id>", ...]
}

If materials are insufficient (fewer than 3 skills and no active pursuits), write summary as "I am still getting to know myself; I have not accumulated enough experience to form a stable self-image." Use empty arrays for strengths/growth_edges/source_refs.

Below are the materials:
`;

interface ParsedSelfReflection {
  summary: string;
  strengths: string[];
  growthEdges: string[];
  sourceRefs: string[];
}

function parseSelfReflection(text: string): ParsedSelfReflection | null {
  const trimmed = text.trim();
  // Tolerate occasional ```json fence added by LLM
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = m ? m[1] : trimmed;
  try {
    const obj = JSON.parse(body) as Partial<{
      summary: unknown;
      strengths: unknown;
      growth_edges: unknown;
      source_refs: unknown;
    }>;
    if (typeof obj.summary !== 'string') return null;
    return {
      summary: obj.summary,
      strengths: Array.isArray(obj.strengths)
        ? obj.strengths.filter((s): s is string => typeof s === 'string')
        : [],
      growthEdges: Array.isArray(obj.growth_edges)
        ? obj.growth_edges.filter((s): s is string => typeof s === 'string')
        : [],
      sourceRefs: Array.isArray(obj.source_refs)
        ? obj.source_refs.filter((s): s is string => typeof s === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

// ── SelfReflector ───────────────────────────────────────────────────────

export interface SelfReflectResult {
  /** Whether self.* facts were actually written (false when materials are insufficient or parse fails) */
  updated: boolean;
  summary: string;
  strengths: string[];
  growthEdges: string[];
  sourceRefs: string[];
  /** Heuristic: what fraction of the sourceRefs entries appearing in the summary match the input materials */
  sourceIntegrity: number;
  llmCostTokens: number;
}

export interface SelfReflectorOptions {
  auditHook?: MemoryAuditHook;
  rootPursuitId?: string;
  /** How many top skills to fetch */
  topSkillsLimit?: number;
  /** Minimum number of skills required before starting reflection (otherwise produce placeholder description) */
  minSkillsForReflect?: number;
}

export class SelfReflector {
  private readonly auditHook: MemoryAuditHook | undefined;
  private readonly rootPursuitId: string;
  private readonly topSkillsLimit: number;
  private readonly minSkillsForReflect: number;

  constructor(
    private readonly llm: ExtractorLlmClient,
    private readonly memory: MemoryStore,
    private readonly skills: SkillStore,
    private readonly pursuits: PursuitStore,
    private readonly actions: ActionLog,
    private readonly outcomes: DriveOutcomeStore,
    options: SelfReflectorOptions = {},
  ) {
    this.auditHook = options.auditHook;
    this.rootPursuitId = options.rootPursuitId ?? BOOTSTRAP_ROOT_PURSUIT_ID;
    this.topSkillsLimit = options.topSkillsLimit ?? 20;
    this.minSkillsForReflect = options.minSkillsForReflect ?? 3;
  }

  /**
   * Execute one round of self-reflection.
   *
   * - Insufficient materials → write placeholder summary ("still getting to know myself"), updated=true
   * - LLM failure or parse failure → do not write, updated=false
   * - Normal → write self.summary / self.strengths / self.growth_edges, updated=true
   */
  async reflect(): Promise<SelfReflectResult> {
    const topSkills = this.skills.listAll(this.topSkillsLimit);
    // The bootstrap root itself is the agent's identity container, not a "accumulated pursuit";
    // filter it out when assessing materials
    const activePursuits = this.pursuits
      .listActive(this.rootPursuitId)
      .filter((p) => p.id !== this.rootPursuitId);

    // Insufficient materials: use placeholder
    if (topSkills.length < this.minSkillsForReflect && activePursuits.length === 0) {
      const summary =
        'I am still getting to know myself; I have not accumulated enough experience to form a stable self-image.';
      this.memory.updateSelfFact('summary', summary, [], 'self-reflector');
      this.auditHook?.append('self_domain_write', {
        source: 'self-reflector',
        origin: 'Internal',
        toolName: 'update_self_fact',
        key: 'summary',
        mode: 'placeholder',
      });
      return {
        updated: true,
        summary,
        strengths: [],
        growthEdges: [],
        sourceRefs: [],
        sourceIntegrity: 1.0,
        llmCostTokens: 0,
      };
    }

    // Build prompt
    const materials: string[] = [];
    if (topSkills.length > 0) {
      materials.push('## Skills (sorted by use count)');
      for (const s of topSkills) {
        const kindTag = s.kind === 'negative' ? '[negative]' : '';
        materials.push(
          `[skill:${s.name}] use_count=${s.useCount} ${kindTag} | ${s.description.slice(0, 100)}`,
        );
      }
    }
    if (activePursuits.length > 0) {
      materials.push('\n## Active Pursuits');
      for (const p of activePursuits) {
        materials.push(
          `[pursuit:${p.id}] ${p.title} — ${p.intent.slice(0, 100)} (${p.progressMarkers.length} progress)`,
        );
      }
    }
    const prompt = SELF_REFLECT_INSTRUCTIONS + '\n' + materials.join('\n');

    // LLM
    let parsed: ParsedSelfReflection | null = null;
    let tokensUsed = 0;
    try {
      const r = await this.llm.complete(prompt);
      tokensUsed = r.tokensUsed;
      parsed = parseSelfReflection(r.text);
    } catch (e) {
      this.auditHook?.append('self_domain_write', {
        source: 'self-reflector',
        origin: 'Internal',
        toolName: 'update_self_fact',
        mode: 'llm_error',
        error: String(e).slice(0, 200),
      });
      return {
        updated: false,
        summary: '',
        strengths: [],
        growthEdges: [],
        sourceRefs: [],
        sourceIntegrity: 0,
        llmCostTokens: tokensUsed,
      };
    }

    if (!parsed) {
      this.auditHook?.append('self_domain_write', {
        source: 'self-reflector',
        origin: 'Internal',
        toolName: 'update_self_fact',
        mode: 'parse_error',
      });
      return {
        updated: false,
        summary: '',
        strengths: [],
        growthEdges: [],
        sourceRefs: [],
        sourceIntegrity: 0,
        llmCostTokens: tokensUsed,
      };
    }

    // Verify sourceRefs authenticity (sampled; not a hard reject, only computes integrity score)
    const skillIds = new Set(topSkills.map((s) => `skill:${s.name}`));
    const pursuitIds = new Set(activePursuits.map((p) => `pursuit:${p.id}`));
    const validRefs = parsed.sourceRefs.filter(
      (r) => skillIds.has(r) || pursuitIds.has(r) || /^(drive|outcome):/i.test(r),
    );
    const sourceIntegrity =
      parsed.sourceRefs.length > 0
        ? validRefs.length / parsed.sourceRefs.length
        : 0;

    // Write (write even if integrity is low, but record in audit)
    this.memory.updateSelfFact(
      'summary',
      parsed.summary,
      parsed.sourceRefs,
      'self-reflector',
    );
    if (parsed.strengths.length > 0) {
      this.memory.updateSelfFact(
        'strengths',
        parsed.strengths,
        parsed.sourceRefs,
        'self-reflector',
      );
    }
    if (parsed.growthEdges.length > 0) {
      this.memory.updateSelfFact(
        'growth_edges',
        parsed.growthEdges,
        parsed.sourceRefs,
        'self-reflector',
      );
    }

    this.auditHook?.append('self_domain_write', {
      source: 'self-reflector',
      origin: 'Internal',
      toolName: 'update_self_fact',
      mode: 'success',
      sourceIntegrity,
      refsCount: parsed.sourceRefs.length,
      validRefsCount: validRefs.length,
    });

    return {
      updated: true,
      summary: parsed.summary,
      strengths: parsed.strengths,
      growthEdges: parsed.growthEdges,
      sourceRefs: parsed.sourceRefs,
      sourceIntegrity,
      llmCostTokens: tokensUsed,
    };
  }
}
