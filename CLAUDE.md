# CLAUDE.md

Guidance for AI agents working in this repository.

## Project overview

`@rfc0/effect-runner` is a small, **database-agnostic** effect runner for the functional-core / imperative-shell
pattern. The domain returns writes as data (a `Persistable` batch + a response); the shell (`runEffects`) applies
them in one transaction with optimistic-concurrency version guards, optional idempotency, and bounded retry. The
consumer plugs in a small **adapter port** for their store. TypeScript (strict, ESM/NodeNext), zod, neverthrow,
remeda. MIT, published to npm as `@rfc0/effect-runner`.

The package is tiny — `src/engine.ts`, `src/persistable.ts`, `src/index.ts` — and is meant to stay that way.

## Commands

```bash
npm run lint        # eslint src test — includes the driver-free import ban (part of the gate)
npm run typecheck   # tsc --noEmit
npm run test        # vitest run (tests live under test/, not colocated)
npm run build       # tsc -p tsconfig.build.json → dist/
```

Run a single test file: `npx vitest run test/engine.test.ts`

## Definition of Done (verify before EVERY push)

```bash
npm run lint && npm run typecheck && npm run test && npm run build
```

Before pushing, read your own diff (`git diff origin/main...HEAD`) and check it against the non-negotiables below.
State the result in the PR description. Review is the backstop, not the gate.

## Non-negotiables

1. **Driver-free and consumer-free.** `src/` never imports a database driver (`drizzle-orm`, `@libsql/*`, `pg`,
   `better-sqlite3`, `mysql2`, …) and never names a consumer's entities, error types, or infrastructure. This is
   lint-enforced in `eslint.config.js`; never weaken or bypass it. Allowed runtime deps: `zod`, `neverthrow`,
   `remeda`.
2. **The adapter port is the public API.** The data contract (`Persistable`, `PersistOutcome`, `FlowOutcome`,
   `PersistenceMeta`/`withPersistenceMeta`, `INITIAL_VERSION`) and the port (`TransactionRunner`,
   `EntityApplier`, `ApplierRegistry`, `ReadBack`, `IsTransientContention`, `EngineContext`, `VersionConflict`,
   `MAX_RUN_EFFECTS_ATTEMPTS`) are semver-governed. A breaking change is a major bump — flag it explicitly and
   never make one casually (ADR 0001).
3. **The engine owns no error taxonomy.** Retry exhaustion is mapped through the injected `conflictError`
   factory; never introduce a concrete error type the consumer must adopt.
4. **Constants over literals.** No bare string/number where a zod `.enum.*` or named constant exists
   (`PersistOp.enum.insert`, `MAX_RUN_EFFECTS_ATTEMPTS`), and no literal copy-pasted across call sites — including
   error/log message strings.
5. **Declarative over imperative.** Use remeda (`R.pipe`, `R.filter`, `R.unique`, …) before hand-rolled loops or
   reducers. Native `map`/`filter` is fine for a single-stage transform; an order-dependent awaiting loop is fine.
6. **Names don't restate their module; one job per function.** Verb + noun; `is*`/`has*`/`can*` booleans.
7. **One concern per library.** zod = schemas/decoding, neverthrow = control flow/error track, remeda = reshaping.
8. **Keep it simple.** No abstraction before three concrete cases, no generics where a concrete type works, no
   options for behaviour that has never varied.
9. **Tests ship with behaviour changes.** The engine is tested generically (atomicity, version-conflict → discard
   → re-run, bounded retry, idempotent duplicates, sequence partial success). Update/add tests in `test/`.
10. **Docs in the same change.** Structural or contract changes update `docs/architecture.md`; a new decision
    gets an ADR in `docs/adr/`. Keep `README.md` examples accurate to the real signatures.
11. **Code style:** TypeScript strict; relative imports end in `.js`; static imports at the top; comments explain
    *why*, never *what*.

## Documentation map (read before generating)

- `docs/architecture.md` — the engine as built: data contract, adapter port, semantics. Source of truth.
- `docs/functional-core-imperative-shell.md` — the principle the engine implements. Agnostic: **no** project
  nouns, library names, ADR references, or status tracking belong in it.
- `docs/adr/` — decisions with rationale; never contradict an accepted ADR without writing a new one.
- `CONTRIBUTING.md` — conventions for human contributors; consistent with this file.

## Keep docs and source FinTrack-free

The engine was extracted from an application, but its docs and source describe the **generic** engine only.
Never mention the originating application's domain (its entities, tools, storage choices) in `src/`, `test/`,
`docs/`, or the README. The single sanctioned reference is the "extracted from" credit (README "Why", ADR 0001).

## Process

- Commit messages follow Conventional Commits: `type(scope): description` (`feat`, `fix`, `docs`, `refactor`,
  `test`, `chore`, `ci`). Use `!` or a `BREAKING CHANGE:` footer for incompatible changes.
- Releases are automated from CI (`.github/workflows/release.yml`); don't bump versions or publish by hand.

## Git workflow (branch + PR only)

`main` is protected — never commit or push directly to it.

1. Branch off the latest `main`: `git checkout main && git pull && git checkout -b type/short-description`
   (e.g. `docs/engine-docs`, `fix/retry-exhaustion`).
2. Commit on the branch (Conventional Commits), `git push -u origin <branch>`.
3. Open a PR targeting `main`; CI must pass and it must be reviewed before merge.
4. After merge, pull `main` before starting the next branch.

## Pull request comments

When addressing review feedback, reply to every open review comment after the work is done, referencing the commit
SHA that resolves it. Use `gh api graphql` with `addPullRequestReviewThreadReply` (the REST replies endpoint is
unreliable). Do this without waiting to be asked.

## Tech debt

When a known trade-off is deliberately deferred, open a **GitHub Issue** (current behaviour and why it's
suboptimal, the improved approach, why deferred, when to tackle it, rough effort) and reference it from the PR.
Do not create local markdown files for this.
