/**
 * Compactor: context compressor
 *
 * When conversation history approaches the LLM context window limit, summarizes the middle
 * segment of messages while preserving the head (system prompt + first exchange) and
 * tail (most recent N turns).
 *
 * Key design:
 *   - No data loss: original messages stay in Layer 0; summary written to Layer 1 (memory_notes)
 *   - Generic interface: CompactorMessage is not bound to a specific SDK type
 *   - Injectable estimator: default heuristic (character count × 0.6); can be replaced with a real tokenizer
 *   - Safe fallback: on LLM failure, returns the original message array rather than crashing
 *
 * Note: this is a simplified version of the "Summarize" tier in the IronClaw three-tier compression strategy.
 *       Truncate (direct cutoff) and MoveToWorkspace (preserve all details to a workspace)
 *       can be added as Phase 2 extensions.
 */

import type { NotesStore } from './notes.js';
import type { ExtractorLlmClient } from './extractor.js';
import type {
  CompactorMessage,
  CompactorConfig,
  CompactionResult,
} from './types.js';
import type { MemoryAuditHook } from './audit.js';

// ── Default token estimator ────────────────────────────────────────────────────

/**
 * Heuristic token estimator: JSON-serialized character count × 0.6
 *
 * Chinese characters are approximately 1 token; English words approximately 1.3 tokens;
 * average estimated at 0.6 characters/token.
 * Production use should apply a real tokenizer (e.g. tiktoken); sufficient for demos / tests.
 */
function defaultEstimator(msg: CompactorMessage): number {
  const text =
    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return Math.ceil(text.length * 0.6);
}

// ── Prompt template ────────────────────────────────────────────────────────

const SUMMARIZE_INSTRUCTIONS = `You are a conversation compression assistant. Below is a segment of conversation history. Please **compress it into a concise summary**.

**Retain**:
- Key decisions and their reasons
- Names of people, projects, files, and paths mentioned
- Completed tasks and incomplete tasks
- Any important errors or issues
- Preferences or constraints expressed by the user

**Remove**:
- Pleasantries and small talk
- Repeated information
- Detailed command output (unless it contains errors)
- Old information superseded by later conversation

**Output format**: One or more paragraphs in third-person, past tense. Do not include markdown headings or lists.
**Strictly control length**: Summary length should not exceed 30% of the original.
**The last sentence must highlight "pending items / unanswered questions / threads to continue next time"** (if any); this summary will serve as context for the next session to pick up where we left off.

Below is the conversation to compress:
`;

function buildSummaryPrompt(messages: CompactorMessage[]): string {
  const dialogue = messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content);
      return `[${m.role}] ${text}`;
    })
    .join('\n');

  return SUMMARIZE_INSTRUCTIONS + '\n' + dialogue + '\n\nSummary:';
}

// ── Compactor class ───────────────────────────────────────────────────────

export interface CompactorOptions {
  /** Optional: audit hook for self-domain writes (records an Internal origin event each time a summary is written to NotesStore) */
  auditHook?: MemoryAuditHook;
}

export class Compactor {
  private readonly estimator: (msg: CompactorMessage) => number;
  private readonly auditHook: MemoryAuditHook | undefined;

  constructor(
    private readonly llm: ExtractorLlmClient,
    private readonly notes: NotesStore,
    private readonly config: CompactorConfig,
    options: CompactorOptions = {},
  ) {
    this.estimator = config.estimator ?? defaultEstimator;
    this.auditHook = options.auditHook;
  }

  /**
   * Estimates the total token count for an array of messages
   */
  estimateTokens(messages: CompactorMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimator(m), 0);
  }

  /**
   * Returns whether compaction is needed (soft threshold, used at the start of a turn during the "quiet period")
   */
  needsCompaction(messages: CompactorMessage[]): boolean {
    if (messages.length < this.config.protectFirstN + this.config.protectLastN + 2) {
      return false; // Too short; no room to compact
    }
    return this.estimateTokens(messages) > this.config.thresholdTokens;
  }

  /**
   * Returns whether hard-cap compaction is needed (used by in-turn tool loop as a safety net to prevent window overflow).
   * Default hardThresholdTokens = thresholdTokens × 1.4, leaving enough headroom for in-turn tool
   * chain messages (plan_id / tool_result) to be retained verbatim in the tail protectLastN entries,
   * avoiding mid-turn compaction breaking protocol-precise IDs.
   */
  needsHardCompaction(messages: CompactorMessage[]): boolean {
    if (messages.length < this.config.protectFirstN + this.config.protectLastN + 2) {
      return false;
    }
    const hard =
      this.config.hardThresholdTokens ?? Math.floor(this.config.thresholdTokens * 1.4);
    return this.estimateTokens(messages) > hard;
  }

  /**
   * Performs compaction (if needed)
   *
   * Steps:
   *   1. Check whether compaction is needed → return unchanged if not
   *   2. Split: [head] + [middle] + [tail]
   *   3. Call LLM to summarize the middle segment
   *   4. Write the summary to NotesStore (high importance)
   *   5. Construct new message array: head + summary message + tail
   *   6. Return CompactionResult
   *
   * @param messages Current message array
   * @param sessionId Optional session id; used to associate the note
   */
  async compact(
    messages: CompactorMessage[],
    sessionId?: string,
  ): Promise<CompactionResult> {
    const tokensBefore = this.estimateTokens(messages);

    if (!this.needsCompaction(messages)) {
      return {
        compactedMessages: messages,
        didCompact: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        summaryNoteId: null,
        llmCostTokens: 0,
      };
    }

    const { protectFirstN, protectLastN } = this.config;
    const head = messages.slice(0, protectFirstN);
    const tail = messages.slice(messages.length - protectLastN);
    const middle = messages.slice(protectFirstN, messages.length - protectLastN);

    if (middle.length === 0) {
      return {
        compactedMessages: messages,
        didCompact: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        summaryNoteId: null,
        llmCostTokens: 0,
      };
    }

    // Call LLM to summarize the middle segment
    let summaryText = '';
    let llmCostTokens = 0;
    try {
      const prompt = buildSummaryPrompt(middle);
      const result = await this.llm.complete(prompt);
      summaryText = result.text.trim();
      llmCostTokens = result.tokensUsed;
    } catch (e) {
      // LLM failed → safe fallback: return original messages, mark as not compacted
      return {
        compactedMessages: messages,
        didCompact: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        summaryNoteId: null,
        llmCostTokens: 0,
      };
    }

    // Hard-truncate LLM output — prevents LLM from emitting an excessively long "summary" when given
    // a massive conversation as input (observed in production: LLM partially restated the original text,
    // producing multi-MB notes that polluted the entire memory prefix across sessions).
    // A normal summary will not exceed MAX_SUMMARY_BYTES; if it does, the LLM has behaved abnormally.
    const MAX_SUMMARY_BYTES = 4_000;
    if (summaryText.length > MAX_SUMMARY_BYTES) {
      const originalLen = summaryText.length;
      summaryText =
        summaryText.slice(0, MAX_SUMMARY_BYTES) +
        `\n...[LLM summary abnormally long, original ${originalLen} chars, truncated to ${MAX_SUMMARY_BYTES}]`;
    }

    if (!summaryText) {
      return {
        compactedMessages: messages,
        didCompact: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        summaryNoteId: null,
        llmCostTokens,
      };
    }

    // Write summary to Layer 1: when sessionId is present, upsert with fixed id 'session-summary-<id>',
    // importance=1.0 (distinct from ordinary notes; used for cross-session context injection);
    // without sessionId, falls back to the old behavior of a random-id ordinary note (importance=0.8).
    // Multiple compactions within the same session retain only the latest summary.
    let note;
    if (sessionId) {
      note = this.notes.upsertNote(`session-summary-${sessionId}`, {
        content: summaryText,
        importance: 1.0,
        sessionId,
      });
    } else {
      note = this.notes.storeNote({
        content: summaryText,
        importance: 0.8,
        sessionId: null,
      });
    }
    this.auditHook?.append('self_domain_write', {
      source: 'compactor',
      origin: 'Internal',
      toolName: 'store_note',
      sessionId: sessionId ?? null,
      noteId: note.id,
    });

    // Construct the new message array
    const summaryMessage: CompactorMessage = {
      role: 'user',
      content:
        '[Context summary — the previous conversation has been compressed into the following key points]\n' + summaryText,
    };

    const compactedMessages = [...head, summaryMessage, ...tail];
    const tokensAfter = this.estimateTokens(compactedMessages);

    return {
      compactedMessages,
      didCompact: true,
      tokensBefore,
      tokensAfter,
      summaryNoteId: note.id,
      llmCostTokens,
    };
  }
}
