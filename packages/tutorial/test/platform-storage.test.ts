import { describe, expect, it } from 'vitest';

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
});
