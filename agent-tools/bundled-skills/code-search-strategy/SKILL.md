---
name: code-search-strategy
description: An efficient three-step method for finding things in a codebase — glob to locate → grep for keywords → readFile to read closely. Avoids running a full-repo grep or reading entire files from the start.
when_to_use: User asks "where is X in the code / who implements X / how do I find Y"; locating a file before modifying a module; debugging and wanting to trace a stack trace back to its source; locating entry points before reading an unfamiliar codebase; facing a large repo and not knowing where to begin
version: 1.0.0
---

# Code Search Strategy

## When to Use

- Need to find a function / class / config / string in the codebase
- User says "where is X / who calls Y / where is Z defined"
- About to change a concept that spans multiple files

## Three-Step Method (Coarse to Fine)

### Step 1 · glob to Locate the File Set

Use `glob` first to narrow down candidate files — **do not** run a bare grep across the entire repo.
```
glob("**/*.ts")              # all ts files
glob("src/**/*.{ts,tsx}")    # only under src
glob("**/auth*.ts")          # names containing auth
```

The glob output is a list of filenames that **a person/LLM can scan** — far fewer tokens than hundreds of grep match lines across the whole repo.

### Step 2 · grep to Narrow Down to Matching Lines

Only grep against the subset of files identified in Step 1:
```
grep -n "<symbol>" <files-from-glob>
```

Add `-n` (line numbers) + `-A 2 -B 2` (2 lines of context) for easy jump-reading later.

**Do not** run `grep -r "X" /` across the whole disk — it returns hundreds of lines, causing LLM to lose focus and making it unreadable.

### Step 3 · readFile to Read Closely

Only read the key sections of files that matched in grep (pass `offset` + `limit`):
```
readFile(path, offset=120, limit=40)   # read 40 lines around line 120
```

If a full file read exceeds 500 lines, consider reading in segments.

## Comparison Example

**❌ Slow and token-heavy**:
```
grep -r "useState" .         # thousands of hits, impossible to review
```

**✅ Efficient**:
```
glob("src/components/**/*.tsx")        # narrow to ~50 component files
grep -ln "useState" <those files>      # which components use useState
readFile(<top-3>, ranges...)           # closely read the most relevant ones
```

## Anti-patterns

- ❌ Starting with `grep -r` across the whole repo → token explosion + signal buried in noise
- ❌ readFile on a 5000-line file without passing offset/limit → wastes the context window
- ❌ Drawing conclusions from only the first grep hit → the same symbol name is often defined in multiple places
- ❌ Using an overly broad glob pattern `**/*` without restricting by extension → scans binaries / lock files
