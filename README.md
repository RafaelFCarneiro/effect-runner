# @rfc0/effect-runner

A small, **database-agnostic** effect runner for the functional-core / imperative-shell pattern.

Your domain **decides** a write and returns it as **data** — a batch of `Persistable`s (`insert` / `update` /
`delete` / `check`, each carrying an entity tag + model) plus the response the caller should get. The **shell** —
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
import { PersistOp, type FlowOutcome } from '@rfc0/effect-runner';
import { okAsync, type ResultAsync } from 'neverthrow';

// A flow returns the writes as data + the response — it performs no I/O.
const createThing = (input: Input): ResultAsync<FlowOutcome<Thing>, MyError> =>
  okAsync({
    persist: [{ op: PersistOp.enum.insert, entity: 'thing', model: thing, idempotencyKey }],
    response: thing,
  });
```

`withPersistenceMeta(schema)` adds the optimistic-concurrency `version` token to a model's *entity* schema;
`INITIAL_VERSION` is where a fresh row starts.

### Validating a row you only read

When a decision depends on a row it doesn't write, add `checkVersion(entity, id, version)` to the batch. The
engine validates, inside the same transaction, that the row is still at the version you read; if not, the batch
rolls back and the flow re-runs (same bounded retry as a stale `update`). A check writes nothing and publishes
nothing, so prefer it to rewriting an unchanged row.

```ts
import { checkVersion, PersistOp } from '@rfc0/effect-runner';

persist: [checkVersion('account', account.id, account.version), { op: PersistOp.enum.insert, entity: 'entry', model: entry }]
```

Entities you check need an applier with the optional `check(tx, id, version)`: report `applied: false` when the
row is no longer at `version`. A plain `SELECT` is not enough on a concurrent store: `check` must hold the row until
commit (a row lock such as `FOR SHARE`, or serializable isolation with serialization failures reported as transient
contention), otherwise two transactions can still check each other's rows and both commit. See
[Read-set validation](docs/architecture.md#read-set-validation).

## The adapter port (what you implement for your DB)

`runEffects` is generic over an opaque transaction handle `TTx` and your error type `E`. It takes an
`EngineContext` (`runner`, `isTransientContention`, `conflictError`), an `ApplierRegistry`, and the flow:

- **`TransactionRunner<TTx>`** (`ctx.runner`) — `runInTransaction(work: (tx) => Promise<T>): Promise<T>`; opens a unit of work,
  commits on success, rolls back on throw.
- **`ApplierRegistry<TTx>`** — per entity tag, an **`EntityApplier<TTx>`** with `insert` / `update` / `delete`
  (and optionally `check`) that perform the mechanical write over `tx` and decide nothing. An applier reports `applied: false` on a stale version (the engine turns that into a
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
// result: Result<T, E>; optional 4th argument `publish(entities)` fires after each commit that applied at least one write
```

### Change notification

```ts
import { createChangeBus, runEffects } from '@rfc0/effect-runner';

const bus = createChangeBus({ onError: logListenerFailure });
const unsubscribe = bus.subscribe((entities) => refresh(entities)); // e.g. ['thing']

await runEffects({ ...ctx, onPublishError: logPublishFailure }, registry, flow, bus.publish);
```

`createChangeBus` is an in-memory transport; for several processes see [Across processes](#across-processes) or
implement the `ChangeBus` interface over your own transport. A failing notification never fails a committed write.

The bus is generic over its event (`createChangeBus<E>()`, default `readonly string[]`). `runEffects` always
publishes entity tags, so adapt them to your richer event once, at the composition root:

```ts
type CommitEvent = { entities: readonly string[]; at: Date };

const bus = createChangeBus<CommitEvent>({ onError: logListenerFailure });
bus.subscribe(({ entities, at }) => refresh(entities, at));

const publish: PublishChange = (entities) => bus.publish({ entities, at: new Date() });
await runEffects(ctx, registry, flow, publish);
```

#### Across processes

Provide a `ChangeLogStore` (a table or equivalent) and make two calls. Each process writes its own `origin`;
`publishLocal` is what the relay delivers on, so a relayed event is never recorded again.

```ts
import { createRelayedChangeBus, startChangeRelay, type ChangeLogEntry, type ChangeLogStore } from '@rfc0/effect-runner';

type Event = { entities: readonly string[] };

const rows: ChangeLogEntry<Event>[] = []; // a toy store; use a real table, ids increasing in write order
const origins = new Map<number, string>();
const store: ChangeLogStore<Event> = {
  append: async ({ event, origin }) => {
    const id = rows.length + 1;
    origins.set(id, origin);
    rows.push({ id, origin, event });
  },
  latestId: async () => rows.length,
  readAfter: async (afterId, excludeOrigin, limit) =>
    rows.filter((row) => row.id > afterId && origins.get(row.id) !== excludeOrigin).slice(0, limit),
  pruneBefore: async () => {},
};

const origin = crypto.randomUUID();
const { bus, publishLocal, settled } = createRelayedChangeBus<Event>({ store, origin, onError: logFailure });
const relay = await startChangeRelay({
  store, publishLocal, origin, pollMs: 250, retentionMs: 3_600_000, pruneEveryMs: 60_000, batchLimit: 100,
  onError: logFailure,
});

bus.subscribe(({ entities }) => refresh(entities));
const publish: PublishChange = (entities) => bus.publish({ entities });
await runEffects(ctx, registry, flow, publish);

await relay.stop();
await settled();
```

Delivery across processes is at-most-once and best-effort; see [ADR 0003](docs/adr/0003-relayed-change-bus.md).

`runEffectsSequence` runs a sequence of independent units (each its own transaction + retry), for batch imports.

## Documentation

- [Architecture](docs/architecture.md) — the engine's data contract, adapter port, and semantics
- [Functional Core, Imperative Shell](docs/functional-core-imperative-shell.md) — the principle it implements
- [Contributing](CONTRIBUTING.md) — conventions and the pre-PR gate
- [ADR 0001](docs/adr/0001-extracted-from-an-application.md) — why it exists and what counts as the public API
- [ADR 0002](docs/adr/0002-change-bus.md) — the change bus and post-commit failure isolation
- [ADR 0003](docs/adr/0003-relayed-change-bus.md) — the store-backed change bus across processes

## Why

Extracted from a personal-finance app so the write-path engine — the part that is pure plumbing, not domain —
could be reused across projects and database backends without dragging the app along. The engine imports only
`zod` / `neverthrow` / `remeda` and is lint-guarded against database-driver imports.

## License

MIT © Rafael Ferreira Carneiro
