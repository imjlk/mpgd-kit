import { describe, expect, it, vi } from 'vitest';

import {
  createInitialTutorialProgress,
  createTutorialDirector,
  defineTutorial,
} from '../src/index.js';
import { createMemoryTutorialProgressStore, installTutorialDebugBridge } from '../src/testing.js';

const tutorial = defineTutorial({
  id: 'testing.tutorial',
  initialScene: 'lobby',
  revision: 1,
  steps: [
    {
      advance: { kind: 'acknowledge' },
      id: 'welcome',
      interaction: 'blocked',
      scene: 'lobby',
      target: 'welcome',
    },
  ],
} as const);

describe('tutorial testing helpers', () => {
  it('does not record or apply saves when the memory store is unavailable', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const store = createMemoryTutorialProgressStore({
      available: false,
      definition: tutorial,
      initial,
      rejectSave: true,
    });
    const next = {
      ...initial,
      completedStepIds: ['welcome'],
      updatedAt: '2026-08-12T00:01:00.000Z',
    } as const;

    await expect(store.save(next)).resolves.toBeUndefined();

    expect(store.available).toBe(false);
    expect(store.getSnapshot()).toEqual(initial);
    expect(store.saves).toEqual([]);
  });

  it('does not restore a destroyed predecessor after same-key bridges are removed out of order', () => {
    const globalObject = {} as typeof globalThis;
    const record = globalObject as unknown as Record<string, unknown>;
    const globalKey = '__TEST_TUTORIAL__';
    const first = installTutorialDebugBridge({
      director: createTutorialDirector({
        autoStart: true,
        definition: tutorial,
        progressStore: createMemoryTutorialProgressStore({ definition: tutorial, initial: null }),
      }),
      globalKey,
      globalObject,
    });
    const second = installTutorialDebugBridge({
      director: createTutorialDirector({
        autoStart: true,
        definition: tutorial,
        progressStore: createMemoryTutorialProgressStore({ definition: tutorial, initial: null }),
      }),
      globalKey,
      globalObject,
    });

    first.destroy();
    expect(record[globalKey]).toBe(second.bridge);

    second.destroy();
    expect(globalKey in record).toBe(false);
    expect(record[globalKey]).not.toBe(first.bridge);
  });

  it('restores an own undefined debug key after stacked bridges are removed out of order', () => {
    const globalObject = {} as typeof globalThis;
    const record = globalObject as unknown as Record<string, unknown>;
    const globalKey = '__TEST_UNDEFINED_TUTORIAL__';
    record[globalKey] = undefined;
    const first = installTutorialDebugBridge({
      director: createTutorialDirector({
        autoStart: true,
        definition: tutorial,
        progressStore: createMemoryTutorialProgressStore({ definition: tutorial, initial: null }),
      }),
      globalKey,
      globalObject,
    });
    const second = installTutorialDebugBridge({
      director: createTutorialDirector({
        autoStart: true,
        definition: tutorial,
        progressStore: createMemoryTutorialProgressStore({ definition: tutorial, initial: null }),
      }),
      globalKey,
      globalObject,
    });

    first.destroy();
    second.destroy();

    expect(Object.hasOwn(record, globalKey)).toBe(true);
    expect(record[globalKey]).toBeUndefined();
  });

  it('runs the debug replay completion hook only after replay succeeds', async () => {
    const events: string[] = [];
    const afterReplay = vi.fn(() => {
      events.push('after');
    });
    const bridge = installTutorialDebugBridge({
      afterReplay,
      beforeReplay: () => {
        events.push('before');
      },
      director: {
        replay: async () => {
          events.push('replay');
        },
      } as never,
      globalKey: '__TEST_REPLAY__',
      globalObject: {} as typeof globalThis,
    });

    await bridge.bridge.replay();

    expect(events).toEqual(['before', 'replay', 'after']);
    expect(afterReplay).toHaveBeenCalledOnce();
    bridge.destroy();
  });
});
