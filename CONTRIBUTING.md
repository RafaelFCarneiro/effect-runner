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

- **Constants over literals.** Never pass a magic string or number where a named constant exists. Zod enums
  expose `.enum` — use `PersistOp.enum.insert`, not `'insert'`. A value used in more than one place gets a
  constant; never copy-paste a literal across call sites. Thresholds and limits are named
  (`MAX_RUN_EFFECTS_ATTEMPTS`).
- **Declarative over imperative.** Reach for [remeda](https://remedajs.com/) before writing a loop or a
  hand-rolled reduce (`R.pipe`, `R.filter`, `R.unique`, `R.countBy`, …). Native `map`/`filter` is fine for a
  single-stage transform. Where order-dependent awaiting is the point (applying a batch in sequence), a plain
  loop is acceptable.
- **Names don't restate their module.** The file or import namespace already provides context: `modelToDb` in
  `adapters/transactions.ts`, not `modelTransactionToDb`. Resolve collisions with namespacing, not longer names.
  Otherwise names are descriptive — verb + noun for functions, `is*`/`has*`/`can*` for booleans, no cryptic
  abbreviations.
- **One concern per library.** zod owns schemas and decoding; neverthrow owns control flow and the error track;
  remeda owns data reshaping. Don't use one to do another's job.
- **Single responsibility.** One function, one job; if the description needs "and", split it. Extract a block
  that can be named and tested on its own.
- **Keep it simple.** No abstraction before there are three concrete cases, no generics where a concrete type
  works, no options for behaviour that has never varied.
- **Static imports** at the top of the file; relative imports end in `.js` (ESM/NodeNext).
- **Comments explain why** (invariants, trade-offs), not what the code already says.
- **Consistency over cleverness.** Follow the existing pattern unless it genuinely doesn't fit, and document why.

## The public API

The data contract and adapter port described in [docs/architecture.md](docs/architecture.md) are the public API.
Changing them in a breaking way is a semver-major (see [ADR 0001](docs/adr/0001-extracted-from-fintrack.md)).
Add tests alongside any behaviour change.
