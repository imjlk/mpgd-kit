import { describe, expect, it, vi } from 'vitest';

import { createGameUiBridge } from './index.js';

function createBridge() {
  return createGameUiBridge<{ count: number; label: string }, string, string>({
    initialSnapshot: { count: 0, label: 'initial' },
  });
}

describe('headless scoped UI bridge', () => {
  it('keeps caller snapshots by reference without freezing or cloning consumer objects', () => {
    const initial = { nested: { count: 0 } };
    const bridge = createGameUiBridge({ initialSnapshot: initial });
    const listener = vi.fn();
    bridge.subscribeSnapshot(listener);
    expect(bridge.getSnapshot()).toBe(initial);
    expect(Object.isFrozen(initial)).toBe(false);
    expect(Object.isFrozen(initial.nested)).toBe(false);
    bridge.setSnapshot(initial);
    expect(listener).not.toHaveBeenCalled();
    const next = { nested: { count: 1 } };
    bridge.setSnapshot(next);
    expect(bridge.getSnapshot()).toBe(next);
    expect(listener).toHaveBeenCalledExactlyOnceWith(next);
    expect(Object.isFrozen(bridge)).toBe(true);
  });

  it('selects only changed fields and honors custom equality', () => {
    const bridge = createBridge();
    const count = vi.fn();
    const labelLength = vi.fn();
    bridge.subscribeSelector((state) => state.count, count);
    bridge.subscribeSelector(
      (state) => ({ length: state.label.length }),
      labelLength,
      (left, right) => left.length === right.length,
    );
    bridge.setSnapshot({ count: 0, label: 'another' });
    expect(count).not.toHaveBeenCalled();
    expect(labelLength).not.toHaveBeenCalled();
    bridge.setSnapshot({ count: 1, label: 'next' });
    expect(count).toHaveBeenCalledExactlyOnceWith(1);
    expect(labelLength).toHaveBeenCalledExactlyOnceWith({ length: 4 });
  });

  it('delivers commands and events in registration order without replay', () => {
    const bridge = createBridge();
    const seen: string[] = [];
    bridge.emit('old');
    bridge.onCommand((command) => {
      seen.push(`a:${command}`);
      bridge.emit('event');
    });
    bridge.onCommand((command) => {
      seen.push(`b:${command}`);
    });
    bridge.onEvent((event) => {
      seen.push(event);
    });
    bridge.dispatch('intent');
    expect(seen).toEqual(['a:intent', 'b:intent', 'event']);
  });

  it('captures each snapshot round and queues reentrant changes', () => {
    const bridge = createBridge();
    const seen: number[] = [];
    bridge.subscribeSnapshot((snapshot) => {
      if (snapshot.count === 1) {
        bridge.setSnapshot({ count: 2, label: 'nested' });
      }
    });
    bridge.subscribeSnapshot((snapshot) => {
      seen.push(snapshot.count);
    });
    bridge.setSnapshot({ count: 1, label: 'first' });
    expect(seen).toEqual([1, 2]);
  });

  it('skips unsubscribed listeners and defers new registrations to future dispatches', () => {
    const bridge = createBridge();
    const seen: string[] = [];
    let unsubscribe = () => {};
    bridge.onCommand(() => {
      unsubscribe();
      bridge.onCommand(() => {
        seen.push('new');
      });
    });
    unsubscribe = bridge.onCommand(() => {
      seen.push('removed');
    });
    bridge.dispatch('one');
    expect(seen).toEqual([]);
    bridge.dispatch('two');
    expect(seen).toEqual(['new']);
    unsubscribe();
  });

  it('isolates thrown listeners, rejected promises, selectors and error-hook failures', async () => {
    const errors: unknown[] = [];
    const bridge = createGameUiBridge<number, string, string>({
      initialSnapshot: 0,
      onListenerError: (error) => {
        errors.push(error);
        throw new Error('error hook');
      },
    });
    const seen = vi.fn();
    bridge.onEvent(() => {
      throw new Error('sync');
    });
    bridge.onEvent(() => Promise.reject(new Error('async')));
    bridge.onEvent(seen);
    bridge.subscribeSelector((value) => {
      if (value === 1) {
        throw new Error('selector');
      }
      return value;
    }, seen);
    bridge.emit('observed');
    bridge.setSnapshot(1);
    bridge.setSnapshot(2);
    await Promise.resolve();
    expect(errors).toHaveLength(3);
    expect(seen.mock.calls).toEqual([['observed'], [2]]);
  });

  it('rejects initial selector errors without installing a broken subscription', () => {
    const bridge = createBridge();
    const selector = vi.fn(() => {
      throw new Error('initial');
    });
    expect(() => bridge.subscribeSelector(selector, () => {})).toThrow('initial');
    bridge.setSnapshot({ count: 1, label: 'next' });
    expect(selector).toHaveBeenCalledTimes(1);
  });

  it('prevents a late screen A response from overwriting screen B or sending its events', async () => {
    const bridge = createBridge();
    const a = bridge.createScope();
    let complete = (_value: number) => {};
    const request = new Promise<number>((resolve) => {
      complete = resolve;
    });
    const commits = request.then((count) => [
      a.setSnapshot({ count, label: 'old screen' }),
      a.emit('old completion'),
    ]);
    a.dispose();
    const b = bridge.createScope();
    const seen = vi.fn();
    b.onEvent(seen);
    b.setSnapshot({ count: 7, label: 'screen B' });
    complete(99);
    expect(await commits).toEqual([false, false]);
    expect(bridge.getSnapshot()).toEqual({ count: 7, label: 'screen B' });
    expect(seen).not.toHaveBeenCalled();
    expect(b.isDisposed()).toBe(false);
  });

  it('revokes callbacks before cleanup can dispatch reentrantly', () => {
    const bridge = createBridge();
    const scope = bridge.createScope();
    const stale = vi.fn();
    const other = vi.fn();
    scope.own(() => bridge.emit('cleanup'));
    scope.onEvent(stale);
    scope.subscribeSnapshot(stale);
    bridge.onEvent(other);
    scope.dispose();
    expect(stale).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledExactlyOnceWith('cleanup');
  });

  it('cleans up each resource once, including resources arriving after disposal', async () => {
    const errors = vi.fn();
    const bridge = createGameUiBridge({ initialSnapshot: 0, onListenerError: errors });
    const scope = bridge.createScope();
    const released = vi.fn();
    const early = scope.own(released);
    early();
    early();
    scope.own(() => Promise.reject(new Error('cleanup failure')));
    const last = vi.fn();
    scope.own(last);
    scope.dispose();
    scope.dispose();
    const late = vi.fn();
    scope.own(late)();
    await Promise.resolve();
    expect(released).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('does not accumulate listeners across repeated screen creation and disposal', () => {
    const bridge = createBridge();
    const stale = vi.fn();
    for (let index = 0; index < 100; index += 1) {
      const scope = bridge.createScope();
      scope.subscribeSnapshot(stale);
      scope.subscribeSelector((state) => state.count, stale);
      scope.onEvent(stale);
      scope.onCommand(stale);
      scope.dispose();
    }
    bridge.setSnapshot({ count: 1, label: 'new' });
    bridge.emit('new');
    bridge.dispatch('new');
    expect(stale).not.toHaveBeenCalled();
  });

  it('destroys all scopes and rejects new work while late scope commits stay quiet', () => {
    const bridge = createBridge();
    const scope = bridge.createScope();
    const cleanup = vi.fn();
    scope.own(cleanup);
    bridge.destroy();
    bridge.destroy();
    scope.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scope.isDisposed()).toBe(true);
    expect(scope.setSnapshot({ count: 1, label: 'late' })).toBe(false);
    expect(scope.emit('late')).toBe(false);
    expect(scope.dispatch('late')).toBe(false);
    for (const action of [
      () => bridge.setSnapshot(bridge.getSnapshot()),
      () => bridge.emit('new'),
      () => bridge.dispatch('new'),
      () => bridge.subscribeSnapshot(() => {}),
      () => bridge.subscribeSelector((state) => state, () => {}),
      () => bridge.onEvent(() => {}),
      () => bridge.onCommand(() => {}),
      () => bridge.createScope(),
      () => scope.onEvent(() => {}),
    ]) {
      expect(action).toThrow('destroyed');
    }
  });

  it('suppresses pending deliveries after reentrant destruction', () => {
    const bridge = createBridge();
    const stale = vi.fn();
    bridge.onEvent(() => {
      bridge.dispatch('queued');
      bridge.destroy();
    });
    bridge.onEvent(stale);
    bridge.onCommand(stale);
    bridge.emit('destroy');
    expect(stale).not.toHaveBeenCalled();
  });
});
