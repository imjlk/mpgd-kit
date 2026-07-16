import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

import { createAnalyticsReporter, type AnalyticsSink } from '@mpgd/analytics';
import type {
  LeaderboardScoreInput,
  LogicalAdPlacementId,
  LogicalProductId,
  PlatformGateway,
  PlatformTarget,
  PurchaseResult,
  RewardedAdResult,
} from '@mpgd/platform';

import type {
  GameServicesContractClient,
} from './contract';
import type {
  ClaimAdRewardRequest,
  ClaimAdRewardResponse,
  GameServicesAdRewardTarget,
  GameServicesLeaderboardTarget,
  GameServicesLedgerTarget,
  GameServicesStoreTarget,
  RecordLeaderboardScoreRequest,
  RecordLeaderboardScoreResponse,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types';

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
  readonly version?: string;
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
  readonly target: GameServicesLedgerTarget;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
  readonly now?: () => string;
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
  const analytics = createAnalyticsReporter({
    target: input.target,
    sessionId: input.analyticsSessionId ?? input.playerId,
    now,
    ...(input.analytics === undefined ? {} : { sink: input.analytics }),
  });

  return {
    async purchase(purchaseInput) {
      const target = input.target;

      if (!isGameServicesCommerceTarget(target)) {
        const purchase = {
          status: 'failed',
          entitlementIds: [],
        } satisfies PurchaseResult;

        await analytics.track({
          name: 'purchase_rejected',
          properties: {
            productId: purchaseInput.productId,
            status: purchase.status,
            reason: 'unsupported_target',
          },
        });

        return {
          status: 'rejected',
          purchase,
        };
      }

      const purchase = await input.gateway.commerce.purchase(purchaseInput);

      if (target === 'verse8') {
        const status = purchase.status === 'completed' ? 'rejected' : purchase.status;

        await analytics.track({
          name: 'purchase_rejected',
          properties: {
            productId: purchaseInput.productId,
            status,
            reason: purchase.status === 'completed'
              ? 'verse8_grants_require_agent8_purchase_event'
              : 'agent8_purchase_event_pending',
          },
        });

        return {
          status,
          purchase,
        };
      }

      if (purchase.status !== 'completed' || purchase.transactionId === undefined) {
        await analytics.track({
          name: 'purchase_rejected',
          properties: {
            productId: purchaseInput.productId,
            status: purchase.status,
            reason: purchase.transactionId === undefined ? 'missing_transaction_id' : undefined,
          },
        });

        return {
          status: purchase.status === 'completed' ? 'rejected' : purchase.status,
          purchase,
        };
      }

      const verification = await input.backend.purchases.verifyPurchase({
        target,
        playerId: input.playerId,
        productId: purchaseInput.productId,
        platformTransactionId: purchase.transactionId,
        idempotencyKey: purchaseInput.idempotencyKey,
        purchasedAt: now(),
        ...(purchase.evidence === undefined ? {} : { evidence: purchase.evidence }),
      });

      const result = {
        status: verification.verified ? 'granted' : 'rejected',
        purchase,
        verification,
        ...(verification.ledgerEntryId === undefined
          ? {}
          : { ledgerEntryId: verification.ledgerEntryId }),
      } satisfies GameServicesPurchaseResult;

      await analytics.track({
        name: verification.verified ? 'purchase_granted' : 'purchase_rejected',
        properties: {
          productId: purchaseInput.productId,
          status: result.status,
          ledgerEntryId: verification.ledgerEntryId,
          alreadyProcessed: verification.alreadyProcessed,
          reason: verification.reason,
        },
      });

      return result;
    },

    async claimRewardedAd(rewardInput) {
      const target = input.target;

      if (!isGameServicesAdRewardTarget(target)) {
        const reward = {
          status: 'unavailable',
          rewardGranted: false,
        } satisfies RewardedAdResult;

        await analytics.track({
          name: 'rewarded_ad_rejected',
          properties: {
            placementId: rewardInput.placementId,
            status: reward.status,
            rewardGranted: reward.rewardGranted,
            reason: 'unsupported_target',
          },
        });

        return {
          status: 'rejected',
          reward,
        };
      }

      const reward = await input.gateway.ads.showRewarded(rewardInput);

      if (reward.status !== 'completed' || !reward.rewardGranted) {
        await analytics.track({
          name: 'rewarded_ad_rejected',
          properties: {
            placementId: rewardInput.placementId,
            status: reward.status,
            rewardGranted: reward.rewardGranted,
          },
        });

        return {
          status: reward.status === 'completed' ? 'rejected' : reward.status,
          reward,
        };
      }

      const claim = await input.backend.adRewards.claimAdReward({
        target,
        playerId: input.playerId,
        placementId: rewardInput.placementId,
        ...(reward.ledgerEntryId === undefined
          ? {}
          : { platformImpressionId: reward.ledgerEntryId }),
        idempotencyKey: rewardInput.idempotencyKey,
        completedAt: now(),
        ...(reward.evidence === undefined ? {} : { evidence: reward.evidence }),
      });

      const result = {
        status: claim.granted ? 'granted' : 'rejected',
        reward,
        claim,
        ...(claim.ledgerEntryId === undefined ? {} : { ledgerEntryId: claim.ledgerEntryId }),
      } satisfies GameServicesRewardedAdResult;

      await analytics.track({
        name: claim.granted ? 'rewarded_ad_granted' : 'rewarded_ad_rejected',
        properties: {
          placementId: rewardInput.placementId,
          status: result.status,
          ledgerEntryId: claim.ledgerEntryId,
          alreadyProcessed: claim.alreadyProcessed,
          reason: claim.reason,
        },
      });

      return result;
    },

    async submitLeaderboardScore(scoreInput) {
      const target = input.target;

      if (!isGameServicesLeaderboardTarget(target)) {
        await analytics.track({
          name: 'leaderboard_submitted',
          properties: {
            leaderboardId: scoreInput.leaderboardId,
            score: scoreInput.score,
            submitted: false,
            reason: 'unsupported_target',
          },
        });

        return {
          submitted: false,
          platformSubmitted: false,
          alreadyProcessed: false,
        };
      }

      const platformResult = await input.gateway.leaderboard.submitScore(scoreInput);

      if (!platformResult.submitted) {
        await analytics.track({
          name: 'leaderboard_submitted',
          properties: {
            leaderboardId: scoreInput.leaderboardId,
            score: scoreInput.score,
            submitted: false,
          },
        });

        return {
          submitted: false,
          platformSubmitted: false,
          alreadyProcessed: false,
        };
      }

      const record = await input.backend.leaderboard.recordScore({
        target,
        playerId: input.playerId,
        ...scoreInput,
      });

      const result = {
        submitted: record.submitted,
        platformSubmitted: true,
        rank: record.rank,
        ledgerEntryId: record.ledgerEntryId,
        alreadyProcessed: record.alreadyProcessed,
      } satisfies GameServicesLeaderboardResult;

      await analytics.track({
        name: 'leaderboard_recorded',
        properties: {
          leaderboardId: scoreInput.leaderboardId,
          score: scoreInput.score,
          submitted: result.submitted,
          rank: result.rank,
          ledgerEntryId: result.ledgerEntryId,
          alreadyProcessed: result.alreadyProcessed,
        },
      });

      return result;
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

function isGameServicesCommerceTarget(
  target: GameServicesLedgerTarget,
): target is GameServicesStoreTarget | 'verse8' {
  return target === 'android' || target === 'ios' || target === 'ait' || target === 'verse8';
}

function isGameServicesAdRewardTarget(
  target: GameServicesLedgerTarget,
): target is GameServicesAdRewardTarget {
  return target === 'android' || target === 'ios' || target === 'ait' || target === 'verse8';
}

function isGameServicesLeaderboardTarget(
  target: GameServicesLedgerTarget,
): target is GameServicesLeaderboardTarget {
  return target === 'browser'
    || target === 'android'
    || target === 'ios'
    || target === 'ait'
    || target === 'reddit';
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
