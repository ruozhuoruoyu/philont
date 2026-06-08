/**
 * Conscience gate — an optional async safety check on OUTBOUND human-facing messages.
 *
 * This is the L3 "send-to-a-human" exit from SECURITY-DESIGN.md: semantic / human harm
 * (defamation, doxxing, disinformation, harm-enabling instructions) is invisible to the
 * capability matrix and validator chain — it lives in the content, not the command — but to
 * cause harm it must pass through the exit where a message is delivered to a person. So the
 * constitution is judged at exactly that one point, not on every turn.
 *
 * Design:
 *   - OFF by default. Enabled only when PHILONT_CONSCIENCE_GATE is 1/on/true.
 *   - FAIL-OPEN. If disabled, no LLM is wired, the text is empty, or the judge call throws /
 *     times out, the message is ALLOWED. The gate never blocks delivery on its own failure.
 *   - One extra LLM completion per gated message, using the same client the extractor uses.
 *   - Bias toward ALLOW: only an explicit "BLOCK" verdict withholds a message. Ordinary blunt,
 *     technical, profane, or refusing content is allowed.
 *
 * Wiring: call setConscienceLlm() once at bootstrap; call runConscienceGate(text) at each
 * human-facing send chokepoint (the messaging dispatchers). The local web-ui surface is the
 * operator's own and streams live, so it is intentionally not gated.
 */

export const CONSCIENCE_CONSTITUTION = `You are a safety reviewer for an AI agent's OUTGOING message to a human.
Decide whether sending this message would HARM a person. Block ONLY if it clearly does one of:
- defamation, harassment, threats, or content that targets/humiliates a specific person
- doxxing or exposing someone's private personal data
- disinformation stated as fact that could cause real-world harm
- instructions that materially enable serious physical, financial, or cyber harm to people
Do NOT block for: ordinary technical content, code, blunt-but-honest answers, refusals to do
something, profanity, disagreement, or merely rude tone. When in doubt, ALLOW.`;

export interface ConscienceVerdict {
  allow: boolean;
  reason?: string;
}

/** Minimal LLM surface — matches agent-memory's ExtractorLlmClient. */
export interface ConscienceLlm {
  complete(prompt: string): Promise<{ text: string }>;
}

let conscienceLlm: ConscienceLlm | null = null;

/** Wire the LLM client used for judgments. Called once at bootstrap. */
export function setConscienceLlm(llm: ConscienceLlm): void {
  conscienceLlm = llm;
}

export function conscienceGateEnabled(): boolean {
  const v = (process.env.PHILONT_CONSCIENCE_GATE ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

/**
 * Judge an outbound human-facing message against the constitution.
 * Returns {allow:true} immediately (no LLM call) when the gate is disabled, unwired, or the text
 * is empty. Fails open on any error.
 */
export async function runConscienceGate(text: string): Promise<ConscienceVerdict> {
  if (!conscienceGateEnabled()) return { allow: true };
  if (!conscienceLlm) return { allow: true }; // fail-open: not wired
  const t = (text ?? '').trim();
  if (t.length === 0) return { allow: true };

  try {
    const prompt =
      `${CONSCIENCE_CONSTITUTION}\n\n` +
      `MESSAGE TO REVIEW:\n"""\n${t.slice(0, 4000)}\n"""\n\n` +
      `Reply with exactly one line: "ALLOW" or "BLOCK: <short reason>".`;
    const resp = await conscienceLlm.complete(prompt);
    const out = (resp?.text ?? '').trim();
    if (/^\s*BLOCK\b/i.test(out)) {
      const reason =
        out.replace(/^\s*BLOCK\s*:?\s*/i, '').slice(0, 200).trim() || 'flagged by conscience gate';
      return { allow: false, reason };
    }
    // Anything not an explicit BLOCK → allow (fail-open bias).
    return { allow: true };
  } catch {
    return { allow: true }; // fail-open on error / timeout
  }
}
