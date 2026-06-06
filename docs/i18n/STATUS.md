# Open-source i18n (中译英) — Status & Plan

Goal: move the codebase + system prompts to **English** for open-source release, while keeping
**Chinese user-facing replies for WeChat** (and any user whose locale is Chinese).

This file is the running status. The translation choices to review are in:
- `glossary.md` — canonical ZH→EN terminology (review this first; everything else follows it).
- `mapping-system-prompt.md` — the main system prompt, full ZH→proposed-EN (HIGH RISK, **not yet applied** — needs your sign-off).
- `mapping-deep_explore.md` — the deep_explore module strings, ZH→EN (applied; see slice below).

---

## Scope (measured 2026-06-05)

| Package | files w/ Chinese | Chinese lines |
|---|---|---|
| server | 51 | 4251 |
| agent-memory | 74 | 4879 |
| agent-tools | 47 | 1263 |
| agent-policy | 24 | 523 |
| demo | 22 | 800 |
| web-ui | 7 | 398 |
| launcher | 8 | 166 |
| agent-mcp | 7 | 146 |
| **total (src)** | **~240** | **~14,400** |

Split: ~8,900 lines are **comments** (low risk — no behavior change), ~5,000 are **string literals**
(higher risk — includes LLM-facing prompts, tool descriptions, user-facing text).

## Risk tiers (drives the order of work)

1. **LLM-facing prompts / tool descriptions** — HIGHEST risk. Changing wording changes model behavior.
   Translate carefully, prefer English (models reason as well or better in English), keep semantics.
2. **Parsed contracts** — e.g. the `## 给用户` / `## 工作日志` section headers are parsed by
   `output_section_filter.ts`, referenced by `wechat/index.ts`, `max_iter_summary.ts`, and dozens of
   inline prompt instructions in `chat-handler.ts`. Flipping these requires lockstep changes.
3. **User-facing strings** (CLI/web-ui/error/fallback text) — need the response-language mechanism so
   English prompts don't force English replies on WeChat users.
4. **Comments** — bulk, low risk; do last, in batches, against the agreed glossary.

## The keystone decision: decouple *prompt language* from *response language*

Flipping prompts to English would otherwise make the agent reply in English to **everyone**, including
WeChat users who expect Chinese. Fix: keep prompts English, but inject a per-channel/per-user
**response-language directive**. WeChat → Chinese; explicit `user.locale` fact wins; otherwise mirror
the user. See `server/src/response_language.ts`.

The parsed section headers are made **bilingual** (accept both `## For User`/`## Work Log` and the legacy
`## 给用户`/`## 工作日志`) so the prompt header can flip to English without breaking the WeChat split.

---

## Done (applied + tested, this session)

- `server/src/response_language.ts` — response-language resolver + directive. **Tested** (`response_language.test.ts`).
- Wired the directive into `buildFreshMessages` (chat-handler) — additive, behavior-preserving (WeChat pinned Chinese, others mirror the user).
- `output_section_filter.ts` — section headings now **bilingual** (EN + legacy ZH). **Tested** (added EN cases).
- `deep_explore` module fully translated to English (comments + tool descriptions + LLM-facing prompts + outputs); all 33 tests updated and green. This is the **vetted slice / template** for the rest. See `mapping-deep_explore.md`.
- `glossary.md` — canonical terminology table (signed off: deep exploration / intrinsic drive / honesty gate / verifier).
- **Main system prompt** (`chat-handler.ts` ~3598) — APPLIED to English after review (option (a) "≤ ~200 characters", English examples). Section headers `## For User` / `## Work Log`; the ~13 inline header references + `max_iter_summary.ts` token flipped in lockstep. Tests green.
- **Subsystem rename** `深度推理 → 深度探索`: tool `deep_reason`→`deep_explore`, env `PHILONT_DEEP_REASON_*`→`PHILONT_DEEP_EXPLORE_*`, action `explore`→`discover`. DB tables `reasoning_*` kept (internal).

## Remaining (after glossary sign-off)

- Translate remaining LLM-facing prompts / tool descriptions package by package (agent-tools tool
  descriptions, planAndExecute, skeptic/aux prompts, channel phrases, the many inline `chat-handler` drive/honesty prompts).
- Translate user-facing strings (web-ui labels, launcher, CLI, `max_iter_summary` fallback text).
- Bulk comment translation (8.9k lines) — lowest risk; batchable (potentially via a workflow) once the glossary is fixed so terminology stays consistent.
- Each batch: tests must stay green; any test that asserts a Chinese output string gets updated in the same change.

## Conventions

- Prompts/comments/docs → English. Code identifiers were already English.
- Do **not** translate: third-party names, attributions, or any quoted user content.
- Keep `[[memory-link]]`-style and structural tokens intact.
- When a test asserts a now-translated string, update the assertion in the same commit (green tests = consistency proof).
