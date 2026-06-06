# Security Policy

Philont is software that can read and write files, run shell commands, and make
network requests on the host that runs it. We take its security posture
seriously, and so should you when deploying it.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private **["Report a vulnerability"](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
flow (Security tab → *Report a vulnerability*), or email the maintainers if a
contact address is listed on the repository.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal proof of concept is ideal).
- Affected version / commit and your environment.

We aim to acknowledge reports within a few business days and will keep you
updated on remediation. Please give us reasonable time to ship a fix before any
public disclosure.

## Scope

Philont is a **developer preview**. The architecture and core safety mechanisms
(the `agent-policy` permission layer, validator chain, sandbox, audit log,
honesty gates) are implemented, but production hardening — sandbox
escape/stress testing, load testing — is still in progress.

Especially relevant areas:

- **Permission layer (`agent-policy`)** — bypasses of the capability matrix,
  validator chain (path ACLs, SSRF, dangerous commands, secret-leak detection),
  or the grant store.
- **Sandbox isolation** — escapes from the direct/task/process execution layers.
- **Credential handling** — leakage of stored secrets or the audit log.
- **MCP / plugin loading** — untrusted server or plugin code escaping its bounds.

## Deployment expectations

Philont ships **without authentication** and assumes a single trusted user on a
trusted local network. The Web UI and HTTP API must not be exposed directly to
the internet. See [DEPLOYMENT.md → Production hardening](DEPLOYMENT.md#production-hardening)
for the required reverse-proxy, auth, and isolation steps. Vulnerabilities that
require ignoring those documented expectations may be considered out of scope.

## Handling secrets

Never commit real API keys, tokens, or credentials. Use `.env` (git-ignored) and
`.env.example` for templates. The repository's own leak detector
(`agent-policy/src/validators/leakDetector.ts`) reflects the secret patterns we
guard against at runtime.
