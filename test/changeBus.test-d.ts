import { describe, expectTypeOf, it } from 'vitest';
import { createChangeBus, type ChangeBus } from '../src/changeBus.js';
import type { PublishChange } from '../src/engine.js';

describe('ChangeBus types', () => {
  it('keeps the unparameterized shape as the entity-tags bus', () => {
    expectTypeOf<ChangeBus>().toEqualTypeOf<ChangeBus<readonly string[]>>();
    expectTypeOf<ChangeBus['publish']>().toEqualTypeOf<(event: readonly string[]) => void>();
    expectTypeOf<ChangeBus['subscribe']>().toEqualTypeOf<
      (listener: (event: readonly string[]) => void) => () => void
    >();
  });

  it('keeps the default bus pluggable into runEffects', () => {
    expectTypeOf(createChangeBus().publish).toEqualTypeOf<PublishChange>();
    expectTypeOf<ChangeBus['publish']>().toMatchTypeOf<PublishChange>();
  });

  it('infers the event type from the type argument', () => {
    expectTypeOf(createChangeBus<{ at: number }>()).toEqualTypeOf<ChangeBus<{ at: number }>>();
  });
});
