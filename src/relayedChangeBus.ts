import { createChangeBus, type ChangeBus } from './changeBus.js';
import type { ChangeLogStore } from './changeLog.js';
import { runIsolated } from './isolate.js';

export type RelayedChangeBusOptions<E> = {
  store: ChangeLogStore<E>;
  /** This process's id, written on every record so relays can tell whose it is. */
  origin: string;
  clock?: () => Date;
  /** Receives a failing listener and a failed append; a throwing reporter is dropped. */
  onError?: (cause: unknown) => void;
  /** Skips events not worth recording; they are still delivered locally. */
  shouldAppend?: (event: E) => boolean;
};

export type RelayedChangeBus<E> = {
  /** `publish` tells local subscribers first, then queues an append that it never awaits. */
  bus: ChangeBus<E>;
  /** Local delivery only: what a relay publishes on, so a relayed event is never recorded again. */
  publishLocal: (event: E) => void;
  /** Resolves once every append requested so far has finished or failed. */
  settled: () => Promise<void>;
};

const alwaysAppend = (): boolean => true;

export const createRelayedChangeBus = <E>({
  store,
  origin,
  clock = () => new Date(),
  onError,
  shouldAppend = alwaysAppend,
}: RelayedChangeBusOptions<E>): RelayedChangeBus<E> => {
  const local = createChangeBus<E>({ onError });
  const queue = { tail: Promise.resolve() };

  const appendLater = (event: E): void => {
    queue.tail = queue.tail
      .then(() => (shouldAppend(event) ? store.append({ event, origin, createdAt: clock().toISOString() }) : undefined))
      // The tail must never reject, or one failure would stop every later append.
      .catch((cause: unknown) => runIsolated(() => onError?.(cause)));
  };

  return {
    bus: {
      publish: (event) => {
        local.publish(event);
        appendLater(event);
      },
      subscribe: local.subscribe,
    },
    publishLocal: local.publish,
    settled: () => queue.tail,
  };
};
