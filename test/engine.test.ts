import { okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import {
  isRetryable,
  MAX_RUN_EFFECTS_ATTEMPTS,
  runEffects,
  runEffectsSequence,
  VersionConflict,
  type ApplierRegistry,
  type EngineContext,
} from '../src/engine.js';
import { checkVersion, PersistOp, type Persistable } from '../src/persistable.js';

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

  it('preserves the committed response when onPublishError itself throws', async () => {
    const { ctx, registry } = makeHarness();
    const throwingReporter = (): void => {
      throw new Error('reporter failed');
    };

    const result = await runEffects({ ...ctx, onPublishError: throwingReporter }, registry, flowOf([insertThing]), throwingPublish);

    expect(result._unsafeUnwrap()).toBe('done');
  });

  it('continues a sequence when onPublishError itself throws', async () => {
    const { ctx, registry } = makeHarness();
    const throwingReporter = (): void => {
      throw new Error('reporter failed');
    };

    const results = await runEffectsSequence(
      { ...ctx, onPublishError: throwingReporter },
      registry,
      [1, 2],
      () => flowOf([insertThing]),
      throwingPublish,
    );

    expect(results.map((r) => r._unsafeUnwrap())).toEqual(['done', 'done']);
  });

  it('routes an async publish rejection to onPublishError without failing the write', async () => {
    const { ctx, registry, onPublishError } = makeHarness();
    const rejectingPublish = async (): Promise<void> => {
      throw publishCause;
    };

    const result = await runEffects(ctx, registry, flowOf([insertThing]), rejectingPublish);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result._unsafeUnwrap()).toBe('done');
    expect(onPublishError).toHaveBeenCalledExactlyOnceWith(publishCause);
  });

  it('consumes a rejection from an async onPublishError', async () => {
    const { ctx, registry } = makeHarness();
    const rejectingReporter = async (): Promise<void> => {
      throw new Error('reporter failed');
    };

    const result = await runEffects({ ...ctx, onPublishError: rejectingReporter }, registry, flowOf([insertThing]), throwingPublish);
    await new Promise((resolve) => setTimeout(resolve, 0));

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

describe('read-version check', () => {
  const CURRENT_VERSION = 2;
  const STALE_VERSION = 1;

  const makeHarness = (hasCheck = true) => {
    const calls: string[] = [];
    const ctx: EngineContext<null, string> = {
      runner: { runInTransaction: (work) => work(null) },
      isTransientContention: () => false,
      conflictError: () => 'conflict',
    };
    const registry: ApplierRegistry<null> = {
      guard: {
        insert: async () => ({ applied: true }),
        update: async () => ({ applied: true }),
        delete: async () => ({ applied: true }),
        ...(hasCheck && {
          check: async (_tx, id, version) => {
            calls.push(`check:${id}`);
            return { applied: version === CURRENT_VERSION };
          },
        }),
      },
      thing: {
        insert: async () => {
          calls.push('insert:thing');
          return { applied: true };
        },
        update: async () => ({ applied: true }),
        delete: async () => ({ applied: true }),
      },
    };
    return { ctx, registry, calls };
  };

  const insertThing: Persistable = { op: PersistOp.enum.insert, entity: 'thing', model: {} };
  const flowOf = (persist: Persistable[]) => () => okAsync({ persist, response: 'done' });

  it('passes when the version still matches', async () => {
    const { ctx, registry } = makeHarness();

    const result = await runEffects(ctx, registry, flowOf([checkVersion('guard', 'g-1', CURRENT_VERSION)]));

    expect(result._unsafeUnwrap()).toBe('done');
  });

  it('retries a stale version and succeeds once the flow re-reads', async () => {
    const { ctx, registry } = makeHarness();
    const versionsRead = [STALE_VERSION, CURRENT_VERSION];
    const flow = () => okAsync({ persist: [checkVersion('guard', 'g-1', versionsRead.shift()!)], response: 'done' });

    const result = await runEffects(ctx, registry, flow);

    expect(result._unsafeUnwrap()).toBe('done');
    expect(versionsRead).toEqual([]);
  });

  it('exhausts the attempts on persistent staleness like an update conflict', async () => {
    const { ctx, registry } = makeHarness();
    const flow = vi.fn(flowOf([checkVersion('guard', 'g-1', STALE_VERSION)]));

    const result = await runEffects(ctx, registry, flow);

    expect(result._unsafeUnwrapErr()).toBe('conflict');
    expect(flow).toHaveBeenCalledTimes(MAX_RUN_EFFECTS_ATTEMPTS);
  });

  it('publishes nothing for a batch of checks', async () => {
    const { ctx, registry } = makeHarness();
    const publish = vi.fn();

    await runEffects(ctx, registry, flowOf([checkVersion('guard', 'g-1', CURRENT_VERSION)]), publish);

    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes only the written entity in a mixed batch and gives checks no outcome', async () => {
    const { ctx, registry } = makeHarness();
    const publish = vi.fn();
    const response = (outcomes: unknown[]) => outcomes;

    const result = await runEffects(
      ctx,
      registry,
      () => okAsync({ persist: [checkVersion('guard', 'g-1', CURRENT_VERSION), insertThing], response }),
      publish,
    );

    expect(publish).toHaveBeenCalledExactlyOnceWith(['thing']);
    expect(result._unsafeUnwrap()).toEqual([{ entity: 'thing', applied: true }]);
  });

  it('preserves batch order across mixed writes and checks', async () => {
    const { ctx, registry, calls } = makeHarness();

    await runEffects(
      ctx,
      registry,
      flowOf([checkVersion('guard', 'first', CURRENT_VERSION), insertThing, checkVersion('guard', 'second', CURRENT_VERSION)]),
    );

    expect(calls).toEqual(['check:first', 'insert:thing', 'check:second']);
  });

  it('commits nothing when a later check is stale, with every write in the same transaction', async () => {
    const committed: string[] = [];
    const publish = vi.fn();
    const transactionsSeen = new Set<object>();
    const ctx: EngineContext<string[], string> = {
      runner: {
        runInTransaction: async (work) => {
          const staged: string[] = [];
          transactionsSeen.add(staged);
          const result = await work(staged);
          committed.push(...staged);
          return result;
        },
      },
      isTransientContention: () => false,
      conflictError: () => 'conflict',
    };
    const registry: ApplierRegistry<string[]> = {
      thing: {
        insert: async (staged) => {
          staged.push('thing');
          return { applied: true };
        },
        update: async () => ({ applied: true }),
        delete: async () => ({ applied: true }),
      },
      guard: {
        insert: async () => ({ applied: true }),
        update: async () => ({ applied: true }),
        delete: async () => ({ applied: true }),
        check: async (staged, _id, version) => {
          expect(staged).toContain('thing');
          return { applied: version === CURRENT_VERSION };
        },
      },
    };

    const result = await runEffects(ctx, registry, flowOf([insertThing, checkVersion('guard', 'g-1', STALE_VERSION)]), publish);

    expect(result._unsafeUnwrapErr()).toBe('conflict');
    expect(committed).toEqual([]);
    expect(transactionsSeen.size).toBe(MAX_RUN_EFFECTS_ATTEMPTS);
    expect(publish).not.toHaveBeenCalled();
  });

  it('throws a clear programming error when the applier has no check', async () => {
    const { ctx, registry } = makeHarness(false);

    await expect(runEffects(ctx, registry, flowOf([checkVersion('guard', 'g-1', CURRENT_VERSION)]))).rejects.toThrow(
      'applier for entity "guard" does not implement check',
    );
  });
});
