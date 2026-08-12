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
  type Listener = (snapshot: TutorialDirectorSnapshot<TDefinition>) => void;
  interface Subscription { readonly listener: Listener }
  interface PendingPersistence {
    readonly progress: TutorialProgressOf<TDefinition>;
    readonly resolve: () => void;
  }
  const listeners = new Set<Subscription>();
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
  const persistenceQueue: PendingPersistence[] = [];
  let persistenceBusy = false;
  let persistenceIdle: Promise<void> | null = null;
  let resolvePersistenceIdle: (() => void) | null = null;
  let publicationVersion = 0;
  let snapshot = createSnapshot(definition, progress, replaying, suspended, currentScene);

  if (stored === null && progress !== null) {
    void persist(progress);
  }

  function now(): string {
    return clock().toISOString();
  }

  function reportError(error: unknown): void {
    try {
      input.onError?.(error);
    } catch {
      // Error reporting must not interrupt tutorial state transitions.
    }
  }

  function invokeProgressSave(next: TutorialProgressOf<TDefinition>): Promise<void> | null {
    try {
      return progressStore.save(next).catch((error: unknown) => {
        reportError(error);
      });
    } catch (error) {
      reportError(error);
      return null;
    }
  }

  function finishPersistenceCycle(): void {
    const resolveIdle = resolvePersistenceIdle;
    resolvePersistenceIdle = null;
    persistenceIdle = null;
    resolveIdle?.();
  }

  function pumpPersistence(): void {
    if (persistenceBusy) {
      return;
    }

    while (true) {
      const pending = persistenceQueue.shift();

      if (pending === undefined) {
        finishPersistenceCycle();
        return;
      }

      persistenceBusy = true;
      const operation = invokeProgressSave(pending.progress);

      if (operation === null) {
        persistenceBusy = false;
        pending.resolve();
        continue;
      }

      void operation.then(() => {
        persistenceBusy = false;
        pending.resolve();
        pumpPersistence();
      });
      return;
    }
  }

  function enqueuePersistence(next: TutorialProgressOf<TDefinition>): Promise<void> {
    const completion = new Promise<void>((resolve) => {
      persistenceQueue.push({ progress: next, resolve });
    });

    if (persistenceIdle === null) {
      const idle = new Promise<void>((resolve) => {
        resolvePersistenceIdle = resolve;
      });
      void (persistenceIdle = idle);
    }

    pumpPersistence();
    return completion;
  }

  function persist(next: TutorialProgressOf<TDefinition>): Promise<void> {
    if (destroyed || replaying) {
      return Promise.resolve();
    }

    return enqueuePersistence(next);
  }

  async function flush(): Promise<void> {
    const pendingPersistence = persistenceIdle;

    if (pendingPersistence !== null) {
      await pendingPersistence;
    }

    await progressStore.flush();
  }

  function persistAndPublish(next: TutorialProgressOf<TDefinition>): void {
    const versionBeforePersistence = publicationVersion;
    void persist(next);

    if (publicationVersion === versionBeforePersistence) {
      publish();
    }
  }

  function notifyListener(listener: Listener, nextSnapshot: TutorialDirectorSnapshot<TDefinition>): void {
    try {
      listener(nextSnapshot);
    } catch (error) {
      reportError(error);
    }
  }

  function publish(): void {
    if (destroyed) {
      return;
    }

    publicationVersion += 1;
    const publishedSnapshot = createSnapshot(
      definition,
      progress,
      replaying,
      suspended,
      currentScene,
    );
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

        snapshot = pendingSnapshot;
        const recipients = [...listeners];

        for (const subscription of recipients) {
          if (listeners.has(subscription)) {
            notifyListener(subscription.listener, pendingSnapshot);
          }
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

    persistAndPublish(progress);
  }

  return {
    acknowledge(stepId) {
      if (destroyed) {
        return;
      }

      const step = getCurrentStep();

      if (step?.id === stepId && step.advance.kind === 'acknowledge') {
        advanceCurrent();
      }
    },
    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      listeners.clear();
      pendingSnapshots.length = 0;
    },
    flush,
    getSnapshot: () => snapshot,
    observeAction(action) {
      if (destroyed) {
        return;
      }

      const step = getCurrentStep();

      if (canAdvance(step) && step.advance.kind === 'action' && step.advance.action === action) {
        advanceCurrent();
      }
    },
    observeScene(scene) {
      if (destroyed) {
        return;
      }

      currentScene = scene;
      const step = getCurrentStep();

      if (progress?.status === 'active' && step?.scene === scene && progress.checkpoint !== scene) {
        progress = { ...progress, checkpoint: scene, updatedAt: now() };
        persistAndPublish(progress);
        return;
      }

      publish();
    },
    observeSignal(signal) {
      if (destroyed) {
        return;
      }

      const step = getCurrentStep();

      if (canAdvance(step) && step.advance.kind === 'signal' && step.advance.signal === signal) {
        advanceCurrent();
      }
    },
    async replay(options = {}) {
      if (destroyed) {
        return;
      }

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
      if (destroyed || suspended === nextSuspended) {
        return;
      }

      suspended = nextSuspended;
      publish();
    },
    async skip() {
      if (destroyed || progress === null) {
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
      const skippedProgress = progress;
      replaying = false;
      durableBeforeReplay = null;
      replayRestorePending = false;
      durableFallbackDuringPublish = progressBeforeSkip;

      try {
        publish();
      } finally {
        durableFallbackDuringPublish = undefined;
      }

      if (progress !== skippedProgress || replaying) {
        return;
      }

      await enqueuePersistence(skippedProgress);
    },
    subscribe(listener) {
      if (destroyed) {
        return () => undefined;
      }

      const subscription: Subscription = { listener };
      listeners.add(subscription);
      notifyListener(listener, snapshot);
      return () => listeners.delete(subscription);
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
