import type {
  TutorialActionOf,
  TutorialDefinition,
  TutorialSignalOf,
  TutorialStepIdOf,
} from './definition.js';
import type { TutorialDirector, TutorialReplayOptions } from './director.js';
import type { TutorialProgress, TutorialProgressOf, TutorialProgressStore } from './progress.js';

export interface MemoryTutorialProgressStore<
  TProgress extends TutorialProgress,
> extends TutorialProgressStore<TProgress> {
  readonly saves: readonly TProgress[];
}

export function createMemoryTutorialProgressStore(): MemoryTutorialProgressStore<TutorialProgress>;
export function createMemoryTutorialProgressStore<TDefinition extends TutorialDefinition>(input: {
  readonly definition: TDefinition;
  readonly available?: boolean;
  readonly initial?: TutorialProgressOf<TDefinition> | null;
  readonly rejectSave?: boolean;
}): MemoryTutorialProgressStore<TutorialProgressOf<TDefinition>>;
export function createMemoryTutorialProgressStore<TProgress extends TutorialProgress>(input?: {
  readonly available?: boolean;
  readonly definition?: TutorialDefinition;
  readonly initial?: TProgress | null;
  readonly rejectSave?: boolean;
}): MemoryTutorialProgressStore<TProgress>;
export function createMemoryTutorialProgressStore<TProgress extends TutorialProgress>(input: {
  readonly available?: boolean;
  readonly definition?: TutorialDefinition;
  readonly initial?: TProgress | null;
  readonly rejectSave?: boolean;
} = {}): MemoryTutorialProgressStore<TProgress> {
  const available = input.available ?? true;
  let current = input.initial ?? null;
  const saves: TProgress[] = [];

  return {
    available,
    flush: () => Promise.resolve(),
    get saves() {
      return saves;
    },
    getSnapshot: () => current,
    async save(progress) {
      if (!available) {
        return;
      }

      if (input.rejectSave === true) {
        throw new Error('Memory tutorial progress store rejected a save.');
      }

      current = progress;
      saves.push(progress);
    },
  };
}

export type TutorialDebugMode = 'default' | 'off' | 'replay';

export interface TutorialDebugLaunchPolicy<TStepId extends string = string> {
  readonly enabled: boolean;
  readonly mode: TutorialDebugMode;
  readonly stepId: TStepId | null;
}

export function resolveTutorialDebugLaunchPolicy<TDefinition extends TutorialDefinition>(input: {
  readonly definition: TDefinition;
  readonly enabled: boolean;
  readonly search: string;
}): TutorialDebugLaunchPolicy<TutorialStepIdOf<TDefinition>> {
  if (!input.enabled) {
    return { enabled: false, mode: 'default', stepId: null };
  }

  const parameters = new URLSearchParams(input.search);
  const requestedMode = parameters.get('mpgd-tutorial');
  const requestedStepId = parameters.get('mpgd-tutorial-step');
  const mode: TutorialDebugMode = requestedMode === 'off'
    ? 'off'
    : requestedMode === 'replay' || requestedStepId !== null
      ? 'replay'
      : 'default';

  return {
    enabled: true,
    mode,
    stepId: requestedStepId !== null && isTutorialStepId(input.definition, requestedStepId)
      ? requestedStepId
      : null,
  };
}

export async function applyTutorialDebugLaunchPolicy<TDefinition extends TutorialDefinition>(
  director: TutorialDirector<TDefinition>,
  policy: TutorialDebugLaunchPolicy<TutorialStepIdOf<TDefinition>>,
): Promise<void> {
  if (!policy.enabled || policy.mode === 'default' && policy.stepId === null) {
    return;
  }

  if (policy.mode === 'off') {
    director.setSuspended(true);
    return;
  }

  const options: TutorialReplayOptions<TDefinition> = policy.stepId === null
    ? {}
    : { fromStepId: policy.stepId };
  await director.replay(options);
}

function isTutorialStepId<TDefinition extends TutorialDefinition>(
  definition: TDefinition,
  stepId: string,
): stepId is TutorialStepIdOf<TDefinition> {
  return definition.steps.some((step) => step.id === stepId);
}

export interface TutorialDebugBridge<TDefinition extends TutorialDefinition> {
  action(action: TutorialActionOf<TDefinition>): void;
  getSnapshot(): ReturnType<TutorialDirector<TDefinition>['getSnapshot']>;
  goToStep(stepId: TutorialStepIdOf<TDefinition>): Promise<void>;
  replay(): Promise<void>;
  scene(scene: string): void;
  signal(signal: TutorialSignalOf<TDefinition>): void;
  skip(): Promise<void>;
  suspend(suspended: boolean): void;
}

export interface InstallTutorialDebugBridgeInput<TDefinition extends TutorialDefinition> {
  readonly afterReplay?: (
    options: TutorialReplayOptions<TDefinition>,
  ) => Promise<void> | void;
  readonly beforeReplay?: (
    options: TutorialReplayOptions<TDefinition>,
  ) => Promise<void> | void;
  readonly director: TutorialDirector<TDefinition>;
  readonly floatingReplayTrigger?: false | {
    readonly ariaLabel?: string;
    readonly className?: string;
    readonly label?: string;
    readonly parent?: HTMLElement;
  };
  readonly globalKey?: string;
  readonly globalObject?: typeof globalThis;
  readonly onError?: (error: unknown) => void;
}

interface TutorialDebugBridgeInstallation {
  readonly bridge: object;
  readonly fallback: unknown;
  readonly fallbackHadOwnProperty: boolean;
  readonly globalKey: string;
  readonly predecessor: TutorialDebugBridgeInstallation | null;
  readonly record: Record<string, unknown>;
  destroyed: boolean;
}

const tutorialDebugBridgeInstallations = new WeakMap<object, TutorialDebugBridgeInstallation>();

export function installTutorialDebugBridge<TDefinition extends TutorialDefinition>(
  input: InstallTutorialDebugBridgeInput<TDefinition>,
): { readonly bridge: TutorialDebugBridge<TDefinition>; destroy(): void } {
  const globalObject = input.globalObject ?? globalThis;
  const globalKey = input.globalKey ?? '__MPGD_TUTORIAL__';
  const record = globalObject as unknown as Record<string, unknown>;
  const previousHadOwnProperty = Object.hasOwn(record, globalKey);
  const previous = record[globalKey];
  const replay = async (options: TutorialReplayOptions<TDefinition> = {}): Promise<void> => {
    await input.beforeReplay?.(options);
    await input.director.replay(options);
    await input.afterReplay?.(options);
  };
  const bridge: TutorialDebugBridge<TDefinition> = {
    action: (action) => input.director.observeAction(action),
    getSnapshot: () => input.director.getSnapshot(),
    goToStep: (stepId) => replay({ fromStepId: stepId }),
    replay: () => replay(),
    scene: (scene) => input.director.observeScene(scene),
    signal: (signal) => input.director.observeSignal(signal),
    skip: () => input.director.skip(),
    suspend: (suspended) => input.director.setSuspended(suspended),
  };
  const possiblePredecessor = typeof previous === 'object' && previous !== null
    ? tutorialDebugBridgeInstallations.get(previous)
    : undefined;
  const predecessor = possiblePredecessor?.record === record
      && possiblePredecessor.globalKey === globalKey
    ? possiblePredecessor
    : null;
  const installation: TutorialDebugBridgeInstallation = {
    bridge,
    destroyed: false,
    fallback: predecessor === null ? previous : predecessor.fallback,
    fallbackHadOwnProperty: predecessor === null
      ? previousHadOwnProperty
      : predecessor.fallbackHadOwnProperty,
    globalKey,
    predecessor,
    record,
  };
  tutorialDebugBridgeInstallations.set(bridge, installation);
  record[globalKey] = bridge;

  const destroyTrigger = createFloatingReplayTrigger(input, bridge);

  return {
    bridge,
    destroy() {
      if (installation.destroyed) {
        return;
      }

      installation.destroyed = true;
      destroyTrigger?.();

      if (record[globalKey] !== bridge) {
        return;
      }

      let restoredInstallation = installation.predecessor;

      while (restoredInstallation?.destroyed === true) {
        restoredInstallation = restoredInstallation.predecessor;
      }

      if (restoredInstallation !== null) {
        record[globalKey] = restoredInstallation.bridge;
      } else if (installation.fallbackHadOwnProperty) {
        record[globalKey] = installation.fallback;
      } else {
        Reflect.deleteProperty(record, globalKey);
      }
    },
  };
}

function createFloatingReplayTrigger<TDefinition extends TutorialDefinition>(
  input: InstallTutorialDebugBridgeInput<TDefinition>,
  bridge: TutorialDebugBridge<TDefinition>,
): (() => void) | null {
  if (input.floatingReplayTrigger === false
    || input.floatingReplayTrigger === undefined
    || typeof document === 'undefined') {
    return null;
  }

  const options = input.floatingReplayTrigger;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = options.label ?? '?';
  button.setAttribute('aria-label', options.ariaLabel ?? 'Replay tutorial');
  button.dataset.mpgdTutorialDebugReplay = 'true';
  button.className = options.className ?? '';
  button.style.position = 'fixed';
  button.style.insetBlockStart = '12px';
  button.style.insetInlineEnd = '12px';
  button.style.zIndex = '2147483647';
  const reportError = (error: unknown): void => {
    try {
      input.onError?.(error);
    } catch {
      // Error reporting must not interrupt floating replay trigger handling.
    }
  };
  const handleClick = (): void => {
    void bridge.replay().catch(reportError);
  };
  button.addEventListener('click', handleClick);
  (options.parent ?? document.body).appendChild(button);
  return () => {
    button.removeEventListener('click', handleClick);
    button.remove();
  };
}
