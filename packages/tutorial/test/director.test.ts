import { describe, expect, it } from 'vitest';

import {
  createInitialTutorialProgress,
  createTutorialDirector,
  defineTutorial,
  parseTutorialProgress,
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
      enabled: false,
      search: '?mpgd-tutorial=off',
    }));
    expect(director.getSnapshot().suspended).toBe(false);

    await applyTutorialDebugLaunchPolicy(director, resolveTutorialDebugLaunchPolicy({
      enabled: true,
      search: '?mpgd-tutorial=replay&mpgd-tutorial-step=move',
    }));
    expect(director.getSnapshot()).toMatchObject({
      currentStepId: 'move',
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
