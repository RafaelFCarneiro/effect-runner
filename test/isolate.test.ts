import { describe, expect, it, vi } from 'vitest';
import { runIsolated } from '../src/isolate.js';

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('runIsolated', () => {
  it('runs the work and reports nothing when it succeeds', () => {
    const work = vi.fn();
    const onFailure = vi.fn();

    runIsolated(work, onFailure);

    expect(work).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('routes a synchronous throw to onFailure without throwing', () => {
    const cause = new Error('sync failure');
    const onFailure = vi.fn();

    expect(() =>
      runIsolated(() => {
        throw cause;
      }, onFailure),
    ).not.toThrow();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(cause);
  });

  it('routes an async rejection to onFailure', async () => {
    const cause = new Error('async failure');
    const onFailure = vi.fn();

    runIsolated(async () => {
      throw cause;
    }, onFailure);
    await flushMicrotasks();

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(cause);
  });

  it('observes a rejecting thenable that is not a native Promise', async () => {
    const cause = new Error('thenable failure');
    const onFailure = vi.fn();
    const thenable = { then: (_resolve: unknown, reject: (c: unknown) => void) => reject(cause) };

    runIsolated(() => thenable, onFailure);
    await flushMicrotasks();

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(cause);
  });

  it('does not call onFailure when async work resolves', async () => {
    const onFailure = vi.fn();

    runIsolated(async () => 'ok', onFailure);
    await flushMicrotasks();

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('drops a failure silently when no onFailure is given', async () => {
    expect(() =>
      runIsolated(() => {
        throw new Error('sync failure');
      }),
    ).not.toThrow();
    runIsolated(async () => {
      throw new Error('async failure');
    });
    await flushMicrotasks();
  });

  it('swallows a synchronously throwing onFailure', () => {
    expect(() =>
      runIsolated(
        () => {
          throw new Error('work failed');
        },
        () => {
          throw new Error('reporter failed');
        },
      ),
    ).not.toThrow();
  });

  it('consumes a rejecting async onFailure', async () => {
    runIsolated(
      () => {
        throw new Error('work failed');
      },
      async () => {
        throw new Error('reporter failed');
      },
    );
    await flushMicrotasks();
  });

  it('does not wait for async work before returning', () => {
    let isSettled = false;

    runIsolated(() => new Promise<void>((resolve) => setTimeout(() => ((isSettled = true), resolve()), 5)));

    expect(isSettled).toBe(false);
  });
});
