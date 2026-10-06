const ignoreFailure = (): void => {};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === 'function';

/**
 * Runs `work` so it can never fail its caller: a sync throw or async rejection goes to `onFailure`, and a
 * failing `onFailure` is dropped. Promises are observed, not awaited, so delivery never delays the caller.
 */
export const runIsolated = (work: () => unknown, onFailure: (cause: unknown) => unknown = ignoreFailure): void => {
  const report = (cause: unknown): void => {
    try {
      const reported = onFailure(cause);
      if (isThenable(reported)) reported.then(undefined, ignoreFailure);
    } catch {
      // Nowhere left to report to.
    }
  };
  try {
    const result = work();
    if (isThenable(result)) result.then(undefined, report);
  } catch (cause) {
    report(cause);
  }
};
