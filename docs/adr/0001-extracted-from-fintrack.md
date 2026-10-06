# ADR 0001: Extracted from an application; the adapter port is the public API

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

The effect engine began as the write-path plumbing inside a personal-finance application, where it was already
free of domain knowledge and database drivers. The application's own decision record (ADR-031 there) chose to
extract it into a standalone package so it can be reused across projects and database backends without
dragging the application along. That application's ADRs stay with that application; this is the engine's own
decision trail.

## Decision

1. The engine is published as `@rfc0/effect-runner`, MIT-licensed, public on npm.
2. **The adapter port is the public API.** Every export of `src/index.ts` is semver-governed: the data
   contract (`PersistOp`, `Persistable`, `PersistOutcome`, `FlowOutcome`, `PersistenceMeta`/`withPersistenceMeta`,
   `INITIAL_VERSION`), the port an integrator implements (`TransactionRunner`, `EntityApplier`,
   `ApplierRegistry`, `ReadBack`, `IsTransientContention`, `EngineContext`, `PublishChange`, `VersionConflict`),
   and the entry points and helpers (`runEffects`, `runEffectsSequence`, `SequenceOutcome`, `isRetryable`,
   `MAX_RUN_EFFECTS_ATTEMPTS`). A breaking change to any of them is a **semver-major**; the policy is defined by
   the index exports, so this list follows `src/index.ts` rather than the other way round.
3. The engine stays **driver-and-consumer-free**: it depends only on `zod`, `neverthrow` and `remeda`, imports
   no database driver, and names no consumer's entities or error types. This is enforced by an ESLint
   `no-restricted-imports` rule, so a violation fails the build.

## Consequences

- Integrators can swap databases by writing a small adapter, without engine changes.
- Internals may change freely as long as the port and contract hold.
- The engine owns no error taxonomy; consumers inject their own via `conflictError`.
- Contributions that need a driver or consumer-specific concept belong in the adapter, not here.
