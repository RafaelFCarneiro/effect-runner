import { okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import {
  isRetryable,
  runEffects,
  runEffectsSequence,
  VersionConflict,
  type ApplierRegistry,
  type EngineContext,
} from '../src/engine.js';
import { PersistOp, type Persistable } from '../src/persistable.js';

// The pure decision point of the port seam: `isRetryable` composes the `VersionConflict` sentinel the
// engine owns with the adapter-supplied `isTransientContention` classifier, with no driver-specific
// import. This covers just that composition, in isolation.
describe('isRetryable (the retry decision, decoupled from any concrete adapter)', () => {
  it('retries a VersionConflict regardless of what the adapter classifier says', () => {
    expect(isRetryable(new VersionConflict(), () => false)).toBe(true);
  });

  it('retries a cause the adapter classifies as transient contention', () => {
    const busyLikeCause = new Error('database is locked');
    expect(isRetryable(busyLikeCause, () => true)).toBe(true);
  });

  it('propagates a cause that is neither a VersionConflict nor classified as transient', () => {
    const unrelatedCause = new Error('unique constraint failed');
    expect(isRetryable(unrelatedCause, () => false)).toBe(false);
  });
});

describe('change publication after commit', () => {
  const publishCause = new Error('notification failed');
  const throwingPublish = (): void => {
    throw publishCause;
  };

  const makeHarness = (isApplied = true) => {
    const onPublishError = vi.fn();
    const ctx: EngineContext<null, string> = {
      runner: { runInTransaction: (work) => work(null) },
      isTransientContention: () => false,
      conflictError: () => 'conflict',
      onPublishError,
    };
    const registry: ApplierRegistry<null> = {
      thing: {
        insert: async () => ({ applied: isApplied }),
        update: async () => ({ applied: true }),
        delete: async () => ({ applied: true }),
      },
    };
    return { ctx, registry, onPublishError };
  };

  const insertThing: Persistable = { op: PersistOp.enum.insert, entity: 'thing', model: {} };
  const flowOf = (persist: Persistable[]) => () => okAsync({ persist, response: 'done' });

  it('publishes the changed entity tags once after a commit', async () => {
    const { ctx, registry } = makeHarness();
    const publish = vi.fn();

    await runEffects(ctx, registry, flowOf([insertThing, insertThing]), publish);

    expect(publish).toHaveBeenCalledExactlyOnceWith(['thing']);
  });

  it('resolves Ok with the response and reports the cause when publish throws after a commit', async () => {
    const { ctx, registry, onPublishError } = makeHarness();

    const result = await runEffects(ctx, registry, flowOf([insertThing]), throwingPublish);

    expect(result._unsafeUnwrap()).toBe('done');
    expect(onPublishError).toHaveBeenCalledExactlyOnceWith(publishCause);
  });

  it('still returns the committed response when publish throws and no onPublishError is set', async () => {
    const { ctx, registry } = makeHarness();

    const result = await runEffects({ ...ctx, onPublishError: undefined }, registry, flowOf([insertThing]), throwingPublish);

    expect(result._unsafeUnwrap()).toBe('done');
  });

  it('keeps every unit committed in a sequence when publish throws', async () => {
    const { ctx, registry, onPublishError } = makeHarness();

    const results = await runEffectsSequence(ctx, registry, [1, 2], () => flowOf([insertThing]), throwingPublish);

    expect(results.map((r) => r._unsafeUnwrap())).toEqual(['done', 'done']);
    expect(onPublishError).toHaveBeenCalledTimes(2);
  });

  it('does not publish for an empty batch', async () => {
    const { ctx, registry } = makeHarness();
    const publish = vi.fn();

    await runEffects(ctx, registry, flowOf([]), publish);

    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish when every write was an idempotent duplicate', async () => {
    const { ctx, registry } = makeHarness(false);
    const publish = vi.fn();

    await runEffects(ctx, registry, flowOf([insertThing]), publish);

    expect(publish).not.toHaveBeenCalled();
  });
});
