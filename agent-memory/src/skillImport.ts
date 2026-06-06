/**
 * Bulk skill import — populates SkillStore from external sources (e.g. SKILL.md loader)
 *
 * Accepts duck-typed skill input to avoid hard dependency on agent-tools.
 * Any object with the shape { name, description, triggerKeywords, actionTemplate } works.
 */

import type { SkillStore } from './skills.js';
import type { RoutingRuleStore } from './routing_rules.js';
import { ensureBundledRoutingRule } from './routing_bundled.js';

/** Generic skill input (automatically compatible with agent-tools' ParsedSkill) */
export interface ImportableSkill {
  name: string;
  description: string;
  triggerKeywords: string[];
  actionTemplate: string;
  /**
   * v15: trigger scenario text (SKILL.md frontmatter `when_to_use:` or fallback `## When to Use` section).
   * Used when injecting skill index into system prompt + as routing rule trigger_condition when loading bundled skills.
   */
  whenToUse?: string;
  /** kind: 'positive' (default) | 'negative' (anti-pattern) */
  kind?: 'positive' | 'negative';
  /**
   * Optional source tag (v10):
   *   undefined / null — locally written / reflection auto-generated (default)
   *   'clawhub:<slug>@<version>' — loaded from ClawHub
   *
   * Automatically forwarded from ParsedSkill.metadata.openclaw.source, or explicitly set by caller.
   */
  source?: string | null;
}

export interface ImportOptions {
  /** Conflict strategy: 'skip' (default) | 'replace' | 'merge' */
  onConflict?: 'skip' | 'replace' | 'merge';
  /**
   * v15: optional RoutingRuleStore. When provided, bundled / locally-written skills (source does
   * not start with 'self:') will automatically have a confidence='tentative'
   * `auto:bundled:<name>` routing rule written after loading (based on whenToUse text).
   * See routing_bundled.ts for details.
   */
  routingRules?: RoutingRuleStore;
}

export interface ImportResult {
  created: string[];
  updated: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Bulk-write a list of skills parsed from SKILL.md into SkillStore
 *
 * @param store    target SkillStore
 * @param skills   list of skill inputs (typically produced by loadSkills())
 * @param options  conflict handling strategy
 */
export function importSkills(
  store: SkillStore,
  skills: ImportableSkill[],
  options: ImportOptions = {},
): ImportResult {
  const onConflict = options.onConflict || 'skip';
  const result: ImportResult = {
    created: [],
    updated: [],
    skipped: [],
    errors: [],
  };

  for (const skill of skills) {
    if (!skill.name || !skill.actionTemplate) {
      result.errors.push({
        name: skill.name || '(unnamed)',
        error: 'missing name or actionTemplate',
      });
      continue;
    }

    try {
      const existing = store.getByName(skill.name);
      let touched = false;

      if (!existing) {
        store.createSkill({
          name: skill.name,
          description: skill.description || '',
          triggerKeywords: skill.triggerKeywords || [],
          actionTemplate: skill.actionTemplate,
          whenToUse: skill.whenToUse ?? '',
          kind: skill.kind,
          source: skill.source ?? null,
        });
        result.created.push(skill.name);
        touched = true;
      } else if (onConflict === 'skip') {
        result.skipped.push(skill.name);
      } else if (onConflict === 'replace') {
        // 2026-05-20: content diff — only call updateSkill and count as updated when a field actually changed.
        // Unconditional replace previously caused every hot-reload to report all existing skills as
        // "N updates"; combined with high-frequency fs.watch triggers this flooded the log. Skip when content unchanged.
        const incomingKw = skill.triggerKeywords || [];
        const kwSame =
          existing.triggerKeywords.length === incomingKw.length &&
          existing.triggerKeywords.every((k, i) => k === incomingKw[i]);
        const sameContent =
          existing.description === (skill.description || '') &&
          existing.actionTemplate === skill.actionTemplate &&
          existing.whenToUse === (skill.whenToUse ?? '') &&
          (existing.source ?? null) === (skill.source ?? null) &&
          kwSame;
        if (sameContent) {
          result.skipped.push(skill.name);
        } else {
          store.updateSkill(skill.name, {
            description: skill.description || '',
            triggerKeywords: incomingKw,
            actionTemplate: skill.actionTemplate,
            whenToUse: skill.whenToUse ?? '',
            source: skill.source ?? null,
          });
          result.updated.push(skill.name);
          touched = true;
        }
      } else if (onConflict === 'merge') {
        // merge: combine triggerKeywords, preserve existing.actionTemplate without overwriting
        const mergedKeywords = Array.from(
          new Set([...existing.triggerKeywords, ...(skill.triggerKeywords || [])]),
        );
        // whenToUse merge strategy: override with new value when non-empty (common scenario after SKILL.md re-parse
        // upgrades the scenario description); preserve old value when new value is empty
        const mergedWhenToUse = (skill.whenToUse?.trim()) || existing.whenToUse;
        store.updateSkill(skill.name, {
          description: skill.description || existing.description,
          triggerKeywords: mergedKeywords,
          whenToUse: mergedWhenToUse,
        });
        result.updated.push(skill.name);
        touched = true;
      }

      // v15: auto-maintain routing rule after bundled / locally-written skill is loaded or updated.
      // Reflection-generated skills (source 'self:reflect-*' / 'self:doc-to-skill:*')
      // use their own routing rule write path; skip here.
      if (touched && options.routingRules) {
        try {
          ensureBundledRoutingRule(options.routingRules, skill);
        } catch (e) {
          // routing rule failure must not pollute the skill import main flow
          console.warn(`[skillImport] ensureBundledRoutingRule(${skill.name}) failed: ${e}`);
        }
      }
    } catch (e) {
      result.errors.push({ name: skill.name, error: String(e) });
    }
  }

  return result;
}
