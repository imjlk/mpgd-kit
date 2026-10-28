import { describe, expect, it, vi } from 'vitest';

import {
  createPurchasePresentationChannel,
  createPurchasePresentationRelay,
  createPurchasePresentationSequenceGuard,
  type PlatformPurchasePresentationEvent,
  type PurchasePresentationListener,
} from './index.js';

function fakeSource() {
  const listeners = new Set<PurchasePresentationListener>();
  return {
    listeners,
    source: {
      subscribe(listener: PurchasePresentationListener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(event: PlatformPurchasePresentationEvent) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

describe('purchase presentation channel', () => {
  it('numbers facts, keeps attempt and reason, and isolates a failing listener', () => {
    const errors: unknown[] = [];
    const channel = createPurchasePresentationChannel({
      onListenerError: (error) => errors.push(error),
    });
    channel.presentation.subscribe(() => {
      throw new Error('listener failed');
    });
    const seen: PlatformPurchasePresentationEvent[] = [];
    const unsubscribe = channel.presentation.subscribe((event) => seen.push(event));
    channel.publish({ idempotencyKey: 'a', state: 'open', attempt: 2 });
    channel.publish({ idempotencyKey: 'a', state: 'closed', reason: 'timeout' });
    unsubscribe();
    channel.publish({ idempotencyKey: 'b', state: 'open' });
    expect(seen).toEqual([
      { idempotencyKey: 'a', sequence: 1, state: 'open', attempt: 2 },
      { idempotencyKey: 'a', sequence: 2, state: 'closed', reason: 'timeout' },
    ]);
    expect(errors).toHaveLength(3);
  });
});

describe('purchase presentation channel reporter', () => {
  it('keeps delivering when the listener error reporter throws too', () => {
    const channel = createPurchasePresentationChannel({
      onListenerError: () => {
        throw new Error('reporter failed');
      },
    });
    channel.presentation.subscribe(() => {
      throw new Error('listener failed');
    });
    const seen: PlatformPurchasePresentationEvent['state'][] = [];
    channel.presentation.subscribe((event) => seen.push(event.state));
    expect(() => channel.publish({ idempotencyKey: 'a', state: 'closed' })).not.toThrow();
    expect(seen).toEqual(['closed']);
  });
});

describe('purchase presentation sequence guard', () => {
  it('drops a superseded fact per key and per attempt', () => {
    const fresh = createPurchasePresentationSequenceGuard();
    expect(fresh({ idempotencyKey: 'a', sequence: 5, state: 'open' })).toBe(true);
    expect(fresh({ idempotencyKey: 'a', sequence: 5, state: 'closed' })).toBe(false);
    expect(fresh({ idempotencyKey: 'b', sequence: 1, state: 'open' })).toBe(true);
    expect(fresh({ idempotencyKey: 'a', sequence: 6, state: 'closed' })).toBe(true);
    // A replay of an ended key's old fact during a same-key retry is still dropped.
    expect(fresh({ idempotencyKey: 'a', sequence: 6, state: 'not-started' })).toBe(false);
    expect(fresh({ idempotencyKey: 'a', sequence: 7, state: 'open' })).toBe(true);
    // A tagged source restarts per attempt.
    expect(fresh({ idempotencyKey: 'c', sequence: 2, state: 'closed', attempt: 1 })).toBe(true);
    expect(fresh({ idempotencyKey: 'c', sequence: 1, state: 'open', attempt: 2 })).toBe(true);
    expect(fresh({ idempotencyKey: 'c', sequence: 1.5, state: 'open', attempt: 2 })).toBe(false);
  });

  it('remembers only the most recent ended keys', () => {
    const fresh = createPurchasePresentationSequenceGuard({ retiredKeyLimit: 2 });
    for (const key of ['a', 'b', 'c']) {
      expect(fresh({ idempotencyKey: key, sequence: 10, state: 'not-started' })).toBe(true);
    }
    // `a` was pruned; `b` and `c` still reject their old sequence.
    expect(fresh({ idempotencyKey: 'a', sequence: 10, state: 'not-started' })).toBe(true);
    expect(fresh({ idempotencyKey: 'c', sequence: 10, state: 'not-started' })).toBe(false);
    // An open key is never pruned.
    const keep = createPurchasePresentationSequenceGuard({ retiredKeyLimit: 1 });
    expect(keep({ idempotencyKey: 'open', sequence: 3, state: 'open' })).toBe(true);
    for (const key of ['x', 'y', 'z']) {
      keep({ idempotencyKey: key, sequence: 1, state: 'closed' });
    }
    expect(keep({ idempotencyKey: 'open', sequence: 3, state: 'closed' })).toBe(false);
  });
});

describe('purchase presentation relay', () => {
  it('relays renumbered fresh facts and adds not-started for a call without a fact', async () => {
    const { source, listeners, emit } = fakeSource();
    const relay = createPurchasePresentationRelay(source);
    const log: string[] = [];
    const unsubscribe = relay.presentation.subscribe((event) => {
      log.push(`${event.idempotencyKey}:${String(event.sequence)}:${event.state}`);
    });
    const second = relay.presentation.subscribe(() => undefined);
    expect(listeners.size).toBe(1);

    await relay.track('refused', async () => {
      log.push('refused:run');
    });
    await relay.track('sold', async () => {
      emit({ idempotencyKey: 'sold', sequence: 40, state: 'open', attempt: 2 });
      emit({ idempotencyKey: 'sold', sequence: 40, state: 'not-started', attempt: 2 });
    });
    await expect(relay.track('thrown', async () => {
      throw new Error('refused');
    })).rejects.toThrow('refused');
    expect(log).toEqual([
      'refused:run',
      'refused:1:not-started',
      'sold:2:open',
      'thrown:3:not-started',
    ]);
    unsubscribe();
    expect(listeners.size).toBe(1);
    second();
    expect(listeners.size).toBe(0);
  });

  it('claims no not-started for a refused call of a key whose sheet is still up', async () => {
    const { source, emit } = fakeSource();
    const relay = createPurchasePresentationRelay(source);
    const log: string[] = [];
    relay.presentation.subscribe((event) => log.push(`${event.idempotencyKey}:${event.state}`));
    await relay.track('k', async () => {
      emit({ idempotencyKey: 'k', sequence: 1, state: 'unknown' });
    });
    // A same-key call the provider refuses without a fact.
    await relay.track('k', async () => undefined);
    emit({ idempotencyKey: 'k', sequence: 2, state: 'not-started' });
    // The key is free again: a refused call now ends not-started.
    await relay.track('k', async () => undefined);
    // A concurrent same-key call does not end the running one either.
    let finish: (() => void) | undefined;
    const running = relay.track('r', () => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    await relay.track('r', async () => undefined);
    finish?.();
    await running;
    expect(log).toEqual(['k:unknown', 'k:not-started', 'k:not-started', 'r:not-started']);
  });

  it('reports a throwing listener and keeps delivering', async () => {
    const onListenerError = vi.fn();
    const { source } = fakeSource();
    const relay = createPurchasePresentationRelay(source, { onListenerError });
    relay.presentation.subscribe(() => {
      throw new Error('boom');
    });
    const seen: PlatformPurchasePresentationEvent[] = [];
    relay.presentation.subscribe((event) => seen.push(event));
    await relay.track('k', async () => undefined);
    expect(seen.map((event) => event.state)).toEqual(['not-started']);
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });
});
