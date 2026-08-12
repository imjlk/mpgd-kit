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
  let current = input.initial ?? null;
  const saves: TProgress[] = [];

  return {
    available: input.available ?? true,
    flush: () => Promise.resolve(),
    get saves() {
      return saves;
    },
    getSnapshot: () => current,
    async save(progress) {
      if (input.rejectSave === true) {
        throw new Error('Memory tutorial progress store rejected a save.');
      }

      current = progress;
      saves.push(progress);
    },
  };
}

export type TutorialDebugMode = 'default' | 'off' | 'replay';

export interface TutorialDebugLaunchPolicy {
  readonly enabled: boolean;
  readonly mode: TutorialDebugMode;
  readonly stepId: string | null;
}

export function resolveTutorialDebugLaunchPolicy(input: {
  readonly enabled: boolean;
  readonly search: string;
}): TutorialDebugLaunchPolicy {
  if (!input.enabled) {
    return { enabled: false, mode: 'default', stepId: null };
  }

  const parameters = new URLSearchParams(input.search);
  const requestedMode = parameters.get('mpgd-tutorial');
  const mode: TutorialDebugMode = requestedMode === 'off'
      || requestedMode === 'replay'
    ? requestedMode
    : 'default';

  return {
    enabled: true,
    mode,
    stepId: parameters.get('mpgd-tutorial-step'),
  };
}

export async function applyTutorialDebugLaunchPolicy<TDefinition extends TutorialDefinition>(
  director: TutorialDirector<TDefinition>,
  policy: TutorialDebugLaunchPolicy,
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
    : { fromStepId: policy.stepId as TutorialStepIdOf<TDefinition> };
  await director.replay(options);
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

export function installTutorialDebugBridge<TDefinition extends TutorialDefinition>(
  input: InstallTutorialDebugBridgeInput<TDefinition>,
): { readonly bridge: TutorialDebugBridge<TDefinition>; destroy(): void } {
  const globalObject = input.globalObject ?? globalThis;
  const globalKey = input.globalKey ?? '__MPGD_TUTORIAL__';
  const record = globalObject as unknown as Record<string, unknown>;
  const previous = record[globalKey];
  const replay = async (options: TutorialReplayOptions<TDefinition> = {}): Promise<void> => {
    await input.beforeReplay?.(options);
    await input.director.replay(options);
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
  record[globalKey] = bridge;

  const trigger = createFloatingReplayTrigger(input, bridge);

  return {
    bridge,
    destroy() {
      trigger?.remove();

      if (record[globalKey] !== bridge) {
        return;
      }

      if (previous === undefined) {
        Reflect.deleteProperty(record, globalKey);
      } else {
        record[globalKey] = previous;
      }
    },
  };
}

function createFloatingReplayTrigger<TDefinition extends TutorialDefinition>(
  input: InstallTutorialDebugBridgeInput<TDefinition>,
  bridge: TutorialDebugBridge<TDefinition>,
): HTMLButtonElement | null {
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
  button.addEventListener('click', () => {
    void bridge.replay().catch((error: unknown) => input.onError?.(error));
  });
  (options.parent ?? document.body).appendChild(button);
  return button;
}
