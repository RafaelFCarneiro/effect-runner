import { describe, expect, it, vi } from 'vitest';
import { createRelayedChangeBus } from '../src/relayedChangeBus.js';
import { createMemoryChangeLogStore, deferred } from './memoryChangeLogStore.js';

type Event = { name: string };
const ORIGIN = 'process-a';

describe('createRelayedChangeBus', () => {
  it('delivers locally first, then appends with origin and clock time', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const order: string[] = [];
    store.hooks.append = async () => {
      order.push('append');
    };
    const { bus, settled } = createRelayedChangeBus<Event>({
      store,
      origin: ORIGIN,
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    bus.subscribe(() => order.push('listener'));

    bus.publish({ name: 'x' });
    expect(store.calls.append).toBe(0);
    await settled();

    expect(order).toEqual(['listener', 'append']);
    expect(store.rows.map((row) => row.entry)).toEqual([{ id: 1, origin: ORIGIN, event: { name: 'x' } }]);
    expect(store.rows[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('appends in publish order even when an earlier append is slower', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const gate = deferred();
    store.hooks.append = (record) => (record.event.name === 'first' ? gate.promise : Promise.resolve());
    const { bus, settled } = createRelayedChangeBus<Event>({ store, origin: ORIGIN });

    bus.publish({ name: 'first' });
    bus.publish({ name: 'second' });
    gate.resolve();
    await settled();

    expect(store.rows.map((row) => (row.entry as { event: Event }).event.name)).toEqual(['first', 'second']);
  });

  it('never awaits an append in publish', () => {
    const store = createMemoryChangeLogStore<Event>();
    store.hooks.append = () => new Promise(() => undefined);
    const { bus } = createRelayedChangeBus<Event>({ store, origin: ORIGIN });
    const listener = vi.fn();
    bus.subscribe(listener);

    expect(() => bus.publish({ name: 'x' })).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports a failed append to onError without throwing from publish', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const failure = new Error('disk full');
    store.append = () => Promise.reject(failure);
    const onError = vi.fn();
    const { bus, settled } = createRelayedChangeBus<Event>({ store, origin: ORIGIN, onError });

    expect(() => bus.publish({ name: 'x' })).not.toThrow();
    await settled();

    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('reports a synchronously throwing append the same way', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const failure = new Error('sync');
    store.append = () => {
      throw failure;
    };
    const onError = vi.fn();
    const { bus, settled } = createRelayedChangeBus<Event>({ store, origin: ORIGIN, onError });

    bus.publish({ name: 'x' });
    await settled();

    expect(onError).toHaveBeenCalledWith(failure);
  });

  it.each([
    ['throws', () => { throw new Error('reporter'); }],
    ['rejects', () => Promise.reject(new Error('reporter'))],
  ])('keeps appending when onError %s', async (_label, onError) => {
    const store = createMemoryChangeLogStore<Event>();
    const realAppend = store.append;
    const calls = { n: 0 };
    store.append = (record) => (calls.n++ === 0 ? Promise.reject(new Error('first fails')) : realAppend(record));
    const { bus, settled } = createRelayedChangeBus<Event>({ store, origin: ORIGIN, onError });

    bus.publish({ name: 'lost' });
    bus.publish({ name: 'kept' });
    await settled();

    expect(store.rows.map((row) => (row.entry as { event: Event }).event.name)).toEqual(['kept']);
  });

  it('routes a throwing listener to onError and still appends', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const onError = vi.fn();
    const { bus, settled } = createRelayedChangeBus<Event>({ store, origin: ORIGIN, onError });
    const failure = new Error('listener');
    bus.subscribe(() => {
      throw failure;
    });

    bus.publish({ name: 'x' });
    await settled();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(store.rows).toHaveLength(1);
  });

  it('skips the append when shouldAppend declines, but still delivers locally', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const { bus, settled } = createRelayedChangeBus<Event>({
      store,
      origin: ORIGIN,
      shouldAppend: (event) => event.name !== 'quiet',
    });
    const listener = vi.fn();
    bus.subscribe(listener);

    bus.publish({ name: 'quiet' });
    bus.publish({ name: 'loud' });
    await settled();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(1);
  });

  it('publishLocal delivers locally and never appends', async () => {
    const store = createMemoryChangeLogStore<Event>();
    const { bus, publishLocal, settled } = createRelayedChangeBus<Event>({ store, origin: ORIGIN });
    const listener = vi.fn();
    bus.subscribe(listener);

    publishLocal({ name: 'relayed' });
    await settled();

    expect(listener).toHaveBeenCalledWith({ name: 'relayed' });
    expect(store.calls.append).toBe(0);
  });

  it('settled resolves immediately when nothing was published', async () => {
    const { settled } = createRelayedChangeBus<Event>({ store: createMemoryChangeLogStore<Event>(), origin: ORIGIN });

    await expect(settled()).resolves.toBeUndefined();
  });
});
