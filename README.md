# @rafaelfcarneiro/effect-runner

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
npm install @rafaelfcarneiro/effect-runner zod neverthrow
```

## The contract (what your domain returns)

```ts
import type { FlowOutcome, Persistable } from '@rafaelfcarneiro/effect-runner';
import { insert } from '@rafaelfcarneiro/effect-runner'; // your logic builds Persistables

// A flow returns the writes as data + the response — it performs no I/O.
const createThing = (input): FlowOutcome<Thing> => ({
  persist: [{ op: 'insert', entity: 'thing', model: thing, idempotencyKey }],
  response: thing,
});
```

`withPersistenceMeta(schema)` adds the optimistic-concurrency `version` token to a model's *entity* schema;
`INITIAL_VERSION` is where a fresh row starts.

## The adapter port (what you implement for your DB)

`runEffects` is generic over an opaque transaction handle `TTx` and your error type `E`, and takes an
`EngineContext`:

- **`TransactionRunner<TTx>`** — `runInTransaction(work: (tx) => Promise<T>): Promise<T>`; opens a unit of work,
  commits on success, rolls back on throw.
- **`ApplierRegistry<TTx>`** — per entity tag, an **`EntityApplier<TTx>`** with `insert` / `update` / `delete`
  that perform the mechanical write over `tx` and decide nothing. A versioned applier throws `VersionConflict`
  on a stale version or a unique/FK race; the engine catches it and retries.
- **`IsTransientContention`** — `(cause) => boolean`; tells the engine which driver errors are retryable
  transient contention (e.g. a busy lock).
- A conflict-error factory so the engine maps an exhausted retry into *your* error type `E` — the engine owns no
  error taxonomy.

```ts
import { runEffects } from '@rafaelfcarneiro/effect-runner';

const result = await runEffects(flowOutcome, {
  runInTransaction,          // your TransactionRunner
  registry,                  // your ApplierRegistry<TTx>
  isTransientContention,     // your driver's busy/contention check
  conflictError: () => myConflict(),
});
```

`runEffectsSequence` runs a sequence of independent units (each its own transaction + retry), for batch imports.

## Why

Extracted from a personal-finance app so the write-path engine — the part that is pure plumbing, not domain —
could be reused across projects and database backends without dragging the app along. The engine imports only
`zod` / `neverthrow` / `remeda` and is lint-guarded against database-driver imports.

## License

MIT © Rafael Ferreira Carneiro
