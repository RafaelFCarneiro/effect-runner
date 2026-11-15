import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startChangeRelay, type ChangeRelayOptions } from '../src/changeRelay.js';
import { createRelayedChangeBus } from '../src/relayedChangeBus.js';
import { createMemoryChangeLogStore, deferred, type MemoryChangeLogStore } from './memoryChangeLogStore.js';

type Event = { name: string };
const ORIGIN = 'process-a';
const OTHER = 'process-b';
const POLL_MS = 100;
const PRUNE_MS = 1_000;
const RETENTION_MS = 5_000;
const NOW = new Date('2026-01-01T01:00:00.000Z');

const start = (
  store: MemoryChangeLogStore<Event>,
  overrides: Partial<ChangeRelayOptions<Event>> = {},
) => {
  const published: Event[] = [];
  const onError = vi.fn();
  const relay = startChangeRelay<Event>({
    store,
    publishLocal: (event) => published.push(event),
    origin: ORIGIN,
    pollMs: POLL_MS,
    retentionMs: RETENTION_MS,
    pruneEveryMs: PRUNE_MS,
    batchLimit: 10,
    clock: () => NOW,
    onError,
    ...overrides,
  });
  return { relay, published, onError };
};

const tick = async (times = 1): Promise<void> => {
  await vi.advanceTimersByTimeAsync(POLL_MS * times);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startChangeRelay', () => {
  it('resolves only after the cursor is set, so a later write is seen', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const gate = deferred();
    store.hooks.latestId = () => gate.promise;
    const state = { resolved: false };
    const { relay, published } = start(store);
    void relay.then(() => {
      state.resolved = true;
    });

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(state.resolved).toBe(false);
    expect(store.calls.readAfter).toHaveLength(0);

    gate.resolve();
    await relay;
    store.write(OTHER, { name: 'after' });
    await tick();

    expect(published).toEqual([{ name: 'after' }]);
  });

  it('rejects, starting nothing, when the cursor cannot be read', async () => {
    const store = createMemoryChangeLogStore<Event>();
    store.latestId = () => Promise.reject(new Error('down'));
    const { relay } = start(store);

    await expect(relay).rejects.toThrow('down');
    await tick(3);
    expect(store.calls.readAfter).toHaveLength(0);
  });

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects batchLimit %s before touching the store', async (batchLimit) => {
    const store = createMemoryChangeLogStore<Event>();
    const { relay } = start(store, { batchLimit });

    await expect(relay).rejects.toThrow(RangeError);
    expect(store.calls.latestId).toBe(0);
  });

  it('does not replay records written before it started', async () => {
    const store = createMemoryChangeLogStore<Event>();
    store.write(OTHER, { name: 'old' });
    const { relay, published } = start(store);
    const { stop } = await relay;

    await tick(2);
    store.write(OTHER, { name: 'new' });
    await tick();

    expect(published).toEqual([{ name: 'new' }]);
    await stop();
  });

  it('excludes its own origin and never re-appends a relayed event', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const { bus, publishLocal, settled } = createRelayedChangeBus<Event>({ store, origin: ORIGIN });
    const heard: Event[] = [];
    bus.subscribe((event) => heard.push(event));
    const { relay } = start(store, { publishLocal });
    const { stop } = await relay;

    bus.publish({ name: 'mine' });
    await settled();
    store.write(OTHER, { name: 'theirs' });
    await tick(2);
    await settled();

    expect(heard).toEqual([{ name: 'mine' }, { name: 'theirs' }]);
    expect(store.rows.map((row) => row.origin)).toEqual([ORIGIN, OTHER]);
    expect(store.calls.readAfter.every((call) => call.excludeOrigin === ORIGIN)).toBe(true);
    await stop();
  });

  it('reports a skipped record, publishes the others, and does not read it again', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const { relay, published, onError } = start(store);
    const { stop } = await relay;

    store.write(OTHER, { name: 'one' });
    const skippedId = store.writeSkipped('bad json');
    store.write(OTHER, { name: 'two' });
    await tick();

    expect(published).toEqual([{ name: 'one' }, { name: 'two' }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain(`${skippedId}`);
    expect(String(onError.mock.calls[0]?.[0])).toContain('bad json');
    expect(store.calls.readAfter.at(-1)?.afterId).toBe(0);

    store.write(OTHER, { name: 'three' });
    await tick();
    expect(store.calls.readAfter.at(-1)?.afterId).toBe(3);
    expect(onError).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('keeps going when publishLocal throws', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const failure = new Error('subscriber');
    const heard: string[] = [];
    const { relay, onError } = start(store, {
      publishLocal: (event) => {
        heard.push(event.name);
        if (event.name === 'one') throw failure;
      },
    });
    const { stop } = await relay;

    store.write(OTHER, { name: 'one' });
    store.write(OTHER, { name: 'two' });
    await tick();

    expect(heard).toEqual(['one', 'two']);
    expect(onError).toHaveBeenCalledWith(failure);
    await stop();
  });

  it('drains a backlog across ticks, one batch per tick', async () => {
    const store = createMemoryChangeLogStore<Event>();
    store.token.value = 'constant';
    const { relay, published } = start(store, { batchLimit: 2 });
    const { stop } = await relay;
    [1, 2, 3, 4, 5].forEach((n) => store.write(OTHER, { name: `e${n}` }));
    store.token.value = 'constant';

    await tick();
    expect(published).toHaveLength(2);
    await tick();
    expect(published).toHaveLength(4);
    await tick();
    expect(published.map((event) => event.name)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);

    const reads = store.calls.readAfter.length;
    await tick(2);
    expect(store.calls.readAfter).toHaveLength(reads);
    await stop();
  });

  it('does not read while the token is unchanged, and reads when it changes', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const { relay, published } = start(store);
    const { stop } = await relay;

    await tick();
    expect(store.calls.readAfter).toHaveLength(1);
    await tick(3);
    expect(store.calls.readAfter).toHaveLength(1);

    store.write(OTHER, { name: 'x' });
    await tick();
    expect(store.calls.readAfter).toHaveLength(2);
    expect(published).toEqual([{ name: 'x' }]);
    await stop();
  });

  it('reads on every tick when the store offers no changeToken', async () => {
    const store = createMemoryChangeLogStore<Event>({ withToken: false });
    const { relay } = start(store);
    const { stop } = await relay;

    await tick(3);

    expect(store.calls.readAfter).toHaveLength(3);
    await stop();
  });

  it('does not start a tick while the previous one is still running', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const gate = deferred();
    store.hooks.readAfter = () => gate.promise;
    const { relay } = start(store);
    const { stop } = await relay;

    await tick(5);
    expect(store.calls.readAfter).toHaveLength(1);

    gate.resolve();
    store.hooks.readAfter = undefined;
    store.write(OTHER, { name: 'x' });
    await tick();
    expect(store.calls.readAfter).toHaveLength(2);
    await stop();
  });

  it('reports a failing tick and still runs the next one', async () => {
    const store = createMemoryChangeLogStore<Event>({ withToken: false });
    const failure = new Error('read failed');
    const state = { failed: false };
    store.hooks.readAfter = async () => {
      if (!state.failed) {
        state.failed = true;
        throw failure;
      }
    };
    const { relay, published, onError } = start(store);
    const { stop } = await relay;
    store.write(OTHER, { name: 'x' });

    await tick();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(published).toEqual([]);

    await tick();
    expect(published).toEqual([{ name: 'x' }]);
    await stop();
  });

  it('survives a throwing onError', async () => {
    const store = createMemoryChangeLogStore<Event>({ withToken: false });
    store.hooks.readAfter = () => Promise.reject(new Error('down'));
    const { relay } = start(store, {
      onError: () => {
        throw new Error('reporter');
      },
    });
    const { stop } = await relay;

    await tick(3);

    expect(store.calls.readAfter).toHaveLength(3);
    await stop();
  });

  it('prunes by retention every pruneEveryMs', async () => {
    const store = createMemoryChangeLogStore<Event>();
    store.write(OTHER, { name: 'old' }, '2026-01-01T00:00:00.000Z');
    store.write(OTHER, { name: 'fresh' }, '2026-01-01T00:59:59.000Z');
    const { relay } = start(store);
    const { stop } = await relay;

    await vi.advanceTimersByTimeAsync(PRUNE_MS - 1);
    expect(store.calls.pruneBefore).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(store.calls.pruneBefore).toEqual(['2026-01-01T00:59:55.000Z']);
    expect(store.rows.map((row) => row.entry)).toEqual([{ id: 2, origin: OTHER, event: { name: 'fresh' } }]);
    await stop();
  });

  it('reports a failing prune and prunes again', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const failure = new Error('prune failed');
    store.pruneBefore = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const { relay, onError } = start(store);
    const { stop } = await relay;

    await vi.advanceTimersByTimeAsync(PRUNE_MS * 2);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(store.pruneBefore).toHaveBeenCalledTimes(2);
    await stop();
  });

  it('reports a synchronously throwing prune and prunes again', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const failure = new Error('sync prune');
    store.pruneBefore = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValue(undefined);
    const { relay, onError } = start(store);
    const { stop } = await relay;

    await vi.advanceTimersByTimeAsync(PRUNE_MS * 2);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(store.pruneBefore).toHaveBeenCalledTimes(2);
    await stop();
  });

  it('stop waits for the tick in flight and stops the timers', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const gate = deferred();
    store.hooks.readAfter = () => gate.promise;
    const { relay } = start(store);
    const { stop } = await relay;
    await tick();
    const state = { stopped: false };

    const stopping = stop().then(() => {
      state.stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(state.stopped).toBe(true);

    const reads = store.calls.readAfter.length;
    await vi.advanceTimersByTimeAsync(PRUNE_MS * 2);
    expect(store.calls.readAfter).toHaveLength(reads);
    expect(store.calls.pruneBefore).toEqual([]);
  });

  it('works when timers have no unref, and unrefs them when they do', async () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValueOnce({ unref } as never)
      .mockReturnValueOnce(7 as never);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const { relay } = start(createMemoryChangeLogStore<Event>());

    const { stop } = await relay;
    await stop();

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });
});
