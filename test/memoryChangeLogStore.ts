import type { ChangeLogEntry, ChangeLogStore } from '../src/changeLog.js';

type Row<E> = { id: number; origin: string; createdAt: string; entry: ChangeLogEntry<E> };

export type MemoryChangeLogStore<E> = ChangeLogStore<E> & {
  rows: Row<E>[];
  calls: { append: number; latestId: number; readAfter: { afterId: number; excludeOrigin: string; limit: number }[]; changeToken: number; pruneBefore: string[] };
  /** Writes a record as another process would, without going through `append`. */
  write: (origin: string, event: E, createdAt?: string) => number;
  writeSkipped: (reason: string) => number;
  token: { value: unknown };
  hooks: { append?: (record: Parameters<ChangeLogStore<E>['append']>[0]) => Promise<void>; readAfter?: () => Promise<void>; latestId?: () => Promise<void> };
};

export const createMemoryChangeLogStore = <E>({ withToken = true }: { withToken?: boolean } = {}): MemoryChangeLogStore<E> => {
  const rows: Row<E>[] = [];
  const calls: MemoryChangeLogStore<E>['calls'] = { append: 0, latestId: 0, readAfter: [], changeToken: 0, pruneBefore: [] };
  const token = { value: 0 as unknown };
  const hooks: MemoryChangeLogStore<E>['hooks'] = {};
  // Monotonic like a real log: pruning must never let an id be reused.
  const counter = { last: 0 };
  const nextId = (): number => ++counter.last;

  const write = (origin: string, event: E, createdAt = new Date(0).toISOString()): number => {
    const id = nextId();
    rows.push({ id, origin, createdAt, entry: { id, origin, event } });
    token.value = (token.value as number) + 1;
    return id;
  };

  const store: MemoryChangeLogStore<E> = {
    rows,
    calls,
    token,
    hooks,
    write,
    writeSkipped: (reason) => {
      const id = nextId();
      rows.push({ id, origin: '', createdAt: new Date(0).toISOString(), entry: { id, skipped: reason } });
      token.value = (token.value as number) + 1;
      return id;
    },
    append: async (record) => {
      calls.append += 1;
      await hooks.append?.(record);
      write(record.origin, record.event, record.createdAt);
    },
    latestId: async () => {
      calls.latestId += 1;
      await hooks.latestId?.();
      return counter.last;
    },
    readAfter: async (afterId, excludeOrigin, limit) => {
      calls.readAfter.push({ afterId, excludeOrigin, limit });
      await hooks.readAfter?.();
      return rows
        .filter((row) => row.id > afterId && row.origin !== excludeOrigin)
        .slice(0, limit)
        .map((row) => row.entry);
    },
    pruneBefore: async (isoInstant) => {
      calls.pruneBefore.push(isoInstant);
      const kept = rows.filter((row) => row.createdAt >= isoInstant);
      rows.splice(0, rows.length, ...kept);
    },
  };
  if (withToken) {
    store.changeToken = async () => {
      calls.changeToken += 1;
      return token.value;
    };
  }
  return store;
};

export const deferred = <T = void>() => {
  const handle = {} as { resolve: (value: T) => void; reject: (cause: unknown) => void };
  const promise = new Promise<T>((resolve, reject) => Object.assign(handle, { resolve, reject }));
  return { promise, ...handle };
};
