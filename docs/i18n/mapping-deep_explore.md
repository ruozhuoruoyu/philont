# Mapping: `server/src/deep_explore.ts` (APPLIED — vetted slice)

This module's **LLM-facing strings + user-facing tool outputs** are now English; all 33 deep_explore
tests are green (test assertions updated in lockstep — that green is the consistency proof). Dense
internal `//`/JSDoc comments are intentionally left for the reviewed bulk-comment phase (zero behavior,
lowest risk). Use this as the template for translating the other modules.

## What changed (ZH → EN), by surface

### Tool descriptions (the API the main agent sees)
- `reason_decompose` / `reason_record` descriptions + all `parameters` field descriptions → English.
- Node-kind enum descriptions → English (`subgoal/lemma/construction/counterexample/conjecture`).
- `deep_explore` composite tool `description` (start/continue/explore/status) + `goal/seed/assumptions` schema descriptions → English.

### Sub-LLM prompts (drive the reasoning sub-agent)
- `renderTreePrompt` — full reasoning-discipline prompt (root proposition / known assumptions / frontier / proved / dead ends / actions / how-to-reason) → English. Section headers: `## 根命题`→`## Root proposition`, `## 当前 frontier`→`## Current frontier`, `## 已证`→`## Proved`, `## 死胡同`→`## Dead ends`, etc.
- `buildExplorePrompt` — experimental-math discipline → English. `## 探索主题`→`## Exploration topic`, `## 挂载点`→`## Attach point` (still exposes `root node [id]`).
- `buildSkepticSystemPrompt` — adversarial reviewer prompt → English. **Verdict line switched to `VERDICT: REFUTED` / `VERDICT: HOLDS`.** Note: `parseSkepticVerdict` stays **bilingual** (accepts both `判定: 证伪`/`维持` and `VERDICT: REFUTED`/`HOLDS`) so old transcripts and either output style parse.
- `buildScorerPrompt` — value-estimator prompt → English; technique taxonomy glossed in English.

### User-facing tool outputs / errors (relayed by the main agent, then localized per channel)
- `renderProgressText` (round summary), explore-round summary, `status` output → English.
- All `reason_decompose`/`reason_record` ok/error strings → English (e.g. "Node X does not exist… Current open nodes: […]; retry with a real id").
- Budget/abort/cap tails, `formatOpenIds` empty case `(no open nodes)`, config `console.warn`s → English.

### Identifier rename
- `KIND_CN` → `KIND_LABEL` (values now English: subgoal/lemma/…); both call sites updated.

## Behavior notes
- Translating the sub-LLM prompts to English is **safe and arguably better** — the reasoning sub-agent does math, which models handle as well or better in English, and its output returns to the main turn as a tool_result that the main agent relays to the user in the user's language (Chinese for WeChat, via `response_language.ts`).
- `parseSkepticVerdict` kept bilingual on purpose — do **not** drop the Chinese branch.

## Tests updated (assertions that matched now-translated strings)
`formatOpenIds` empty case; decompose/record not-found errors (`open nodes`); proved-refuted output (`did not pass adversarial verification`) + backtracking note (`refuted`); proved-confirmed (`passed adversarial verification`); skeptic prompt (`unsure`/`no argument was given`); scorer prompt (`JSON array`); explore prompt (`experimental-mathematics engine`, `root node [id]`) + the fake-LLM root-id regex; explore output (`1 new data-backed conjecture`). Parser tests still feed Chinese verdicts — unchanged (bilingual parser).
