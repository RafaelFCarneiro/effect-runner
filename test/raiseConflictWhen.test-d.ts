import { describe, expectTypeOf, it } from 'vitest';
import { raiseConflictWhen, type EntityApplier, type IsConflict } from '../src/engine.js';

describe('raiseConflictWhen types', () => {
  it('takes an IsConflict predicate', () => {
    expectTypeOf(raiseConflictWhen).parameter(0).toEqualTypeOf<IsConflict>();
    expectTypeOf<IsConflict>().toEqualTypeOf<(cause: unknown) => boolean>();
  });

  it('infers TTx from the applier it decorates', () => {
    const applier = {} as EntityApplier<{ id: number }>;
    expectTypeOf(raiseConflictWhen(() => true)(applier)).toEqualTypeOf<EntityApplier<{ id: number }>>();
  });
});
