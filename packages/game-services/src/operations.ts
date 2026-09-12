import type {
  LogicalAdPlacementId,
  LogicalProductId,
  PurchaseResult,
  RewardedAdResult,
} from '@mpgd/platform';

import type {
  GameServicesOperationOptions,
  GameServicesPurchaseProgress,
  GameServicesRewardedAdProgress,
} from './operation-progress.js';
import type { ClaimAdRewardResponse, VerifyPurchaseResponse } from './types.js';
export type {
  GameServicesOperationKind,
  GameServicesOperationLocation,
  GameServicesOperationOptions,
  GameServicesOperationProgress,
  GameServicesPurchaseProgress,
  GameServicesRewardedAdProgress,
} from './operation-progress.js';

/** DOM-free public operation port, implemented by GameServicesClient. */
export interface GameServicesOperationClient {
  purchase(
    input: GameServicesPurchaseInput,
    options?: GameServicesOperationOptions<GameServicesPurchaseProgress>,
  ): Promise<GameServicesPurchaseResult>;
  claimRewardedAd(
    input: GameServicesRewardedAdInput,
    options?: GameServicesOperationOptions<GameServicesRewardedAdProgress>,
  ): Promise<GameServicesRewardedAdResult>;
}

export interface GameServicesPurchaseInput {
  readonly productId: LogicalProductId;
  readonly source: 'shop' | 'stage_fail' | 'result' | 'event';
  readonly idempotencyKey: string;
}

export interface GameServicesPurchaseResult {
  readonly status: 'granted' | 'cancelled' | 'pending' | 'failed' | 'rejected';
  readonly purchase: PurchaseResult;
  readonly verification?: VerifyPurchaseResponse;
  readonly ledgerEntryId?: string;
}

export interface GameServicesRewardedAdInput {
  readonly placementId: LogicalAdPlacementId;
  readonly idempotencyKey: string;
}

export interface GameServicesRewardedAdResult {
  readonly status: 'granted' | 'skipped' | 'unavailable' | 'failed' | 'rejected';
  readonly reward: RewardedAdResult;
  readonly claim?: ClaimAdRewardResponse;
  readonly ledgerEntryId?: string;
}
