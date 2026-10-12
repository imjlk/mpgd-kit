import { oc, type as orpcType, type RouterContractClient } from '@orpc/contract';

import type { CommerceServiceCapabilities } from '@mpgd/platform/commerce';

import type {
  ClaimAdRewardRequest,
  ClaimAdRewardResponse,
  PurchaseLedgerStatusRequest,
  PurchaseLedgerStatusResponse,
  RecordLeaderboardScoreRequest,
  RecordLeaderboardScoreResponse,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types.js';

export interface GameServicesHealthResponse {
  readonly ok: true;
  readonly service: 'game-services';
  readonly version: string;
}

export const gameServicesContract = oc.router({
  health: oc
    .input(orpcType<void>())
    .output(orpcType<GameServicesHealthResponse>()),
  commerce: oc.router({
    verifyPurchase: oc
      .input(orpcType<VerifyPurchaseRequest>())
      .output(orpcType<VerifyPurchaseResponse>()),
    /** RFC "Revocation and expiry entries"; NOT_FOUND on a backend without the read. */
    getPurchaseLedgerStatus: oc
      .input(orpcType<PurchaseLedgerStatusRequest>())
      .output(orpcType<PurchaseLedgerStatusResponse>()),
    /** RFC "Provider capabilities endpoint"; NOT_FOUND on a backend without a registry. */
    getCapabilities: oc
      .input(orpcType<void>())
      .output(orpcType<CommerceServiceCapabilities>()),
  }),
  ads: oc.router({
    claimReward: oc
      .input(orpcType<ClaimAdRewardRequest>())
      .output(orpcType<ClaimAdRewardResponse>()),
  }),
  leaderboard: oc.router({
    recordScore: oc
      .input(orpcType<RecordLeaderboardScoreRequest>())
      .output(orpcType<RecordLeaderboardScoreResponse>()),
  }),
});

export type GameServicesContract = typeof gameServicesContract;
export type GameServicesContractClient = RouterContractClient<GameServicesContract>;
