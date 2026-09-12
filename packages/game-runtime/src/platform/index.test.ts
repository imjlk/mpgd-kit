import { describe, expect, it, vi } from 'vitest';

import { createGameExecutionController } from '../index.js';
import { bindGameLifecycle, type GameLifecycleSource } from './index.js';

function source() {
  const pauses = new Set<() => void>();
  const resumes = new Set<() => void>();
  return {
    onPause(callback: () => void) {
      pauses.add(callback);
      return () => {
        pauses.delete(callback); };
    },
    onResume(callback: () => void) {
      resumes.add(callback);
      return () => {
        resumes.delete(callback); };
    },
    pause: () => pauses.forEach((callback) => callback()),
    resume: () => resumes.forEach((callback) => callback()),
    count: () => pauses.size + resumes.size,
  };
}

describe('platform-neutral lifecycle binding', () => {
  it('uses explicitly selected channels without blocking other channels', () => {
    const controller = createGameExecutionController();
    const binding = bindGameLifecycle({
      controller, source: source(), initialState: 'inactive', reason: 'audio-only', channels: ['audio'],
    });
    expect(controller.getSnapshot().blocked).toEqual({
      simulation: false, 'gameplay-input': false, rendering: false, audio: true,
    });
    binding.dispose();
  });

  it.each([
    { reason: '' }, { channels: [] }, { channels: ['invalid'] },
    { initialState: 'invalid' }, { readState: 1 }, { readState: () => 'invalid' },
  ])('rejects malformed lifecycle options and releases partial registration', (invalid) => {
    const controller = createGameExecutionController();
    const lifecycle = source();
    expect(() => bindGameLifecycle({
      controller, source: lifecycle, initialState: 'active', ...invalid,
    } as unknown as Parameters<typeof bindGameLifecycle>[0])).toThrow();
    expect(lifecycle.count()).toBe(0);
    expect(controller.getSnapshot().blocks).toEqual([]);
  });

  it('deduplicates events and releases only its own block across multiple sources', () => {
    const controller = createGameExecutionController();
    const settings = controller.acquireBlock({ reason: 'settings', channels: ['simulation'] });
    const a = source();
    const b = source();
    const first = bindGameLifecycle({ controller, source: a, initialState: 'active' });
    const second = bindGameLifecycle({ controller, source: b, initialState: 'active' });
    a.pause();
    a.pause();
    b.pause();
    expect(controller.getSnapshot().blocks).toHaveLength(3);
    a.resume();
    a.resume();
    expect(controller.getSnapshot().blocks).toHaveLength(2);
    second.dispose();
    expect(controller.getSnapshot().blocks).toEqual([settings.info]);
    first.dispose();
    first.dispose();
    settings.release();
    expect(controller.getSnapshot().blocked.simulation).toBe(false);
    expect(a.count() + b.count()).toBe(0);
  });

  it.each(['inactive', 'unknown'] as const)('starts conservatively from %s', (initialState) => {
    const controller = createGameExecutionController();
    const lifecycle = source();
    const binding = bindGameLifecycle({ controller, source: lifecycle, initialState });
    expect(Object.values(controller.getSnapshot().blocked).every(Boolean)).toBe(true);
    lifecycle.resume();
    expect(controller.getSnapshot().blocked.simulation).toBe(false);
    binding.dispose();
  });

  it('does not silently treat absent initialization as active', () => {
    const controller = createGameExecutionController();
    const lifecycle = source();
    expect(() => bindGameLifecycle({
      controller, source: lifecycle,
    } as unknown as Parameters<typeof bindGameLifecycle>[0])).toThrow('explicit');
    expect(lifecycle.count()).toBe(0);
  });

  it('subscribes before reading current state and honors an event during that read', () => {
    const controller = createGameExecutionController();
    const lifecycle = source();
    const binding = bindGameLifecycle({
      controller,
      source: lifecycle,
      readState: () => {
        expect(lifecycle.count()).toBe(2);
        lifecycle.pause();
        return 'active';
      },
    });
    expect(controller.getSnapshot().blocked.simulation).toBe(true);
    lifecycle.resume();
    expect(controller.getSnapshot().blocked.simulation).toBe(false);
    binding.dispose();
  });

  it('honors an event delivered synchronously during subscription over explicit initial state', () => {
    const controller = createGameExecutionController();
    const lifecycle = source();
    const binding = bindGameLifecycle({
      controller,
      initialState: 'active',
      source: {
        ...lifecycle,
        onPause(callback) {
          callback();
          return lifecycle.onPause(callback);
        },
      },
    });
    expect(controller.getSnapshot().blocked.simulation).toBe(true);
    binding.dispose();
  });

  it('handles a source resume while block acquisition notifies listeners', () => {
    const controller = createGameExecutionController();
    const lifecycle = source();
    controller.subscribe((snapshot) => {
      if (snapshot.blocks.length > 0) {
        lifecycle.resume();
      }
    });
    const binding = bindGameLifecycle({ controller, source: lifecycle, initialState: 'inactive' });
    expect(controller.getSnapshot().blocks).toEqual([]);
    lifecycle.pause();
    expect(controller.getSnapshot().blocks).toEqual([]);
    binding.dispose();
  });

  it('removes partial subscriptions on setup failure even when cleanup throws', () => {
    const controller = createGameExecutionController();
    const onError = vi.fn();
    const lifecycle: GameLifecycleSource = {
      onPause: () => () => {
        throw new Error('cleanup'); },
      onResume: () => {
        throw new Error('setup'); },
    };
    expect(() => bindGameLifecycle({
      controller, source: lifecycle, initialState: 'active', onError,
    })).toThrow('setup');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().blocks).toEqual([]);
    controller.destroy();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('automatically removes source callbacks on controller destruction and ignores late delivery', () => {
    const controller = createGameExecutionController();
    const lifecycle = source();
    let latePause = () => {};
    const binding = bindGameLifecycle({
      controller,
      initialState: 'inactive',
      source: {
        ...lifecycle,
        onPause(callback) {
          latePause = callback;
          return lifecycle.onPause(callback);
        },
      },
    });
    controller.destroy();
    expect(lifecycle.count()).toBe(0);
    expect(() => latePause()).not.toThrow();
    binding.dispose();
    expect(controller.getSnapshot().status).toBe('destroyed');
  });
});
