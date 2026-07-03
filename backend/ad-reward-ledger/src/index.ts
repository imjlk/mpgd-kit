import type { LogicalAdPlacementId } from '@mpgd/monetization-contract';
import typia from 'typia';

export interface ClaimAdRewardRequest {
  readonly target: 'android' | 'ios' | 'ait';
  readonly playerId: string;
  readonly placementId: LogicalAdPlacementId;
  readonly platformImpressionId?: string;
  readonly idempotencyKey: string;
  readonly completedAt: string;
}

export interface ClaimAdRewardResponse {
  readonly granted: boolean;
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
}

export const assertClaimAdRewardRequest = typia.createAssert<ClaimAdRewardRequest>();
export const assertClaimAdRewardResponse = typia.createAssert<ClaimAdRewardResponse>();
