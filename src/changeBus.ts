import type { PublishChange } from './engine.js';

/** In-process pub/sub for committed-change notifications; `publish` plugs straight into `runEffects`. */
export type ChangeBus = {
  publish: PublishChange;
  /** Registers a listener; the returned function removes it. */
  subscribe: (listener: PublishChange) => () => void;
};

export type ChangeBusOptions = {
  /** Receives anything a listener throws; defaults to a no-op. */
  onError?: (cause: unknown) => void;
};

const ignoreError = (): void => {};

/** A plain `Set` keeps the package runtime-agnostic: no `node:events`, no listener cap, no dependencies. */
export const createChangeBus = ({ onError = ignoreError }: ChangeBusOptions = {}): ChangeBus => {
  const listeners = new Set<PublishChange>();

  const notify = (listener: PublishChange, entities: readonly string[]): void => {
    try {
      listener(entities);
    } catch (cause) {
      // A faulty reporter must not break isolation for the remaining listeners.
      try {
        onError(cause);
      } catch {
        // Nowhere left to report to.
      }
    }
  };

  return {
    // Snapshot so (un)subscribing from inside a listener never alters the in-flight round.
    publish: (entities) => [...listeners].forEach((listener) => notify(listener, entities)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
