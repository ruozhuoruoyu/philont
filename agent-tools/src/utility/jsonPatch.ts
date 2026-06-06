/**
 * jsonPatch tool - RFC 6902 style structured JSON editing
 *
 * Supported operations:
 *   - add      add a value at a path
 *   - remove   delete a path
 *   - replace  replace the value at a path
 *   - move     move a value (from → path)
 *   - copy     copy a value (from → path)
 *   - test     assert the value at a path (for idempotency)
 *
 * Paths use JSON Pointer format (RFC 6901):
 *   /foo/bar       accesses obj.foo.bar
 *   /foo/0         accesses obj.foo[0]
 *   /foo/-         appends to the end of an array
 */

import type { Tool } from '@agent/policy';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

interface Op {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: JsonValue;
  from?: string;
}

function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Invalid pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getByPointer(doc: JsonValue, pointer: string): { parent: any; key: string | number; value: JsonValue } | null {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) return { parent: null, key: '', value: doc };

  let cur: any = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return null;
    const t = Array.isArray(cur) ? Number(tokens[i]) : tokens[i];
    cur = cur[t as any];
  }
  if (cur === null || typeof cur !== 'object') return null;
  const lastRaw = tokens[tokens.length - 1];
  const key = Array.isArray(cur) ? Number(lastRaw) : lastRaw;
  return { parent: cur, key, value: cur[key as any] };
}

function applyOp(doc: JsonValue, op: Op): JsonValue {
  switch (op.op) {
    case 'test': {
      const hit = getByPointer(doc, op.path);
      if (!hit) throw new Error(`test: path not found ${op.path}`);
      if (JSON.stringify(hit.value) !== JSON.stringify(op.value)) {
        throw new Error(`test: value mismatch at ${op.path}`);
      }
      return doc;
    }

    case 'add':
    case 'replace': {
      if (op.value === undefined) throw new Error(`${op.op}: value required`);
      const tokens = parsePointer(op.path);
      if (tokens.length === 0) return op.value;
      const hit = getByPointer(doc, op.path);
      if (!hit) throw new Error(`${op.op}: parent not found ${op.path}`);
      if (Array.isArray(hit.parent)) {
        const lastToken = tokens[tokens.length - 1];
        if (op.op === 'add') {
          const idx = lastToken === '-' ? hit.parent.length : Number(lastToken);
          hit.parent.splice(idx, 0, op.value);
        } else {
          hit.parent[Number(lastToken)] = op.value;
        }
      } else {
        hit.parent[hit.key as string] = op.value;
      }
      return doc;
    }

    case 'remove': {
      const tokens = parsePointer(op.path);
      if (tokens.length === 0) throw new Error('remove: cannot remove root');
      const hit = getByPointer(doc, op.path);
      if (!hit) throw new Error(`remove: path not found ${op.path}`);
      if (Array.isArray(hit.parent)) {
        hit.parent.splice(Number(hit.key), 1);
      } else {
        delete hit.parent[hit.key as string];
      }
      return doc;
    }

    case 'move':
    case 'copy': {
      if (!op.from) throw new Error(`${op.op}: from required`);
      const src = getByPointer(doc, op.from);
      if (!src) throw new Error(`${op.op}: source not found ${op.from}`);
      const value = JSON.parse(JSON.stringify(src.value)) as JsonValue;
      if (op.op === 'move') {
        doc = applyOp(doc, { op: 'remove', path: op.from });
      }
      return applyOp(doc, { op: 'add', path: op.path, value });
    }
  }
}

export const jsonPatchTool: Tool = {
  name: 'jsonPatch',
  description: 'RFC 6902 JSON Patch editing (add/remove/replace/move/copy/test)',
  schema: {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Input JSON string' },
      operations: {
        type: 'array',
        description: 'List of operations (per RFC 6902)',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'] },
            path: { type: 'string', description: 'JSON Pointer path (e.g. /foo/0/bar)' },
            value: { description: 'Value for add/replace/test' },
            from: { type: 'string', description: 'Source path for move/copy' },
          },
          required: ['op', 'path'],
        },
      },
    },
    required: ['document', 'operations'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    const documentStr = params.document as string;
    const operations = params.operations as Op[];

    let doc: JsonValue;
    try {
      doc = JSON.parse(documentStr);
    } catch (e) {
      return { success: false, output: '', error: `Invalid JSON: ${e}` };
    }

    try {
      for (const op of operations) {
        doc = applyOp(doc, op);
      }
      return { success: true, output: JSON.stringify(doc, null, 2) };
    } catch (e) {
      return { success: false, output: '', error: String(e) };
    }
  },
};
