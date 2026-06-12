/**
 * Pure-function helper layer for plan_protocol_gate.
 *
 * Decoupled from chat-handler.ts; **no side effects** — does not import any module that
 * opens a DB or starts a driver. chat-handler.ts re-exports both functions for backward
 * compatibility.
 *
 * Design principles (Phase 18, 2026-05-27, "lazy gate"):
 *   The gate should fire at **"the contract moment before writing code"** (the LLM is about
 *   to make a real change), not at **"before an exploration task"** (the LLM hasn't seen
 *   the data yet).
 *
 *   Read-only shell commands (ls / find / cat / grep etc.) are treated as read-equivalents,
 *   passed through on the same basis as readFile / listDir / glob and other read-class tools.
 *
 *   Result:
 *     - Data-exploration tasks (debug / PR review / incident response):
 *       shell ls etc. can be called freely during exploration; not locked by the gate
 *     - Recurring-schedule tasks (mycox / heartbeat):
 *       the first POST API call (write×network) immediately fires the gate, enforcing the
 *       plan flow
 *     - Config-deploy / external research:
 *       gate fires on the first real write/execute change after exploration completes
 *
 * Motivation: root cause of a multi-step data-standardization task agent-fail —
 * in-turn-tool-block locking readFile + plan_protocol_gate locking shell created a double
 * blockade with no way forward → LLM 90s timeout.
 */

// Phase 18: "read-equivalent" allowlist for shell commands.
//
// Design principle: **strict allowlist + deny escape paths**. It is better to under-allow
// (LLM switches to read-class tools) than to over-allow (let a potentially write-capable
// command through).
//
// Commands NOT in the allowlist (write-capable):
//   - tee / sponge / dd: write to files
//   - sed / awk: `-i` option allows in-place file modification
//   - tar / zip / gzip / gunzip: create / modify archives
//   - rm / mv / cp / mkdir / touch / chmod / chown: file mutation
//   - curl / wget: can POST / -o write to file
//   - python / node / bash / sh / ruby / perl: arbitrary scripts can do anything
//   - git: can modify working tree / push
//   - xargs: itself is read, but whether the downstream command is read determines safety
//             — controlled strictly via firstWord
//
// To use any of the above → LLM calls plan_draft → plan_update_step doing → gate opens.
const READ_ONLY_SHELL_VERBS = new Set([
  'ls',
  'find',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'wc',
  'stat',
  'file',
  'du',
  'df',
  'pwd',
  'whoami',
  'id',
  'echo',
  'printf',
  'date',
  'uname',
  'which',
  'whereis',
  'type',
  'sort',
  'uniq',
  'tr',
  'cut',
  'tree',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'jq',
  'yq',
]);

export function isReadOnlyShellCommand(commandInput: unknown): boolean {
  if (typeof commandInput !== 'string') return false;
  const cmd = commandInput.trim();
  if (!cmd) return false;
  // Reject shell combinations that could escape to write:
  //   - Redirect > >> (file overwrite/append)
  //   - Command chaining ; & && || (may chain to write commands)
  //   - Backtick / $(...) command substitution (may embed write)
  //   - |tee / |sponge / |dd writing to file
  //
  // Note: || must be explicitly escaped — | is a regex metacharacter. && is covered by [;&].
  // Single | (pipe) is allowed — ls | grep / cat | head are still read-only chains.
  if (/[;&]|>{1,2}|\$\(|`|\|\|/.test(cmd)) return false;
  if (/\|\s*(tee|sponge|dd)\b/.test(cmd)) return false;
  // Take the first word (ignoring space-separated arguments); require it to be in the allowlist
  const firstWord = cmd.split(/\s+/)[0];
  if (!READ_ONLY_SHELL_VERBS.has(firstWord)) return false;
  // find special case: block -delete / -exec / -execdir (side-effect flags)
  if (firstWord === 'find') {
    if (/-delete\b|-exec(dir)?\b/.test(cmd)) return false;
  }
  return true;
}

// env PHILONT_PLAN_GATE_EXEMPT_READONLY=0 reverts to Phase 7 strict mode (only plan_* /
// task_mode_classify pass through; all other tools are subject to plan state constraints).
//
// Phase 18 (2026-05-27, "lazy gate"): shell command whose first word is in READ_ONLY_SHELL_VERBS
// and has no escape characters → treated as read-equivalent, passed through.
export function isPlanGateExempt(
  toolName: string,
  classification: { capability: string; domain: string } | null,
  toolInput?: Record<string, unknown> | undefined,
): boolean {
  if (toolName === 'task_mode_classify') return true;
  if (toolName.startsWith('plan_')) return true;
  // deep_explore is its own deep-work protocol (decompose → verify per claim → cross-turn tracking),
  // with rigor at least equal to the plan flow. Gating it behind plan_draft stacks two protocols and
  // (observed in production) locked the exploration pathway out entirely: the classifier picked slow
  // mode for an exploration-shaped request, then the gate banned deep_explore until a plan was
  // drafted — so the model fell back to inline web searching. Let it be chosen directly.
  if (toolName === 'deep_explore') return true;
  // askUserQuestion is classified as read×local, but during the plan-drafting phase
  // the LLM must not ask the user (prevents offloading responsibility).
  // Legitimate use is during the plan-executing phase where the gate already opens all tools.
  if (toolName === 'askUserQuestion') return false;
  if (process.env.PHILONT_PLAN_GATE_EXEMPT_READONLY === '0') return false;
  if (!classification) return false;
  if (classification.capability === 'read') return true;
  if (classification.capability === 'write' && classification.domain === 'self') return true;
  // Phase 18: shell with read-only command prefix → exempt.
  // Only execute×local + first word in READ_ONLY_SHELL_VERBS + no escape chars qualifies.
  // Other execute (execute×network / execute×system / shell with rm/curl/python etc.)
  // remain subject to plan state constraints.
  if (
    toolName === 'shell' &&
    classification.capability === 'execute' &&
    classification.domain === 'local' &&
    isReadOnlyShellCommand(toolInput?.command)
  ) {
    return true;
  }
  return false;
}
