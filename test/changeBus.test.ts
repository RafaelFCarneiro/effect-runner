import { describe, expect, it, vi } from 'vitest';
import { createChangeBus } from '../src/changeBus.js';

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
});
