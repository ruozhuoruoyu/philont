/**
 * skill_install_wrapper — wraps the fs-only install/uninstallSkill tools to synchronously
 * trigger a SkillStore reload after execution.
 *
 * Background: the installSkillTool / uninstallSkillTool shipped by agent-tools only touch
 * the filesystem; they do not directly update the SkillStore (to keep agent-tools independent
 * of agent-memory and maintain an acyclic package dependency graph). DB consistency relies on
 * fs.watch asynchronously triggering reloadSkillsFromDisk with a 250ms debounce + fs event
 * propagation delay. The LLM can call install→use within the same turn with nearly zero
 * delay → SkillStore not yet refreshed → use_skill returns null → user sees "skill I just
 * installed is not usable".
 *
 * Fix: wrap at the server layer (the seam that holds both agent-tools and SkillStore); after
 * a successful execute, synchronously `await reloadSkillsFromDisk` before returning the
 * result. This makes the tool call boundary the same as the "installed and visible" boundary,
 * so the LLM can immediately use_skill and it will be found.
 *
 * reload failure does not contaminate the original result — the file is already written to
 * disk successfully; a reload failure is more of a runtime environment problem and should not
 * cause the LLM to see a self-contradictory ⚠ + file-already-exists state. A warn log is
 * left for ops debugging.
 */

import type { Tool } from '@agent/policy';

export function wrapSkillToolWithReload(
  tool: Tool,
  reload: () => Promise<void>,
): Tool {
  return {
    ...tool,
    async execute(params: Record<string, unknown>) {
      const result = await tool.execute(params);
      if (result.success) {
        try {
          await reload();
        } catch (e) {
          console.warn(`[${tool.name}] post-reload failed:`, e);
        }
      }
      return result;
    },
  };
}
