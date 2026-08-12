import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInitialTutorialProgress, defineTutorial } from '../src/index.js';
import { createPlatformTutorialProgressStore } from '../src/platform-storage.js';

const tutorial = defineTutorial({
  id: 'storage.tutorial',
  initialScene: 'lobby',
  revision: 1,
  steps: [{
    advance: { kind: 'acknowledge' },
    id: 'welcome',
    interaction: 'blocked',
    scene: 'lobby',
    target: 'welcome',
  }],
} as const);

describe('platform tutorial progress store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads validated progress and serializes queued writes', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const saved: unknown[] = [];
    const store = await createPlatformTutorialProgressStore({
      definition: tutorial,
      key: 'tutorial',
      storage: {
        load: async () => ({ value: initial }),
        save: async ({ value }) => {
          saved.push(value);
        },
      },
    });

    expect(store.available).toBe(true);
    expect(store.getSnapshot()).toEqual(initial);
    const first = { ...initial, updatedAt: '2026-08-12T00:01:00.000Z' };
    const second = { ...initial, updatedAt: '2026-08-12T00:02:00.000Z' };
    await Promise.all([store.save(first), store.save(second)]);
    await store.flush();

    expect(saved).toEqual([first, second]);
    expect(store.getSnapshot()).toEqual(second);
  });

  it('fails closed for corrupt records unless ignore is explicit', async () => {
    const errors: unknown[] = [];
    const disabled = await createPlatformTutorialProgressStore({
      definition: tutorial,
      key: 'tutorial',
      onError: (error) => errors.push(error),
      storage: {
        load: async () => ({ value: { schemaVersion: 99 } }),
        save: async () => undefined,
      },
    });
    const ignored = await createPlatformTutorialProgressStore({
      definition: tutorial,
      invalidRecord: 'ignore',
      key: 'tutorial',
      storage: {
        load: async () => ({ value: { schemaVersion: 99 } }),
        save: async () => undefined,
      },
    });

    expect(disabled.available).toBe(false);
    expect(errors).toHaveLength(1);
    expect(ignored.available).toBe(true);
    expect(ignored.getSnapshot()).toBeNull();
  });

  it('stops queued writes after the storage adapter fails', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    let attempts = 0;
    const store = await createPlatformTutorialProgressStore({
      definition: tutorial,
      key: 'tutorial',
      storage: {
        load: async () => ({ value: initial }),
        save: async () => {
          attempts += 1;
          throw new Error('storage unavailable');
        },
      },
    });

    const first = { ...initial, updatedAt: '2026-08-12T00:01:00.000Z' };
    const second = { ...initial, updatedAt: '2026-08-12T00:02:00.000Z' };
    await Promise.allSettled([store.save(first), store.save(second)]);
    await store.flush();

    expect(attempts).toBe(1);
    expect(store.available).toBe(false);
    expect(store.getSnapshot()).toEqual(initial);
  });

  it('fails closed when the storage load times out', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let resolveLoad!: (value: { readonly value: unknown }) => void;
    const storePromise = createPlatformTutorialProgressStore({
      definition: tutorial,
      key: 'tutorial',
      onError: (error) => errors.push(error),
      storage: {
        load: () => new Promise((resolve) => {
          resolveLoad = resolve;
        }),
        save: async () => undefined,
      },
      loadTimeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    const store = await storePromise;

    expect(store.available).toBe(false);
    expect(store.getSnapshot()).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(expect.objectContaining({
      message: 'Tutorial storage load timed out after 25ms.',
    }));
    resolveLoad({ value: createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z') });
    await Promise.resolve();
    expect(store.available).toBe(false);
    expect(store.getSnapshot()).toBeNull();
    expect(errors).toHaveLength(1);
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it('keeps slow uncancellable saves serialized until they durably settle', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const attempts: unknown[] = [];
    const resolvers: (() => void)[] = [];
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const store = await createPlatformTutorialProgressStore({
      definition: tutorial,
      key: 'tutorial',
      onError: (error) => errors.push(error),
      storage: {
        load: async () => ({ value: initial }),
        save: ({ value }) => {
          attempts.push(value);
          return new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
        },
      },
      loadTimeoutMs: 25,
    });
    const first = { ...initial, updatedAt: '2026-08-12T00:01:00.000Z' };
    const second = { ...initial, updatedAt: '2026-08-12T00:02:00.000Z' };
    const firstSave = store.save(first);
    const secondSave = store.save(second);
    const flushing = store.flush();

    await vi.advanceTimersByTimeAsync(50);
    expect(attempts).toEqual([first]);
    expect(store.available).toBe(true);
    expect(store.getSnapshot()).toEqual(initial);
    expect(errors).toEqual([]);

    resolvers[0]?.();
    await vi.waitFor(() => expect(attempts).toEqual([first, second]));
    expect(store.getSnapshot()).toEqual(first);
    resolvers[1]?.();

    await expect(firstSave).resolves.toBeUndefined();
    await expect(secondSave).resolves.toBeUndefined();
    await expect(flushing).resolves.toBeUndefined();
    expect(store.available).toBe(true);
    expect(store.getSnapshot()).toEqual(second);
    expect(errors).toEqual([]);
  });
});
