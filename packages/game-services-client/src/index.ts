import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

import type { ClaimAdRewardRequest, ClaimAdRewardResponse } from '@mpgd/backend-ad-reward-ledger';
import type {
  RecordLeaderboardScoreRequest,
  RecordLeaderboardScoreResponse,
} from '@mpgd/backend-leaderboard-ledger';
import type {
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from '@mpgd/backend-purchase-verifier';
import {
  type GameServicesContractClient,
} from '@mpgd/game-services-contract';
import type { LeaderboardScoreInput } from '@mpgd/leaderboard-contract';
import type {
  LogicalAdPlacementId,
  LogicalProductId,
  PurchaseResult,
  RewardedAdResult,
} from '@mpgd/monetization-contract';
import type { PlatformGateway, PlatformTarget } from '@mpgd/platform-contract';

export type GameServicesStoreTarget = Extract<PlatformTarget, 'android' | 'ios' | 'ait'>;

export interface PurchaseVerificationApi {
  verifyPurchase(input: VerifyPurchaseRequest): Promise<VerifyPurchaseResponse>;
}

export interface AdRewardClaimApi {
  claimAdReward(input: ClaimAdRewardRequest): Promise<ClaimAdRewardResponse>;
}

export interface LeaderboardRecordApi {
  recordScore(input: RecordLeaderboardScoreRequest): Promise<RecordLeaderboardScoreResponse>;
}

export interface GameServicesBackendApi {
  readonly purchases: PurchaseVerificationApi;
  readonly adRewards: AdRewardClaimApi;
  readonly leaderboard: LeaderboardRecordApi;
}

export const gameServicesBackendEndpoints = {
  verifyPurchase: '/game-services/purchases/verify',
  claimAdReward: '/game-services/ad-rewards/claim',
  recordLeaderboardScore: '/game-services/leaderboard/record',
} as const;

export type GameServicesBackendEndpoint =
  (typeof gameServicesBackendEndpoints)[keyof typeof gameServicesBackendEndpoints];

export interface GameServicesBackendTransportRequest<TBody = unknown> {
  readonly method: 'POST';
  readonly endpoint: GameServicesBackendEndpoint;
  readonly body: TBody;
}

export interface GameServicesBackendTransportResponse<TBody = unknown> {
  readonly status: number;
  readonly body: TBody;
}

export interface GameServicesBackendTransport {
  send(request: GameServicesBackendTransportRequest): Promise<GameServicesBackendTransportResponse>;
}

export interface CreateGameServicesHttpBackendApiInput {
  readonly transport: GameServicesBackendTransport;
}

export interface CreateGameServicesFetchBackendTransportInput {
  readonly baseUrl: string;
  readonly fetch?: GameServicesFetch;
  readonly headers?: Record<string, string>;
}

export interface CreateGameServicesOrpcClientInput {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export type GameServicesFetch = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<GameServicesFetchResponse>;

export interface GameServicesFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export class GameServicesBackendError extends Error {
  readonly endpoint: GameServicesBackendEndpoint;
  readonly status: number;
  readonly body: unknown;

  constructor(endpoint: GameServicesBackendEndpoint, status: number, body: unknown) {
    super(`GameServices backend request failed: ${endpoint} ${status}`);
    this.name = 'GameServicesBackendError';
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

export interface GameServicesClient {
  purchase(input: GameServicesPurchaseInput): Promise<GameServicesPurchaseResult>;
  claimRewardedAd(input: GameServicesRewardedAdInput): Promise<GameServicesRewardedAdResult>;
  submitLeaderboardScore(
    input: GameServicesLeaderboardInput,
  ): Promise<GameServicesLeaderboardResult>;
}

export interface CreateGameServicesClientInput {
  readonly gateway: PlatformGateway;
  readonly backend: GameServicesBackendApi;
  readonly playerId: string;
  readonly target: GameServicesStoreTarget;
  readonly now?: () => string;
}

export interface GameServicesPurchaseInput {
  readonly productId: LogicalProductId;
  readonly source: 'shop' | 'stage_fail' | 'result' | 'event';
  readonly idempotencyKey: string;
}

export interface GameServicesPurchaseResult {
  readonly status: 'granted' | 'cancelled' | 'pending' | 'rejected';
  readonly purchase: PurchaseResult;
  readonly verification?: VerifyPurchaseResponse;
  readonly ledgerEntryId?: string;
}

export interface GameServicesRewardedAdInput {
  readonly placementId: LogicalAdPlacementId;
  readonly idempotencyKey: string;
}

export interface GameServicesRewardedAdResult {
  readonly status: 'granted' | 'skipped' | 'unavailable' | 'rejected';
  readonly reward: RewardedAdResult;
  readonly claim?: ClaimAdRewardResponse;
  readonly ledgerEntryId?: string;
}

export interface GameServicesLeaderboardInput extends LeaderboardScoreInput {}

export interface GameServicesLeaderboardResult {
  readonly submitted: boolean;
  readonly platformSubmitted: boolean;
  readonly rank?: number;
  readonly ledgerEntryId?: string;
  readonly alreadyProcessed: boolean;
}

export function createGameServicesClient(input: CreateGameServicesClientInput): GameServicesClient {
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

export function createGameServicesHttpBackendApi(
  input: CreateGameServicesHttpBackendApiInput,
): GameServicesBackendApi {
  return {
    purchases: {
      async verifyPurchase(body) {
        return sendGameServicesBackendRequest<VerifyPurchaseRequest, VerifyPurchaseResponse>(
          input.transport,
          gameServicesBackendEndpoints.verifyPurchase,
          body,
        );
      },
    },
    adRewards: {
      async claimAdReward(body) {
        return sendGameServicesBackendRequest<ClaimAdRewardRequest, ClaimAdRewardResponse>(
          input.transport,
          gameServicesBackendEndpoints.claimAdReward,
          body,
        );
      },
    },
    leaderboard: {
      async recordScore(body) {
        return sendGameServicesBackendRequest<
          RecordLeaderboardScoreRequest,
          RecordLeaderboardScoreResponse
        >(
          input.transport,
          gameServicesBackendEndpoints.recordLeaderboardScore,
          body,
        );
      },
    },
  };
}

export function createGameServicesFetchBackendTransport(
  input: CreateGameServicesFetchBackendTransportInput,
): GameServicesBackendTransport {
  const fetcher = input.fetch ?? readGlobalFetch();

  return {
    async send(request) {
      const response = await fetcher(joinUrl(input.baseUrl, request.endpoint), {
        method: request.method,
        headers: {
          ...(input.headers ?? {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
      });

      return {
        status: response.status,
        body: await readFetchResponseBody(response),
      };
    },
  };
}

export function createGameServicesOrpcClient(
  input: CreateGameServicesOrpcClientInput,
): GameServicesContractClient {
  const link = new RPCLink({
    origin: input.url,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.headers === undefined
      ? {}
      : {
          headers: () => input.headers,
        }),
  } as never);

  return createORPCClient(link) as GameServicesContractClient;
}

export function createGameServicesOrpcBackendApi(
  client: GameServicesContractClient,
): GameServicesBackendApi {
  return {
    purchases: {
      verifyPurchase(input) {
        return client.commerce.verifyPurchase(input);
      },
    },
    adRewards: {
      claimAdReward(input) {
        return client.ads.claimReward(input);
      },
    },
    leaderboard: {
      recordScore(input) {
        return client.leaderboard.recordScore(input);
      },
    },
  };
}

export function createGameServicesIdempotencyKey(input: {
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

async function sendGameServicesBackendRequest<TRequest, TResponse>(
  transport: GameServicesBackendTransport,
  endpoint: GameServicesBackendEndpoint,
  body: TRequest,
): Promise<TResponse> {
  const response = await transport.send({
    method: 'POST',
    endpoint,
    body,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new GameServicesBackendError(endpoint, response.status, response.body);
  }

  return response.body as TResponse;
}

function readGlobalFetch(): GameServicesFetch {
  const fetcher = (globalThis as { readonly fetch?: GameServicesFetch }).fetch;

  if (fetcher === undefined) {
    throw new Error(
      'globalThis.fetch is unavailable. Provide a GameServices fetch implementation.',
    );
  }

  return fetcher;
}

async function readFetchResponseBody(response: GameServicesFetchResponse): Promise<unknown> {
  const text = await response.text();

  if (text.length === 0) {
    return null;
  }

  return JSON.parse(text);
}

function joinUrl(baseUrl: string, endpoint: GameServicesBackendEndpoint): string {
  return `${baseUrl.replace(/\/+$/g, '')}${endpoint}`;
}
