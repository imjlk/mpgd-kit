import type { ClaimAdRewardRequest } from '@mpgd/backend-ad-reward-ledger';
import type { RecordLeaderboardScoreRequest } from '@mpgd/backend-leaderboard-ledger';
import type { VerifyPurchaseRequest } from '@mpgd/backend-purchase-verifier';
import { WorkerEntrypoint } from 'cloudflare:workers';

import {
  createWorkerFetchHandler,
  createWorkerService,
  type GameServicesWorkerEnv,
} from './handler.js';

export class GameServicesWorker extends WorkerEntrypoint<GameServicesWorkerEnv> {
  override async fetch(request: Request): Promise<Response> {
    return createWorkerFetchHandler(this.env)(request);
  }

  async verifyPurchase(input: VerifyPurchaseRequest) {
    return createWorkerService(this.env).verifyPurchase(input);
  }

  async claimAdReward(input: ClaimAdRewardRequest) {
    return createWorkerService(this.env).claimAdReward(input);
  }

  async recordLeaderboardScore(input: RecordLeaderboardScoreRequest) {
    return createWorkerService(this.env).recordLeaderboardScore(input);
  }
}

export {
  createWorkerFetchHandler,
  createWorkerService,
  type GameServicesWorkerEnv,
} from './handler.js';
export default GameServicesWorker;
