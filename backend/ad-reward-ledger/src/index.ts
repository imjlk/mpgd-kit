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
  readonly reason?: 'UNKNOWN_PLACEMENT' | 'NOT_REWARDED_PLACEMENT';
}

export interface ClaimAdRewardContext {
  readonly placements: AdPlacements;
  readonly ledger: EntitlementLedger;
  readonly now?: () => string;
}

export function assertClaimAdRewardRequest(
  input: ClaimAdRewardRequest,
): ClaimAdRewardRequest {
  assertRecord(input, 'ClaimAdRewardRequest');
  assertStoreTarget(input.target);
  assertNonEmptyString(input.playerId, 'playerId');
  assertNonEmptyString(input.placementId, 'placementId');
  assertOptionalNonEmptyString(input.platformImpressionId, 'platformImpressionId');
  assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
  assertNonEmptyString(input.completedAt, 'completedAt');

  return input;
}

export function assertClaimAdRewardResponse(
  input: ClaimAdRewardResponse,
): ClaimAdRewardResponse {
  assertRecord(input, 'ClaimAdRewardResponse');
  assertBoolean(input.granted, 'granted');
  assertOptionalNonEmptyString(input.ledgerEntryId, 'ledgerEntryId');
  assertBoolean(input.alreadyProcessed, 'alreadyProcessed');
  assertOptionalReason(input.reason);

  return input;
}

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
      reason: placement === undefined ? 'UNKNOWN_PLACEMENT' : 'NOT_REWARDED_PLACEMENT',
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

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertStoreTarget(input: unknown): asserts input is ClaimAdRewardRequest['target'] {
  if (input !== 'android' && input !== 'ios' && input !== 'ait') {
    throw new Error('target must be android, ios, or ait.');
  }
}

function assertNonEmptyString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertOptionalNonEmptyString(
  input: unknown,
  label: string,
): asserts input is string | undefined {
  if (input !== undefined) {
    assertNonEmptyString(input, label);
  }
}

function assertBoolean(input: unknown, label: string): asserts input is boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
}

function assertOptionalReason(
  input: unknown,
): asserts input is ClaimAdRewardResponse['reason'] {
  if (
    input !== undefined
    && input !== 'UNKNOWN_PLACEMENT'
    && input !== 'NOT_REWARDED_PLACEMENT'
  ) {
    throw new Error('reason must be UNKNOWN_PLACEMENT or NOT_REWARDED_PLACEMENT.');
  }
}
