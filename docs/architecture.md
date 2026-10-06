# Architecture

How `@rfc0/effect-runner` is built. The conceptual foundation is
[Functional Core, Imperative Shell](functional-core-imperative-shell.md); this document is the engine's as-built
design. The source of truth is [`src/persistable.ts`](../src/persistable.ts) (data contract) and
[`src/engine.ts`](../src/engine.ts) (shell + adapter port).

## The split the engine implements

- **The domain (functional core)** decides. Its flow is a thunk the shell invokes, yielding a neverthrow
  `ResultAsync<FlowOutcome<T>, E>`: domain failures stay on the error track, and on the Ok path `FlowOutcome<T>`
  carries a batch of `Persistable`s describing the writes plus the response the caller gets. It performs no writes.
- **The shell (`runEffects`)** executes. It applies the batch through an adapter you supply, owns atomicity,
  concurrency, idempotency and retry, and returns the response.

The engine is generic over an opaque transaction handle `TTx` and the consumer's error type `E`. It imports only
`zod`, `neverthrow` and `remeda`, and never a database driver (lint-enforced; see
[ADR 0001](adr/0001-extracted-from-fintrack.md)).

## The data contract

| Export | Role |
|---|---|
| `Persistable<Tag, Model>` | A write intent, one of three shapes (below). |
| `PersistOp` | Zod enum `insert \| update \| delete`; construct ops via `PersistOp.enum.*`, never bare strings. |
| `PersistOutcome` | `{ entity, applied, read? }` — what happened when one `Persistable` was applied. |
| `FlowOutcome<T>` | `{ persist: Persistable[]; response: T \| ((outcomes: PersistOutcome[]) => T) }`. |
| `PersistenceMeta` / `withPersistenceMeta(schema)` | The optimistic-concurrency `version` token (a non-negative int), added to an entity schema without polluting the pure model. |
| `INITIAL_VERSION` | `0` — where a fresh row starts. |

The three `Persistable` shapes:

- `insert` — `{ op, entity, model, idempotencyKey? }`. The model carries no `version`; a new row always starts at
  `INITIAL_VERSION`, which the core does not decide. `idempotencyKey` is optional dedup metadata for the intent,
  not a model field.
- `update` — `{ op, entity, model }` where `model.version` is the version the core **read**. The applier
  computes the persisted version as `model.version + 1`.
- `delete` — `{ op, entity, id, version }`: the id plus the version read, for the same guard.

`entity` is a consumer-owned tag; the shared type never enumerates entities.

### Responses

`response` is normally a plain value the core already holds. For an idempotency-aware flow whose response depends
on whether a write really happened (e.g. a `created` flag), `response` is instead a **synchronous, pure** function
of the `PersistOutcome[]`, called once the batch has committed. A flow that needs a further write puts it in
`persist`; `response` never performs I/O. Outcomes are matched by `entity` tag, not position.

## The adapter port

What an integrator implements:

- **`TransactionRunner<TTx>`** — `runInTransaction(work: (tx: TTx) => Promise<T>): Promise<T>`. Opens a unit of
  work, commits on success, rolls back when `work` throws.
- **`EntityApplier<TTx>`** — per entity, `insert(tx, model, idempotencyKey?)`, `update(tx, model)`,
  `delete(tx, id, version)`, each returning `{ applied, read? }`. Appliers do the mechanical write over `tx`
  and decide nothing; they do not state their own entity tag (the engine stamps it from the `Persistable`).
- **`ApplierRegistry<TTx>`** — `Record<string, EntityApplier<TTx>>`, keyed by entity tag. Adding an entity is
  registration, never a new branch in the engine. An unregistered tag throws.
- **`ReadBack<TTx>`** — `(tx, id) => Promise<unknown>`: an optional per-entity post-write projection an applier
  may use to populate `PersistOutcome.read`, run inside the transaction against the row that actually persisted
  (on an idempotent duplicate, the surviving row). It is the one sanctioned read inside the engine's unit of
  work.
- **`IsTransientContention`** — `(cause: unknown) => boolean`: classifies a driver error as retryable physical
  contention (e.g. a busy lock) as opposed to a genuine failure.
- **`EngineContext<TTx, E>`** — `{ runner, isTransientContention, conflictError }`. `conflictError: () => E` is
  the injected factory that maps retry exhaustion into the consumer's own error type, so the engine owns no
  error taxonomy.
- **`PublishChange`** — optional post-commit hook `(entities: readonly string[]) => void`, defaulting to a
  no-op (see below).

## Semantics

**One transaction per batch.** `runEffects(ctx, registry, flow, publish?)` runs `flow()`, then applies its whole
`persist` batch inside a single `runInTransaction`, dispatching each `Persistable` to its entity's applier in
order. All-or-nothing. An empty batch (e.g. a dry-run preview) skips the transaction entirely.

**Optimistic-concurrency guard.** For `update` and `delete`, the applier conditions the write on the version the
core read (`UPDATE … SET …, version = version + 1 WHERE id = ? AND version = ?`). If it matches no row it
reports `applied: false`, and the engine raises `VersionConflict`, which rolls back the batch.

**Retry.** A thrown cause is retryable if it is a `VersionConflict` or `isTransientContention(cause)` is true;
anything else propagates as a genuine error. A retryable failure rolls back the whole batch and **re-invokes the
flow** — fresh reads, fresh decision — up to `MAX_RUN_EFFECTS_ATTEMPTS` (3) attempts in total. Exhaustion
surfaces `ctx.conflictError()` on the error track. `VersionConflict` is exported so an applier can raise the
same retry for its own non-version conflict (e.g. a unique/FK race).

**Idempotency.** An `insert` may carry `idempotencyKey`. The applier writes it to a fixed key column and, on a
duplicate key, skips the write and returns `applied: false` with `read` reflecting the existing row. Inserts are
never retried for being duplicates; the flow's response function can observe `applied: false` and report
`created: false`.

**Change publication.** After a successful commit, entities whose outcomes were `applied: true` are deduped
and passed to `publish`. A batch with nothing applied (all duplicates, or empty) publishes nothing.

**Independent units.** `runEffectsSequence(ctx, registry, items, flowFor, publish?)` applies items in order, each
through its own transaction and its own bounded retry — identical semantics to `runEffects` by construction.
`flowFor(item)` is invoked only once earlier items have committed or failed, so unit *i+1* sees unit *i*'s
writes. A unit's domain error or retry exhaustion is recorded as an `Err` and the loop continues (partial
success); only an unexpected failure throws. It returns a neverthrow `Result<T, E>` per item.

## Public API stability

Every export of `src/index.ts` — the data contract, the adapter port, and the entry points above — is the
package's public API and semver-governed. See
[ADR 0001](adr/0001-extracted-from-fintrack.md).
