import { runIsolated } from './isolate.js';

/** In-process pub/sub for committed-change notifications; the default event is the entity tags `runEffects` publishes. */
export type ChangeBus<E = readonly string[]> = {
  publish: (event: E) => void;
  /** Registers a listener; the returned function removes it. */
  subscribe: (listener: (event: E) => void) => () => void;
};

export type ChangeBusOptions = {
  /** Receives anything a listener throws or rejects with (sync or async); defaults to a no-op. */
  onError?: (cause: unknown) => void;
};

/** A plain `Set` keeps the package runtime-agnostic: no `node:events`, no listener cap, no dependencies. */
export const createChangeBus = <E = readonly string[]>({ onError }: ChangeBusOptions = {}): ChangeBus<E> => {
  const listeners = new Set<(event: E) => void>();

  return {
    // Snapshot so (un)subscribing from inside a listener never alters the in-flight round.
    publish: (event) => [...listeners].forEach((listener) => runIsolated(() => listener(event), onError)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
