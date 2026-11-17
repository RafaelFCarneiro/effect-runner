import { z } from 'zod';
import {
  planRelayBatch,
  pruneCutoff,
  shouldRead,
  type ChangeLogSkipped,
  type ChangeLogStore,
} from './changeLog.js';
import { runIsolated } from './isolate.js';
import { UNREAD_TOKEN } from './unreadToken.js';

export type ChangeRelayOptions<E> = {
  store: ChangeLogStore<E>;
  /** Publishes on this process's bus only, never the appending one, or records would echo between processes. */
  publishLocal: (event: E) => void;
  origin: string;
  pollMs: number;
  retentionMs: number;
  pruneEveryMs: number;
  batchLimit: number;
  clock?: () => Date;
  /** Receives a failing tick or prune and every record the store could not decode; a throwing reporter is dropped. */
  onError?: (cause: unknown) => void;
};

export type ChangeRelay = {
  /** Clears the timers and waits for the tick or prune in flight. */
  stop: () => Promise<void>;
};

type Cursor = { lastId: number; token: unknown };

const describeSkipped = ({ id, skipped }: ChangeLogSkipped): Error =>
  new Error(`change log record ${id} skipped: ${skipped}`);

// The largest delay `setInterval` honors; beyond it the timer fires almost at once.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
// Keeps `now - retention` a valid Date, so a prune can always build its cutoff.
const MAX_RETENTION_MS = 4e15;

// A record must outlive a few polls, or a slow tick could miss it before it is read.
const MIN_RETENTION_IN_POLLS = 2;

const RelayTimings = z
  .object({
    pollMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS),
    pruneEveryMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS),
    retentionMs: z.number().nonnegative().max(MAX_RETENTION_MS),
    batchLimit: z.number().int().positive(),
  })
  .refine(({ pollMs, retentionMs }) => retentionMs >= MIN_RETENTION_IN_POLLS * pollMs, {
    path: ['retentionMs'],
    message: `must be at least ${MIN_RETENTION_IN_POLLS} times pollMs`,
  });

const describeInvalid = ({ issues }: z.ZodError): string =>
  `invalid change relay options: ${issues.map(({ path, message }) => `${path.map(String).join('.')} ${message}`).join('; ')}`;

// Timers are unref'd only where the runtime has `unref`, so the package needs no Node-only import.
const unrefIfSupported = (timer: unknown): void => {
  const unref = (timer as { unref?: unknown } | null | undefined)?.unref;
  if (typeof unref === 'function') unref.call(timer);
};

/** Never overlaps itself and reports a failure instead of stopping; `idle` resolves when the run in flight ends. */
const repeating = (report: (cause: unknown) => void, work: () => Promise<void>) => {
  const state = { busy: false, running: Promise.resolve() };
  const run = (): void => {
    if (state.busy) return;
    state.busy = true;
    // Via a continuation so a synchronous throw is reported and resets `busy` like a rejection.
    state.running = Promise.resolve()
      .then(work)
      .catch(report)
      .finally(() => {
        state.busy = false;
      });
  };
  return { run, idle: () => state.running };
};

export const startChangeRelay = async <E>({
  store,
  publishLocal,
  origin,
  pollMs,
  retentionMs,
  pruneEveryMs,
  batchLimit,
  clock = () => new Date(),
  onError,
}: ChangeRelayOptions<E>): Promise<ChangeRelay> => {
  // A zero or fractional limit stalls delivery, a negative retention deletes fresh records, and an out-of-range
  // delay makes a timer fire at once: reject before the store or a timer is touched.
  const timings = RelayTimings.safeParse({ pollMs, pruneEveryMs, retentionMs, batchLimit });
  if (!timings.success) throw new RangeError(describeInvalid(timings.error));
  const report = (cause: unknown): void => runIsolated(() => onError?.(cause));
  const cursor: Cursor = { lastId: await store.latestId(), token: UNREAD_TOKEN };

  // The token moves only after the batch was handled, so a failed read is retried on the next tick.
  const relayOnce = async (): Promise<void> => {
    // Without a changeToken the token stays UNREAD_TOKEN, which `shouldRead` treats as "always read".
    const token = store.changeToken ? await store.changeToken() : UNREAD_TOKEN;
    if (!shouldRead(cursor.token, token)) return;
    const entries = await store.readAfter(cursor.lastId, origin, batchLimit);
    const plan = planRelayBatch(cursor.lastId, entries);
    plan.skipped.forEach((entry) => report(describeSkipped(entry)));
    plan.events.forEach((event) => runIsolated(() => publishLocal(event), report));
    cursor.lastId = plan.lastId;
    // A full batch may leave more behind: leave the token unrecorded so the next tick reads on.
    cursor.token = entries.length < batchLimit ? token : UNREAD_TOKEN;
  };

  const tick = repeating(report, relayOnce);
  const prune = repeating(report, () => store.pruneBefore(pruneCutoff(clock(), retentionMs)));
  const timers = [setInterval(tick.run, pollMs), setInterval(prune.run, pruneEveryMs)];
  timers.forEach(unrefIfSupported);

  return {
    stop: async () => {
      timers.forEach((timer) => clearInterval(timer));
      await Promise.all([tick.idle(), prune.idle()]);
    },
  };
};
