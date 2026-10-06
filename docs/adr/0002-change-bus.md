# ADR 0002: The change bus ships in the package; notification failures never fail a commit

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

`PublishChange` lets the engine announce which entities a committed batch changed, but the package supplied only
the hook. Every consumer then wrote the same publish/subscribe pair around it. Separately, `publish` ran after
the commit without protection: a throwing subscriber would surface as an error for a write that had already
succeeded, inviting callers to retry a write that was durable.

## Decision

1. **The bus moves into the package.** `ChangeBus` (`publish` + `subscribe`) and `createChangeBus` are exported
   from `src/index.ts`. It is an additive, semver-minor change; nothing is removed.
2. **A `Set`, not `node:events`.** The default bus is a plain `Set` of listeners: no event name, no
   max-listener limit, no new dependency, and no Node-only module, so the package stays runtime-agnostic
   (`zod`, `neverthrow`, `remeda` only).
3. **The interface is the seam for multi-process transports.** `createChangeBus` is process-local. A deployment
   spanning processes implements `ChangeBus` over its own transport (a database `LISTEN`/`NOTIFY`, a broker) and
   hands its `publish` to the engine; the engine does not change.
4. **Post-commit failure isolation.** The bus isolates each listener (a throwing listener is reported to
   `onError`, never stops the others, never escapes `publish`) and snapshots listeners per publish. The engine
   additionally wraps `publish` and routes failures to the optional `EngineContext.onPublishError`, so a custom
   `ChangeBus` cannot turn a committed write into an error. The field is optional, so existing contexts remain
   valid.

## Consequences

- Consumers get a working default transport without writing one, and a custom one through the same interface.
- A committed write always returns its response; notification is best-effort. Delivery is at-most-once and
  in-process for the default bus; a consumer needing durable delivery must provide it in its own `ChangeBus`.
- Without `onPublishError`, a failed publish is silently dropped; consumers that care should set it.
