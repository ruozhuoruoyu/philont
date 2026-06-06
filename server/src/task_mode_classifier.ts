/**
 * Automatic task mode classifier (v17 Phase 7 hardened 1, 2026-05-12)
 *
 * Replaces "LLM self-assesses fast/slow by reading the prompt". Applies heuristics at the
 * handleChatSend entry point; does not depend on LLM cooperation.
 *
 * Field observation (2026-05-11 mycox): after reading the buildMemoryPrefix task mode section,
 * the LLM still skipped task_mode_classify('slow') and went directly to webFetch — the protocol
 * never entered. This module moves the judgment out of the LLM's attention allocation by using
 * userMessage features + historical failure signatures.
 *
 * Design principles:
 *   - Pure function (unit-testable; synchronously callable at the chat-handler entry point)
 *   - Zero LLM calls (purely heuristic)
 *   - Misclassify fast→slow = soft cost (turn is 2-3 tool calls longer; does not break functionality)
 *   - Misclassify slow→fast = impossible (only one-directional fast→slow; never auto-demoted)
 *   - Bilingual keyword coverage (Chinese + English)
 *
 * Decision (Phase 13 tightened, 2026-05-17):
 *   - **strong** = guide-hint || heavy-keyword || multi-step-connector
 *   - **weak**   = contains-url || msg-long-240+
 *   - Upgrade to slow = strong ≥ 1 && (strong+weak) ≥ 2
 *   - Or R6 "same-sig historical failure" triggers alone (strong signal)
 *
 *   Background: Phase 12 field testing found `Read https://x.com/foo` (single URL read task)
 *   was incorrectly upgraded to slow and forced through the plan protocol; it is actually
 *   an ad-hoc single-step task that should stay fast.
 *   `contains-url` alone no longer counts as strong; it only contributes votes when co-occurring
 *   with a strong signal.
 */

import type { PlanStore } from '@agent/memory';
import { createHash } from 'node:crypto';

export interface ClassifyInput {
  userMessage: string;
  /** First 60 chars of user message, sha1[:8], as a quick task signature (can be overridden by LLM later) */
  taskSignatureCandidate: string;
  /** PlanStore for same-sig historical failure lookup — optional (can omit in test scenarios) */
  plans?: PlanStore;
}

export interface ClassifyResult {
  /** Whether to upgrade to slow */
  isSlow: boolean;
  /** List of matched rule ids (human-readable; for audit) */
  reasons: string[];
  /**
   * Phase 13.5 (2026-05-17): project name inferred from the guide URL in the user message
   * (kebab-case). Only returned when reasons includes `heavy-keyword` (register / onboard /
   * onboard etc., strong project-onboarding intent) AND the first URL path segment is valid kebab-case.
   *
   * Used by caller (chat-handler auto-plan-on-slow) to pre-fill the placeholder plan's
   * persistedTo field — mechanism-layer fallback that starts plan.md even when the LLM
   * does not proactively pass persist:true.
   *
   * False-positive risk: first URL path segment is not a project name (e.g. docs.example.com/api/v1/foo).
   * Mitigated by requiring heavy-keyword. The LLM can still override via plan_revise with
   * persist:false, or a different project name.
   */
  projectHint?: string;
}

/** Phase 13.5: extract first URL path segment (used with heavy-keyword). */
export function extractProjectFromGuideUrl(rawMessage: string): string | null {
  const m = rawMessage.match(/https?:\/\/[^\s,;:'"<>()`，。;:、]+/);
  if (!m) return null;
  const urlStr = m[0].replace(/[.,;:!?]+$/, '');
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) {
    // No path — use the first hostname segment (`mycox.ai` → `mycox`), provided it is
    // kebab-case and not a generic service host (api / www / docs / cdn etc.).
    const host = url.hostname.split('.')[0]?.toLowerCase();
    if (!host) return null;
    if (/^(www|api|app|docs|cdn|static|img|images|assets|blog|news|forum|m|mobile)$/.test(host)) {
      return null;
    }
    if (/^[a-z][a-z0-9-]{1,30}$/.test(host)) return host;
    return null;
  }
  const first = parts[0].toLowerCase();
  // First path segment: skip API version paths (api/v1/...) and use a broader match
  if (/^(api|v\d+|docs?|wiki|help)$/.test(first)) {
    // Fall back to first hostname segment (e.g. docs.python.org/3/library → python)
    const host = url.hostname.split('.')[0]?.toLowerCase();
    if (host && /^[a-z][a-z0-9-]{1,30}$/.test(host) &&
        !/^(www|api|app|docs|cdn|static|m)$/.test(host)) {
      return host;
    }
    return null;
  }
  if (/^[a-z][a-z0-9-]{1,30}$/.test(first)) return first;
  return null;
}

/**
 * Compute a quick task signature for a user message (first 60 chars normalised + sha1[:8]).
 *
 * **Intentionally imprecise** — the LLM can pass a more accurate task_signature later via plan_draft.
 * This hash only serves the R6 historical lookup; coarse granularity is fine.
 */
export function quickSignatureHash(userMessage: string): string {
  const normalized = userMessage
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  if (!normalized) return '0'.repeat(8);
  return createHash('sha1').update(normalized).digest('hex').slice(0, 8);
}

/** R3 multi-step connectors — bilingual (Chinese + English) */
const MULTI_STEP_PATTERN =
  /(然后|再|接着|之后|完成后|依次|分别|步骤|逐步|first[, ].*second|finally)|\b(then|after|next|step\s*\d+)\b/i;

/** R4 high-complexity keywords — frequent in mycox-type tasks */
const HEAVY_KEYWORD_PATTERN =
  /(接入|对接|注册|onboarding|部署|deploy|集成|integrate|调研|实现|搭建|配置|迁移|重构|联调|心跳|鉴权|授权)|\b(register|onboard|deploy|integrate|investigate|implement|configure|migrate|refactor|webhook|heartbeat)\b/i;

/** R5 explicit guide hint */
const GUIDE_HINT_PATTERN =
  /(指引|guide|文档|spec|手册|按.*要求|按.*文档|参考.*md|按.*md)/i;

/** R2 URL */
const URL_PATTERN = /https?:\/\/\S+/i;

export function autoClassify(input: ClassifyInput): ClassifyResult {
  const reasons: string[] = [];
  const text = input.userMessage;

  // R1 length signal (contributing factor; does not trigger alone)
  if (text.length >= 240) reasons.push('msg-long-240+');

  // R2 contains URL → likely needs to follow a document
  if (URL_PATTERN.test(text)) reasons.push('contains-url');

  // R3 multi-step connectors
  if (MULTI_STEP_PATTERN.test(text)) reasons.push('multi-step-connector');

  // R4 high-complexity keywords
  if (HEAVY_KEYWORD_PATTERN.test(text)) reasons.push('heavy-keyword');

  // R5 explicit guide / spec hint
  if (GUIDE_HINT_PATTERN.test(text)) reasons.push('guide-hint');

  // R6 history: same task_signature has failed before (strong signal; triggers alone)
  let sameSigHistoryFailed = false;
  if (input.plans && input.taskSignatureCandidate) {
    try {
      const history = input.plans.listBySignature(
        input.taskSignatureCandidate,
        { limit: 5 },
      );
      if (history.some((p) => p.status === 'failed')) {
        sameSigHistoryFailed = true;
        reasons.push('same-sig-history-failed');
      }
    } catch {
      // PlanStore query failure does not affect classify (degrade to other rules)
    }
  }

  // Phase 13 tightened: require both strong + weak signal to upgrade to slow;
  // prevents single URL / single length from incorrectly upgrading
  const STRONG = new Set(['guide-hint', 'heavy-keyword', 'multi-step-connector']);
  const strongCount = reasons.filter((r) => STRONG.has(r)).length;
  const isSlow =
    sameSigHistoryFailed ||
    (strongCount >= 1 && reasons.length >= 2);

  // Phase 13.5: heavy-keyword match → infer project name for caller to pre-fill persistedTo
  // placeholder. "register / onboard / integrate" etc. strongly imply a long-lived agent role
  // task where plan.md should auto-start.
  let projectHint: string | undefined;
  if (isSlow && reasons.includes('heavy-keyword')) {
    const hint = extractProjectFromGuideUrl(text);
    if (hint) projectHint = hint;
  }

  return { isSlow, reasons, projectHint };
}
