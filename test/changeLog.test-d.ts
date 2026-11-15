import { describe, expectTypeOf, it } from 'vitest';
import type { ChangeBus } from '../src/changeBus.js';
import {
  planRelayBatch,
  type ChangeLogEntry,
  type ChangeLogRecord,
  type ChangeLogStore,
  type NewChangeLogRecord,
} from '../src/changeLog.js';
import { startChangeRelay, type ChangeRelay, type ChangeRelayOptions } from '../src/changeRelay.js';
import { createRelayedChangeBus, type RelayedChangeBus } from '../src/relayedChangeBus.js';

type Event = { at: number };

describe('ChangeLogStore types', () => {
  it('carries the event type through the port', () => {
    expectTypeOf<ChangeLogStore<Event>['append']>().toEqualTypeOf<(record: NewChangeLogRecord<Event>) => Promise<void>>();
    expectTypeOf<ChangeLogStore<Event>['readAfter']>().returns.resolves.toEqualTypeOf<readonly ChangeLogEntry<Event>[]>();
    expectTypeOf<NewChangeLogRecord<Event>['event']>().toEqualTypeOf<Event>();
    expectTypeOf<ChangeLogRecord<Event>['event']>().toEqualTypeOf<Event>();
  });

  it('keeps changeToken optional', () => {
    expectTypeOf<ChangeLogStore<Event>['changeToken']>().toEqualTypeOf<(() => Promise<unknown>) | undefined>();
  });
});

describe('createRelayedChangeBus types', () => {
  it('infers E from the store and exposes a ChangeBus<E>', () => {
    const store = {} as ChangeLogStore<Event>;
    const relayed = createRelayedChangeBus({ store, origin: 'a' });

    expectTypeOf(relayed).toEqualTypeOf<RelayedChangeBus<Event>>();
    expectTypeOf(relayed.bus).toEqualTypeOf<ChangeBus<Event>>();
    expectTypeOf(relayed.publishLocal).toEqualTypeOf<(event: Event) => void>();
    expectTypeOf(relayed.settled).toEqualTypeOf<() => Promise<void>>();
  });

  it('types shouldAppend by the event', () => {
    const store = {} as ChangeLogStore<Event>;
    createRelayedChangeBus({ store, origin: 'a', shouldAppend: (event) => event.at > 0 });
    // @ts-expect-error the predicate receives an Event, not a string
    createRelayedChangeBus({ store, origin: 'a', shouldAppend: (event: string) => event.length > 0 });
  });
});

describe('startChangeRelay types', () => {
  it('ties publishLocal to the store event', () => {
    expectTypeOf<ChangeRelayOptions<Event>['publishLocal']>().toEqualTypeOf<(event: Event) => void>();
    expectTypeOf(startChangeRelay<Event>).returns.resolves.toEqualTypeOf<ChangeRelay>();
    expectTypeOf<ChangeRelay['stop']>().toEqualTypeOf<() => Promise<void>>();
  });
});

describe('planRelayBatch types', () => {
  it('returns events of the entry event type', () => {
    const plan = planRelayBatch(0, [] as readonly ChangeLogEntry<Event>[]);

    expectTypeOf(plan.events).toEqualTypeOf<readonly Event[]>();
    expectTypeOf(plan.lastId).toEqualTypeOf<number>();
  });
});
