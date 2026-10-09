import type {
  GameServicesOperationClient,
  GameServicesRewardedAdResult,
} from '@mpgd/game-services/operations';
import type { PlatformGateway, RewardedAdResult } from '@mpgd/platform';
import type { AdPlacementInput } from '@mpgd/platform/ads';
import {
  createGameExecutionController,
  type ExecutionBlock,
  type GameExecutionController,
} from '../index.js';
import { bindGameLifecycle, type GameLifecycleState } from '../platform/index.js';
import {
  createFullScreenPresentationScope,
  type FullScreenPresentationScope,
} from '../presentation/index.js';
import {
  createAdClaimEvidenceRecoveryObserver,
  createCoordinatedPlatformGateway,
  type AdClaimEvidenceObservation,
  type AdWaitDeadline,
  type PurchasePresentationEvent,
} from '../ads/index.js';
import {
  createGameActionCoordinator,
  type GameActionCoordinator,
  type GameActionReconciliationPort,
} from '../actions/index.js';
import { observe, type ObserverErrorHandler } from '../observers.js';

/** Structural service ports keep the core usable without DOM, HTTP, or schema libraries. */
export interface GameServicePorts {
  readonly client?: GameServicesOperationClient;
  readonly monetizationRecovery?: {
    recoverRewardResult(idempotencyKey: string, platform: RewardedAdResult): Promise<GameServicesRewardedAdResult>;
    reconcile(): Promise<unknown>;
  };
}
/** One scene's logical play state; execution blocks remain owned by the game runtime. */
export interface GameGameplayScope {
  setActive(active: boolean): void;
  dispose(): void;
}
export interface GamePlatformRuntime<
  T extends PlatformGateway = PlatformGateway,
  S extends GameServicePorts = GameServicePorts,
> {
  readonly gateway: T;
  readonly execution: GameExecutionController;
  readonly presentation: FullScreenPresentationScope;
  readonly services: S;
  readonly actions?: GameActionCoordinator;
  createGameplayScope(): GameGameplayScope;
  setLoadingProgress(progress: number): void;
  /** Complete host loading before opening a play scene. Rejected starts remain blocked. */
  completeLoading(): Promise<void>;
  /** Reconcile existing journal entries only; this method never opens platform UI. */
  reconcile(): Promise<void>;
  /** Game teardown; native observers and application-owned late recovery may continue. */
  dispose(): void;
}
/** Construct once above every scene, preserving target gateway extensions and receiver binding. */
export function createGamePlatformRuntime<T extends PlatformGateway, S extends GameServicePorts>(input: {
  readonly gateway: T;
  readonly createServices: (gateway: T) => S;
  readonly initialLifecycleState: GameLifecycleState;
  readonly canShow?: (placement: AdPlacementInput) => boolean;
  readonly deadline?: AdWaitDeadline;
  readonly reconciliation?: GameActionReconciliationPort;
  readonly purchasePresentation?: { subscribe(listener: (event: PurchasePresentationEvent) => void): () => void };
  readonly onObserverError?: ObserverErrorHandler;
  /** Must complete synchronously; asynchronous uploads belong at earlier checkpoints. */
  readonly onExit?: () => void;
}): GamePlatformRuntime<T, S> {
  const execution = createGameExecutionController({
    ...(input.onObserverError === undefined ? {} : { onListenerError: input.onObserverError }),
  });
  const presentation = createFullScreenPresentationScope({ execution });
  let services: S | undefined;
  let lateEvidence: ((observation: AdClaimEvidenceObservation) => Promise<void>) | undefined;
  const source = input.gateway.ads.provider;
  const coordinated = source === undefined ? undefined : createCoordinatedPlatformGateway({
    gateway: input.gateway, provider: source, presentation,
    canShow: (placement) => input.canShow?.(placement) !== false && (placement.format !== 'rewarded' || services?.monetizationRecovery !== undefined),
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    ...(input.purchasePresentation === undefined ? {} : { purchasePresentation: input.purchasePresentation }),
    ...(input.onObserverError === undefined ? {} : { onObserverError: input.onObserverError }),
    onClaimEvidence: (observation) => lateEvidence?.(observation),
    onLateResult: async ({ input: request, result }) => {
      if (request.format !== 'rewarded' || result.eligibility === 'eligible' || result.presentation !== 'not-started'
        || result.evidence !== undefined || result.claimEvidence !== undefined || services?.monetizationRecovery === undefined) { return; }
      if (result.outcome !== 'failed' && result.outcome !== 'unavailable' && result.outcome !== 'skipped') { return; }
      const recovered = await services.monetizationRecovery.recoverRewardResult(request.idempotencyKey, { status: result.outcome, rewardGranted: false });
      if (!disposed) { actions?.confirmRecoveredRewardResult(request.idempotencyKey, recovered); }
    },
  });
  const gateway = (coordinated ?? input.gateway) as T;
  let lifecycle: ReturnType<typeof bindGameLifecycle> | undefined;
  let actions: GameActionCoordinator | undefined;
  let unsubscribeResume: (() => void) | undefined;
  let disposed = false;
  let unsubscribeExit: (() => void) | undefined;
  let startupBlock = input.gateway.gameLoading === undefined
    ? undefined
    : execution.acquireBlock({
        reason: 'game-runtime:loading',
        channels: ['simulation', 'gameplay-input', 'audio'],
      });
  let loadingCompletion: Promise<void> | undefined;
  const setLoadingProgress = (progress: number) => {
    if (!disposed && loadingCompletion === undefined) {
      observe(
        () => gateway.gameLoading?.setProgress(Math.max(0, Math.min(100, Number(progress) || 0))),
        input.onObserverError,
      );
    }
  };
  const completeLoading = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error('Game runtime is disposed.'));
    }
    if (loadingCompletion !== undefined) {
      return loadingCompletion;
    }
    const attempt = Promise.resolve().then(async () => {
      if (disposed) {
        throw new Error('Game runtime is disposed.');
      }
      gateway.gameLoading?.setProgress(100);
      await gateway.gameLoading?.complete();
      if (disposed) {
        throw new Error('Game runtime was disposed during loading.');
      }
      const owned = startupBlock;
      startupBlock = undefined;
      owned?.release();
    });
    loadingCompletion = attempt;
    void attempt.catch(() => {
      if (loadingCompletion === attempt) {
        loadingCompletion = undefined;
      }
    });
    return attempt;
  };
  let hostAudio: ExecutionBlock | undefined;
  let unsubscribeHostAudio: (() => void) | undefined;
  const gameplayScopes = new Map<object, boolean>();
  const lifecycleReason = 'game-runtime:lifecycle';
  let gameplayActive = false;
  let hasPlayed = false;
  let loading = true;
  let unsubscribeActivity: (() => void) | undefined;
  const updateActivity = () => {
    const snapshot = execution.getSnapshot();
    const activity = gateway.gameActivity;
    const playable = [...gameplayScopes.values()].some(Boolean);
    const blocked = snapshot.blocks.some((block) => block.channels.includes('simulation')
      && !(activity?.handlesFocusChanges === true && hasPlayed && block.reason === lifecycleReason));
    const next = !disposed && snapshot.status === 'active' && playable && !blocked;
    if (next && loading) {
      observe(() => {
        activity?.setLoading(false);
        loading = false;
      }, input.onObserverError);
      if (loading) {
        return;
      }
    }
    if (next !== gameplayActive) {
      observe(() => {
        activity?.setGameplayActive(next);
        gameplayActive = next;
        if (next) {
          hasPlayed = true;
        }
      }, input.onObserverError);
    }
  };
  const createGameplayScope = (): GameGameplayScope => {
    const owner = {};
    let ended = disposed;
    if (!ended) {
      gameplayScopes.set(owner, false);
    }
    return Object.freeze({
      setActive(active: boolean) {
        if (!ended && !disposed) {
          gameplayScopes.set(owner, active);
          updateActivity();
        }
      },
      dispose() {
        if (!ended) {
          ended = true;
          gameplayScopes.delete(owner);
          updateActivity();
        }
      },
    });
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    updateActivity();
    if (loading) {
      observe(() => {
        gateway.gameActivity?.setLoading(false);
        loading = false;
      }, input.onObserverError);
    }
    unsubscribeActivity?.();
    unsubscribeExit?.();
    gameplayScopes.clear();
    execution.destroy();
    if (unsubscribeHostAudio !== undefined) {
      observe(unsubscribeHostAudio, input.onObserverError);
    }
    hostAudio?.release();
    actions?.dispose();
    coordinated?.dispose();
    presentation.dispose();
    lifecycle?.dispose();
    if (unsubscribeResume !== undefined) {
      observe(unsubscribeResume, input.onObserverError);
    }
  };
  const reconcile = async () => {
    if (disposed) {
      return;
    }
    await services?.monetizationRecovery?.reconcile();
    if (!disposed && input.reconciliation !== undefined) {
      await actions?.reconcile();
    }
  };
  try {
    services = input.createServices(gateway);
    const recovery = services.monetizationRecovery;
    if (recovery !== undefined) {
      lateEvidence = createAdClaimEvidenceRecoveryObserver({ recovery, onResult: async (request, result) => {
          if (!disposed && result.status === 'rejected') { actions?.confirmRecoveredRewardResult(request.idempotencyKey, result); }
          if (!disposed && input.reconciliation !== undefined) { await actions?.reconcile(); } } });
    }
    if (services.client !== undefined) {
      actions = createGameActionCoordinator({ execution, client: services.client,
        ...(coordinated === undefined ? {} : { presentation }),
        ...(input.reconciliation === undefined ? {} : { reconciliation: input.reconciliation }),
        ...(input.onObserverError === undefined ? {} : { onObserverError: input.onObserverError }),
      });
    }
    lifecycle = bindGameLifecycle({ controller: execution, source: gateway.lifecycle, initialState: input.initialLifecycleState,
      reason: lifecycleReason,
      ...(input.onObserverError === undefined ? {} : { onError: input.onObserverError }),
    });
    unsubscribeResume = gateway.lifecycle.onResume(() => { observe(reconcile, input.onObserverError); });
    unsubscribeExit = gateway.lifecycle.onExit?.(() => {
      observe(() => input.onExit?.(), input.onObserverError);
      dispose();
    });
    if (disposed) {
      unsubscribeExit?.();
      throw new Error('Game exited during runtime initialization.');
    }
    const settings = gateway.gameSettings;
    if (settings !== undefined) {
      const updateMute = (muted: boolean) => {
        if (disposed) {
          return;
        }
        if (muted && hostAudio === undefined) {
          hostAudio = execution.acquireBlock({ reason: 'game-runtime:host-audio', channels: ['audio'] });
        } else if (!muted && hostAudio !== undefined) {
          const owned = hostAudio;
          hostAudio = undefined;
          owned.release();
        }
      };
      unsubscribeHostAudio = settings.onAudioMuteChange(updateMute);
      updateMute(settings.getAudioMuted());
    }
    observe(() => gateway.gameActivity?.setLoading(true), input.onObserverError);
    unsubscribeActivity = execution.subscribe(updateActivity);
    return Object.freeze({
      gateway,
      execution,
      presentation,
      services,
      createGameplayScope,
      setLoadingProgress,
      completeLoading,
      ...(actions === undefined ? {} : { actions }),
      reconcile,
      dispose,
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
