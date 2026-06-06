/**
 * Credential management LLM tools (2026-05-07)
 *
 * Lets the LLM securely store user-provided credentials (API key / token / secret) in the
 * SecretStore during a user-driven turn; subsequent http calls reference them via {SECRET_NAME} placeholders.
 *
 * Security constraints:
 *   - Credential entry may only be called when the user explicitly provides one; the LLM must not guess values
 *   - autonomous_turn (system turn triggered by schedule) toolBlacklist should block this tool
 *     (prevents schedule turns from tampering with credentials)
 *   - listCredentialNames exposes only IDs, never values
 *   - Deletion is irreversible (SecretStore.delete); use with care
 *
 * Factory pattern: `createCredentialTools(secretStore)` returns [save, remove, list].
 * The server constructs SecretStore at startup and injects into chat-handler's extraInternalTools.
 */

import type { Tool, SecretStore } from '@agent/policy';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

function validateName(name: unknown): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (!NAME_PATTERN.test(name)) {
    return `name must be 1-64 chars, first char alphanumeric, allowed [a-z0-9_-]. Got: ${String(name).slice(0, 60)}`;
  }
  return null;
}

/**
 * 2026-05-14: Detect LLM incorrectly storing an auth header prefix as the value.
 * Common mistake for weaker LLMs (Qwen / Yi / GLM etc.): pasting the full "Bearer xxx" /
 * "Authorization: Bearer xxx" string as the value, causing the http header to be assembled
 * as "Bearer Bearer xxx" → 401.
 *
 * Returns null = OK; returns string = error message (LLM can read and immediately know how to fix it).
 */
export function detectAuthPrefix(value: string): string | null {
  // Header name + colon + any content
  const headerLine = /^(authorization|x-api-key|x-auth-token|api-key|authentication)\s*:/i;
  if (headerLine.test(value)) {
    return (
      `value looks like an entire HTTP header line (starts with "${value.slice(0, value.indexOf(':') + 1)}").` +
      `\nCorrect: value stores the **bare token** only, with no header name + colon.` +
      `\nExample:\n  ❌ value: "Authorization: Bearer sk-xxx"\n  ✅ value: "sk-xxx"`
    );
  }
  // Various auth scheme prefixes
  const schemePrefix = /^(bearer|token|basic|digest|api[\s_-]?key)\s+/i;
  const m = schemePrefix.exec(value);
  if (m) {
    const stripped = value.slice(m[0].length);
    return (
      `value contains the auth-scheme prefix "${m[0].trim()}", which is HTTP Authorization header syntax and should **not** be stored in the credential value.` +
      `\nThe real token is what remains after stripping the prefix.` +
      `\nExample:\n  ❌ value: "${value.slice(0, 30)}..."\n  ✅ value: "${stripped.slice(0, 30)}..."` +
      `\nCall saveCredential again with the stripped version. On later http calls philont will assemble "Bearer {SECRET_NAME}" automatically.`
    );
  }
  return null;
}

export function createCredentialTools(secretStore: SecretStore): Tool[] {
  const saveCredentialTool: Tool = {
    name: 'saveCredential',
    description:
      'Securely store a user-provided API key / token / secret in the SecretStore, encrypted on disk.' +
      '\n\n[When to use] Two cases:' +
      '\n  (a) The user **explicitly** gave a credential in conversation (e.g. "my X key is sk-xxx")' +
      '\n  (b) A **register / auth API returned a token/api_key/credential** — you MUST store it **immediately**,' +
      ' otherwise later http `{SECRET_ID}` placeholders have no value and all authenticated requests → 401 Authentication required.' +
      '\n      This is a **required step** of the register flow; do not wait for the first http failure to fix it.' +
      '\n\n[When not to use]' +
      '\n- The user did not explicitly provide a credential / a value you guessed' +
      '\n- A system auto turn (schedule-triggered autonomous_turn; already blacklisted)' +
      '\n- **The user only gave a prefix** (api_key_prefix field, not the full key) → ask the user for the full key' +
      '\n\n[How to fill value — do NOT do these]' +
      '\n✗ "Bearer sk-xxx"            — has an auth-scheme prefix' +
      '\n✗ "Authorization: Bearer X"  — an entire header line' +
      '\n✗ \'"sk-xxx"\'                — wrapped in quotes' +
      '\n✗ "sk-xxx\\nother"            — contains a newline / multi-line' +
      '\n✗ a short string < 16 chars   — most likely an api_key_prefix, not the full key' +
      '\n✓ "sk-abc123..."             — a bare token, usually ≥ 20 chars' +
      '\n\nThe mechanism layer rejects the wrong forms above, but get it right at the prompt level (saves a failed retry).' +
      '\n\n[Referencing it later] In http headers use a `{<name>}` placeholder, injected by the host automatically:' +
      '\n- name may be kebab-case (`mycox-api-key`) or snake_case (`github_pat`)' +
      '\n- placeholder fallback: `{MY_KEY}` auto-resolves `{my-key}` / `{my_key}`' +
      '\n- **Do not read a `*_prefix` field from a fact and send it as the full key** — the prefix-leak guard will block it',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Credential name, kebab-case or snake_case, 1-64 chars.' +
            ' Common convention: `<service>-api-key` / `<service>_token` (e.g. slack_bot_token / openai_api_key / github_pat).' +
            ' A same name **overwrites** (used for key rotation).',
        },
        value: {
          type: 'string',
          description: 'The real credential value the user gave. **Never** repeat it in any description.',
        },
        description: {
          type: 'string',
          description: 'Optional purpose note (not stored; audit only).',
        },
      },
      required: ['name', 'value'],
    },
    capability: 'write',
    domain: 'self',
    async execute(params) {
      const nameErr = validateName(params.name);
      if (nameErr) return { success: false, output: '', error: nameErr };
      const value = params.value;
      if (typeof value !== 'string' || value.length === 0) {
        return { success: false, output: '', error: 'value is required and must be a non-empty string' };
      }
      // 2026-05-14: auth-prefix mis-storage detector (common weak-LLM mistake).
      // Historical pain point: LLM stores the full "Bearer sk-xxx" / "Authorization: Bearer ..."
      // block as the value instead of the bare token. Next http header is assembled as "Bearer Bearer xxx"
      // → 401 Invalid token format.
      const prefixCheck = detectAuthPrefix(value);
      if (prefixCheck) {
        return {
          success: false,
          output: '',
          error: prefixCheck,
        };
      }
      // value contains newline / tab → clearly pasted multi-line content (possibly a whole header block)
      if (/[\r\n\t]/.test(value)) {
        return {
          success: false,
          output: '',
          error:
            `value contains a newline or tab — you may have pasted multi-line content (a whole curl -H "..."? an HTTP response body?).` +
            `\nCorrect: value should be a **bare token string** — no newline / no "Authorization:" header name / no "Bearer " prefix / no surrounding context.` +
            `\nExample:\n  ❌ value: "Authorization: Bearer sk-xxx"\n  ❌ value: "Bearer sk-xxx"\n  ❌ value: '"sk-xxx"' (quoted)\n  ✅ value: "sk-xxx"`,
        };
      }
      // value is entirely wrapped in quotes (common when pasting a JSON field value including its quotes)
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        return {
          success: false,
          output: '',
          error:
            `value is wrapped in quotes — you may have pasted a string (including its quotes) straight from a JSON response.` +
            `\nCorrect: strip the surrounding quotes and store only the bare token.` +
            `\nExample:\n  ❌ value: '"sk-abc123"'\n  ✅ value: "sk-abc123"`,
        };
      }
      if (value.length > 8192) {
        return { success: false, output: '', error: 'value exceeds 8192 chars, too long (a normal API key is < 200)' };
      }
      if (value.length < 16) {
        return {
          success: false,
          output: '',
          error:
            `value is only ${value.length} chars, below the 16-char threshold.\n` +
            `Common API keys are ≥ 20 chars (AWS=20 / GitHub PAT=40 / Anthropic=100+).\n` +
            `You may have stored an **api_key_prefix truncated prefix** (typically svc_xxxxxxxx, ~12 chars) rather than the full api_key.\n` +
            `Check the register response — the full key is usually in the \`api_key\` field and the prefix in \`api_key_prefix\`; **don't mix them up**.\n` +
            `If you are sure this is the full credential (rare short-key services), pad value to ≥ 16 chars and retry, or ask a philont maintainer to relax the threshold.`,
        };
      }
      try {
        const isUpdate = secretStore.has(params.name as string);
        secretStore.set(params.name as string, value);
        const placeholder = `{${(params.name as string).toUpperCase().replace(/-/g, '_')}}`;
        return {
          success: true,
          output:
            `✅ Credential '${params.name}' ${isUpdate ? 'updated' : 'saved'} (${value.length} chars, encrypted to the SecretStore on disk)\n` +
            `\nPlaceholder: ${placeholder}\n` +
            `\n**Strongly recommend verifying immediately** — call the service's auth endpoint once to confirm the key is complete and works:\n` +
            '```\n' +
            `http({\n` +
            `  method: "GET",\n` +
            `  url: "<base_url>/auth/verify (or /me / /health)",\n` +
            `  headers: { "Authorization": "Bearer ${placeholder}" }\n` +
            `})\n` +
            '```\n' +
            (isUpdate
              ? '\n(Overwrote an existing same-named credential — if the old value is still referenced, confirm the rotation is complete)'
              : '\n(First save. If captured from a register response — check you have the full api_key, not an api_key_prefix)'),
        };
      } catch (e) {
        return { success: false, output: '', error: `Save failed: ${String(e).slice(0, 200)}` };
      }
    },
  };

  const removeCredentialTool: Tool = {
    name: 'removeCredential',
    description:
      'Delete a credential from the SecretStore. [When to use] The user explicitly asks to delete (e.g. "forget my <service> key"), or cleanup after a service is retired. [When not to use] When unsure whether it is still in use / for key rotation (use saveCredential to overwrite).',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Credential name, matching what you used in saveCredential' },
      },
      required: ['name'],
    },
    capability: 'write',
    domain: 'self',
    async execute(params) {
      const nameErr = validateName(params.name);
      if (nameErr) return { success: false, output: '', error: nameErr };
      const removed = secretStore.delete(params.name as string);
      return {
        success: true,
        output: removed
          ? `Credential '${params.name}' deleted`
          : `Credential '${params.name}' does not exist; nothing to delete`,
      };
    },
  };

  const listCredentialNamesTool: Tool = {
    name: 'listCredentialNames',
    description:
      'List which credentials are currently in the SecretStore (names only, **never values**).' +
      '\n[When to use] The user asks "which keys did I give you" / checking before service onboarding whether one is already configured / confirming a placeholder is available before an authenticated http call.' +
      '\n[Correct usage] Reference a name from the result in an http call via a `{<name>}` placeholder; the host injects the full value before sending the request. The LLM never needs to read the full secret; **do not** read a `*_prefix` / `*_token` field from a fact and use it as the full key — that is a prefix, not the full value, and outbound traffic will be blocked by the prefix-leak guard.',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    capability: 'read',
    domain: 'self',
    async execute() {
      const names = secretStore.list();
      if (names.length === 0) {
        return {
          success: true,
          output:
            'No credentials are currently saved.\n' +
            'If needed, have the user provide one via saveCredential; in http calls write a `{<credential-name>}` placeholder and the host injects the full value automatically.',
        };
      }
      return {
        success: true,
        output:
          `Saved credentials (${names.length}):\n${names.map((n) => `- ${n}`).join('\n')}\n` +
          `\n## How to use\n` +
          `In an http call, write a placeholder and the host injects the full value automatically:\n` +
          '```\n' +
          `http({\n` +
          `  url: "https://api.example.com/endpoint",\n` +
          `  headers: { "Authorization": "Bearer {<credential-name>}" }\n` +
          `})\n` +
          '```\n' +
          `- Placeholder syntax \`{<name>}\` without quotes; the host substitutes it on the way out\n` +
          `- Placeholders support fallback: \`{MY_API_KEY}\` auto-resolves to \`my-api-key\` (snake/kebab interconversion, case-insensitive)\n` +
          `- The full secret is never exposed to the LLM; write the placeholder directly, don't assemble a prefix field from a fact`,
      };
    },
  };

  return [saveCredentialTool, removeCredentialTool, listCredentialNamesTool];
}
