---
name: web-research
description: Standard procedure for online research — webSearch to evaluate sources → webFetch to retrieve content → answer with citations. Avoids making things up from memory or jumping to conclusions from a single source.
when_to_use: User asks about up-to-date information that requires the internet (news / price comparison / papers / documentation versions); user asks "what is X / what's happening with X lately"; agent itself realizes "I don't know X but it should be searchable"; multi-source information needs cross-verification to prevent fabrication
version: 1.0.0
---

# Web Research

## When to Use

- User asks a question that requires external information (news / documentation / software versions / API usage / academia)
- You are uncertain about a fact (year, library version, whether an API exists) and are about to answer
- User provides a URL and asks you to "take a look"
- User's message contains a specific token (arxiv ID / CVE / RFC / `lib@version` / quoted proper noun) that you are unfamiliar with

## Standard Procedure

### Step 1 · Search First, Then Fetch

```
webSearch("<keyword 1> <keyword 2> [year/version]")
```
- Specific keywords + time qualifier (e.g. "2025") → more accurate hits
- Look at the top-5 returned titles + URLs and **evaluate sources**: official docs > reputable media > personal blogs > forum replies

### Step 2 · Fetch 1-2 High-Quality Sources

```
webFetch(url, "extract section X / answer question Y")
```
- Write a **specific extraction target** in the prompt — not "summarize this page", but "what are the parameters for this API / what version number fixed this bug"
- **At least 2 independent sources** for cross-verification, especially for numbers / dates / versions

### Step 3 · Answer With Source Citations

```
According to [source 1](url1) and [source 2](url2):
  X is Y (released 2025-03, see source 1)
  Note that Z changed to W after v3.2 (see source 2)
```

Do not use "the internet says / to my knowledge" — these are disguises for fabrication.

## Key Counter-examples

**❌ Answering from memory**:
> "React 19 now enables strict mode by default"
> (you don't know if this is true — this is fabrication)

**✅ Search first**:
> "Let me look up the React 19 release notes to confirm"
> [webSearch / webFetch...]
> "According to the [React 19 announcement](url), the default value of strict mode is X..."

## Anti-patterns

- ❌ Skipping search and directly fetching a guessed URL → likely 404 + wastes a tool call
- ❌ Fetching only one source and treating it as fact → a single source is unreliable
- ❌ Not reading webSearch results before fetching the first one → the first result is not necessarily relevant
- ❌ Using vague phrases like "to my knowledge / generally speaking" to mask unverified claims

## Integration With Memory System

- After finding an important fact, **store_fact** to persist it (no need to search again next time)
- Use `searchNotes` to check local notes first; if found, no need to go online
