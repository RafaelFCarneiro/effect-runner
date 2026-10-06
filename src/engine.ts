import { errAsync, okAsync, type Result, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import { runIsolated } from './isolate.js';
import { PersistOp, type FlowOutcome, type Persistable, type PersistOutcome } from './persistable.js';

/** Post-commit hook: receives the entity tags a committed batch changed; skipped when nothing was applied. */
export type PublishChange = (entities: readonly string[]) => void;

// Optional for callers, so `publish` defaults to this no-op.
const noopPublish: PublishChange = () => {};

// Total attempts per flow; exported so tests assert the policy, not a duplicated literal.
export const MAX_RUN_EFFECTS_ATTEMPTS = 3;

/** Opens a unit of work, commits on success, rolls back on throw. `TTx` is an opaque transaction handle. */
export type TransactionRunner<TTx> = {
  runInTransaction: <T>(work: (tx: TTx) => Promise<T>) => Promise<T>;
};

/** Classifies a thrown failure as retryable transient contention (e.g. a busy lock) vs a genuine error. */
export type IsTransientContention = (cause: unknown) => boolean;

/** The adapter port plus `conflictError`, so the engine returns the consumer's own error type `E`. */
export type EngineContext<TTx, E> = {
  runner: TransactionRunner<TTx>;
  isTransientContention: IsTransientContention;
  conflictError: () => E;
  /** Receives a failure (throw or async rejection) from `publish`; a committed write is never failed by its notification. */
  onPublishError?: (cause: unknown) => void;
};

/** An applier never states its own entity tag; the engine stamps it from the `Persistable`. */
type ApplierOutcome = Omit<PersistOutcome, 'entity'>;

/** Mechanical per-entity writes over `tx`; `model` is already row-shaped, hence `unknown`. */
export type EntityApplier<TTx> = {
  insert: (tx: TTx, model: unknown, idempotencyKey?: string) => Promise<ApplierOutcome>;
  update: (tx: TTx, model: unknown) => Promise<ApplierOutcome>;
  delete: (tx: TTx, id: string, version: number) => Promise<ApplierOutcome>;
};

/** Entity tag → applier. Adding an entity is registration, never a new engine branch. */
export type ApplierRegistry<TTx> = Record<string, EntityApplier<TTx>>;

/** Optional post-write projection populating `PersistOutcome.read`, given the id of the row that persisted.
 *  The one sanctioned entity-supplied read inside the unit of work (see `docs/architecture.md`). */
export type ReadBack<TTx> = (tx: TTx, id: string) => Promise<unknown>;

/** Rolls back the batch and re-runs the flow. Exported so an applier can raise it for its own conflicts. */
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

/** A `VersionConflict` or adapter-classified transient contention retries; anything else propagates. */
export const isRetryable = (cause: unknown, isTransientContention: IsTransientContention): boolean =>
  cause instanceof VersionConflict || isTransientContention(cause);

/** Applies the batch in one transaction; `applied: false` means rolled back and retryable. An empty batch skips the transaction. */
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

/** Plain response, or the function an idempotency-aware flow supplied, given the outcomes. */
const resolveResponse = <T>(response: T | ((outcomes: PersistOutcome[]) => T), outcomes: PersistOutcome[]): T =>
  typeof response === 'function' ? (response as (o: PersistOutcome[]) => T)(outcomes) : response;

/** Publishes the deduped tags of outcomes that actually wrote; idempotent duplicates publish nothing.
 *  Runs after commit, so a throwing or rejecting `publish` is routed to `onPublishError` instead of failing the write. */
const publishChangedEntities = <TTx, E>(
  ctx: EngineContext<TTx, E>,
  outcomes: PersistOutcome[],
  publish: PublishChange,
): void => {
  const entities = R.pipe(
    outcomes,
    R.filter((o) => o.applied),
    R.map((o) => o.entity),
    R.unique(),
  );
  if (entities.length === 0) return;
  runIsolated(() => publish(entities), ctx.onPublishError);
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
          publishChangedEntities(ctx, outcomes, publish);
          return okAsync(resolveResponse(response, outcomes));
        }
        if (attemptsLeft <= 1) return errAsync<T, E>(ctx.conflictError());
        return attempt(ctx, registry, flow, attemptsLeft - 1, publish);
      },
    ),
  );

/**
 * Runs `flow`, applies its `persist` batch atomically via the registry's appliers, and returns its response.
 * A version conflict or transient contention rolls back and re-runs `flow` up to `MAX_RUN_EFFECTS_ATTEMPTS`
 * times, then yields `ctx.conflictError()`. `publish` fires after a commit that applied at least one write, not for empty or all-duplicate batches.
 */
export const runEffects = <T, E, TTx>(
  ctx: EngineContext<TTx, E>,
  registry: ApplierRegistry<TTx>,
  flow: Flow<T, E>,
  publish: PublishChange = noopPublish,
): ResultAsync<T, E> => attempt(ctx, registry, flow, MAX_RUN_EFFECTS_ATTEMPTS, publish);

/** One unit's result: its response, or the error it failed with. */
export type SequenceOutcome<T, E> = Result<T, E>;

/**
 * Applies independent units in order, each with its own transaction and retry (same semantics as `runEffects`).
 * `flowFor(item)` runs only after earlier units settle, so each sees the previous unit's commits. A unit's
 * error is recorded and the loop continues (partial success); an unexpected throw still propagates.
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
