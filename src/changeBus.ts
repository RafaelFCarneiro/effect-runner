import type { PublishChange } from './engine.js';
import { runIsolated } from './isolate.js';

/** In-process pub/sub for committed-change notifications; `publish` plugs straight into `runEffects`. */
export type ChangeBus = {
  publish: PublishChange;
  /** Registers a listener; the returned function removes it. */
  subscribe: (listener: PublishChange) => () => void;
};

export type ChangeBusOptions = {
  /** Receives anything a listener throws or rejects with (sync or async); defaults to a no-op. */
  onError?: (cause: unknown) => void;
};

/** A plain `Set` keeps the package runtime-agnostic: no `node:events`, no listener cap, no dependencies. */
export const createChangeBus = ({ onError }: ChangeBusOptions = {}): ChangeBus => {
  const listeners = new Set<PublishChange>();

  return {
    // Snapshot so (un)subscribing from inside a listener never alters the in-flight round.
    publish: (entities) => [...listeners].forEach((listener) => runIsolated(() => listener(entities), onError)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
