import type {
  ClaimAdRewardRequest,
  GetVerifiedLeaderboardSnapshotRequest,
  RecordLeaderboardScoreRequest,
  RecordVerifiedLeaderboardAttemptRequest,
  VerifyPurchaseRequest,
} from '@mpgd/game-services';
import { WorkerEntrypoint } from 'cloudflare:workers';

import {
  createWorkerFetchHandler,
  createWorkerService,
  type GameServicesWorkerEnv,
  type VerifiedLeaderboardAuthBinding,
  type VerifiedLeaderboardAuthBindingRequest,
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

  async recordVerifiedAttempt(input: RecordVerifiedLeaderboardAttemptRequest) {
    return createWorkerService(this.env).recordVerifiedAttempt(input);
  }

  async getSnapshot(input: GetVerifiedLeaderboardSnapshotRequest) {
    return createWorkerService(this.env).getSnapshot(input);
  }
}

export {
  createWorkerFetchHandler,
  createWorkerService,
  type GameServicesWorkerEnv,
} from './handler.js';
export default GameServicesWorker;
