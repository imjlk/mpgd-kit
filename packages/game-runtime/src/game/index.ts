import type {
  GameServicesOperationClient,
  GameServicesRewardedAdResult,
} from '@mpgd/game-services/operations';
import type { PlatformGateway, RewardedAdResult } from '@mpgd/platform';
import type { AdPlacementInput } from '@mpgd/platform/ads';
import { createGameExecutionController, type GameExecutionController } from '../index.js';
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
export interface GamePlatformRuntime<
  T extends PlatformGateway = PlatformGateway,
  S extends GameServicePorts = GameServicePorts,
> {
  readonly gateway: T;
  readonly execution: GameExecutionController;
  readonly presentation: FullScreenPresentationScope;
  readonly services: S;
  readonly actions?: GameActionCoordinator;
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
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    execution.destroy();
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
      ...(input.onObserverError === undefined ? {} : { onError: input.onObserverError }),
    });
    unsubscribeResume = gateway.lifecycle.onResume(() => { observe(reconcile, input.onObserverError); });
    return Object.freeze({
      gateway,
      execution,
      presentation,
      services,
      ...(actions === undefined ? {} : { actions }),
      reconcile,
      dispose,
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
