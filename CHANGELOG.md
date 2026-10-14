# Changelog

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
