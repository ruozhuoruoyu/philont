---
name: memory-discipline
description: Discipline for using memory tools (store_fact / get_fact / list_facts) — how to choose a namespace, when to read before writing, and how to avoid overwriting and losing information.
when_to_use: About to call store_fact but unsure which namespace / key to use (user / project / self / service.X); need to update an existing memory value (read-then-write to avoid overwrite); agent is about to record an important fact but wants to confirm correct placement / naming convention
version: 1.0.0
---

# Memory Discipline

## When to Use

- The user says "remember this / keep note of / I like / I don't eat / I am ..."
- The user asks "what did I say before / do you still remember X / what is my Y"
- Before making a recommendation or suggestion (should list_facts first to avoid hitting things the user has already rejected)
- Any preference / constraint / attribute / plan that is **long-term and will remain valid in the future**

## Namespace Decision Tree

| Content | namespace | key examples |
|---|---|---|
| User preferences (likes/dislikes) | `user` | `preferences.cuisine` |
| User taboos / allergies / constraints | `user` | `constraints.diet` |
| User identity / attributes | `user` | `role` / `location` / `age` |
| User scheduled events | `user` | `events.<name>` (fact_kind=event, occurred_at=ISO) |
| Project-related | `project` | `tech_stack` / `goals` |
| Role identity (assigned to agent by user) | `user.role` | `style` |
| **Agent's own cognition** | `self` | **read-only** (maintained by SelfReflector) |

## Write Discipline (Critical)

### Read Before Write — Merge, Don't Overwrite

**❌ Wrong** — calling store_fact directly, overwriting:
```
User: "I also hate cilantro"
agent: store_fact(user, preferences.cuisine, {dislikes: ["cilantro"]})
       ← the previously stored dislikes: ["Japanese food"] is lost
```

**✅ Correct** — get first, merge, then store:
```
existing = get_fact(user, preferences.cuisine)
        // {dislikes: ["Japanese food"]}
merged = {dislikes: [...existing.dislikes, "cilantro"]}
store_fact(user, preferences.cuisine, merged)
```

### Negative Preferences Come First

When a user **negates** something, **almost always record it** (the cost of hitting it again on the next recommendation is high).
- "I don't eat spicy food / I'm allergic to peanuts" → constraints, **permanent**
- "I like noodles" → preferences, may decay

### Proactive Memory Principle

Even if the user doesn't say "remember this", **immediately** call store_fact when you see the following signals:
1. Preference statement: "I like / hate / don't like X"
2. Constraint / taboo: "can't eat / allergic / off alcohol"
3. Attribute: "I'm in New York / I'm a backend dev / I'm 30"
4. Planned event: "going to an interview tomorrow / having dumplings at noon"

## Read Discipline

### Scan Before Recommending

Before any "suggest / recommend / which one to pick", always:
```
list_facts(user, prefix="preferences")
list_facts(user, prefix="constraints")
```
Recommending without scanning = high probability of hitting something the user has already rejected.

### "Do You Remember X?" Is Not Small Talk

Immediately call `list_facts` or `get_fact` to look it up — **do not** say "I don't have context" — you have recall_sessions / list_facts available.

## Anti-patterns

- ❌ Saying "got it, I'll remember that" without calling store_fact = lying (HonestyGate will detect this)
- ❌ Writing to the same namespace.key without reading first → overwrites and loses information
- ❌ Using namespace=`assistant` / `agent` etc. (non-standard values) → cannot be read back later
- ❌ Writing the value as long prose → subsequent get_fact returns a wall of text, not structured data. **Use JSON objects** `{key: value}`

## Naming Convention Quick Reference

- Use `.` for hierarchy: `preferences.cuisine` / `events.next_trip`
- Use plural nouns for collections: `dislikes` / `allergies`
- Use ISO 8601 for time fields: `occurred_at: "2026-04-28T12:00:00Z"`
