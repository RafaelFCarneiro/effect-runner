# @rfc0/effect-runner

A small, **database-agnostic** effect runner for the functional-core / imperative-shell pattern.

Your domain **decides** a write and returns it as **data** — a batch of `Persistable`s (`insert` / `update` /
`delete`, each carrying an entity tag + model) plus the response the caller should get. The **shell** —
`runEffects` — applies that batch inside one transaction, with optimistic-concurrency version guards, optional
idempotency, and automatic retry on version conflicts and transient contention. The engine never touches a
database itself: you plug in a tiny **adapter port** for your store (libSQL/SQLite, Postgres, anything).

Pairs naturally with [neverthrow](https://github.com/supermacro/neverthrow) (Result) and
[zod](https://github.com/colinhacks/zod) (the version-token schema helper); `zod` is a peer dependency.

## Install

```bash
npm install @rfc0/effect-runner zod neverthrow
```

## The contract (what your domain returns)

```ts
import type { FlowOutcome } from '@rfc0/effect-runner';
import { okAsync, type ResultAsync } from 'neverthrow';

// A flow returns the writes as data + the response — it performs no I/O.
const createThing = (input: Input): ResultAsync<FlowOutcome<Thing>, MyError> =>
  okAsync({
    persist: [{ op: 'insert', entity: 'thing', model: thing, idempotencyKey }],
    response: thing,
  });
```

`withPersistenceMeta(schema)` adds the optimistic-concurrency `version` token to a model's *entity* schema;
`INITIAL_VERSION` is where a fresh row starts.

## The adapter port (what you implement for your DB)

`runEffects` is generic over an opaque transaction handle `TTx` and your error type `E`. It takes an
`EngineContext` (`runner`, `isTransientContention`, `conflictError`), an `ApplierRegistry`, and the flow:

- **`TransactionRunner<TTx>`** (`ctx.runner`) — `runInTransaction(work: (tx) => Promise<T>): Promise<T>`; opens a unit of work,
  commits on success, rolls back on throw.
- **`ApplierRegistry<TTx>`** — per entity tag, an **`EntityApplier<TTx>`** with `insert` / `update` / `delete`
  that perform the mechanical write over `tx` and decide nothing. An applier reports `applied: false` on a stale version (the engine turns that into a
  `VersionConflict`), or may throw `VersionConflict` itself for a unique/FK race; the engine catches it and retries.
- **`IsTransientContention`** (`ctx.isTransientContention`) — `(cause) => boolean`; tells the engine which driver errors are retryable
  transient contention (e.g. a busy lock).
- **`conflictError`** — a factory on `ctx` so the engine maps an exhausted retry into *your* error type `E` — the engine owns no
  error taxonomy.

```ts
import { runEffects } from '@rfc0/effect-runner';

const ctx = {
  runner,                    // your TransactionRunner<TTx>
  isTransientContention,     // your driver's busy/contention check
  conflictError: () => myConflict(), // maps retry exhaustion into your error type E
};

// `flow` is a thunk returning a neverthrow ResultAsync<FlowOutcome<T>, E>.
const result = await runEffects(ctx, registry, () => createThing(input));
// result: Result<T, E>; optional 4th argument `publish(entities)` fires after each successful commit
```

`runEffectsSequence` runs a sequence of independent units (each its own transaction + retry), for batch imports.

## Documentation

- [Architecture](docs/architecture.md) — the engine's data contract, adapter port, and semantics
- [Functional Core, Imperative Shell](docs/functional-core-imperative-shell.md) — the principle it implements
- [Contributing](CONTRIBUTING.md) — conventions and the pre-PR gate
- [ADR 0001](docs/adr/0001-extracted-from-fintrack.md) — why it exists and what counts as the public API

## Why

Extracted from a personal-finance app so the write-path engine — the part that is pure plumbing, not domain —
could be reused across projects and database backends without dragging the app along. The engine imports only
`zod` / `neverthrow` / `remeda` and is lint-guarded against database-driver imports.

## License

MIT © Rafael Ferreira Carneiro
