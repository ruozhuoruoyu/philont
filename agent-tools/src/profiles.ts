/**
 * Tool profiles — control which tool subset is available in different scenarios
 *
 * Analogous to Linux capability sets: a process doesn't get all permissions, but receives a subset per role.
 *
 * Supports:
 *   - Built-in profiles: minimal / readonly / coding / full
 *   - Custom profiles: extend or override via a JSON config file
 *   - Inheritance: compose existing profiles via the `extends` field
 */

import { readFile } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

export type BuiltinProfile = 'minimal' | 'readonly' | 'coding' | 'full';
export type ToolProfile = BuiltinProfile | string;

/** Custom profile definition */
export interface ProfileDef {
  /** Parent profile to inherit from (can be built-in or custom) */
  extends?: string;
  /** Tool names to add */
  include?: string[];
  /** Tool names to exclude (higher priority than include) */
  exclude?: string[];
  /** Full replacement: if provided, ignores extends/include and uses this list directly */
  tools?: string[];
}

/** Profile set: profileName → definition */
export type ProfileSet = Record<string, ProfileDef>;

/** Tool lists for built-in profiles */
const BUILTIN_TOOLS: Record<Exclude<BuiltinProfile, 'full'>, string[]> = {
  minimal:  ['echo', 'time', 'readFile', 'listDir', 'inspectPath'],
  readonly: [
    'echo', 'time', 'json', 'hash', 'env',
    'readFile', 'listDir', 'inspectPath', 'grep', 'glob',
    'http', 'webSearch', 'webFetch', 'vision',
    'git',
    'askUserQuestion',
  ],
  coding: [
    'echo', 'time', 'memory', 'json', 'jsonPatch', 'hash', 'env',
    'readFile', 'writeFile', 'deleteFile', 'moveFile', 'listDir', 'inspectPath',
    'grep', 'glob', 'patch',
    'shell', 'process', 'z3Verify', 'pariGp',
    'http', 'webSearch', 'webFetch', 'downloadFile', 'vision',
    'git',
    'askUserQuestion',
    'installSkill', 'uninstallSkill',
  ],
};

/**
 * Resolve a profile → list of tool names
 *
 * @param profile   profile name
 * @param customSet custom profile set (optional)
 * @returns         list of tool names; null = unrestricted (full profile)
 */
export function resolveProfile(
  profile: ToolProfile,
  customSet: ProfileSet = {},
): string[] | null {
  return resolveProfileInner(profile, customSet, new Set());
}

function resolveProfileInner(
  profile: ToolProfile,
  customSet: ProfileSet,
  seen: Set<string>,
): string[] | null {
  // full means unrestricted
  if (profile === 'full') return null;

  // Custom profiles take priority (can override built-ins)
  if (profile in customSet) {
    return resolveCustom(profile, customSet, seen);
  }

  // Built-in profile
  if (profile in BUILTIN_TOOLS) {
    return [...BUILTIN_TOOLS[profile as Exclude<BuiltinProfile, 'full'>]];
  }

  throw new Error(`Unknown profile: ${profile}`);
}

function resolveCustom(name: string, set: ProfileSet, seen: Set<string>): string[] {
  if (seen.has(name)) {
    throw new Error(`Circular profile reference: ${[...seen, name].join(' → ')}`);
  }
  seen.add(name);

  const def = set[name];
  if (!def) throw new Error(`Undefined profile: ${name}`);

  // tools field is a direct replacement
  if (def.tools) return [...def.tools];

  // Inherit from parent profile (shares seen set to detect cycles)
  const base = def.extends
    ? (resolveProfileInner(def.extends, set, seen) || [])
    : [];

  const working = new Set(base);
  for (const t of def.include || []) working.add(t);
  for (const t of def.exclude || []) working.delete(t);

  return [...working];
}

/**
 * Filter a tool list by profile
 */
export function filterByProfile(
  tools: Tool[],
  profile: ToolProfile,
  customSet?: ProfileSet,
): Tool[] {
  const names = resolveProfile(profile, customSet);
  if (names === null) return tools; // full
  const allowed = new Set(names);
  return tools.filter((t) => allowed.has(t.name));
}

/**
 * Get the list of tool names allowed by a profile
 */
export function getProfileToolNames(
  profile: ToolProfile,
  customSet?: ProfileSet,
): string[] | null {
  return resolveProfile(profile, customSet);
}

/**
 * Load a profile set from a JSON config file
 *
 * File format:
 *   {
 *     "profiles": {
 *       "research": {
 *         "extends": "readonly",
 *         "include": ["grep", "glob"]
 *       },
 *       "minimal-plus": {
 *         "extends": "minimal",
 *         "include": ["grep"]
 *       }
 *     }
 *   }
 */
export async function loadProfilesFromFile(path: string): Promise<ProfileSet> {
  const content = await readFile(path, 'utf-8');
  const parsed = JSON.parse(content) as { profiles?: ProfileSet };
  if (!parsed.profiles || typeof parsed.profiles !== 'object') {
    throw new Error(`Invalid profile config: missing "profiles" object`);
  }
  return parsed.profiles;
}
