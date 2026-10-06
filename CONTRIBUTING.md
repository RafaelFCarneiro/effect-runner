# Contributing

Thanks for helping. The engine is small on purpose; these conventions keep it that way.

## The gate

Everything below must be green before a PR:

```bash
npm run lint && npm run typecheck && npm run test && npm run build
```

**The driver-free lint rule is non-negotiable.** `src/` must never import a database driver (`drizzle-orm`,
`@libsql/*`, `pg`, `better-sqlite3`, `mysql2`, …). The database is the consumer's adapter, never a dependency
here. Do not weaken or bypass the `no-restricted-imports` rule in `eslint.config.js`.

Use [Conventional Commits](https://www.conventionalcommits.org/) and open a PR from a branch; don't push to
`main`.

## Conventions

The full rules, with examples, live in two documents — read both before writing code:

- [docs/code-quality.md](docs/code-quality.md) — principles: constants over literals, naming, single
  responsibility, declarative over imperative (remeda), terse why-not-what comments, no unnecessary complexity.
- [docs/code-style.md](docs/code-style.md) — implementation patterns: one concern per library (zod / neverthrow /
  remeda), purity at the shell boundary, testing expectations.

In short: named constants, remeda over hand-rolled loops, names that don't restate their module, one job per
function, and comments that say *why* in a line or two.

## The public API

The data contract and adapter port described in [docs/architecture.md](docs/architecture.md) are the public API.
Changing them in a breaking way is a semver-major (see [ADR 0001](docs/adr/0001-extracted-from-fintrack.md)).
Add tests alongside any behaviour change.
