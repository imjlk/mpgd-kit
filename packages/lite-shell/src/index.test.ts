import { describe, expect, it } from 'vitest';

import { collectGlyphs, createFrameLoop, TapRecognizer } from './index.js';

describe('TapRecognizer', () => {
  it('accepts a short still press', () => {
    const tap = new TapRecognizer();
    tap.down(1, { x: 0, y: 0, time: 0 });
    tap.move(1, { x: 4, y: 3, time: 50 });
    expect(tap.up(1, { x: 4, y: 3, time: 120 })).toBe(true);
  });

  it('rejects a scroll gesture that moves beyond 10px even if it returns', () => {
    const tap = new TapRecognizer();
    tap.down(1, { x: 0, y: 0, time: 0 });
    tap.move(1, { x: 0, y: 40, time: 80 });
    expect(tap.up(1, { x: 0, y: 2, time: 160 })).toBe(false);
  });

  it('rejects a long press beyond 600ms', () => {
    const tap = new TapRecognizer();
    tap.down(1, { x: 0, y: 0, time: 0 });
    expect(tap.up(1, { x: 0, y: 0, time: 601 })).toBe(false);
  });

  it('ignores cancelled and unknown pointers', () => {
    const tap = new TapRecognizer();
    tap.down(1, { x: 0, y: 0, time: 0 });
    tap.cancel(1);
    expect(tap.up(1, { x: 0, y: 0, time: 10 })).toBe(false);
    expect(tap.up(2, { x: 0, y: 0, time: 10 })).toBe(false);
  });
});

describe('createFrameLoop', () => {
  it.each(['wake', 'dispose'] as const)('does not duplicate frames when tick calls %s', (action) => {
    const queue = new Map<number, (time: number) => void>();
    let sequence = 0;
    const loop = createFrameLoop({
      tick: () => {
        loop[action]();
        return true;
      },
      scheduler: {
        request(callback) {
          const handle = ++sequence;
          queue.set(handle, callback);
          return handle;
        },
        cancel: (handle) => { queue.delete(handle); },
      },
    });
    loop.wake();
    const callback = queue.get(1);
    queue.delete(1);
    callback?.(16);
    expect(queue.size).toBe(action === 'wake' ? 1 : 0);
    loop.dispose();
    expect(queue.size).toBe(0);
  });
  it('sleeps when tick reports idle and wakes on demand', () => {
    const queue: ((time: number) => void)[] = [];
    let remaining = 2;
    const loop = createFrameLoop({
      tick: () => --remaining > 0,
      scheduler: {
        request: (callback) => queue.push(callback),
        cancel: () => undefined,
      },
    });
    loop.wake();
    loop.wake();
    expect(queue.length).toBe(1);
    queue.shift()?.(16);
    expect(loop.running).toBe(true);
    queue.shift()?.(32);
    expect(loop.running).toBe(false);
    expect(queue.length).toBe(0);
  });
});

describe('collectGlyphs', () => {
  it('returns unique sorted code points', () => {
    expect(collectGlyphs('넵넵넴', '넵!')).toBe('!넴넵');
  });
});
