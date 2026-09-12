import type { PurchaseResult, RewardedAdResult } from '@mpgd/platform';

import type { GameServicesPurchaseResult, GameServicesRewardedAdResult } from './operations.js';

export type GameServicesOperationKind = 'purchase' | 'rewarded-ad';
export type GameServicesOperationLocation = 'local' | 'platform' | 'server';

type PlatformStatus<K extends GameServicesOperationKind> = K extends 'purchase'
  ? PurchaseResult['status']
  : RewardedAdResult['status'];
type OperationResult<K extends GameServicesOperationKind> = K extends 'purchase'
  ? GameServicesPurchaseResult
  : GameServicesRewardedAdResult;

type ProgressStage<K extends GameServicesOperationKind> =
  | { readonly phase: 'platform-requested' }
  | { readonly phase: 'platform-result'; readonly status: PlatformStatus<K> }
  | { readonly phase: 'server-requested' }
  | { readonly phase: 'server-result'; readonly accepted: boolean }
  | { readonly phase: 'completed'; readonly status: OperationResult<K>['status'] }
  | { readonly phase: 'exception'; readonly at: GameServicesOperationLocation };

type OperationProgress<K extends GameServicesOperationKind> = ProgressStage<K> & {
  readonly kind: K;
  /** Invocation-local event order, starting at one. */
  readonly sequence: number;
  /** Optional UI/diagnostic correlation, never an idempotency key or grant proof. */
  readonly correlationId?: string;
};

export type GameServicesPurchaseProgress = OperationProgress<'purchase'>;
export type GameServicesRewardedAdProgress = OperationProgress<'rewarded-ad'>;
export type GameServicesOperationProgress =
  | GameServicesPurchaseProgress
  | GameServicesRewardedAdProgress;

export interface GameServicesOperationOptions<TProgress = GameServicesOperationProgress> {
  readonly onProgress?: (progress: TProgress) => void | Promise<void>;
  readonly onObserverError?: (error: unknown) => void | Promise<void>;
  readonly correlationId?: string;
}

interface OperationReporter<K extends GameServicesOperationKind> {
  platformRequested(): void;
  platformResult(status: PlatformStatus<K>): void;
  serverRequested(): void;
  serverResult(accepted: boolean): void;
}

/** Internal observation wrapper; it does not retry, cancel, verify, or grant anything. */
export async function observeGameServicesOperation<K extends GameServicesOperationKind>(
  kind: K,
  options: GameServicesOperationOptions<OperationProgress<K>> | undefined,
  operation: (reporter: OperationReporter<K>) => Promise<OperationResult<K>>,
): Promise<OperationResult<K>> {
  let onProgress: GameServicesOperationOptions<OperationProgress<K>>['onProgress'];
  let onObserverError: GameServicesOperationOptions['onObserverError'];
  let correlationId: string | undefined;
  let sequence = 0;
  let location: GameServicesOperationLocation = 'local';

  function report(error: unknown): void {
    try {
      if (typeof onObserverError === 'function') {
        const result = onObserverError(error);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
        }
      }
    } catch {
      // Diagnostic callbacks have no authority to change business results.
    }
  }

  // Capture observation options once. Even accessor failures stay outside the business flow.
  try {
    onObserverError = options?.onObserverError;
  } catch {
    // There is no safe error observer to invoke if retrieving it failed.
  }
  try {
    onProgress = options?.onProgress;
    const suppliedId = options?.correlationId;
    if (typeof suppliedId === 'string') {
      correlationId = suppliedId;
    }
  } catch (error) {
    report(error);
  }

  function emit(stage: ProgressStage<K>): void {
    sequence += 1;
    if (typeof onProgress !== 'function') {
      return;
    }
    const observer = onProgress;
    const progress: OperationProgress<K> = Object.freeze({
      ...stage,
      kind,
      sequence,
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    try {
      const result = observer(progress);
      if (result !== undefined) {
        void Promise.resolve(result).catch(report);
      }
    } catch (error) {
      report(error);
    }
  }

  const reporter: OperationReporter<K> = {
    platformRequested(): void {
      location = 'platform';
      emit({ phase: 'platform-requested' });
    },
    platformResult(status): void {
      location = 'local';
      emit({ phase: 'platform-result', status });
    },
    serverRequested(): void {
      location = 'server';
      emit({ phase: 'server-requested' });
    },
    serverResult(accepted): void {
      location = 'local';
      emit({ phase: 'server-result', accepted });
    },
  };
  try {
    const result = await operation(reporter);
    emit({ phase: 'completed', status: result.status });
    return result;
  } catch (error) {
    emit({ phase: 'exception', at: location });
    throw error;
  }
}
