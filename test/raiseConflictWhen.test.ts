import { okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RUN_EFFECTS_ATTEMPTS,
  raiseConflictWhen,
  runEffects,
  VersionConflict,
  type ApplierRegistry,
  type EngineContext,
  type EntityApplier,
} from '../src/engine.js';
import { PersistOp, type Persistable } from '../src/persistable.js';

class RaceError extends Error {}
const isRace = (cause: unknown): boolean => cause instanceof RaceError;
const never = (): boolean => false;
const tx = { handle: 'tx' };
const succeeded = { applied: true };

const makeApplier = (fail?: Error): EntityApplier<typeof tx> => {
  const settle = async () => {
    if (fail) throw fail;
    return succeeded;
  };
  return { insert: vi.fn(settle), update: vi.fn(settle), delete: vi.fn(settle), check: vi.fn(settle) };
};

describe('raiseConflictWhen', () => {
  const writes = [
    ['insert', (a: EntityApplier<typeof tx>) => a.insert(tx, {})],
    ['update', (a: EntityApplier<typeof tx>) => a.update(tx, {})],
    ['delete', (a: EntityApplier<typeof tx>) => a.delete(tx, 'a', 1)],
  ] as const;

  it.each(writes)('%s raises VersionConflict for a matching cause', async (_name, write) => {
    const decorated = raiseConflictWhen(isRace)(makeApplier(new RaceError()));
    await expect(write(decorated)).rejects.toBeInstanceOf(VersionConflict);
  });

  it.each(writes)('%s rethrows a non-matching cause as the same instance', async (_name, write) => {
    const cause = new Error('boom');
    const decorated = raiseConflictWhen(isRace)(makeApplier(cause));
    await expect(write(decorated)).rejects.toBe(cause);
  });

  it.each(writes)('%s returns the applier outcome unchanged on success', async (_name, write) => {
    const decorated = raiseConflictWhen(isRace)(makeApplier());
    await expect(write(decorated)).resolves.toBe(succeeded);
  });

  it('forwards the idempotency key to insert', async () => {
    const applier = makeApplier();
    await raiseConflictWhen(isRace)(applier).insert(tx, { id: 'a' }, 'key-1');
    expect(applier.insert).toHaveBeenCalledWith(tx, { id: 'a' }, 'key-1');
  });

  it.each(writes)('%s keeps the original error as the conflict cause', async (_name, write) => {
    const cause = new RaceError();
    const raised = await write(raiseConflictWhen(isRace)(makeApplier(cause))).catch((error: unknown) => error);
    expect(raised).toBeInstanceOf(VersionConflict);
    expect((raised as VersionConflict).cause).toBe(cause);
  });

  it('passes check through even when the predicate would match', async () => {
    const cause = new RaceError();
    const decorated = raiseConflictWhen(() => true)(makeApplier(cause));
    await expect(decorated.check?.(tx, 'a', 1)).rejects.toBe(cause);
  });
});

describe('raiseConflictWhen with a class-based applier', () => {
  class ClassApplier implements EntityApplier<typeof tx> {
    readonly label = 'receiver';
    insert = async () => succeeded;
    update = async () => succeeded;
    async delete(): Promise<{ applied: boolean }> {
      return { applied: this.label === 'receiver' };
    }
    async check(): Promise<{ applied: boolean }> {
      return { applied: this.label === 'receiver' };
    }
  }

  it('forwards prototype delete and check with their receiver', async () => {
    const decorated = raiseConflictWhen(isRace)(new ClassApplier());
    await expect(decorated.delete(tx, 'a', 1)).resolves.toEqual(succeeded);
    await expect(decorated.check?.(tx, 'a', 1)).resolves.toEqual(succeeded);
  });

  it('keeps check absent when the applier does not implement it', () => {
    const withoutCheck: EntityApplier<typeof tx> = { ...makeApplier(), check: undefined };
    expect(raiseConflictWhen(isRace)(withoutCheck).check).toBeUndefined();
  });
});

describe('raiseConflictWhen through runEffects', () => {
  const ctx: EngineContext<typeof tx, string> = {
    runner: { runInTransaction: (work) => work(tx) },
    isTransientContention: never,
    conflictError: () => 'conflict',
  };
  const insertThing: Persistable = { op: PersistOp.enum.insert, entity: 'thing', model: {} };
  const flow = () => okAsync({ persist: [insertThing], response: 'done' });

  const registryFailing = (failures: Error[]): ApplierRegistry<typeof tx> => ({
    thing: raiseConflictWhen(isRace)({
      insert: async () => {
        const failure = failures.shift();
        if (failure) throw failure;
        return succeeded;
      },
      update: async () => succeeded,
      delete: async () => succeeded,
    }),
  });

  it('retries a matching failure and succeeds on the next attempt', async () => {
    const result = await runEffects(ctx, registryFailing([new RaceError()]), flow);
    expect(result._unsafeUnwrap()).toBe('done');
  });

  it('gives the ordinary conflict answer when every attempt loses the race', async () => {
    const failures = Array.from({ length: MAX_RUN_EFFECTS_ATTEMPTS }, () => new RaceError());
    const result = await runEffects(ctx, registryFailing(failures), flow);
    expect(result._unsafeUnwrapErr()).toBe('conflict');
  });

  it('lets a failure the predicate never matches propagate without retry', async () => {
    const cause = new Error('boom');
    const registry = registryFailing([cause]);
    const insert = vi.spyOn(registry.thing!, 'insert');
    await expect(runEffects(ctx, registry, flow)).rejects.toBe(cause);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
