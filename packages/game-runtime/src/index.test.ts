import { describe, expect, it, vi } from 'vitest';

import {
  createGameExecutionController,
  type ExecutionBlockInput,
  type ExecutionChannel,
} from './index.js';

const settings: ExecutionBlockInput = {
  reason: 'settings',
  channels: ['simulation', 'gameplay-input'],
};

describe('game execution controller', () => {
  it('retains same-reason and background blocks released out of acquisition order', () => {
    const runtime = createGameExecutionController();
    const first = runtime.acquireBlock(settings);
    const second = runtime.acquireBlock(settings);
    const background = runtime.acquireBlock({ ...settings, reason: 'background' });
    expect(first.info.id).not.toBe(second.info.id);
    second.release();
    background.release();
    expect(runtime.getSnapshot().blocked.simulation).toBe(true);
    expect(runtime.getSnapshot().blocks).toEqual([first.info]);
    first.release();
    expect(runtime.getSnapshot().blocked.simulation).toBe(false);
  });

  it.each<ExecutionChannel>(['simulation', 'gameplay-input', 'rendering', 'audio'])(
    'aggregates %s independently',
    (channel) => {
      const runtime = createGameExecutionController();
      const token = runtime.acquireBlock({ reason: 'one', channels: [channel, channel] });
      expect(token.info.channels).toEqual([channel]);
      expect(Object.entries(runtime.getSnapshot().blocked).filter(([, value]) => value)).toEqual([
        [channel, true],
      ]);
      token.release();
      expect(Object.values(runtime.getSnapshot().blocked).every((value) => !value)).toBe(true);
    },
  );

  it('keeps stable references and versions for no-ops and changes for diagnostic-only updates', () => {
    const runtime = createGameExecutionController();
    const initial = runtime.getSnapshot();
    expect(runtime.getSnapshot()).toBe(initial);
    const first = runtime.acquireBlock(settings);
    const one = runtime.getSnapshot();
    const second = runtime.acquireBlock(settings);
    expect(runtime.getSnapshot().version).toBe(one.version + 1);
    expect(runtime.getSnapshot().blocked).toEqual(one.blocked);
    second.release();
    const released = runtime.getSnapshot();
    second.release();
    expect(runtime.getSnapshot()).toBe(released);
    first.release();
  });

  it.each([
    { reason: '', channels: ['simulation'] },
    { reason: '  ', channels: ['audio'] },
    { reason: 'bad', channels: [] },
    { reason: 'bad', channels: ['simulation', 'invalid'] },
    { reason: 'bad', channels: null },
    null,
  ])('rejects invalid input atomically: %j', (input) => {
    const runtime = createGameExecutionController();
    const before = runtime.getSnapshot();
    expect(() => runtime.acquireBlock(input as ExecutionBlockInput)).toThrow();
    expect(runtime.getSnapshot()).toBe(before);
    expect(runtime.acquireBlock(settings).info.id).toBe(1);
  });

  it('protects all owned snapshot containers and copies caller channel arrays', () => {
    const runtime = createGameExecutionController();
    const selected: ExecutionChannel[] = ['audio'];
    const block = runtime.acquireBlock({ reason: 'mute', channels: selected });
    selected.push('simulation');
    const snapshot = runtime.getSnapshot();
    for (const value of [snapshot, snapshot.blocked, snapshot.blocks, block, block.info, block.info.channels]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(snapshot.blocked.simulation).toBe(false);
    expect(() => Object.assign(snapshot.blocked, { audio: false })).toThrow();
  });

  it('isolates controllers and duplicate listener registrations', () => {
    const first = createGameExecutionController();
    const second = createGameExecutionController();
    const token = first.acquireBlock(settings);
    const other = second.acquireBlock(settings);
    token.release();
    expect(second.getSnapshot().blocks).toEqual([other.info]);
    const listener = vi.fn();
    const unsubscribe = first.subscribe(listener);
    first.subscribe(listener);
    unsubscribe();
    unsubscribe();
    first.acquireBlock(settings);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('queues reentrant changes with one snapshot per round and skips unsubscribed recipients', () => {
    const runtime = createGameExecutionController();
    const seen: string[] = [];
    let remove = () => {};
    runtime.subscribe((snapshot) => {
      seen.push(`a${snapshot.version}`);
      if (snapshot.version === 1) {
        remove();
        runtime.subscribe((next) => {
          seen.push(`c${next.version}`);
        });
        runtime.acquireBlock({ reason: 'nested', channels: ['audio'] });
      }
    });
    runtime.subscribe((snapshot) => {
      seen.push(`b${snapshot.version}`);
    });
    remove = runtime.subscribe(() => {
      seen.push('removed');
    });
    expect(seen).toEqual([]);
    runtime.acquireBlock(settings);
    expect(seen).toEqual(['a1', 'b1', 'a2', 'b2', 'c2']);
  });

  it('isolates synchronous and asynchronous observer failures without delaying release', async () => {
    const errors: unknown[] = [];
    const runtime = createGameExecutionController({
      onListenerError: (error) => {
        errors.push(error);
        return Promise.reject(new Error('error hook failed'));
      },
    });
    const seen = vi.fn();
    runtime.subscribe(() => {
      throw new Error('sync');
    });
    runtime.subscribe(() => Promise.reject(new Error('async')));
    runtime.subscribe(seen);
    const token = runtime.acquireBlock(settings);
    token.release();
    expect(runtime.getSnapshot().blocked.simulation).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(4);
  });

  it('makes destruction terminal and never emits an unblocked resume snapshot', () => {
    const runtime = createGameExecutionController({
      onListenerError: () => {
        throw new Error('hook');
      },
    });
    const token = runtime.acquireBlock(settings);
    const seen = vi.fn();
    runtime.subscribe(seen);
    runtime.subscribe(() => {
      throw new Error('listener');
    });
    runtime.destroy();
    const terminal = runtime.getSnapshot();
    runtime.destroy();
    token.release();
    expect(runtime.getSnapshot()).toBe(terminal);
    expect(terminal.status).toBe('destroyed');
    expect(Object.values(terminal.blocked).every(Boolean)).toBe(true);
    expect(terminal.blocks).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(() => runtime.acquireBlock(settings)).toThrow('destroyed');
    expect(() => runtime.subscribe(() => {})).toThrow('destroyed');
  });

  it('suppresses stale active deliveries when a listener destroys reentrantly', () => {
    const runtime = createGameExecutionController();
    const seen: string[] = [];
    runtime.subscribe((snapshot) => {
      if (snapshot.status === 'active') {
        runtime.acquireBlock({ reason: 'nested', channels: ['audio'] });
        runtime.destroy();
      }
    });
    runtime.subscribe((snapshot) => {
      seen.push(snapshot.status);
    });
    const token = runtime.acquireBlock(settings);
    token.release();
    expect(seen).toEqual(['destroyed']);
  });

  it('does not mutate after a caller getter destroys the controller', () => {
    const runtime = createGameExecutionController();
    expect(() => runtime.acquireBlock({
      get reason() {
        runtime.destroy();
        return 'late';
      },
      channels: ['simulation'],
    })).toThrow('destroyed');
    expect(runtime.getSnapshot().blocks).toEqual([]);
  });

  it('runs without DOM, engine, timers, or frame polling', () => {
    vi.useFakeTimers();
    try {
      expect(typeof globalThis).toBe('object');
      const runtime = createGameExecutionController();
      runtime.acquireBlock(settings).release();
      expect(vi.getTimerCount()).toBe(0);
      runtime.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
