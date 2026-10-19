# Changelog

## 0.5.0

### Added

- `check` effect for optimistic-concurrency read-set validation: `PersistOp.enum.check`, the `checkVersion(entity,
  id, version)` builder, and an optional `EntityApplier.check(tx, id, version)`. A stale check raises
  `VersionConflict` (same retry and exhaustion path as a stale update); it writes nothing and contributes no
  `PersistOutcome` or published entity. A check for an entity whose applier lacks `check` throws.

### Compatibility

Backward compatible at runtime: existing batches and appliers are unchanged. Code that exhaustively switches on
`Persistable['op']` or `PersistOp` must handle the new `check` member.

## 0.4.0

### Added

- `ChangeBus` and `createChangeBus` are generic over the event: `ChangeBus<E = readonly string[]>`,
  `createChangeBus<E>(options?)`. `PublishChange` and `runEffects` are unchanged; adapt entities to a richer event
  at the composition root (see the README).

### Compatibility

The default type parameter keeps existing code compiling unchanged; `ChangeBus` without an argument is the previous
shape.

## 0.3.0

- Added the in-memory change bus (`createChangeBus`) and failure-safe post-commit publishing
  (`EngineContext.onPublishError`). See [ADR 0002](docs/adr/0002-change-bus.md).
