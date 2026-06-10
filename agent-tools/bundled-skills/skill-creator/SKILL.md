---
name: skill-creator
description: The meta-skill for writing new skills — distill successful multi-step experiences into a SKILL.md for future reuse, rather than reinventing the wheel every time.
when_to_use: User says "write down this workflow / learn this / turn it into a skill"; agent just completed a non-trivial multi-step task successfully and it's worth distilling; user interactively walks through each step with the agent to generalize it into a SKILL.md. **Human-driven version**: use this skill interactively when the user actively wants to write a skill; automatic generalization of general process documentation goes through doc-to-skill.
version: 1.0.0
---

# Skill Creator

## When to Use

- User says "turn this into a skill / record this workflow / next time something like this..."
- You just hit N pitfalls before finally succeeding (the lessons should be solidified, go straight to the right path next time)
- You see a **reusable multi-step workflow** (single-step operations don't warrant a skill — just call the tool directly)
- User repeatedly makes the same request (frequency signal)

## What is worth making a skill

| Worth it | Not worth it |
|---|---|
| Multi-step routine (N ≥ 3 steps) | Single tool call ("run ls") |
| Decision tree (different paths for different situations) | One-off script |
| Domain knowledge (terminology / conventions / norms) | General programming knowledge (LLM already has it) |
| Tool combination patterns | Things an LLM can already execute reliably |

## SKILL.md Template

```markdown
---
name: <kebab-case-name>
description: One sentence — what it does + when to use it; the LLM reads description to decide whether to invoke it
version: 1.0.0
---

# <Title>

## When to Use
- <trigger condition 1>
- <trigger condition 2>
(list items are automatically extracted as trigger keywords fed to the FTS5 index)

## <Section 1: e.g. Workflow / Steps / Decision Tree>

Specific steps, **with executable code blocks** (LLM can copy and use directly):
```
<command>
```

## Anti-patterns

- ❌ <anti-example 1>
- ❌ <anti-example 2>

## <Optional: Edge Cases / Exceptions>
```

## Writing Discipline

### Description field (most important)

**The LLM decides whether to surface this skill based on description** — write it broadly or generically and it will be buried.

**❌**: `"git utility"`
**✅**: `"Standard git workflow — multi-step routine for branch / commit message / push / pr, avoids missing critical steps"`

Include **what it does + when to use it + what pitfalls it solves**.

### When to Use section (source of trigger keywords)

The loader extracts list items from this section as FTS5 index keywords. So:
- Use **language the user would actually say** as trigger conditions, not technical jargon
  - ❌ "when version control operations are needed"
  - ✅ "user says 'help me commit / push / open a PR'"
- Cover both languages (so users switching languages don't miss it)

### Action template (main body)

- Give **specific commands** + **examples** > abstract descriptions
- Use ```` ``` ```` code blocks throughout so the LLM can reuse directly
- **Include an explicit anti-patterns section** — tell readers what not to do (prevents LLM from going off track)

### Length

- Too short (< 30 lines) = not enough accumulated experience, may not be worth it
- Too long (> 150 lines) = information overload, LLM can't make use of it
- Sweet spot: 50–100 lines

## Storage Location

- Project-wide → `<workdir>/.philont/skills/<name>/SKILL.md` (workspace priority)
- Personal global → `~/.philont/skills/<name>/SKILL.md` (global)
- Bundled (shipped in the philont main repo) → `agent-tools/bundled-skills/<name>/SKILL.md`

After writing, the watcher will automatically reimport — no restart needed.

## Anti-patterns

- ❌ Writing a single tool call as a skill → SKILL.md has only one line, no visible value
- ❌ Using generic words like "util" / "helper" / "various" in description
- ❌ Writing When to Use from the LLM's perspective ("when agent needs X") rather than the user's perspective ("when user asks X")
- ❌ Not writing an anti-patterns section → readers don't know the boundaries, easy to over-apply

## Bootstrap Example

If you discover a workflow worth solidifying in this turn, **write it now** (using the template above) — don't wait until next time.
