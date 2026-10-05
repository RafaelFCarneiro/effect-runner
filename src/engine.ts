import { errAsync, okAsync, type Result, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import { PersistOp, type FlowOutcome, type Persistable, type PersistOutcome } from './persistable.js';

/** Zero database-driver or consumer imports, lint-enforced (ADR 0001) — the consumer's adapter
 *  implements the port this file defines. */

/** Post-commit hook: told which entity tags a committed batch changed (e.g. to drive live updates).
 *  Declared here so the engine stays independent of any concrete change bus. */
export type PublishChange = (entities: readonly string[]) => void;

// Most callers don't care about change notification — `publish` defaults to this no-op rather than
// being required, so the two exported entry points stay backward-compatible.
const noopPublish: PublishChange = () => {};

// A version conflict re-invokes `flow` for a fresh read → fresh decision
// (docs/functional-core-imperative-shell.md rule 4), up to this many attempts total. Exported so
// tests assert the real policy instead of duplicating the literal.
export const MAX_RUN_EFFECTS_ATTEMPTS = 3;

/** The port: opens a unit of work, commits on success, rolls back on throw. The composition root
 *  binds this to the concrete adapter — the retry/orchestration code below calls `runInTransaction`
 *  and never names a driver's transaction API directly. Generic over an opaque transaction handle
 *  `TTx` — this file has no concrete `Tx` to default it to; an adapter may re-export a
 *  `Tx`-defaulted specialization for its own registrations' convenience. */
export type TransactionRunner<TTx> = {
  runInTransaction: <T>(work: (tx: TTx) => Promise<T>) => Promise<T>;
};

/** The port's other capability: classifies a thrown transaction failure as transient physical
 *  contention (e.g. a busy lock) — retried the same way as a `VersionConflict` — versus a genuine
 *  error, which propagates. The adapter's implementation is wired in at the composition root; this
 *  file never imports a driver. */
export type IsTransientContention = (cause: unknown) => boolean;

/** The adapter port plus the composition root's mapping from a retry-exhausted conflict to the
 *  shell's own error type — this is how the engine stays ignorant of any consumer's error union
 *  while every real caller still gets a properly-typed error back. */
export type EngineContext<TTx, E> = {
  runner: TransactionRunner<TTx>;
  isTransientContention: IsTransientContention;
  conflictError: () => E;
};

/** An applier's own outcome, before `applyPersistable` stamps its `Persistable`'s entity tag onto
 *  it — an applier never states its own tag, since the same applier can be registered under
 *  whatever tag the composition root chooses. */
type ApplierOutcome = Omit<PersistOutcome, 'entity'>;

/**
 * What an entity module supplies so this generic shell can apply a `Persistable` tagged with its
 * entity, without this file ever naming that entity. `insert`/`update` receive an already
 * db-row-shaped `model` — the model→row adaptation happens upstream, at the handler that calls
 * `runEffects`, never here — so `unknown` is deliberate: this file has no entity-specific row
 * type to name. Each method returns an `ApplierOutcome`; `applied` drives this file's own
 * retry/conflict decision (rule 4). Generic over the opaque transaction handle `TTx` —
 * the adapter that implements this port supplies its own concrete `TTx`.
 */
export type EntityApplier<TTx> = {
  insert: (tx: TTx, model: unknown, idempotencyKey?: string) => Promise<ApplierOutcome>;
  update: (tx: TTx, model: unknown) => Promise<ApplierOutcome>;
  delete: (tx: TTx, id: string, version: number) => Promise<ApplierOutcome>;
};

/** Every entity tag a converted flow might produce a `Persistable` for, mapped to how to apply
 *  it — assembled once at the composition root; this file only ever looks values up in it, never
 *  lists an entity itself. */
export type ApplierRegistry<TTx> = Record<string, EntityApplier<TTx>>;

/** An entity's own post-write projection, supplied at registration: invoked after a successful
 *  insert/update with the id of the row that actually persisted (on an idempotent duplicate, the
 *  surviving row's — never the discarded mint), returning the decoded view that lands on
 *  `PersistOutcome.read`. The one sanctioned entity-supplied hook performing a read inside the
 *  engine — a recorded deviation from FC/IS rules 3/6 (`docs/architecture.md`); a second
 *  entity-supplied hook is the signal this design is wrong. Generic over `TTx`, same as
 *  `EntityApplier`. */
export type ReadBack<TTx> = (tx: TTx, id: string) => Promise<unknown>;

/** Signals "roll back the whole batch and re-invoke the flow for a fresh read/decision" up
 *  through `runInTransaction`'s rejection; caught by `applyBatch`, never leaks past `runEffects`.
 *  Exported so an `EntityApplier` can raise the same retry for its own non-version conflict (e.g. a unique-constraint race). */
export class VersionConflict extends Error {}

const resolveApplier = <TTx>(registry: ApplierRegistry<TTx>, entity: string): EntityApplier<TTx> => {
  const applier = registry[entity];
  if (!applier) throw new Error(`runEffects: no applier registered for entity "${entity}"`);
  return applier;
};

const applyPersistable = async <TTx>(
  tx: TTx,
  registry: ApplierRegistry<TTx>,
  p: Persistable,
): Promise<PersistOutcome> => {
  const applier = resolveApplier(registry, p.entity);
  const outcome = await (async (): Promise<ApplierOutcome> => {
    switch (p.op) {
      case PersistOp.enum.insert:
        // An idempotent-duplicate no-op reports `applied: false` — inserts never retry here.
        return applier.insert(tx, p.model, p.idempotencyKey);
      case PersistOp.enum.update: {
        const updateOutcome = await applier.update(tx, p.model);
        if (!updateOutcome.applied) throw new VersionConflict();
        return updateOutcome;
      }
      case PersistOp.enum.delete: {
        const deleteOutcome = await applier.delete(tx, p.id, p.version);
        if (!deleteOutcome.applied) throw new VersionConflict();
        return deleteOutcome;
      }
      default: {
        const _exhaustive: never = p;
        throw new Error(`runEffects: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
      }
    }
  })();
  return { ...outcome, entity: p.entity };
};

/** The retry decision: a logical version conflict or a cause the adapter classifies as transient
 *  physical contention (e.g. a lock-wait timeout) is retried the same way; anything else is a genuine failure and
 *  propagates. Composed purely from the `VersionConflict` sentinel this file owns and the
 *  adapter-supplied `isTransientContention` classifier — no driver-specific import here. Exported
 *  so this composition has its own fast unit coverage. */
export const isRetryable = (cause: unknown, isTransientContention: IsTransientContention): boolean =>
  cause instanceof VersionConflict || isTransientContention(cause);

/** Applies the whole batch in one transaction, returning each outcome positionally parallel to
 *  `persist` — empty on a version conflict or a transient physical lock, since the transaction
 *  already rolled back. An empty batch (a dry-run preview flow) skips `runInTransaction` entirely.
 */
const applyBatch = async <TTx>(
  runner: TransactionRunner<TTx>,
  isTransientContention: IsTransientContention,
  registry: ApplierRegistry<TTx>,
  persist: Persistable[],
): Promise<{ applied: boolean; outcomes: PersistOutcome[] }> => {
  if (persist.length === 0) return { applied: true, outcomes: [] };

  const outcomes: PersistOutcome[] = [];
  try {
    await runner.runInTransaction(async (tx) => {
      for (const p of persist) outcomes.push(await applyPersistable(tx, registry, p));
    });
    return { applied: true, outcomes };
  } catch (cause) {
    if (isRetryable(cause, isTransientContention)) return { applied: false, outcomes: [] };
    throw cause;
  }
};

type Flow<T, E> = () => ResultAsync<FlowOutcome<T>, E>;

/** Resolves `FlowOutcome.response` against the batch's outcomes — the plain value for the common
 *  case, or the result of calling the function an idempotency-aware flow handed back (rule 6). */
const resolveResponse = <T>(response: T | ((outcomes: PersistOutcome[]) => T), outcomes: PersistOutcome[]): T =>
  typeof response === 'function' ? (response as (o: PersistOutcome[]) => T)(outcomes) : response;

/** Only outcomes that actually wrote something feed the change bus — an idempotent-duplicate
 *  insert's `applied: false` outcome changed nothing, so its entity is never published. Deduped,
 *  since one batch commonly touches the same entity via more than one `Persistable`. A no-op batch
 *  (nothing applied) publishes nothing. */
const publishChangedEntities = (outcomes: PersistOutcome[], publish: PublishChange): void => {
  const entities = R.pipe(
    outcomes,
    R.filter((o) => o.applied),
    R.map((o) => o.entity),
    R.unique(),
  );
  if (entities.length > 0) publish(entities);
};

const attempt = <T, E, TTx>(
  ctx: EngineContext<TTx, E>,
  registry: ApplierRegistry<TTx>,
  flow: Flow<T, E>,
  attemptsLeft: number,
  publish: PublishChange,
): ResultAsync<T, E> =>
  flow().andThen(({ persist, response }) =>
    ResultAsync.fromSafePromise(applyBatch(ctx.runner, ctx.isTransientContention, registry, persist)).andThen(
      ({ applied, outcomes }) => {
        if (applied) {
          publishChangedEntities(outcomes, publish);
          return okAsync(resolveResponse(response, outcomes));
        }
        if (attemptsLeft <= 1) return errAsync<T, E>(ctx.conflictError());
        return attempt(ctx, registry, flow, attemptsLeft - 1, publish);
      },
    ),
  );

/**
 * The generic effect runner (docs/functional-core-imperative-shell.md): runs `flow`, applies the
 * `persist` batch it returns in one `ctx.runner.runInTransaction` unit of work by dispatching each
 * `Persistable` to the `registry`'s applier for its entity, and returns `flow`'s `response`.
 * Entity-agnostic — only the `registry` (built once at the composition root) knows which entity is
 * which. A version conflict or transient physical contention (`ctx.isTransientContention`)
 * rolls back the whole batch and re-invokes `flow`, up to `MAX_RUN_EFFECTS_ATTEMPTS`
 * times, before surfacing `ctx.conflictError()`. This is the single-atomic-unit mode — the "unit
 * of work" mode. `ctx` is the adapter port plus the error binding — the composition root binds it to
 * the concrete driver and the consumer's own conflict error. `publish` is the post-commit hook,
 * called once per successful commit with the batch's changed entity tags — optional, so callers
 * that don't need change notification are unaffected.
 */
export const runEffects = <T, E, TTx>(
  ctx: EngineContext<TTx, E>,
  registry: ApplierRegistry<TTx>,
  flow: Flow<T, E>,
  publish: PublishChange = noopPublish,
): ResultAsync<T, E> => attempt(ctx, registry, flow, MAX_RUN_EFFECTS_ATTEMPTS, publish);

/** One unit's outcome from `runEffectsSequence`: its response, or the error it failed with (a
 *  domain error from its own flow, or a bounded-retry-exhausted `ctx.conflictError()`). A plain
 *  neverthrow `Result` — the caller narrows via `isOk`/`isErr` to shape a partial-success response,
 *  no bespoke tagged union or casting needed. */
export type SequenceOutcome<T, E> = Result<T, E>;

/**
 * The sequence-of-independent-units mode applies `items` in order, each
 * through its own call to `attempt` — its own transaction, its own bounded conflict retry — so
 * retry semantics are identical to the single-atomic-unit mode by construction, never
 * re-implemented here. `flowFor(item)` is invoked only once this loop reaches that item, i.e.
 * after every earlier item has already committed (or been recorded as failed) — the re-invocation
 * this relies on for retry is the same mechanism that makes unit *i+1* see unit *i*'s committed
 * writes. A unit's domain error, or its own retry exhaustion, is recorded as `Err` and
 * the loop continues to the next item — partial success, never a short-circuit; only a genuine
 * unexpected failure (not a version conflict) still throws, same as `runEffects`. `publish`,
 * same default as `runEffects`, fires per unit that actually commits.
 */
export const runEffectsSequence = async <I, T, E, TTx>(
  ctx: EngineContext<TTx, E>,
  registry: ApplierRegistry<TTx>,
  items: readonly I[],
  flowFor: (item: I) => Flow<T, E>,
  publish: PublishChange = noopPublish,
): Promise<SequenceOutcome<T, E>[]> => {
  const outcomes: SequenceOutcome<T, E>[] = [];
  for (const item of items) {
    outcomes.push(await attempt(ctx, registry, flowFor(item), MAX_RUN_EFFECTS_ATTEMPTS, publish));
  }
  return outcomes;
};
