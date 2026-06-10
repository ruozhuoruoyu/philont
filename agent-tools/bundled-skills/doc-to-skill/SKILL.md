---
name: doc-to-skill
description: General-purpose meta-skill — given the URL of a process document (SOP / runbook / API guide / any markdown operations guide), distills the document into a reusable philont skill persisted to the SkillStore so that future similar requests are handled automatically. Upgrades from "read the doc and follow along" to "read it once and know how to do it myself".
when_to_use: User provides a process document URL and wants the agent to learn to follow it ("learn this SOP / save this runbook / follow https://.../guide.md from now on"); user provides a markdown process document but has **not** mentioned heartbeat/credentials/interval (otherwise use service-onboarding); agent discovers a highly detailed step-by-step operations guide worth solidifying during its own research
version: 1.0.0
---

# Doc → Skill General Distiller

One of philont's core principles is **"read it once and know how to do it myself"**. This skill transforms "agent reads a process document"
into "agent learns a class of tasks" — any SOP / runbook / operations manual as input, philont skill as output.

## When to Use

- User says "read https://... and follow it from now on" / "learn this SOP" / "turn this runbook into your skill"
- User provides a markdown / HTML process document but has **not** mentioned heartbeat / credentials / interval (otherwise use `service-onboarding`)
- Agent discovers a highly detailed step-by-step operations guide during its own research that is worth solidifying into a reusable skill

## When NOT to Use (boundaries)

| Scenario | Use instead | Reason |
|---|---|---|
| API service + credentials + periodic heartbeat ("register X service, key=xx, every 30min") | **`service-onboarding`** | That is the specialized version with step 5 that mandates schedule_reminder |
| User distilling experience through conversation ("save the flow we just went through") | **`skill-creator`** (interactive) | User actively driving skill creation requires Q/A interaction |
| Looking for a ready-made skill on a public registry ("is there an X skill on ClawHub") | **`clawhub`** / **`github-skills`** | Not distilling a new skill — installing an existing one |
| User asks "what does this doc say" (one-off query) | Answer directly with `webFetch`, **do not** create a skill | One-off need does not warrant persistence |
| Document is pure reference material (API reference / glossary / spec) with no operations flow | **`store_note`** as fallback | Without an "action sequence" the resulting skill is a hollow shell |

## Core Philosophy

skill-creator teaches **humans to write** (interactive); service-onboarding is too specialized (mandates heartbeat); clawhub pulls ready-made skills.
This skill covers the **most fundamental** case — "I read an instruction manual and now I know how" — pure document input, general-purpose process output,
no credentials, no heartbeat, no external service assumptions.

Difference from reflection self-learning:
- The reflection path is **experience-driven** (agent summarizes after running a task once)
- This skill is **document-driven** (agent distills after reading a document, without needing to run it first)
- Both paths lead to `installSkill`, and the normal maturity state machine applies

## Steps (strict 6-step sequence)

### 1. Fetch + verify document readability

```
http({ method: "GET", url: "<doc-url>" })
```

**Use `http` not `webFetch`** (same lesson as service-onboarding: the aux LLM distillation in webFetch may misidentify
instruction documents containing "agent should X" as prompt injection and refuse to process them).

Validation:
- HTTP status 200 → continue
- 4xx/5xx / timeout → abort; tell the user the URL is inaccessible; **do not** create a skill
- body length < 500 characters → **refuse to create a skill** (see Anti-patterns); fallback to `store_note` to preserve a document summary
- body is rendered HTML that is too large or garbled → fall back to `webFetch({ extractor: 'raw' })` once

### 2. Parse document structure

LLM reads the raw markdown / HTML directly and **independently** judges:

- How many heading levels exist
- Whether there is a numbered / bulleted **sequence of operational steps** (the key criterion)
- Whether there is a "failure handling / troubleshooting / notes" section
- Whether there is an "anti-pattern / do not do / bad examples" section
- Whether there is a "when to use" section (explicit trigger scenarios)

**Criterion**: must identify at least **3 clear "action steps"** (starting with a verb: "run / call / check / submit...").
Otherwise → this is reference material, not a process; jump to the failure branch (see failure handling table).

### 3. Extract skill metadata + name conflict pre-check

LLM outputs structured candidates (internal reasoning, not printed to user):

```json
{
  "name": "<kebab-case, based on document topic, e.g. 'deploy-runbook' / 'incident-response' / 'data-etl-pipeline'>",
  "description": "<one sentence: what it does + when to use it, used by LLM for routing decisions>",
  "when_to_use": "<narrative text: the scenario in which a user should use this skill, complementing description>",
  "trigger_keywords": ["keyword1", "keyword2", ...],
  "steps": [{ "title", "action", "code_or_command?" }],
  "failure_table": [{ "symptom", "remedy" }],
  "anti_patterns": ["..."],
  "source_url": "<original document URL>",
  "source_hash": "<sha256(url).slice(0,12)>"
}
```

**Name conflict pre-check** (critical step):

```
search_skills({ query: "<candidate name>" })
```

If a skill with the same name already exists → jump to the "name conflict" branch in the failure handling table; **do not force-overwrite**.

### 4. Synthesize SKILL.md text

Assemble using the philont standard frontmatter + section template:

```markdown
---
name: <extracted name>
description: <extracted description>
when_to_use: <extracted when_to_use>
version: 1.0.0
source: self:doc-to-skill:<source_hash>
maturity: draft
---

# <Title from document main heading>

## When to Use
- <bullet 1>
- <bullet 2>

## Process

### Step 1: <title>
<action description>
\`\`\`
<code if any>
\`\`\`
...

## Failure Handling
| Symptom | Response |
|---|---|
...

## Anti-patterns
- ❌ ...

## Source
This skill was automatically distilled by doc-to-skill from <source_url>. The original document is the authoritative source; this skill is the agent's internalized version and may simplify or omit details. If behavior deviates, refer back to the original document.
```

### 5. installSkill for persistence

```
installSkill({
  name: "<name>",
  source: "self:doc-to-skill:<source_hash>",
  content: "<full SKILL.md text synthesized above>"
})
```

`installSkill` synchronously refreshes the SkillStore (see philont P0 fix). `maturity` defaults to `draft`
(recognized by the state machine automatically) — not stable. **A skill that has never been run should not be implicitly trusted**.

### 6. Verify + announce

```
search_skills({ query: "<one of the trigger keywords just extracted>" })
```

If the result includes the new skill → index is working. Reply to the user:

```
✅ Learned: <skill-name> (maturity=draft)
- Source: <doc-url>
- N steps, K anti-patterns
- Next time you say "<example trigger phrase>" it will be used automatically

To modify / re-learn / uninstall, let me know.
```

## Failure Handling Table

| Symptom | Response |
|---|---|
| `http` GET 4xx / 5xx | abort; tell the user the URL is unreachable; **do not** create a skill |
| body < 500 characters | insufficient information to build a skill safely; fallback `store_note({title:'doc:<url>', body:<original text>})`; tell the user "document is too thin — saved as a note rather than creating a skill" |
| Cannot parse 3+ action steps (pure reference material) | **do not** create a skill; `store_note` to preserve summary; tell the user "this document is reference material with no process flow — saved as a note" |
| Skill with same name already exists | **do not force-overwrite**. Give the user 3 options: (a) use a different name (default: append `-v2`) (b) `uninstallSkill` the old one and install the new one (c) merge (feed the new document to the skill-creator flow as an update). Wait for user choice |
| `installSkill` write fails | retry once; abort on second failure; tell the user there is a disk / permission issue |
| Generated SKILL.md fails self-check (missing description / empty when_to_use) | go back to step 3 and re-extract; abort and fallback to store_note after two failures |

## Anti-patterns

- ❌ **Building a skill from a document < 500 characters** — insufficient information; the resulting skill is a hollow shell that pollutes the SkillStore index and slows down the reflection promotion mechanism with noise
- ❌ **Building a skill from a pure API reference / glossary / data table** — no "action sequence"; the description will be vague, triggers will be poor, and LLM will never match it
- ❌ **Force-overwriting a skill with the same name** — will destroy local experience built by the user / reflection. Must ask the user to decide the resolution path
- ❌ **Setting maturity directly to stable** — a skill that has never been run gets implicitly trusted; when it actually fails, the reflection state machine needs several demotions to correct it, causing significant damage. **Must default to draft**
- ❌ **Using webFetch to fetch the document** — the aux LLM distillation may refuse to read "agent operation instruction" documents (see the service-onboarding production lesson). **Use http GET to fetch raw markdown**
- ❌ **doc-to-skill calling doc-to-skill recursively** — when a document links to another document, **do not** automatically dive in. Learn one document at a time; let the user explicitly initiate any follow-on documents
- ❌ Giving the skill a very generic name (`deploy` / `api` / `helper`) — consistent with skill-creator writing discipline; a bad trigger is the same as not creating the skill

## Coordination with Other Meta-Skills

| skill | Relationship |
|---|---|
| `service-onboarding` | Specialized superset: also reads a document, but **additionally** requires credentials + heartbeat + auth verify. doc-to-skill is its "service-free" superset |
| `skill-creator` | Complementary: skill-creator teaches **humans to write the format** (interactive); doc-to-skill is the agent self-driven version, internally reusing the skill-creator SKILL.md template |
| `clawhub` / `github-skills` | Complementary: they pull ready-made skills from public repositories; doc-to-skill **derives** new skills from private / internal / arbitrary URL documents |
| reflection closing emit `new_skill` | Complementary: reflection is experience-driven (distills after successful run); doc-to-skill is document-driven (distills after reading). Both paths lead to `installSkill` |

## Quality Control (coordinated with skill_maturity.ts state machine)

- **Defaults to `maturity='draft'`**, compatible with schema v11 state machine: reflection tracks use_count,
  1 success → confirmed, 5 → stable, 3 consecutive failures → deprecated
- **source marked `self:doc-to-skill:<hash>`**, distinguishable from reflection self-generated `self:reflect-<id>` /
  clawhub's `clawhub:<slug>@<ver>`, audit-traceable
- Draft skills learned by doc-to-skill **do not** go through the layer-1 automatic routing rule path (routing_bundled.ts
  internally skips source 'self:*' in source detection). After reflection validates success ≥ 1 time and promotes to confirmed,
  reflection writes a routing rule itself
- ≥ 3 failures → automatically deprecated (same existing skill state machine)

## Bootstrap Examples

| URL | Expected path |
|---|---|
| `https://kubernetes.io/docs/tasks/debug/debug-cluster/` (numbered steps + troubleshooting) | Positive example: 6-step full run, installs `k8s-cluster-debug` draft skill |
| `https://github.com/<org>/<repo>/blob/main/RUNBOOK.md` | Positive example: typical ops runbook |
| `https://docs.python.org/3/library/json.html` (pure API reference) | Negative example at step 2: no action sequence → store_note fallback |
| Any README < 500 characters | Negative example at step 1: body too short → store_note |
| User provides the same document twice | Failure table: name conflict branch, ask user for options |
| User provides a service guide.md + key + 30min (misrouted) | Should be matched first by `service-onboarding` routing rule (keywords "credentials / heartbeat"); doc-to-skill does not match |
