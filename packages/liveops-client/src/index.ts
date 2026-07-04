import type { ClaimAdRewardRequest, ClaimAdRewardResponse } from '@mpgd/backend-ad-reward-ledger';
import type {
  RecordLeaderboardScoreRequest,
  RecordLeaderboardScoreResponse,
} from '@mpgd/backend-leaderboard-ledger';
import type {
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from '@mpgd/backend-purchase-verifier';
import type { LeaderboardScoreInput } from '@mpgd/leaderboard-contract';
import type {
  LogicalAdPlacementId,
  LogicalProductId,
  PurchaseResult,
  RewardedAdResult,
} from '@mpgd/monetization-contract';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform-contract';

export type LiveOpsStoreTarget = Extract<PlatformTarget, 'android' | 'ios' | 'ait'>;

export interface PurchaseVerificationApi {
  verifyPurchase(input: VerifyPurchaseRequest): Promise<VerifyPurchaseResponse>;
}

export interface AdRewardClaimApi {
  claimAdReward(input: ClaimAdRewardRequest): Promise<ClaimAdRewardResponse>;
}

export interface LeaderboardRecordApi {
  recordScore(input: RecordLeaderboardScoreRequest): Promise<RecordLeaderboardScoreResponse>;
}

export interface LiveOpsBackendApi {
  readonly purchases: PurchaseVerificationApi;
  readonly adRewards: AdRewardClaimApi;
  readonly leaderboard: LeaderboardRecordApi;
}

export interface LiveOpsClient {
  purchase(input: LiveOpsPurchaseInput): Promise<LiveOpsPurchaseResult>;
  claimRewardedAd(input: LiveOpsRewardedAdInput): Promise<LiveOpsRewardedAdResult>;
  submitLeaderboardScore(
    input: LiveOpsLeaderboardInput,
  ): Promise<LiveOpsLeaderboardResult>;
}

export interface CreateLiveOpsClientInput {
  readonly gateway: PlatformGateway;
  readonly backend: LiveOpsBackendApi;
  readonly playerId: string;
  readonly target: LiveOpsStoreTarget;
  readonly now?: () => string;
}

export interface LiveOpsPurchaseInput {
  readonly productId: LogicalProductId;
  readonly source: 'shop' | 'stage_fail' | 'result' | 'event';
  readonly idempotencyKey: string;
}

export interface LiveOpsPurchaseResult {
  readonly status: 'granted' | 'cancelled' | 'pending' | 'rejected';
  readonly purchase: PurchaseResult;
  readonly verification?: VerifyPurchaseResponse;
  readonly ledgerEntryId?: string;
}

export interface LiveOpsRewardedAdInput {
  readonly placementId: LogicalAdPlacementId;
  readonly idempotencyKey: string;
}

export interface LiveOpsRewardedAdResult {
  readonly status: 'granted' | 'skipped' | 'unavailable' | 'rejected';
  readonly reward: RewardedAdResult;
  readonly claim?: ClaimAdRewardResponse;
  readonly ledgerEntryId?: string;
}

export interface LiveOpsLeaderboardInput extends LeaderboardScoreInput {}

export interface LiveOpsLeaderboardResult {
  readonly submitted: boolean;
  readonly platformSubmitted: boolean;
  readonly rank?: number;
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
}

export function createLiveOpsClient(input: CreateLiveOpsClientInput): LiveOpsClient {
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async purchase(purchaseInput) {
      const purchase = await input.gateway.commerce.purchase(purchaseInput);

      if (purchase.status !== 'completed' || purchase.transactionId === undefined) {
        return {
          status: purchase.status === 'completed' ? 'rejected' : purchase.status,
          purchase,
        };
      }

      const verification = await input.backend.purchases.verifyPurchase({
        target: input.target,
        playerId: input.playerId,
        productId: purchaseInput.productId,
        platformTransactionId: purchase.transactionId,
        idempotencyKey: purchaseInput.idempotencyKey,
        purchasedAt: now(),
      });

      return {
        status: verification.verified ? 'granted' : 'rejected',
        purchase,
        verification,
        ...(verification.ledgerEntryId === undefined
          ? {}
          : { ledgerEntryId: verification.ledgerEntryId }),
      };
    },

    async claimRewardedAd(rewardInput) {
      const reward = await input.gateway.ads.showRewarded(rewardInput);

      if (reward.status !== 'completed' || !reward.rewardGranted) {
        return {
          status: reward.status === 'completed' ? 'rejected' : reward.status,
          reward,
        };
      }

      const claim = await input.backend.adRewards.claimAdReward({
        target: input.target,
        playerId: input.playerId,
        placementId: rewardInput.placementId,
        ...(reward.ledgerEntryId === undefined
          ? {}
          : { platformImpressionId: reward.ledgerEntryId }),
        idempotencyKey: rewardInput.idempotencyKey,
        completedAt: now(),
      });

      return {
        status: claim.granted ? 'granted' : 'rejected',
        reward,
        claim,
        ...(claim.ledgerEntryId === undefined ? {} : { ledgerEntryId: claim.ledgerEntryId }),
      };
    },

    async submitLeaderboardScore(scoreInput) {
      const platformResult = await input.gateway.leaderboard.submitScore(scoreInput);

      if (!platformResult.submitted) {
        return {
          submitted: false,
          platformSubmitted: false,
          alreadyProcessed: false,
        };
      }

      const record = await input.backend.leaderboard.recordScore({
        target: input.target,
        playerId: input.playerId,
        ...scoreInput,
      });

      return {
        submitted: record.submitted,
        platformSubmitted: true,
        rank: record.rank,
        ledgerEntryId: record.ledgerEntryId,
        alreadyProcessed: record.alreadyProcessed,
      };
    },
  };
}

export function createLiveOpsIdempotencyKey(input: {
  readonly target: PlatformTarget;
  readonly playerId: string;
  readonly action: 'purchase' | 'rewarded-ad' | 'leaderboard';
  readonly subjectId: string;
  readonly runId: string;
}): string {
  return [
    input.action,
    normalizeSegment(input.target),
    normalizeSegment(input.playerId),
    normalizeSegment(input.subjectId),
    normalizeSegment(input.runId),
  ].join(':');
}

function normalizeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]+/g, '-').replaceAll(/^-|-$/g, '').slice(0, 64);
}
