import { describe, expect, it } from 'vitest';
import { isRetryable, VersionConflict } from '../src/engine.js';

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
