/**
 * Secured HTTP tool — supports zero-exposure credential injection
 *
 * Usage:
 *   const httpTool = createSecuredHttpTool(secretStore);
 *   // The LLM can call:
 *   httpTool.execute({
 *     url: 'https://api.github.com/user',
 *     headers: { 'Authorization': 'Bearer {GITHUB_TOKEN}' },
 *   });
 *   // The plaintext token never appears in the tool code; injection happens in the fetch wrapper layer.
 *
 * Differences from the plain httpTool:
 *   - Uses an injecting fetch that recognizes {SECRET_ID} and replaces them
 *   - Plaintext values never appear in tool params or tool output (unless the API echoes them back)
 *   - The response body is run through redactOutput (covers 15+ secret patterns) before being returned
 */

import type { Tool, SecretStore } from '@agent/policy';
import { createInjectingFetch, redactOutput } from '@agent/policy';

export interface SecuredHttpOptions {
  /** Whitelist of secret IDs allowed for injection; if not provided, all secrets in the store are allowed */
  allowedSecrets?: string[];
  /** Whether to redact secrets from the response body, default true */
  redactResponse?: boolean;
  /** Injection callback (for auditing) */
  onInject?: (info: { secretIds: string[]; url: string }) => void;
}

export function createSecuredHttpTool(
  store: SecretStore,
  options: SecuredHttpOptions = {},
): Tool {
  const allowed = options.allowedSecrets ? new Set(options.allowedSecrets) : undefined;
  const redactResponse = options.redactResponse ?? true;

  const injectingFetch = createInjectingFetch(store, {
    allowedSecrets: allowed,
    scanPreInject: true,
    onInject: options.onInject,
  });

  return {
    name: 'http',
    description: 'Send an HTTP request (supports {SECRET_ID} credential placeholders, injected automatically by the host)',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL, may contain {SECRET_ID} placeholders' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        headers: { type: 'object', description: 'Request headers, may contain {SECRET_ID} placeholders' },
        body: {
          description:
            'Request body. Pass a string (sent as-is) or an object (auto JSON.stringify + adds Content-Type: application/json). May contain {SECRET_ID} placeholders.',
        },
      },
      required: ['url'],
    },
    capability: 'read',
    domain: 'network',
    classify(params) {
      const method = String(params.method ?? 'GET').toUpperCase();
      const isWrite = /^(POST|PUT|DELETE|PATCH)$/.test(method);
      return { capability: isWrite ? 'write' : 'read', domain: 'network' };
    },
    async execute(params) {
      // 2026-05-11: url is required. schema required: ['url'] is not always enforced server-side
      // (some LLMs omit fields); old code cast it to undefined, causing fetch to throw
      // "Cannot read properties of undefined (reading 'url')" — a very misleading error for the LLM.
      // Fail fast here with a clear error.
      const url = params.url;
      if (typeof url !== 'string' || url.length === 0) {
        return {
          success: false,
          output: '',
          error: `http tool: 'url' is required and must be a non-empty string (got ${typeof url === 'undefined' ? 'undefined' : JSON.stringify(url)}). Pass full URL like "https://api.example.com/path".`,
        };
      }

      // 2026-05-17: URL HTML-leak validation.
      // Real-world bug: when the LLM copies a URL from rendered text / markdown links it sometimes
      // includes HTML closing tag characters, e.g. `https://my">https://mycox.ai/...` — fetch fails
      // to parse it, the LLM doesn't understand the error and retries repeatedly → triggers
      // in-turn-reflection tool lock. Fail fast here with a clear message.
      //
      // Only check for obvious HTML tag characters (", <, >, HTML entities). The "double protocol"
      // pattern is not checked — OAuth redirect URLs like `?to=https://...` are legitimate and
      // would be falsely flagged. HTML characters are sufficient to block the real-world bug path.
      const htmlLeak = /["<>]|&(?:quot|lt|gt|amp);/;
      if (htmlLeak.test(url)) {
        const preview = url.length > 100 ? `${url.slice(0, 100)}...` : url;
        return {
          success: false,
          output: '',
          error:
            `http tool: URL contains HTML tag characters (got: "${preview}").\n` +
            `Common cause: copying \`<a href="...">...\` from markdown / rendered HTML and bringing the closing \`">\` along.\n` +
            `Fix: take the URL directly from a JSON response field (e.g. response.posts[i].url or response.id), not from rendered text.\n` +
            `If you are just building an endpoint from an id, assemble \`https://host/api/posts/\${id}\` yourself; don't copy the whole markdown link.`,
        };
      }
      const method = (params.method as string) || 'GET';
      // 2026-05-17 Phase 13.5: method character-set validation.
      // Real-world bug: LLM provider template fragments (DSML / qwen tool-call templates) sometimes
      // leak into the method field, e.g. `POST</｜DSML｜parameter name="headers"...>` as a whole block.
      // fetch receiving an invalid method throws the very cryptic
      // `Cannot convert argument to a ByteString because the character at index N has a value of 65372`
      // — the LLM can't understand this and retries or switches tools. Fail fast with a clear message.
      const VALID_METHODS = new Set([
        'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
      ]);
      const methodUpper = method.toUpperCase();
      if (!VALID_METHODS.has(methodUpper)) {
        const preview = method.length > 60 ? `${method.slice(0, 60)}...` : method;
        return {
          success: false,
          output: '',
          error:
            `http tool: method must be one of ${[...VALID_METHODS].join('/')} (got: "${preview}").\n` +
            `Common cause: the LLM tool-call output contained DSML / Qwen tool-call template fragments (e.g. ` +
            `a whole "POST</｜DSML｜parameter...>" stuffed into the method field).\n` +
            `Fix: the method field takes only the verb word; headers / body go in their own parameters — don't splice in template text.`,
        };
      }
      const headers = { ...((params.headers as Record<string, string>) || {}) };
      // 2026-05-11: body object compatibility — LLMs often pass object literals; old code cast them to
      // string, causing fetch to call toString() and send "[object Object]"; the target service then
      // reports "JSON Parse error: Unexpected identifier 'object'". Here, if we receive an object,
      // auto-stringify it and add Content-Type: application/json when the caller hasn't set it.
      let body: string | undefined;
      const rawBody = params.body;
      if (rawBody === undefined || rawBody === null) {
        body = undefined;
      } else if (typeof rawBody === 'string') {
        body = rawBody;
      } else {
        body = JSON.stringify(rawBody);
        const hasContentType = Object.keys(headers).some(
          (k) => k.toLowerCase() === 'content-type',
        );
        if (!hasContentType) {
          headers['Content-Type'] = 'application/json';
        }
      }

      try {
        const response = await injectingFetch(url, { method, headers, body });
        let text = await response.text();

        if (redactResponse) {
          text = redactOutput(text);
        }

        if (!response.ok) {
          // 2026-05-10: on failure, concatenate URL + method + response body prefix into the error,
          // so the LLM sees complete diagnostic info instead of an isolated "HTTP 401".
          // The url is still in placeholder form (input.url has not been replaced with plaintext;
          // redact only touches the response), so no secret is leaked.
          const bodyPreview = text.slice(0, 300);
          const richError =
            `HTTP ${response.status} ${method} ${url}` +
            (bodyPreview ? `\nResponse body: ${bodyPreview}` : '');
          // Also log to console for operator debugging (real-world: mycox heartbeat debug couldn't see the URL)
          console.warn(`[http] FAIL ${response.status} ${method} ${url}`);
          if (bodyPreview) {
            console.warn(`[http] body preview: ${bodyPreview.slice(0, 200)}`);
          }
          return {
            success: false,
            output: text,
            error: richError,
          };
        }

        return {
          success: true,
          output: text,
          error: undefined,
        };
      } catch (error) {
        const richError = `${method} ${url} threw: ${String(error)}`;
        console.warn(`[http] EXCEPTION ${method} ${url}: ${String(error).slice(0, 200)}`);
        return {
          success: false,
          output: '',
          error: richError,
        };
      }
    },
  };
}
