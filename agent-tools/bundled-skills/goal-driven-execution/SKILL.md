---
name: goal-driven-execution
description: When given an ambiguous task, first translate it into "what does done look like + how to verify" before starting; after finishing within the same turn, verify with tools rather than declaring completion by gut feeling.
when_to_use: Task is vague or goal is unclear (user only gave a high-level direction); multi-step task needs goal decomposition + acceptance criteria before execution; scenarios where the agent tends to "finish part of it and declare done"; user says something like "clean up X / help me deal with Y" — underspecified requests
version: 1.0.0
---

# Goal-Driven Execution

## When to Use

Any of the following scenarios:

- The task the user gave is **vague** ("sort out X" / "optimize this" / "improve Y")
- The task has **multiple plausible end states** ("add some tests" → 1 or 50? What edge-case boundary?)
- The task **looks simple but has side effects** ("make this code async" → who calls it? Do all callers need updating?)
- About to **declare completion** ("done" / "OK" / "finished") — must verify first

## Core Three Steps

### 1. Convert task → success criteria

After receiving a task, first answer 3 questions in your head or in text:

```
- What does this look like when it's *done*? (specific enough to grep / curl / test)
- What is must-have vs. nice-to-have?
- What are the failure modes? In what situations should I stop and ask the user?
```

**❌ Anti-example**:
> User: "add some tests"
> agent: starts writing tests directly → writes 50 edge cases → user: "I just wanted one happy path"

**✅ Good example**:
> User: "add some tests"
> agent: "I'll add a happy-path unit test first; I'll leave edge cases as TODO comments for you to decide whether to fill in — sound good?"

> User: "if you're unsure just do the happy path" ← start only after user authorizes

### 2. While working, keep "success criteria" front of mind

For every line of code written, ask: **does this line bring me closer to the success criteria, or does it just look like progress?**

If the answer is the latter → stop, don't add it. This is the concrete execution step for the "Don't add features beyond what the task requires" principle in philont CLAUDE.md.

### 3. Before declaring done, **verify with tools** (not by gut feel)

Must use tools to self-verify before declaring completion. **HonestyGate already has a runtime intercept in place** (completion claim vs. ✓/⚠ tool markers mismatch → forced retry), **but relying on the gate as a safety net is the last line of defense for failures — it should not be the everyday dependency**.

| Task type | Verification method |
|---|---|
| Write file | `readFile` to check what was actually written |
| Modify code | `grep`/`glob` to check references, `runShell` to run typecheck/test |
| Delete something | `glob` to confirm it's gone, `grep` to confirm no residual references |
| Network operation | `curl -I` or corresponding tool to check status code / actual response |
| Fix bug | Reproduce the bug once, check whether it still triggers |

**Not verified = not done**. Use a tool to check before saying "I've fixed it".

## Anti-patterns (detecting these triggers this skill)

- ❌ "I'll do X, then Y, then Z..." and just diving in — without asking "does the user want Z"
- ❌ Three consecutive `writeFile` calls followed by "done" — **VerifyBeforeClaim Gate** will trigger a retry (no `readFile`/`grep`/`glob` after completion)
- ❌ "should be fine" / "looks OK" / "theoretically no problem" — all synonyms for "not verified"
- ❌ Treating nice-to-have as must-have, doing a bunch of things the user didn't ask for — this is Karpathy's biggest complaint about LLMs

## Relationship to existing philont mechanisms

This skill is **upfront prevention** (prompt layer); philont's Drive / Gate is **post-hoc detection** (runtime intercept).

- Prompts that use this skill → in most cases the gate fallback is not needed
- Not used → HonestyGate / VerifyBeforeClaim / TaskCommitmentDrive triggers, forced retry

Ideal state: gate hit rate decreases over time, because the agent applied this skill's discipline upfront.

## One-line summary

**First answer "what does done look like", then start; after finishing, verify with tools, then declare done.**
