---
name: git-workflow
description: Standard git workflow — a multi-step routine for branch / commit message / push / pr, avoiding omission of critical steps (e.g. verifying with status, writing a proper commit message).
when_to_use: User says "commit this / push / create a PR / switch branch"; code changes are complete and need to enter the git workflow; need to write a proper message + check status before committing; creating a PR requires a standardized procedure
version: 1.0.0
---

# Git Workflow

## When to Use

- User says "help me commit / push / open a PR"
- Work is done and it's time to commit
- Actions involve git push / git commit / git rebase / pr

## Pre-flight checklist

Before starting any git operation, run these three commands in parallel — do not assume current state:

1. `git status` (see untracked / unstaged changes)
2. `git diff` (see actual changes)
3. `git log -5 --oneline` (see recent commit style, keep message style consistent)

## Commit Convention

- **Subject**: < 70 characters, type prefix (feat/fix/refactor/docs/chore/test) + scope + one-sentence rationale
- **Body**: multiple paragraphs explaining "why", not "what was done" — the diff already shows what was done
- **Do not** use `git add -A` or `git add .` — that will pull in .env / large binaries / IDE config. **Add files by name**: `git add path1 path2`
- **Do not** use `--no-verify` to skip hooks, unless the user explicitly requests it

## Push / PR Procedure

```
git status                         # confirm the list of files to commit
git add <specific paths>           # not -A
git commit -m "$(cat <<'EOF'
<subject>

<body>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git status                         # confirm the commit is clean
# Ask the user before pushing (push is a hard-to-reverse action):
git push origin <branch>
gh pr create --title "<title>" --body "<body>"
```

## Anti-patterns

- ❌ Running `add -A` without checking git status first → easy to pollute history
- ❌ Commit subject "update / fix / wip" and other uninformative words
- ❌ Pushing / force-pushing / amending an already-published commit without asking the user
- ❌ Commit body restating the diff contents ("modified file X to do Y") — write **why** instead

## Fixing Hook Failures

A pre-commit hook failure = the commit did NOT succeed. **Do not** use `--amend` (that would modify the previous commit). Fix the problem → re-stage → create a **new** commit.
