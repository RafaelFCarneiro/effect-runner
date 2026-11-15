import { filter, firstBy, identity, map, pipe } from 'remeda';
import { UNREAD_TOKEN } from './unreadToken.js';

export type ChangeLogRecord<E> = { id: number; origin: string; event: E };

/** A record the store could not decode: reported with its reason, never thrown, so it cannot block later ones. */
export type ChangeLogSkipped = { id: number; skipped: string };

export type ChangeLogEntry<E> = ChangeLogRecord<E> | ChangeLogSkipped;

export type NewChangeLogRecord<E> = { event: E; origin: string; createdAt: string };

/**
 * The consumer's storage for cross-process change notifications. `id` strictly increases, is never reused (even
 * after pruning removes the newest records), and records become readable in increasing id order: the relay's cursor
 * would otherwise skip a record.
 */
export type ChangeLogStore<E> = {
  append: (record: NewChangeLogRecord<E>) => Promise<void>;
  latestId: () => Promise<number>;
  /** Entries past `afterId` not written by `excludeOrigin`, in id order, at most `limit`. */
  readAfter: (afterId: number, excludeOrigin: string, limit: number) => Promise<readonly ChangeLogEntry<E>[]>;
  /** Deletes records created before the ISO instant. */
  pruneBefore: (isoInstant: string) => Promise<void>;
  /** Any value that changes when another process may have written; absent, the relay reads on every tick. */
  changeToken?: () => Promise<unknown>;
};

export type RelayBatchPlan<E> = {
  events: readonly E[];
  skipped: readonly ChangeLogSkipped[];
  lastId: number;
};

const isSkipped = <E>(entry: ChangeLogEntry<E>): entry is ChangeLogSkipped => 'skipped' in entry;

const isRecord = <E>(entry: ChangeLogEntry<E>): entry is ChangeLogRecord<E> => !isSkipped(entry);

const eventOf = <E>({ event }: ChangeLogRecord<E>): E => event;

const idOf = <E>({ id }: ChangeLogEntry<E>): number => id;

/** The cursor moves past skipped records too, so a record that cannot decode is never read again. */
export const planRelayBatch = <E>(lastId: number, entries: readonly ChangeLogEntry<E>[]): RelayBatchPlan<E> => ({
  events: pipe(entries, filter(isRecord<E>), map(eventOf<E>)),
  skipped: entries.filter(isSkipped<E>),
  lastId: firstBy([lastId, ...entries.map(idOf<E>)], [identity(), 'desc']) ?? lastId,
});

/** Records created before this instant are past retention; the clock is the caller's. */
export const pruneCutoff = (now: Date, retentionMs: number): string =>
  new Date(now.getTime() - retentionMs).toISOString();

/** Reads on the first reading (nothing recorded) and whenever the token differs from the recorded one. */
export const shouldRead = (previousToken: unknown, currentToken: unknown): boolean =>
  previousToken === UNREAD_TOKEN || !Object.is(previousToken, currentToken);
