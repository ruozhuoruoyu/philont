# Contributing to Philont

Thanks for your interest in improving Philont! This project is a developer
preview, so contributions — bug reports, docs, tests, and code — are all welcome.

## Ground rules

- Be respectful. By participating you agree to the
  [Code of Conduct](CODE_OF_CONDUCT.md).
- For **security vulnerabilities**, do **not** open a public issue — follow
  [SECURITY.md](SECURITY.md).
- Keep changes focused. One logical change per pull request.

## Project layout & build

Philont is a layered TypeScript monorepo (each package builds independently;
there is no root `package.json`). Build bottom-up:

```
agent-policy → agent-tools → agent-mcp → agent-plugins → agent-memory → server / web-ui / launcher
```

`scripts/build-all.sh` (Windows: `scripts/build-all.ps1`) does this for you.

The Rust crates `agent-core` and `agent-node` are **dormant** and not part of the
build or runtime — you don't need a Rust toolchain to contribute.

## Development workflow

1. Fork and create a branch off `main`:
   ```bash
   git checkout -b fix/short-description
   ```
2. Make your change. Match the style of the surrounding code (naming, comment
   density, idioms). The codebase uses plain `tsc` + the Node built-in test
   runner — no extra formatter is enforced, but `.editorconfig` defines the basics.
3. Build and test the affected package(s):
   ```bash
   cd <package> && npm install && npm test
   ```
4. If you touched cross-package behavior, run the full suite:
   ```bash
   for pkg in agent-policy agent-memory agent-tools agent-mcp agent-plugins; do
     echo "== $pkg =="; (cd "$pkg" && npm test 2>&1 | tail -5)
   done
   ```
5. Type-check:
   ```bash
   cd <package> && npx tsc --noEmit
   ```

## Pull requests

- Fill in the PR template.
- Describe **what** changed and **why**, and how you tested it.
- Add or update tests for behavior changes.
- Update relevant docs (`README.md`, `DEPLOYMENT.md`, package READMEs) when you
  change user-facing behavior or configuration.
- Keep the commit history readable; squash noisy WIP commits before review.

## Coding conventions

- **TypeScript**, ESM, targeting Node ≥ 20.
- Prefer the existing utilities and patterns over new dependencies.
- The **mechanism/policy split** is core: keep concrete capabilities in
  userspace packages and out of the kernel design. New tools go in `agent-tools`
  and must declare their `capability × domain` classification so the policy layer
  can govern them.
- When you borrow an algorithm or pattern from another project, **credit it**
  inline with a `Reference:` comment (see `agent-policy/src/validators/` for the
  convention).

## Reporting bugs & requesting features

Use the GitHub issue templates. A good bug report includes your OS, Node version,
the exact command, and the full error output.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
