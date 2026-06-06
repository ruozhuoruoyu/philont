/**
 * Plugin manifest parsing + validation
 *
 * Uses JSON-Schema-style validation without executing any code.
 * Plugins that fail validation are skipped and the error is logged.
 */

import { readFile } from 'node:fs/promises';
import type { PluginManifest } from './types.js';

export interface ManifestValidationResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors: string[];
}

/**
 * Validate + parse a plugin.json file
 */
export async function loadManifest(path: string): Promise<ManifestValidationResult> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (e) {
    return { valid: false, errors: [`Cannot read manifest: ${e}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { valid: false, errors: [`Invalid JSON: ${e}`] };
  }

  return validateManifest(parsed);
}

/**
 * Validate a manifest object
 */
export function validateManifest(obj: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['Manifest must be a JSON object'] };
  }

  const m = obj as Record<string, unknown>;

  // Required fields
  for (const field of ['id', 'name', 'version'] as const) {
    if (typeof m[field] !== 'string' || !m[field]) {
      errors.push(`"${field}" must be a non-empty string`);
    }
  }

  // id format: lowercase alphanumeric with hyphens
  if (typeof m.id === 'string' && !/^[a-z][a-z0-9-]*$/.test(m.id)) {
    errors.push('"id" must match /^[a-z][a-z0-9-]*$/');
  }

  // Optional field types
  if (m.description !== undefined && typeof m.description !== 'string') {
    errors.push('"description" must be a string');
  }
  if (m.main !== undefined && typeof m.main !== 'string') {
    errors.push('"main" must be a string');
  }
  if (m.requiresEnv !== undefined) {
    if (!Array.isArray(m.requiresEnv) || !m.requiresEnv.every((s) => typeof s === 'string')) {
      errors.push('"requiresEnv" must be a string array');
    }
  }
  if (m.providesTools !== undefined) {
    if (!Array.isArray(m.providesTools) || !m.providesTools.every((s) => typeof s === 'string')) {
      errors.push('"providesTools" must be a string array');
    }
  }
  if (m.sandbox !== undefined && m.sandbox !== 'direct' && m.sandbox !== 'worker') {
    errors.push('"sandbox" must be "direct" or "worker"');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    manifest: m as unknown as PluginManifest,
    errors: [],
  };
}

/**
 * Check whether environment variables satisfy the plugin's requirements
 */
export function checkEnvRequirements(manifest: PluginManifest): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const varName of manifest.requiresEnv || []) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }
  return { ok: missing.length === 0, missing };
}
