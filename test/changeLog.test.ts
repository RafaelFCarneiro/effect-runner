import { describe, expect, it } from 'vitest';
import { planRelayBatch, pruneCutoff, shouldRead, type ChangeLogEntry } from '../src/changeLog.js';
import { UNREAD_TOKEN } from '../src/unreadToken.js';

type Event = { name: string };

describe('planRelayBatch', () => {
  it('splits a batch into events and skipped records, in id order', () => {
    const entries: ChangeLogEntry<Event>[] = [
      { id: 4, origin: 'a', event: { name: 'first' } },
      { id: 5, skipped: 'bad json' },
      { id: 6, origin: 'b', event: { name: 'second' } },
    ];

    expect(planRelayBatch(3, entries)).toEqual({
      events: [{ name: 'first' }, { name: 'second' }],
      skipped: [{ id: 5, skipped: 'bad json' }],
      lastId: 6,
    });
  });

  it('moves the cursor past a trailing skipped record', () => {
    expect(planRelayBatch(3, [{ id: 4, skipped: 'bad' }]).lastId).toBe(4);
  });

  it('keeps the cursor on an empty batch', () => {
    expect(planRelayBatch(7, [])).toEqual({ events: [], skipped: [], lastId: 7 });
  });
});

describe('pruneCutoff', () => {
  it('is the instant retentionMs before now, as an ISO string', () => {
    expect(pruneCutoff(new Date('2026-01-02T00:00:00.000Z'), 24 * 60 * 60 * 1000)).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('shouldRead', () => {
  it('always reads the first time', () => {
    expect(shouldRead(UNREAD_TOKEN, 1)).toBe(true);
    expect(shouldRead(UNREAD_TOKEN, undefined)).toBe(true);
    expect(shouldRead(UNREAD_TOKEN, UNREAD_TOKEN)).toBe(true);
  });

  it('reads only when the token changed, compared with Object.is', () => {
    expect(shouldRead(1, 1)).toBe(false);
    expect(shouldRead(1, 2)).toBe(true);
    expect(shouldRead(undefined, undefined)).toBe(false);
    expect(shouldRead(Number.NaN, Number.NaN)).toBe(false);
    expect(shouldRead(0, -0)).toBe(true);
  });
});
