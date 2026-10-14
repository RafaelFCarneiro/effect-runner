import { describe, expect, it, vi } from 'vitest';
import { createChangeBus } from '../src/changeBus.js';
import type { PublishChange } from '../src/engine.js';

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createChangeBus', () => {
  it('delivers the same entity tags to every subscriber', () => {
    const bus = createChangeBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe(first);
    bus.subscribe(second);

    bus.publish(['thing', 'other']);

    expect(first).toHaveBeenCalledWith(['thing', 'other']);
    expect(second).toHaveBeenCalledWith(['thing', 'other']);
  });

  it('stops delivering to a listener once it unsubscribes', () => {
    const bus = createChangeBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);

    unsubscribe();
    bus.publish(['thing']);

    expect(listener).not.toHaveBeenCalled();
  });

  it('reports a throwing listener to onError while the remaining listeners still receive the event', () => {
    const cause = new Error('listener failed');
    const onError = vi.fn();
    const bus = createChangeBus({ onError });
    const after = vi.fn();
    bus.subscribe(() => {
      throw cause;
    });
    bus.subscribe(after);

    bus.publish(['thing']);

    expect(onError).toHaveBeenCalledWith(cause);
    expect(after).toHaveBeenCalledWith(['thing']);
  });

  it('keeps notifying remaining listeners when onError itself throws', () => {
    const bus = createChangeBus({
      onError: () => {
        throw new Error('reporter failed');
      },
    });
    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error('listener failed');
    });
    bus.subscribe(after);

    expect(() => bus.publish(['thing'])).not.toThrow();
    expect(after).toHaveBeenCalledWith(['thing']);
  });

  it('never throws from publish, even without an onError handler', () => {
    const bus = createChangeBus();
    bus.subscribe(() => {
      throw new Error('listener failed');
    });

    expect(() => bus.publish(['thing'])).not.toThrow();
  });

  it('keeps an unsubscribe during publish from affecting the in-flight round', () => {
    const bus = createChangeBus();
    const late = vi.fn();
    let unsubscribeLate = (): void => {};
    bus.subscribe(() => unsubscribeLate());
    unsubscribeLate = bus.subscribe(late);

    bus.publish(['thing']);
    expect(late).toHaveBeenCalledTimes(1);

    bus.publish(['thing']);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('keeps a subscribe during publish from affecting the in-flight round', () => {
    const bus = createChangeBus();
    const added = vi.fn();
    bus.subscribe(() => {
      bus.subscribe(added);
    });

    bus.publish(['thing']);
    expect(added).not.toHaveBeenCalled();

    bus.publish(['thing']);
    expect(added).toHaveBeenCalledTimes(1);
  });

  it('reports an async listener rejection to onError', async () => {
    const cause = new Error('async listener failed');
    const onError = vi.fn();
    const bus = createChangeBus({ onError });
    bus.subscribe(async () => {
      throw cause;
    });

    bus.publish(['thing']);
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledWith(cause);
  });

  it('consumes a rejection from an async onError', async () => {
    const bus = createChangeBus({
      onError: async () => {
        throw new Error('async reporter failed');
      },
    });
    bus.subscribe(() => {
      throw new Error('listener failed');
    });

    expect(() => bus.publish(['thing'])).not.toThrow();
    await flushMicrotasks();
  });
});

describe('createChangeBus with a custom event', () => {
  type CommitEvent = { entities: readonly string[]; at: number };
  const event: CommitEvent = { entities: ['thing'], at: 1 };

  it('delivers the custom event unchanged to every subscriber', () => {
    const bus = createChangeBus<CommitEvent>();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe(first);
    bus.subscribe(second);

    bus.publish(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });

  it('isolates a throwing listener and reports it to onError', () => {
    const cause = new Error('listener failed');
    const onError = vi.fn();
    const bus = createChangeBus<CommitEvent>({ onError });
    const after = vi.fn();
    bus.subscribe(() => {
      throw cause;
    });
    bus.subscribe(after);

    expect(() => bus.publish(event)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(cause);
    expect(after).toHaveBeenCalledWith(event);
  });

  it('stops delivering to a listener once it unsubscribes', () => {
    const bus = createChangeBus<CommitEvent>();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);

    unsubscribe();
    bus.publish(event);

    expect(listener).not.toHaveBeenCalled();
  });

  it('receives the custom event from a PublishChange adapter over entities', () => {
    const bus = createChangeBus<CommitEvent>();
    const listener = vi.fn();
    bus.subscribe(listener);
    const publish: PublishChange = (entities) => bus.publish({ entities, at: 1 });

    publish(['thing']);

    expect(listener).toHaveBeenCalledWith(event);
  });
});
