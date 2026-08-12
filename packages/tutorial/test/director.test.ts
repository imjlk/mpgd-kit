import { describe, expect, it } from 'vitest';

import {
  createInitialTutorialProgress,
  createTutorialDirector,
  createTutorialProgressAtStep,
  defineTutorial,
  parseTutorialProgress,
  type TutorialDirector,
  type TutorialProgressOf,
} from '../src/index.js';
import {
  applyTutorialDebugLaunchPolicy,
  createMemoryTutorialProgressStore,
  resolveTutorialDebugLaunchPolicy,
} from '../src/testing.js';

const tutorial = defineTutorial({
  id: 'test.tutorial',
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
    {
      advance: { action: 'open-play', kind: 'action' },
      id: 'open-play',
      interaction: 'target',
      scene: 'lobby',
      target: 'play',
    },
    {
      advance: { kind: 'signal', signal: 'moved' },
      id: 'move',
      interaction: 'gameplay',
      scene: 'play',
      target: 'field',
    },
    {
      advance: { kind: 'signal', signal: 'finished' },
      id: 'await-result',
      interaction: 'hidden',
      scene: 'play',
      target: null,
    },
    {
      advance: { kind: 'acknowledge' },
      id: 'result',
      interaction: 'blocked',
      scene: 'result',
      target: 'result',
    },
  ],
} as const);

describe('tutorial director', () => {
  it('advances only through matching scene actions and signals', async () => {
    const store = createMemoryTutorialProgressStore({
      definition: tutorial,
      initial: null,
    });
    const director = createTutorialDirector({
      autoStart: true,
      clock: () => new Date('2026-08-12T00:00:00.000Z'),
      definition: tutorial,
      progressStore: store,
    });

    expect(director.getSnapshot().presentedStep?.id).toBe('welcome');
    director.acknowledge('welcome');
    director.observeAction('open-play');
    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'move',
      presentedStep: null,
      requiredScene: 'play',
    });

    director.observeSignal('moved');
    expect(director.getSnapshot().currentStepId).toBe('move');
    director.observeScene('play');
    director.observeSignal('moved');
    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'await-result',
      presentedStep: null,
    });
    director.observeSignal('finished');
    director.observeScene('result');
    expect(director.getSnapshot().presentedStep?.id).toBe('result');
    director.acknowledge('result');
    await director.flush();

    expect(director.getSnapshot()).toMatchObject({
      active: false,
      currentStepId: null,
      status: 'completed',
    });
    expect(store.getSnapshot()?.completedStepIds).toEqual([
      'welcome',
      'open-play',
      'move',
      'await-result',
      'result',
    ]);
  });

  it('reports synchronous progress saves without interrupting construction or advancement', async () => {
    const saveError = new Error('Synchronous save failed.');
    const errors: unknown[] = [];
    const director = createTutorialDirector({
      autoStart: true,
      definition: tutorial,
      onError: (error) => errors.push(error),
      progressStore: {
        available: true,
        flush: async () => undefined,
        getSnapshot: () => null,
        save: () => {
          throw saveError;
        },
      },
    });

    expect(director.getSnapshot().currentStepId).toBe('welcome');
    expect(errors).toEqual([saveError]);

    director.acknowledge('welcome');
    expect(director.getSnapshot().currentStepId).toBe('open-play');
    expect(errors).toEqual([saveError, saveError]);
  });

  it('registers persistence before an immediate flush', async () => {
    let releaseSave: (() => void) | undefined;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let registeredSave = Promise.resolve();
    const director = createTutorialDirector({
      autoStart: true,
      definition: tutorial,
      progressStore: {
        available: true,
        flush: () => registeredSave,
        getSnapshot: () => null,
        save: () => {
          void (registeredSave = pendingSave);
          return pendingSave;
        },
      },
    });
    let flushed = false;
    const flushing = director.flush().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);

    releaseSave?.();
    await flushing;
    expect(flushed).toBe(true);
  });

  it('serializes custom-store saves through advancement and an explicit skip', async () => {
    type Progress = TutorialProgressOf<typeof tutorial>;
    let releaseInitialSave: (() => void) | undefined;
    const initialSavePending = new Promise<void>((resolve) => {
      releaseInitialSave = resolve;
    });
    const pendingSaves = new Set<Promise<void>>();
    const started: Progress[] = [];
    let durable: Progress | null = null;
    const director = createTutorialDirector({
      autoStart: true,
      definition: tutorial,
      progressStore: {
        available: true,
        async flush() {
          await Promise.all([...pendingSaves]);
        },
        getSnapshot: () => durable,
        save(progress) {
          started.push(progress);
          const operation = (async () => {
            if (progress.completedStepIds.length === 0) {
              await initialSavePending;
            }

            durable = progress;
          })();
          pendingSaves.add(operation);
          void operation.finally(() => pendingSaves.delete(operation));
          return operation;
        },
      },
    });

    director.acknowledge('welcome');
    const skipping = director.skip();
    let flushed = false;
    const flushing = director.flush().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(started.map((progress) => progress.completedStepIds)).toEqual([[]]);
    expect(flushed).toBe(false);

    releaseInitialSave?.();
    await skipping;
    await flushing;

    expect(started.map((progress) => ({
      completedStepIds: progress.completedStepIds,
      status: progress.status,
    }))).toEqual([
      { completedStepIds: [], status: 'active' },
      { completedStepIds: ['welcome'], status: 'active' },
      { completedStepIds: ['welcome'], status: 'skipped' },
    ]);
    expect(durable).toMatchObject({
      completedStepIds: ['welcome'],
      status: 'skipped',
    });
  });

  it('queues a save that synchronously reenters the director', async () => {
    type Progress = TutorialProgressOf<typeof tutorial>;
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    let releaseFirstSave: (() => void) | undefined;
    const firstSavePending = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const started: Progress[] = [];
    let durable: Progress = initial;
    let firstSave = true;
    let reentrantSkip: Promise<void> | undefined;
    let flushedSaveCount = 0;
    let director: TutorialDirector<typeof tutorial>;
    director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      progressStore: {
        available: true,
        async flush() {
          flushedSaveCount = started.length;
        },
        getSnapshot: () => durable,
        save(progress) {
          started.push(progress);

          if (firstSave) {
            firstSave = false;
            const skipping = director.skip();
            void (reentrantSkip = skipping);
            return firstSavePending.then(() => {
              durable = progress;
            });
          }

          durable = progress;
          return Promise.resolve();
        },
      },
    });

    director.acknowledge('welcome');
    let flushed = false;
    const flushing = director.flush().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(started.map((progress) => progress.status)).toEqual(['active']);
    expect(flushed).toBe(false);

    releaseFirstSave?.();
    await reentrantSkip;
    await flushing;

    expect(started.map((progress) => ({
      completedStepIds: progress.completedStepIds,
      status: progress.status,
    }))).toEqual([
      { completedStepIds: ['welcome'], status: 'active' },
      { completedStepIds: ['welcome'], status: 'skipped' },
    ]);
    expect(durable).toMatchObject({ completedStepIds: ['welcome'], status: 'skipped' });
    expect(flushedSaveCount).toBe(2);
  });

  it('preserves durable completion when a replay is skipped', async () => {
    const completed = {
      ...createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z'),
      completedAt: '2026-08-12T00:01:00.000Z',
      completedStepIds: tutorial.steps.map((step) => step.id),
      status: 'completed' as const,
    };
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial: completed });
    const director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      progressStore: store,
    });

    await director.replay({ fromStepId: 'move' });
    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'move',
      replaying: true,
      requiredScene: 'play',
    });
    await director.replay({ fromStepId: 'open-play' });
    await director.skip();

    expect(director.getSnapshot()).toMatchObject({
      replaying: false,
      status: 'completed',
    });
    expect(store.getSnapshot()).toEqual(completed);
  });

  it('restores durable progress when an in-session replay completes', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial });
    const director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      progressStore: store,
    });

    await director.replay({ fromStepId: 'result' });
    director.observeScene('result');
    director.acknowledge('result');
    await director.flush();

    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'welcome',
      replaying: false,
      status: 'active',
    });
    expect(store.getSnapshot()).toEqual(initial);
    expect(store.saves).toEqual([]);
  });

  it('does not replace a durable completion with a direct skip', async () => {
    const completed = {
      ...createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z'),
      completedAt: '2026-08-12T00:01:00.000Z',
      completedStepIds: tutorial.steps.map((step) => step.id),
      status: 'completed' as const,
    };
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial: completed });
    const director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      progressStore: store,
    });

    await director.skip();

    expect(director.getSnapshot().status).toBe('completed');
    expect(store.getSnapshot()).toEqual(completed);
  });

  it('does not persist or publish queued state when publication destroys the director', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const saved: unknown[] = [];
    const director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      progressStore: {
        available: true,
        flush: async () => undefined,
        getSnapshot: () => initial,
        save: async (progress) => {
          saved.push(progress);
        },
      },
    });

    director.subscribe((snapshot) => {
      if (snapshot.status === 'skipped') {
        void director.replay({ fromStepId: 'move' });
        director.destroy();
      }
    });
    await director.skip();

    expect(saved).toEqual([]);
    expect(director.getSnapshot().status).toBe('skipped');
  });

  it('persists a skip and continues publication when a listener throws', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial });
    const listenerError = new Error('Listener rejected the skipped snapshot.');
    const errors: unknown[] = [];
    const observedStatuses: string[] = [];
    const director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      onError: (error) => errors.push(error),
      progressStore: store,
    });
    director.subscribe((snapshot) => {
      if (snapshot.status === 'skipped') {
        throw listenerError;
      }
    });
    director.subscribe((snapshot) => observedStatuses.push(snapshot.status));

    await expect(director.skip()).resolves.toBeUndefined();
    await director.flush();

    expect(errors).toEqual([listenerError]);
    expect(observedStatuses.at(-1)).toBe('skipped');
    expect(director.getSnapshot().status).toBe('skipped');
    expect(store.getSnapshot()?.status).toBe('skipped');
    expect(store.saves.at(-1)?.status).toBe('skipped');
  });

  it('restores the prior durable state when replay starts during skip publication', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial });
    const director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      progressStore: store,
    });
    let replayStarted = false;
    director.subscribe((snapshot) => {
      if (snapshot.status === 'skipped' && !replayStarted) {
        replayStarted = true;
        void director.replay({ fromStepId: 'move' });
      }
    });

    await director.skip();
    await director.skip();
    await director.flush();

    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'welcome',
      replaying: false,
      status: 'active',
    });
    expect(store.getSnapshot()).toEqual(initial);
    expect(store.saves).toEqual([]);
  });

  it('publishes one stable snapshot to every listener during a reentrant replay', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial });
    const director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      progressStore: store,
    });
    let replayStarted = false;
    const observed: string[] = [];
    director.subscribe((snapshot) => {
      if (snapshot.status === 'skipped' && !replayStarted) {
        replayStarted = true;
        void director.replay({ fromStepId: 'move' });
      }
    });
    director.subscribe((snapshot) => {
      const argumentKey = `${snapshot.status}:${snapshot.currentStepId ?? 'none'}`;
      const current = director.getSnapshot();
      const currentKey = `${current.status}:${current.currentStepId ?? 'none'}`;
      observed.push(`${argumentKey}|${currentKey}`);
    });

    await director.skip();

    expect(observed.slice(-2)).toEqual([
      'skipped:none|skipped:none',
      'active:move|active:move',
    ]);
    const finalSnapshot = director.getSnapshot();
    expect(observed.at(-1)).toBe(
      `${finalSnapshot.status}:${finalSnapshot.currentStepId ?? 'none'}|${finalSnapshot.status}:${finalSnapshot.currentStepId ?? 'none'}`,
    );
    expect(director.getSnapshot()).toMatchObject({ currentStepId: 'move', replaying: true });
  });

  it('does not duplicate the current publication for a reentrant subscriber', async () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial });
    const director = createTutorialDirector({
      autoStart: false,
      definition: tutorial,
      progressStore: store,
    });
    const observed: string[] = [];
    let subscribed = false;
    director.subscribe((snapshot) => {
      if (snapshot.status === 'skipped' && !subscribed) {
        subscribed = true;
        void director.replay({ fromStepId: 'move' });
        director.subscribe((nested) => {
          observed.push(`${nested.status}:${nested.currentStepId ?? 'none'}`);
        });
      }
    });

    await director.skip();

    expect(observed).toEqual(['skipped:none', 'active:move']);
  });

  it('publishes the current snapshot when a listener subscribes', () => {
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial: null });
    const director = createTutorialDirector({
      autoStart: true,
      definition: tutorial,
      progressStore: store,
    });
    const snapshots: unknown[] = [];

    director.subscribe((snapshot) => snapshots.push(snapshot));

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ currentStepId: 'welcome' });
  });

  it('makes destruction terminal while preserving snapshot and flush access', async () => {
    const timestamp = '2026-08-12T00:00:00.000Z';
    const initial = createInitialTutorialProgress(tutorial, timestamp);
    const beforeSceneObservation: TutorialProgressOf<typeof tutorial> = {
      ...createTutorialProgressAtStep(tutorial, 'move', timestamp),
      checkpoint: 'lobby',
    };

    async function expectTerminalNoOp(
      initialProgress: TutorialProgressOf<typeof tutorial>,
      invoke: (director: TutorialDirector<typeof tutorial>) => Promise<void> | void,
      initialScene?: string,
    ): Promise<void> {
      const saved: TutorialProgressOf<typeof tutorial>[] = [];
      let flushes = 0;
      const director = createTutorialDirector({
        autoStart: false,
        definition: tutorial,
        ...(initialScene === undefined ? {} : { initialScene }),
        progressStore: {
          available: true,
          async flush() {
            flushes += 1;
          },
          getSnapshot: () => initialProgress,
          save: async (progress) => {
            saved.push(progress);
          },
        },
      });
      const published: unknown[] = [];
      const unsubscribe = director.subscribe((snapshot) => published.push(snapshot));
      const terminalSnapshot = director.getSnapshot();

      director.destroy();
      director.destroy();

      let lateDeliveries = 0;
      const unsubscribeLate = director.subscribe(() => {
        lateDeliveries += 1;
      });
      unsubscribeLate();
      unsubscribeLate();
      unsubscribe();
      await invoke(director);
      await expect(director.flush()).resolves.toBeUndefined();

      expect(director.getSnapshot()).toBe(terminalSnapshot);
      expect(published).toEqual([terminalSnapshot]);
      expect(lateDeliveries).toBe(0);
      expect(saved).toEqual([]);
      expect(flushes).toBe(1);
    }

    await expectTerminalNoOp(initial, (director) => director.acknowledge('welcome'));
    await expectTerminalNoOp(
      createTutorialProgressAtStep(tutorial, 'open-play', timestamp),
      (director) => director.observeAction('open-play'),
    );
    await expectTerminalNoOp(
      beforeSceneObservation,
      (director) => director.observeScene('play'),
    );
    await expectTerminalNoOp(
      createTutorialProgressAtStep(tutorial, 'move', timestamp),
      (director) => director.observeSignal('moved'),
      'play',
    );
    await expectTerminalNoOp(initial, (director) => director.replay({ fromStepId: 'move' }));
    await expectTerminalNoOp(initial, (director) => director.setSuspended(true));
    await expectTerminalNoOp(initial, (director) => director.skip());
  });

  it('does not mutate replay state when an unknown step is requested', async () => {
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial: null });
    const director = createTutorialDirector({
      autoStart: true,
      definition: tutorial,
      progressStore: store,
    });

    await expect(director.replay({ fromStepId: 'missing' as 'welcome' })).rejects.toThrow(
      'Unknown tutorial step: missing',
    );

    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'welcome',
      replaying: false,
    });
    director.acknowledge('welcome');
    await director.flush();
    expect(store.getSnapshot()?.completedStepIds).toEqual(['welcome']);
  });

  it('applies debug launch policy only when explicitly enabled', async () => {
    const store = createMemoryTutorialProgressStore({ definition: tutorial, initial: null });
    const director = createTutorialDirector({
      autoStart: true,
      definition: tutorial,
      progressStore: store,
    });

    await applyTutorialDebugLaunchPolicy(director, resolveTutorialDebugLaunchPolicy({
      definition: tutorial,
      enabled: false,
      search: '?mpgd-tutorial=off',
    }));
    expect(director.getSnapshot().suspended).toBe(false);

    await applyTutorialDebugLaunchPolicy(director, resolveTutorialDebugLaunchPolicy({
      definition: tutorial,
      enabled: true,
      search: '?mpgd-tutorial=replay&mpgd-tutorial-step=move',
    }));
    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'move',
      replaying: true,
    });

    await expect(applyTutorialDebugLaunchPolicy(director, resolveTutorialDebugLaunchPolicy({
      definition: tutorial,
      enabled: true,
      search: '?mpgd-tutorial-step=missing',
    }))).resolves.toBeUndefined();
    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'welcome',
      replaying: true,
    });
  });
});

describe('tutorial progress parser', () => {
  it('accepts exact prefixes and rejects corrupt completion states', () => {
    const initial = createInitialTutorialProgress(tutorial, '2026-08-12T00:00:00.000Z');
    expect(parseTutorialProgress(tutorial, initial)).toEqual(initial);
    expect(parseTutorialProgress(tutorial, {
      ...initial,
      completedStepIds: ['open-play'],
    })).toBeNull();
    expect(parseTutorialProgress(tutorial, {
      ...initial,
      completedAt: '2026-08-12T00:01:00.000Z',
      status: 'completed',
    })).toBeNull();
    expect(parseTutorialProgress(tutorial, {
      ...initial,
      definitionRevision: 2,
    })).toBeNull();
  });
});
