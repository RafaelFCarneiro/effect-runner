import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('public API', () => {
  it('exports the change-log functions ADR 0003 names', () => {
    expect(api.createRelayedChangeBus).toBeTypeOf('function');
    expect(api.startChangeRelay).toBeTypeOf('function');
    expect(api.planRelayBatch).toBeTypeOf('function');
    expect(api.pruneCutoff).toBeTypeOf('function');
    expect(api.shouldRead).toBeTypeOf('function');
  });

  it('exports the conflict-classification decorator', () => {
    expect(api.raiseConflictWhen).toBeTypeOf('function');
  });

  it('keeps the unread-token marker internal', () => {
    expect(Object.keys(api)).not.toContain('UNREAD_TOKEN');
  });
});
