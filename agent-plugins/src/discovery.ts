/**
 * Plugin discovery — scan directories for subdirectories containing plugin.json
 *
 * Standard directory structure:
 *   plugins/
 *   ├── my-plugin/
 *   │   ├── plugin.json
 *   │   ├── index.js      (or dist/index.js)
 *   │   └── ...
 *   └── another-plugin/
 *       ├── plugin.json
 *       └── ...
 *
 * Default scan locations (highest → lowest priority):
 *   1. workspace plugins:  <workDir>/.philont/plugins/
 *   2. global plugins:     ~/.philont/plugins/
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PluginSource } from './types.js';

export interface DiscoveredPlugin {
  /** Plugin directory */
  pluginDir: string;
  /** plugin.json path */
  manifestPath: string;
  /** Source (used for logging) */
  source: string;
}

/**
 * Scan a single directory and return subdirectories that contain plugin.json
 */
async function scanSource(source: PluginSource): Promise<DiscoveredPlugin[]> {
  const results: DiscoveredPlugin[] = [];

  let entries: string[];
  try {
    entries = await readdir(source.path);
  } catch {
    return results; // directory does not exist
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const pluginDir = join(source.path, entry);
    const s = await stat(pluginDir).catch(() => null);
    if (!s?.isDirectory()) continue;

    const manifestPath = join(pluginDir, 'plugin.json');
    const mStat = await stat(manifestPath).catch(() => null);
    if (!mStat?.isFile()) continue;

    results.push({
      pluginDir,
      manifestPath,
      source: source.label,
    });
  }

  return results;
}

/**
 * Get the default plugin source list
 */
export function defaultPluginSources(workDir?: string): PluginSource[] {
  const sources: PluginSource[] = [];

  if (workDir) {
    sources.push({
      label: 'workspace',
      path: join(workDir, '.philont', 'plugins'),
      priority: 100,
    });
  }

  sources.push({
    label: 'global',
    path: join(homedir(), '.philont', 'plugins'),
    priority: 50,
  });

  return sources;
}

/**
 * Scan all sources and return the list of discovered plugins (sorted by priority)
 *
 * Same-ID plugins: higher-priority source overrides lower-priority
 */
export async function discoverPlugins(sources: PluginSource[]): Promise<DiscoveredPlugin[]> {
  // Scan from lowest to highest priority (higher priority overrides lower)
  const sorted = [...sources].sort((a, b) => (a.priority || 0) - (b.priority || 0));

  // Use a Map for deduplication: key is the plugin directory name
  const seen = new Map<string, DiscoveredPlugin>();

  for (const source of sorted) {
    const found = await scanSource(source);
    for (const p of found) {
      // Use the directory name as the dedup key (not manifest.id because it hasn't been parsed yet)
      const key = p.pluginDir.split(/[/\\]/).pop()!;
      seen.set(key, p);
    }
  }

  return Array.from(seen.values());
}
