---
name: github-skills
description: Install skills directly from SKILL.md files in any GitHub repository, covering the long tail beyond ClawHub.
when_to_use: User provides a GitHub repo URL and asks to "install an X skill"; user says "check if there's a skill for X on GitHub"; no suitable skill found locally or on clawhub, need to search the GitHub long tail
version: 1.0.0
---

# GitHub as Skill Source

## When to Use

- `clawhub search` finds nothing suitable, but I believe GitHub has something
- User gave a GitHub URL to install ("install this repo's skill: https://github.com/foo/bar")
- Looking for "niche but excellent" domain skills (many personal projects only publish to GitHub, not ClawHub)

## Prerequisites

- `gh` CLI (GitHub CLI): `brew install gh` or `apt install gh`, then run `gh auth login` once
- The `search` in this skill uses `gh search code`, which requires an authenticated session. If `gh auth status` fails, tell the user to log in first.

## Core Workflow

### 1. Search GitHub for SKILL.md files

```
shell({ command: "gh search code 'philont skill SKILL.md path:**/SKILL.md' --limit 10 --json repository,path" })
```

Narrow by topic:

```
shell({ command: "gh search code '<topic> SKILL.md path:**/SKILL.md' --limit 10 --json repository,path" })
```

From the JSON output, pick `repository.nameWithOwner` + `path`, and assemble into a raw URL:
```
https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>
```

### 2. Fetch and validate

```
http({
  method: "GET",
  url: "https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>",
})
```

Once the text is retrieved, **validate**:
- Must start with `---\n` (YAML frontmatter)
- frontmatter must contain a `name:` field
- body must contain a `## When to Use` section (otherwise trigger keywords cannot be extracted)
- Entire file < 8KB (philont loader cap — files exceeding this will be rejected)

If any check fails, tell the user the reason and do not install.

### 3. Install

Read the `name` from frontmatter (if missing, fall back to owner-repo form or ask the user). Then:

```
installSkill({
  name: "<from-frontmatter-or-derived>",
  content: "<full SKILL.md text>",
  source: "github:<owner>/<repo>@<commit-sha>"
})
```

`<commit-sha>` can be obtained with another HTTP GET:
```
http({
  method: "GET",
  url: "https://api.github.com/repos/<owner>/<repo>/commits/HEAD",
  headers: { "Accept": "application/vnd.github.v3+json" }
})
```
Read `.sha` from the response body and take the first 7 characters. If you want to keep it simple, write `github:<owner>/<repo>@HEAD` directly, but the version will not be reproducible.

### 4. Uninstall

```
uninstallSkill({ name: "<name>" })
```

Same path as uninstalling a skill installed from ClawHub.

## Decision Tree: User gave me a GitHub URL — install directly?

- URL looks like `https://github.com/<owner>/<repo>/blob/.../SKILL.md` → convert to raw URL, follow the workflow directly
- URL is a repo root → try `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/SKILL.md`; if that fails, ask the user for the specific path
- URL is not GitHub → use `installSkill` content mode to install directly (any HTTP source works; see `Anti-patterns` notes)

## Anti-patterns

- ❌ Don't call `installSkill` without validating first. SKILL.md files on GitHub lack the pre-publish review that ClawHub has; they may have been written incorrectly during someone's testing. Validate at minimum three things: has frontmatter, has name, has When to Use.
- ❌ Don't forget the source tag. If the user later asks "where did this come from", I must be able to answer.
- ❌ Don't use `gh repo clone` to pull the entire repository. We only need one SKILL.md file; cloning wastes disk space and time. Use an `http` GET on the raw URL instead.
- ❌ Don't install a SKILL.md from a private repo without telling the user. Private repos are accessible via `gh api`, but raw URLs return 401 by default. If the user hasn't explicitly asked to install from a private repo, skip it.
- ❌ Don't put `owner/repo`-style strings containing slashes in the `name` field. philont's installSkill only allows `[a-z0-9_-]` and will reject it. When deriving the name, replace slashes with `-`.

## Failure Handling

| Symptom | Response |
|---|---|
| `gh: command not found` | Tell the user to run `brew install gh` / `apt install gh` |
| `gh auth status` reports not logged in | Tell the user to run `gh auth login` |
| raw URL returns 404 | Try the `master` branch (old repos default to master, not main); if that also fails, tell the user the file doesn't exist at that path |
| frontmatter parse failure | Show the user the first 200 characters of the raw content and ask whether they want to "install as-is" (force-override with `installSkill content`) |
| Content > 8KB | Do not install. Tell the user the SKILL.md is too long and suggest the author split it |
