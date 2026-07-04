import { oc, type as orpcType, type RouterContractClient } from '@orpc/contract';

import type {
  ClaimAdRewardRequest,
  ClaimAdRewardResponse,
  RecordLeaderboardScoreRequest,
  RecordLeaderboardScoreResponse,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types';

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
