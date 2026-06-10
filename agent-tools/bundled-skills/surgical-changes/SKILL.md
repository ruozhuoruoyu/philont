---
name: surgical-changes
description: When modifying code, only touch what needs to be touched — a bug fix doesn't mean opportunistic cleanup, adding a feature doesn't mean refactoring the surrounding code, don't touch code the user didn't ask for just because it "looks better"; for every diff ask "is this line required by the task".
when_to_use: Before receiving a "fix a bug" / "add a feature" / "change X" type task; when an agent is about to modify a large amount of code but the task only requires a small change; when the diff contains extra cleanup that "looks like it should be done while we're here"; when the user has strong opinions about code style cleanliness
version: 1.0.0
---

# Surgical Changes

## When to Use

Immediately invoke this skill when you see any of these signals:

- **Bug fix** — user says "fix X" / "X is erroring" / "X isn't working"
- **Small feature** — "add Y" / "support Z" (with a specified scope)
- **Behavior tweak** — "change X to Y" / "make X do this when Z"
- You see **code changes in the diff that the task didn't ask for**

## Core Rules

### 1. Only touch what needs to be touched

The task defines the change surface → do not expand it.

**❌ Bad example**:
> User: "Fix the crash in chunkText when length is 0"
> Agent diff:
>   - chunkText.ts: add `if (text.length === 0) return [];` ← required by task
>   - chunkText.ts: refactor entire function from if-else to switch ← user didn't ask for this
>   - tests/chunkText.test.ts: add 30 new tests ← user didn't ask for this
>   - utils/string.ts: "opportunistically optimized" another function too ← completely unrelated

**✅ Good example**:
> Diff contains only one line in chunkText.ts + one directly corresponding regression test, **just those two changes**.
> Everything else that "could be changed while we're here" — **list it in the reply** and let the user decide whether to open a separate task.

### 2. Bug fix ≠ cleanup

When fixing a bug, do **not**:
- Rename related variables (even if the old names are bad)
- Refactor adjacent functions (even if there's a better way to write them)
- Add logging / change formatting / adjust indentation
- Delete code that "looks unused" (the user may depend on it elsewhere)

If there is **genuinely** related cleanup that needs to be done, tell the user at the end of your reply: "I noticed X also has a similar issue — want me to open a separate fix for that?", **do not fold it into the current commit**.

### 3. Don't delete other people's code, only delete your own "garbage"

Allowed:
- ✅ Delete code you wrote **in this task** that you decided not to keep midway through
- ✅ Delete imports you added **in this task** that became unused after refactoring

Prohibited:
- ❌ Delete other people's code that "looks unused" — you don't know about reflection / dynamic import / runtime string references
- ❌ "Opportunistically clean up" surrounding dead-code-look-alikes

**Decision rule**: Was this code added for **this task specifically**? Yes → you can delete your own; No → don't touch it.

### 4. Match style, don't "improve" it

Use the existing file's:
- Naming conventions (camelCase / snake_case / abbreviation preferences)
- Error handling patterns (throw vs Result vs callbacks)
- Logging format
- Comment density

Even if you think the new style is "better", in **this file** follow what already exists.

If the project's style is inconsistent across the board and you want to fix it → open a separate task, don't sneak it in.

### 5. Don't write "might be useful later" code

If the task calls for X cases, write X cases.

- Unnecessary "future-proofing" parameters ❌
- Unnecessary "might be extended later" interfaces ❌
- Unnecessary "generalized" abstractions ❌

Per Karpathy's exact words: **"Minimal code, don't write predictive features"**. Three similar lines of code beats "premature abstraction".

## Self-check Checklist (review before committing)

```
[ ] Every line in my diff can be directly traced back to the task description?
[ ] Nothing was "opportunistically" changed that the user didn't ask for?
[ ] No other people's code was deleted, even if it "looks unused"?
[ ] Style is consistent with the existing file?
[ ] No "might be useful later" parameters / interfaces / abstractions were written?
```

Any No → split the diff, revert the parts that shouldn't be included, and tell the user in your reply "I noticed X — want to open a separate task for that".

## Relationship to Existing philont Mechanisms

The philont CLAUDE.md "Doing tasks" section already emphasizes this ("A bug fix doesn't need surrounding cleanup"). This skill extracts that section and adds executable steps so the agent can `searchSkills('surgical')` and recall it on demand.

## Anti-pattern Quick Reference

| What you want to do | Should you? |
|---|---|
| Fix bug, opportunistically update an error message string | ❌ (unless the user mentioned it) |
| Add feature, opportunistically add type annotations to other functions in the same file | ❌ (separate task) |
| Fix typo, opportunistically run prettier on the entire file | ❌ |
| Delete an import you just added, because it's no longer needed after refactoring | ✅ |
| Rename a variable that was added in this task | ✅ |
| Rename an existing variable that has been in use for 3 years | ❌ |

## One-line Summary

**Every line in the diff must have a source in the task; anything that doesn't, revert it.**
