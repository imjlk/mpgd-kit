import typia from 'typia';

import type { AdPlacements } from '@mpgd/ad-placements';
import type { EntitlementLedger, EntitlementLedgerPayload } from '@mpgd/backend-entitlement-ledger';
import type { LogicalAdPlacementId } from '@mpgd/monetization-contract';

export type AdRewardIdempotencyKey = string;

export interface ClaimAdRewardRequest {
  readonly target: 'android' | 'ios' | 'ait';
  readonly playerId: string;
  readonly placementId: LogicalAdPlacementId;
  readonly platformImpressionId?: string;
  readonly idempotencyKey: AdRewardIdempotencyKey;
  readonly completedAt: string;
}

export interface ClaimAdRewardResponse {
  readonly granted: boolean;
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
}

export interface ClaimAdRewardContext {
  readonly placements: AdPlacements;
  readonly ledger: EntitlementLedger;
  readonly now?: () => string;
}

export const assertClaimAdRewardRequest = typia.createAssert<ClaimAdRewardRequest>();
export const assertClaimAdRewardResponse = typia.createAssert<ClaimAdRewardResponse>();

export function claimAdReward(
  input: ClaimAdRewardRequest,
  context: ClaimAdRewardContext,
): ClaimAdRewardResponse {
  const request = assertClaimAdRewardRequest(input);
  const placement = context.placements.placements.find((entry) => entry.id === request.placementId);

  if (placement === undefined || placement.type !== 'rewarded' || placement.reward === undefined) {
    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
    });
  }

  const payload: EntitlementLedgerPayload = {
    target: request.target,
    placementId: request.placementId,
    rewardType: placement.reward.type,
    amount: placement.reward.amount,
    completedAt: request.completedAt,
  };

  if (placement.reward.currency !== undefined) {
    payload.currency = placement.reward.currency;
  }

  if (request.platformImpressionId !== undefined) {
    payload.platformImpressionId = request.platformImpressionId;
  }

  const result = context.ledger.recordGrant({
    playerId: request.playerId,
    grantId: request.placementId,
    source: 'ad_reward',
    idempotencyKey: request.idempotencyKey,
    grantedAt: context.now?.() ?? new Date().toISOString(),
    payload,
  });

  return assertClaimAdRewardResponse({
    granted: true,
    ledgerEntryId: result.ledgerEntryId,
    alreadyProcessed: result.alreadyProcessed,
  });
}
