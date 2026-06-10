---
name: clawhub
description: Discover, install, and uninstall skills from the ClawHub public skill registry (clawhub.ai), internalizing community knowledge as my own capabilities.
when_to_use: User mentions ClawHub / the public skill registry / community skills; agent notices "no local skill available but the community might have one" and wants to search; user says "check if ClawHub has X" / "install a skill to handle X"
version: 1.0.0
---

# ClawHub Skill Registry

## When to Use

- The user's request has no ready-made skill available to me, but it matches a publicly reusable pattern ("k8s manifest validation" / "Postgres backup" / "GitHub PR review", etc.)
- User explicitly says: "find/install/uninstall a ClawHub skill" / "see if ClawHub has X"
- I've repeatedly run into the same type of problem and realize I need more systematic domain guidance

## What ClawHub Is

ClawHub is OpenClaw's public skill registry (clawhub.ai). All skills are public, versioned SKILL.md bundles. Operated via the local `clawhub` CLI, installed through npm:

```
npm i -g clawhub
```

If `which clawhub` fails, tell the user to install it first, then we'll continue.

## Core Workflow

### 1. Search

```
shell({ command: "clawhub search '<query>' --limit 5" })
```

Example: `clawhub search "k8s yaml validate"`. Returns several slugs + one-line descriptions. Read the candidates and pick the one that best matches the user's needs.

### 2. Install

```
shell({ command: "clawhub install <slug> --dir .philont/skills" })
```

`--dir .philont/skills` directs ClawHub to install the SKILL.md into philont's main skill directory (by default it installs to `./skills/`; while the philont loader reads there too, `.philont/skills/` has higher priority and avoids conflicts).

After writing to disk, **immediately patch the source tag** so philont knows this skill came from ClawHub:

```
installSkill({ name: "<slug>", source: "clawhub:<slug>@<version>" })
```

Read `<version>` from the output of `clawhub install`. If the output format changes, run `clawhub list` to check the lockfile.

When `installSkill` returns, the SkillStore has already been refreshed synchronously — the next tool call (including `use_skill`) will immediately see the new skill without waiting for the fs watcher.

#### Idempotency: `Already installed`

If `clawhub install` exits non-zero and stderr contains `Already installed` (possibly accompanied by libuv assertion noise), **do not treat this as a failure**:
- The file is already on disk, no need to reinstall
- Proceed directly to `installSkill({ name: "<slug>", source: "clawhub:<slug>@<version>" })` to patch the source, **do not add `--force`** (`--force` would lose local changes the user or the reflector made to that directory)
- Only pass `--force` when you have a good reason to pull a new version (and first `uninstallSkill` to clear the old one)

### 3. List Installed Skills

Two approaches:

- Read philont's own SkillStore (entries tagged `[clawhub]` in the system prompt index are these)
- Run `shell({ command: "clawhub list" })` to read `.clawhub/lock.json` (from ClawHub's perspective)

The two should be consistent. When they aren't (e.g., user manually deleted the directory), philont reload-prune will sync automatically.

### 4. Uninstall

```
uninstallSkill({ name: "<slug>" })
```

This deletes the `.philont/skills/<slug>/` directory; after the watcher triggers a reload, the prune path automatically removes the corresponding row from SkillStore.

Do not call `clawhub uninstall` directly (it operates on `.clawhub/lock.json`, which philont does not read).

### 5. Update

```
shell({ command: "clawhub update <slug>" })   # single skill
shell({ command: "clawhub update --all" })    # all skills
```

After updating, **re-patch the source tag** (version has changed):

```
installSkill({ name: "<slug>", source: "clawhub:<slug>@<new-version>" })
```

## Decision Tree: User mentions a domain I don't know — should I install a skill?

- One-off question (user asks only once, and general LLM capability is sufficient) → don't install, answer directly
- Repeatedly occurring multi-step pattern (N ≥ 3 steps, and LLM handles it inconsistently on its own) → install
- User explicitly says "install this" → install
- Nothing suitable found on ClawHub → tell the user nothing was found, ask if they want to provide a GitHub URL to install directly (via the `github-skills` skill)

## Anti-patterns

- ❌ Don't forget to patch the source after `clawhub install`. Without a source tag, reload-prune will treat it as a locally hand-written skill, and orphaned rows won't be cleaned up automatically on uninstall.
- ❌ Don't use `shell` to directly execute `rm -rf .philont/skills/<slug>` instead of `uninstallSkill`. The former bypasses the prune path and leaves SkillStore rows behind (though they will be cleaned up on next reload, the semantics are unclear).
- ❌ Don't use `clawhub install --force` to overwrite a same-named skill the user wrote locally — this will destroy results produced by the reflector. Explicitly `uninstallSkill` first, then reinstall.
- ❌ Don't relay ClawHub search results to the user verbatim and then wait for instructions. Pick the best match and install it directly; report back only on failure. Acting autonomously means not asking for approval at every step.

## Failure Handling

| Symptom | Response |
|---|---|
| `clawhub: command not found` | Tell user to run `npm i -g clawhub`, then retry |
| Network timeout | Retry once; if it fails again, tell user there's a network issue |
| No matching slug found | Switch to `github-skills` to search, or report back "ClawHub has no relevant skills" |
| `clawhub install` reports permission/disk space error | Relay the error to the user directly, do not pretend success |
| `Error: Already installed` (with or without libuv assertion) | Don't reinstall, don't pass `--force`; go straight to `installSkill {name, source}` to patch source. The skill is already on disk; exit≠0 is the CLI's "friendly failure" refusing to reinstall. |
| `clawhub install` hangs for a long time (>2 minutes) | Retry once with an explicit larger `timeout` (e.g., 300000); if it still times out, tell the user there's a network issue |
