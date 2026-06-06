/**
 * installSkill / uninstallSkill tools
 *
 * Kernel mechanism layer (mechanism, not policy): provides general primitives for "install/uninstall SKILL.md".
 * How to discover new skills / which registry to pull from is the SKILL.md (policy layer)'s own concern —
 * the factory-bundled `clawhub` / `github-skills` SKILL.md teaches the agent to use each CLI/API,
 * then uses these two tools to write the result into .philont/skills/.
 *
 * Design notes:
 *   - These two tools do **not call SkillStore directly**; they only touch the filesystem.
 *     DB consistency is guaranteed by server/chat-handler's reload-prune path (fs watcher
 *     + reloadSkillsFromDisk reads new files and calls importSkills; orphan rows are cleared on prune).
 *     This keeps agent-tools free of a dependency on agent-memory, maintaining an acyclic package graph.
 *
 *   - Security falls back on the 3×4 matrix: capability='write', domain='self', same level as memoryTool.
 *     SKILL.md content is not pre-audited — the same threat surface as webFetch pulling page content into a prompt.
 *     The size cap in loader.parseSkillFile (8KB) blocks the extreme case of "stuffing a long doc into a prompt".
 */

import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '@agent/policy';

/**
 * Validate a skill name.
 *   - Must be 1-64 characters
 *   - Only [a-z0-9_-] allowed (lowercase letters / digits / underscores / hyphens)
 *   - '.' and '..' (pure punctuation) are not allowed
 *
 * This is defense in depth: normal SKILL.md names all pass; any path-traversal
 * attempt is blocked here before it even reaches join().
 */
function validateSkillName(name: string): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (name.length === 0) return 'name must not be empty';
  if (name.length > 64) return 'name exceeds 64 characters';
  if (name === '.' || name === '..') return `name cannot be "${name}"`;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return 'name must match [a-z0-9_-] (lowercase letters, digits, underscores, hyphens only)';
  }
  return null;
}

/**
 * Install root: <cwd>/.philont/skills/. Always writes here — the loader also scans here first
 * on read, closing the semantic loop. <cwd>/skills/ is an openclaw upstream convention,
 * read-only here, to avoid double-write conflicts between user-manual installs and agent installs.
 */
function installRoot(): string {
  return join(process.cwd(), '.philont', 'skills');
}

/**
 * Candidate uninstall root list: .philont/skills/ first (our write path),
 * skills/ as fallback (the default directory for `clawhub install`, also read by the philont loader).
 */
function uninstallCandidates(): string[] {
  return [
    join(process.cwd(), '.philont', 'skills'),
    join(process.cwd(), 'skills'),
  ];
}

/**
 * Inject or replace a key in the frontmatter block.
 *
 * Behaviour:
 *   - If `^<key>:.*$` already exists → replace the entire line
 *   - If absent → insert on the line before the closing `---`
 *   - No frontmatter → create a new block at the top of the file containing only this key
 *
 * Does not attempt to preserve YAML comments / quoting style — SKILL.md frontmatter uses a
 * minimal key:value form (see loader.ts:parseFrontmatter); round-trip does not need full YAML.
 */
function injectFrontmatterField(content: string, key: string, value: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const line = `${key}: ${value}`;
  const keyRe = new RegExp(`^${key}:.*$`, 'm');

  if (!fmMatch) {
    // No frontmatter: create a new block
    return `---\n${line}\n---\n\n${content}`;
  }

  const [, yamlBlock, body] = fmMatch;
  let newYaml: string;
  if (keyRe.test(yamlBlock)) {
    newYaml = yamlBlock.replace(keyRe, line);
  } else {
    newYaml = yamlBlock.trimEnd() + '\n' + line;
  }
  return `---\n${newYaml}\n---\n${body}`;
}

/**
 * Install a SKILL.md into the local skill library.
 *
 * Dual mode:
 *   - write mode (content provided): write a new file / overwrite. Optionally inject a source tag.
 *   - patch mode (only source provided): the file must already exist; only updates the frontmatter source field.
 *     Used to add a source tag after a multi-file `clawhub install` bundle has been written to disk.
 *
 * The file lands at <cwd>/.philont/skills/<name>/SKILL.md. After the fs watcher triggers a reload,
 * the SKILL.md enters SkillStore and is visible in the system prompt index next turn.
 */
export const installSkillTool: Tool = {
  name: 'installSkill',
  description:
    'Install a SKILL.md into the local skill library (.philont/skills/<name>/). ' +
    'Provide content to write a new file; provide only source to tag the frontmatter source field of an existing file (for use with clawhub install). ' +
    'After writing, the fs watcher triggers a reload and the new skill becomes visible in the system prompt index next turn.',
  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name / directory name. Only [a-z0-9_-], max 64 chars.',
      },
      content: {
        type: 'string',
        description: 'Full SKILL.md text (including frontmatter). Optional — if omitted, only the source field is patched.',
      },
      source: {
        type: 'string',
        description:
          'Source tag, e.g. "clawhub:k8s-yaml-lint@2.1.0" / "github:owner/repo@<sha>" / "url:https://...". ' +
          'Optional — will be injected/replaced in the frontmatter source: field.',
      },
    },
    required: ['name'],
  },
  capability: 'write',
  domain: 'self',

  async execute(params) {
    try {
      const name = params.name as string;
      const content = params.content as string | undefined;
      const source = params.source as string | undefined;

      const nameErr = validateSkillName(name);
      if (nameErr) {
        return { success: false, output: '', error: `installSkill: ${nameErr}` };
      }

      if (!content && !source) {
        return {
          success: false,
          output: '',
          error: 'installSkill: must provide at least content (write a new file) or source (patch frontmatter)',
        };
      }

      const dir = join(installRoot(), name);
      const file = join(dir, 'SKILL.md');

      let finalContent: string;

      if (content) {
        // write mode: write new file / overwrite
        // Ensure frontmatter contains name (inject if the SKILL.md does not declare it)
        finalContent = injectFrontmatterField(content, 'name', name);
        if (source) {
          finalContent = injectFrontmatterField(finalContent, 'source', source);
        }
      } else {
        // patch mode: file must exist; only change the source field
        let existing: string;
        try {
          existing = await readFile(file, 'utf-8');
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') {
            // patch fallback: the user used the default clawhub install directory (skills/)
            const altFile = join(process.cwd(), 'skills', name, 'SKILL.md');
            try {
              existing = await readFile(altFile, 'utf-8');
              // Migrate it to our standard directory (.philont/skills/) while tagging source
              finalContent = injectFrontmatterField(existing, 'source', source!);
              await mkdir(dir, { recursive: true });
              await writeFile(file, finalContent, 'utf-8');
              return {
                success: true,
                output:
                  `📥 Installed skill ${name} (migrated from skills/ to .philont/skills/, source: ${source})`,
              };
            } catch {
              return {
                success: false,
                output: '',
                error: `installSkill: patch mode requires the file to exist, but ${file} does not`,
              };
            }
          }
          throw e;
        }
        finalContent = injectFrontmatterField(existing, 'source', source!);
      }

      await mkdir(dir, { recursive: true });
      await writeFile(file, finalContent, 'utf-8');

      const sourceLabel = source ? `source: ${source}` : 'local';
      return {
        success: true,
        output: `📥 Installed skill ${name} (${sourceLabel})`,
      };
    } catch (e) {
      return { success: false, output: '', error: `installSkill failed: ${(e as Error).message}` };
    }
  },
};

/**
 * Uninstall a locally installed skill: delete the .philont/skills/<name>/ directory.
 *
 * Implementation only touches the filesystem — does not call SkillStore directly.
 * After the fs watcher triggers a reload, the server-side prune path finds orphan rows
 * in SkillStore where source!=null but the file no longer exists on disk, and
 * calls deleteSkill automatically. This keeps agent-tools free of a dependency on agent-memory.
 *
 * Idempotent: returns success even if the directory does not exist (the user may have deleted it manually).
 */
export const uninstallSkillTool: Tool = {
  name: 'uninstallSkill',
  description:
    'Uninstall a locally installed skill: removes the .philont/skills/<name>/ directory (also checks skills/<name>/ as fallback). ' +
    'Idempotent — returns success even if the directory is already gone. The fs watcher triggers a reload and SkillStore cleans up the DB row automatically.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name / directory name, same rules as installSkill' },
    },
    required: ['name'],
  },
  capability: 'write',
  domain: 'self',

  async execute(params) {
    try {
      const name = params.name as string;

      const nameErr = validateSkillName(name);
      if (nameErr) {
        return { success: false, output: '', error: `uninstallSkill: ${nameErr}` };
      }

      let removed = 0;
      for (const root of uninstallCandidates()) {
        const dir = join(root, name);
        try {
          const s = await stat(dir);
          if (s.isDirectory()) {
            await rm(dir, { recursive: true, force: true });
            removed++;
          }
        } catch (e) {
          // ENOENT = directory not found, skip; other errors re-throw
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }

      // Idempotent: count as success even if the directory was not found (user may have
      // deleted it manually; any stale DB rows are cleaned up by reload-prune).
      const note = removed === 0 ? '(directory was already absent; any stale DB row will be cleaned up by reload-prune)' : '';
      return {
        success: true,
        output: `📤 Uninstalled skill ${name} ${note}`.trim(),
      };
    } catch (e) {
      return { success: false, output: '', error: `uninstallSkill failed: ${(e as Error).message}` };
    }
  },
};
