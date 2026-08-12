import type {
  TutorialActionOf,
  TutorialDefinition,
  TutorialSceneOf,
  TutorialSignalOf,
  TutorialStepIdOf,
  TutorialStepOf,
} from './definition.js';
import {
  createInitialTutorialProgress,
  createTutorialProgressAtStep,
  type TutorialProgressOf,
  type TutorialProgressStatus,
  type TutorialProgressStore,
} from './progress.js';

export interface TutorialDirectorSnapshot<TDefinition extends TutorialDefinition> {
  readonly active: boolean;
  readonly currentScene: string;
  readonly currentStep: TutorialStepOf<TDefinition> | null;
  readonly currentStepId: TutorialStepIdOf<TDefinition> | null;
  readonly presentedStep: TutorialStepOf<TDefinition> | null;
  readonly replaying: boolean;
  readonly requiredScene: TutorialSceneOf<TDefinition> | null;
  readonly status: TutorialProgressStatus | 'inactive';
  readonly suspended: boolean;
}

export interface TutorialReplayOptions<TDefinition extends TutorialDefinition> {
  readonly fromStepId?: TutorialStepIdOf<TDefinition>;
}

export interface TutorialDirector<TDefinition extends TutorialDefinition> {
  acknowledge(stepId: TutorialStepIdOf<TDefinition>): void;
  destroy(): void;
  flush(): Promise<void>;
  getSnapshot(): TutorialDirectorSnapshot<TDefinition>;
  observeAction(action: TutorialActionOf<TDefinition>): void;
  observeScene(scene: string): void;
  observeSignal(signal: TutorialSignalOf<TDefinition>): void;
  replay(options?: TutorialReplayOptions<TDefinition>): Promise<void>;
  setSuspended(suspended: boolean): void;
  skip(): Promise<void>;
  subscribe(listener: (snapshot: TutorialDirectorSnapshot<TDefinition>) => void): () => void;
}

export interface CreateTutorialDirectorInput<TDefinition extends TutorialDefinition> {
  readonly autoStart: boolean;
  readonly clock?: () => Date;
  readonly definition: TDefinition;
  readonly initialScene?: string;
  readonly onError?: (error: unknown) => void;
  readonly progressStore: TutorialProgressStore<TutorialProgressOf<TDefinition>>;
  readonly suspended?: boolean;
}

export function createTutorialDirector<TDefinition extends TutorialDefinition>(
  input: CreateTutorialDirectorInput<TDefinition>,
): TutorialDirector<TDefinition> {
  const { definition, progressStore } = input;
  const listeners = new Set<(snapshot: TutorialDirectorSnapshot<TDefinition>) => void>();
  const clock = input.clock ?? (() => new Date());
  const stored = progressStore.getSnapshot();
  let durableBeforeReplay: TutorialProgressOf<TDefinition> | null = null;
  let replayRestorePending = false;
  let progress = stored ?? (input.autoStart && progressStore.available
    ? createInitialTutorialProgress(definition, now())
    : null);
  let replaying = false;
  let durableFallbackDuringPublish: TutorialProgressOf<TDefinition> | null | undefined;
  let suspended = input.suspended ?? false;
  let destroyed = false;
  let currentScene: string = input.initialScene ?? definition.initialScene;
  let publishing = false;
  const pendingSnapshots: TutorialDirectorSnapshot<TDefinition>[] = [];

  if (stored === null && progress !== null) {
    persist(progress);
  }

  let snapshot = createSnapshot(definition, progress, replaying, suspended, currentScene);

  function now(): string {
    return clock().toISOString();
  }

  function persist(next: TutorialProgressOf<TDefinition>): void {
    if (destroyed || replaying) {
      return;
    }

    void progressStore.save(next).catch((error: unknown) => {
      input.onError?.(error);
    });
  }

  function publish(): void {
    const publishedSnapshot = createSnapshot(
      definition,
      progress,
      replaying,
      suspended,
      currentScene,
    );
    snapshot = publishedSnapshot;
    pendingSnapshots.push(publishedSnapshot);

    if (publishing) {
      return;
    }

    publishing = true;

    try {
      while (pendingSnapshots.length > 0) {
        const pendingSnapshot = pendingSnapshots.shift();

        if (pendingSnapshot === undefined) {
          continue;
        }

        for (const listener of listeners) {
          listener(pendingSnapshot);
        }
      }
    } finally {
      publishing = false;
    }
  }

  function getCurrentStep(): TutorialStepOf<TDefinition> | null {
    if (progress?.status !== 'active') {
      return null;
    }

    return definition.steps[progress.completedStepIds.length] ?? null;
  }

  function canAdvance(step: TutorialStepOf<TDefinition> | null): step is TutorialStepOf<TDefinition> {
    return !suspended
      && progress?.status === 'active'
      && step !== null
      && step.scene === currentScene;
  }

  function advanceCurrent(): void {
    const current = getCurrentStep();

    if (!canAdvance(current) || progress === null) {
      return;
    }

    const completedStepIds = [...progress.completedStepIds, current.id];
    const timestamp = now();
    const complete = completedStepIds.length === definition.steps.length;
    progress = {
      ...progress,
      checkpoint: current.scene,
      completedAt: complete ? timestamp : null,
      completedStepIds,
      skippedAt: null,
      status: complete ? 'completed' : 'active',
      updatedAt: timestamp,
    };

    if (complete && replaying && replayRestorePending) {
      progress = durableBeforeReplay;
      replaying = false;
      replayRestorePending = false;
      durableBeforeReplay = null;
      publish();
      return;
    }

    if (complete) {
      replaying = false;
      replayRestorePending = false;
      durableBeforeReplay = null;
    }

    persist(progress);
    publish();
  }

  return {
    acknowledge(stepId) {
      const step = getCurrentStep();

      if (step?.id === stepId && step.advance.kind === 'acknowledge') {
        advanceCurrent();
      }
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
    flush: () => progressStore.flush(),
    getSnapshot: () => snapshot,
    observeAction(action) {
      const step = getCurrentStep();

      if (canAdvance(step) && step.advance.kind === 'action' && step.advance.action === action) {
        advanceCurrent();
      }
    },
    observeScene(scene) {
      currentScene = scene;
      const step = getCurrentStep();

      if (progress?.status === 'active' && step?.scene === scene && progress.checkpoint !== scene) {
        progress = { ...progress, checkpoint: scene, updatedAt: now() };
        persist(progress);
      }

      publish();
    },
    observeSignal(signal) {
      const step = getCurrentStep();

      if (canAdvance(step) && step.advance.kind === 'signal' && step.advance.signal === signal) {
        advanceCurrent();
      }
    },
    async replay(options = {}) {
      const replayProgress = options.fromStepId === undefined
        ? createInitialTutorialProgress(definition, now())
        : createTutorialProgressAtStep(definition, options.fromStepId, now());

      if (!replaying) {
        durableBeforeReplay = durableFallbackDuringPublish === undefined
          ? progress
          : durableFallbackDuringPublish;
        replayRestorePending = true;
      }

      replaying = true;
      suspended = false;
      progress = replayProgress;
      publish();
    },
    setSuspended(nextSuspended) {
      if (suspended === nextSuspended) {
        return;
      }

      suspended = nextSuspended;
      publish();
    },
    async skip() {
      if (progress === null) {
        return;
      }

      if (replaying && replayRestorePending) {
        progress = durableBeforeReplay;
        durableBeforeReplay = null;
        replayRestorePending = false;
        replaying = false;
        publish();
        return;
      }

      if (progress.status !== 'active') {
        return;
      }

      const progressBeforeSkip = progress;
      const timestamp = now();
      progress = {
        ...progress,
        completedAt: null,
        skippedAt: timestamp,
        status: 'skipped',
        updatedAt: timestamp,
      };
      replaying = false;
      durableBeforeReplay = null;
      replayRestorePending = false;
      durableFallbackDuringPublish = progressBeforeSkip;

      try {
        publish();
      } finally {
        durableFallbackDuringPublish = undefined;
      }

      if (destroyed || replaying) {
        return;
      }

      try {
        await progressStore.save(progress);
      } catch (error) {
        input.onError?.(error);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
  };
}

function createSnapshot<TDefinition extends TutorialDefinition>(
  definition: TDefinition,
  progress: TutorialProgressOf<TDefinition> | null,
  replaying: boolean,
  suspended: boolean,
  currentScene: string,
): TutorialDirectorSnapshot<TDefinition> {
  const currentStep = progress?.status === 'active'
    ? (definition.steps[progress.completedStepIds.length] ?? null)
    : null;
  const active = !suspended && currentStep !== null;
  const inCurrentScene = active && currentStep.scene === currentScene;

  return {
    active,
    currentScene,
    currentStep,
    currentStepId: currentStep?.id ?? null,
    presentedStep: inCurrentScene && currentStep.interaction !== 'hidden' ? currentStep : null,
    replaying,
    requiredScene: currentStep?.scene ?? null,
    status: progress?.status ?? 'inactive',
    suspended,
  };
}
