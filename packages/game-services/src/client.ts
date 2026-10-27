import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

import { createAnalyticsReporter, type AnalyticsSink } from '@mpgd/analytics';
import type {
  LeaderboardScoreInput,
  PlatformGateway,
  PlatformTarget,
  PurchaseResult,
  RewardedAdResult,
} from '@mpgd/platform';
import type { CommerceServiceCapabilities } from '@mpgd/platform/commerce';

import {
  resolveClientRewardClaim,
  type ClientRewardEvidenceRegistry,
} from './client-reward-evidence.js';
import {
  createCommerceReconciler,
  toGameServicesPurchaseResult,
  type CommerceReconciler,
  type CommerceReconcilerEvent,
  type CommerceReconcilerProduct,
} from './commerce-reconciler.js';
import { createDefaultClientRewardEvidenceRegistry } from './default-client-reward-evidence.js';
import { createInMemoryMonetizationOperationStore } from './monetization-operation-store.js';
import type { MonetizationOperationStore } from './monetization-recovery.js';
import type {
  GameServicesOperationClient,
  GameServicesPurchaseResult,
  GameServicesRewardedAdResult,
} from './operations.js';
export type {
  GameServicesOperationClient,
  GameServicesPurchaseInput,
  GameServicesPurchaseResult,
  GameServicesRewardedAdInput,
  GameServicesRewardedAdResult,
} from './operations.js';
import type {
  GameServicesContractClient,
} from './contract.js';
import { observeGameServicesOperation } from './operation-progress.js';
import {
  GameServicesHeaderResolutionError,
  resolveGameServicesRequestHeaders,
  type GameServicesHeaderResolver,
} from './request-headers.js';
import type {
  ClaimAdRewardRequest,
  ClaimAdRewardResponse,
  GameServicesLeaderboardTarget,
  GameServicesLedgerTarget,
  PurchaseLedgerStatusRequest,
  PurchaseLedgerStatusResponse,
  RecordLeaderboardScoreRequest,
  RecordLeaderboardScoreResponse,
  VerifyPurchaseRequest,
  VerifyPurchaseResponse,
} from './types.js';

export type {
  GameServicesOperationKind,
  GameServicesOperationLocation,
  GameServicesOperationOptions,
  GameServicesOperationProgress,
  GameServicesPurchaseProgress,
  GameServicesRewardedAdProgress,
} from './operation-progress.js';

export {
  GameServicesHeaderResolutionError,
  resolveGameServicesRequestHeaders,
  type GameServicesHeaderResolver,
} from './request-headers.js';

export interface PurchaseVerificationApi {
  verifyPurchase(input: VerifyPurchaseRequest): Promise<VerifyPurchaseResponse>;
  /**
   * Whether earlier ledger grants are still active (RFC "Revocation and
   * expiry entries"). The commerce reconciler runs its revocation pass only
   * when a backend offers this read; the reference server offers it since C2.
   */
  getPurchaseLedgerStatus?(input: PurchaseLedgerStatusRequest): Promise<PurchaseLedgerStatusResponse>;
  /**
   * What the backend accepts (RFC "Provider capabilities endpoint"): the
   * stores its commerce evidence registry serves, their schemas, and who
   * finishes. The commerce reconciler compares it with its provider at start
   * when a backend offers it; the reference server offers it when it was
   * created with a `commerceEvidenceRegistry`.
   */
  getCommerceCapabilities?(): Promise<CommerceServiceCapabilities>;
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
  getPurchaseLedgerStatus: '/game-services/purchases/ledger-status',
  getCommerceCapabilities: '/game-services/purchases/capabilities',
  claimAdReward: '/game-services/ad-rewards/claim',
  recordLeaderboardScore: '/game-services/leaderboard/record',
} as const;

export type GameServicesBackendEndpoint =
  (typeof gameServicesBackendEndpoints)[keyof typeof gameServicesBackendEndpoints];

export interface GameServicesBackendTransportRequest<TBody = unknown> {
  readonly method: 'POST';
  readonly endpoint: GameServicesBackendEndpoint;
  readonly body: TBody;
  /** Resolved for this request only; custom transports must not forward elsewhere. */
  readonly headers?: Readonly<Record<string, string>>;
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
  readonly getHeaders?: GameServicesHeaderResolver;
}

export interface CreateGameServicesOrpcClientInput {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
  readonly getHeaders?: GameServicesHeaderResolver;
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

export class GameServicesBackendTransportError extends Error {
  readonly endpoint: GameServicesBackendEndpoint;

  constructor(endpoint: GameServicesBackendEndpoint) {
    super(`GameServices backend transport failed: ${endpoint}`);
    this.name = 'GameServicesBackendTransportError';
    this.endpoint = endpoint;
  }
}

export interface GameServicesClient extends GameServicesOperationClient {
  submitLeaderboardScore(
    input: GameServicesLeaderboardInput,
  ): Promise<GameServicesLeaderboardResult>;
  /**
   * The commerce reconciler behind `purchase`, present when the gateway
   * exposes `commerce`. Call `start()` at runtime start and `reconcile()` on
   * app resume; `purchase` starts it on first use. A gateway without a commerce
   * provider has none, and `purchase` then answers `rejected` without opening
   * any store UI.
   */
  readonly commerceReconciler?: CommerceReconciler;
}

export interface CreateGameServicesClientInput {
  readonly gateway: PlatformGateway;
  readonly backend: GameServicesBackendApi;
  readonly playerId: string;
  readonly target: GameServicesLedgerTarget;
  readonly deploymentTarget?: string;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
  readonly now?: () => string;
  /** Override backend evidence timestamps without backdating analytics events. */
  readonly requestNow?: () => string;
  /** Explicit client decoders only; server verification is configured independently. */
  readonly rewardEvidenceRegistry?: ClientRewardEvidenceRegistry;
  /**
   * Journal of the commerce reconciler used when `gateway.commerce` exists.
   * Without one the journal lives in memory for this session only: duplicates
   * are then caught by the backend ledger, not by the client.
   */
  readonly operationStore?: MonetizationOperationStore;
  /** A reconciler shared with another client, for example the recovery client's. */
  readonly commerceReconciler?: CommerceReconciler;
  /** Receives the one-time warning about a session-only commerce journal; defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
  /** Catalog kinds and SKUs the reconciler resolves without a store read. */
  readonly commerceProducts?: readonly CommerceReconcilerProduct[];
  /** The reconciler's `staleLaunchedAfterMs` (24 hours by default). */
  readonly commerceStaleLaunchedAfterMs?: number;
  readonly onCommerceEvent?: (event: CommerceReconcilerEvent) => void;
}

/**
 * `commerceStaleLaunchedAfterMs` is checked where it enters, so a bad value
 * fails even when no reconciler is built (a gateway without `commerce`).
 */
export function assertCommerceStaleLaunchedAfterMs(value: number | undefined): void {
  if (value !== undefined && !(typeof value === 'number' && value > 0)) {
    throw new RangeError(
      'commerceStaleLaunchedAfterMs must be a positive duration in milliseconds, or Infinity.',
    );
  }
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
  assertCommerceStaleLaunchedAfterMs(input.commerceStaleLaunchedAfterMs);
  const now = input.now ?? (() => new Date().toISOString());
  const requestNow = input.requestNow ?? now;
  const rewardEvidenceRegistry = input.rewardEvidenceRegistry ?? createDefaultClientRewardEvidenceRegistry();
  const allowLegacyRewardCompletion = input.rewardEvidenceRegistry === undefined && input.gateway.ads?.provider === undefined;
  const analytics = createAnalyticsReporter({
    target: input.target,
    sessionId: input.analyticsSessionId ?? input.playerId,
    now,
    ...(input.analytics === undefined ? {} : { sink: input.analytics }),
  });

  const commerceProvider = input.gateway.commerce;
  let commerceReconciler: CommerceReconciler | undefined;
  if (commerceProvider !== undefined) {
    if (input.commerceReconciler === undefined && input.operationStore === undefined) {
      (input.warn ?? console.warn)(
        '@mpgd/game-services: the commerce reconciler is journaling in memory for this session '
          + 'because no operationStore was given; purchases are not recoverable across restarts and '
          + 'the backend ledger is the only duplicate backstop. Pass a durable MonetizationOperationStore.',
      );
    }
    commerceReconciler = input.commerceReconciler ?? createCommerceReconciler({
      provider: commerceProvider,
      backend: input.backend.purchases,
      store: input.operationStore ?? createInMemoryMonetizationOperationStore(),
      playerId: input.playerId,
      target: input.target,
      ...(input.deploymentTarget === undefined ? {} : { deploymentTarget: input.deploymentTarget }),
      ...(input.commerceProducts === undefined ? {} : { products: input.commerceProducts }),
      ...(input.commerceStaleLaunchedAfterMs === undefined
        ? {}
        : { staleLaunchedAfterMs: input.commerceStaleLaunchedAfterMs }),
      now: requestNow,
    });
    if (input.onCommerceEvent !== undefined) {
      commerceReconciler.subscribe(input.onCommerceEvent);
    }
  }
  /** Keys of purchase calls in flight, and those whose backend verdict the observer tracked meanwhile. */
  const inFlightKeys = new Set<string>();
  const trackedVerdicts = new Set<string>();
  const markTracked = (key: string): void => {
    if (inFlightKeys.has(key)) {
      trackedVerdicts.add(key);
    }
  };
  if (commerceReconciler !== undefined && input.commerceReconciler === undefined) {
    // Verdicts arrive as events, inside or after a purchase call; each is tracked once.
    commerceReconciler.subscribe((event) => {
      if (event.type !== 'transition' || event.previous === undefined) {
        return;
      }
      const { record } = event;
      const productId = record.logicalId;
      if (event.previous === 'verifying' && record.state === 'granted') {
        markTracked(record.idempotencyKey);
        analytics.track({
          name: 'purchase_granted',
          properties: {
            productId,
            status: 'granted',
            ledgerEntryId: record.ledgerEntryId,
            alreadyProcessed: record.response?.alreadyProcessed,
          },
        }).catch(() => {});
      } else if (event.previous === 'verifying' && record.state === 'rejected') {
        markTracked(record.idempotencyKey);
        analytics.track({
          name: 'purchase_rejected',
          properties: { productId, status: 'rejected', reason: record.response?.reason },
        }).catch(() => {});
      } else if (event.previous === 'verifying' && record.state === 'pending') {
        markTracked(record.idempotencyKey);
        analytics.track({
          name: 'purchase_pending',
          properties: {
            productId,
            status: 'pending',
            reason: record.response?.reason ?? 'purchase_pending',
          },
        }).catch(() => {});
      } else if (record.state === 'cancelled' || record.state === 'failed') {
        markTracked(record.idempotencyKey);
        analytics.track({
          name: 'purchase_rejected',
          properties: { productId, status: record.state, reason: record.error?.code },
        }).catch(() => {});
      }
    });
  }

  return {
    ...(commerceReconciler === undefined ? {} : { commerceReconciler }),
    async purchase(purchaseInput, options) {
      const reconciler = commerceReconciler;
      if (reconciler !== undefined) {
        return observeGameServicesOperation('purchase', options, async (progress): Promise<GameServicesPurchaseResult> => {
          const key = purchaseInput.idempotencyKey;
          trackedVerdicts.delete(key);
          inFlightKeys.add(key);
          if (!reconciler.started) {
            await reconciler.start();
          }
          // The store phase ends when the journal records what the store answered;
          // the reconcile pass inside requestPurchase then reports the server phases.
          let platformReported = false;
          let serverRequested = false;
          let serverResulted = false;
          const reportPlatform = (status: PurchaseResult['status']): void => {
            if (!platformReported) {
              platformReported = true;
              progress.platformResult(status);
            }
          };
          const unsubscribe = reconciler.subscribe((event) => {
            if (event.type === 'failure' || event.record.idempotencyKey !== key) {
              return;
            }
            if (event.type === 'transition') {
              const { state } = event.record;
              if (state === 'purchased') {
                reportPlatform('completed');
              } else if (state === 'pending' && event.previous === 'launched') {
                reportPlatform('pending');
              } else if ((state === 'cancelled' || state === 'failed') && event.previous !== 'verifying') {
                reportPlatform(state);
              }
            } else if (event.type === 'verify-requested') {
              reportPlatform('completed');
              // A server-owned finish may re-read finalization in the same
              // pass; the server phase is reported once per call.
              if (!serverRequested) {
                serverRequested = true;
                progress.serverRequested();
              }
            } else if (!serverResulted) {
              serverResulted = true;
              progress.serverResult(event.response.verified);
            }
          });
          try {
            progress.platformRequested();
            const outcome = await reconciler.requestPurchase({
              logicalId: purchaseInput.productId,
              idempotencyKey: key,
              source: purchaseInput.source,
            });
            reportPlatform(
              outcome.outcome === 'launched'
                ? 'pending'
                : outcome.outcome === 'purchased'
                  ? (outcome.purchase.state === 'purchased' ? 'completed' : 'pending')
                  : outcome.outcome,
            );
            const record = await reconciler.read(key);
            const result: GameServicesPurchaseResult = record === undefined
              ? {
                  status: 'failed',
                  purchase: {
                    status: 'failed',
                    entitlementIds: [],
                    ...(outcome.outcome === 'cancelled' || outcome.outcome === 'failed'
                      ? { diagnostic: { code: outcome.error.code, retryable: outcome.error.retryable } }
                      : {}),
                  },
                }
              : toGameServicesPurchaseResult(record);
            if (!trackedVerdicts.has(key)) {
              // The call ended without a backend verdict (the store answers later,
              // or a journaled attempt was replayed); report the status it returns.
              await analytics.track({
                name: result.status === 'granted'
                  ? 'purchase_granted'
                  : result.status === 'pending'
                    ? 'purchase_pending'
                    : 'purchase_rejected',
                properties: {
                  productId: purchaseInput.productId,
                  status: result.status,
                  ledgerEntryId: result.ledgerEntryId,
                  alreadyProcessed: result.verification?.alreadyProcessed,
                  reason: result.status === 'pending'
                    ? 'purchase_pending'
                    : (result.verification?.reason ?? record?.error?.code),
                },
              });
            }
            return result;
          } finally {
            unsubscribe();
            inFlightKeys.delete(key);
            trackedVerdicts.delete(key);
          }
        });
      }
      // No commerce provider: the target sells nothing through this gateway.
      // The reconciler is the only purchase path, so there is no fallback that
      // could grant from a platform callback; fail closed without store UI.
      return observeGameServicesOperation('purchase', options, async (): Promise<GameServicesPurchaseResult> => {
        const purchase = {
          status: 'failed',
          entitlementIds: [],
        } satisfies PurchaseResult;

        await analytics.track({
          name: 'purchase_rejected',
          properties: {
            productId: purchaseInput.productId,
            status: purchase.status,
            reason: 'commerce_unavailable',
          },
        });

        return {
          status: 'rejected',
          purchase,
        };
      });
    },

    async claimRewardedAd(rewardInput, options) {
      return observeGameServicesOperation('rewarded-ad', options, async (progress): Promise<GameServicesRewardedAdResult> => {
        const target = input.target;

        progress.platformRequested();
        const reward = await input.gateway.ads.showRewarded(rewardInput);
        progress.platformResult(reward.status);

        const candidate = resolveClientRewardClaim(reward, rewardEvidenceRegistry, {
          allowLegacyCompletion: allowLegacyRewardCompletion,
        });
        if (candidate === undefined) {
          await analytics.track({
            name: reward.status === 'pending' ? 'rewarded_ad_pending' : 'rewarded_ad_rejected',
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

        const platformImpressionId = candidate.platformImpressionId;
        const claimRequest: ClaimAdRewardRequest = {
          target,
          ...(input.gateway.ads.provider === undefined ? {} : { providerId: input.gateway.ads.provider.id }),
          ...(input.deploymentTarget === undefined || input.deploymentTarget === target
            ? {}
            : { deploymentTarget: input.deploymentTarget }),
          playerId: input.playerId,
          placementId: rewardInput.placementId,
          ...(platformImpressionId === undefined
            ? {}
            : { platformImpressionId }),
          idempotencyKey: rewardInput.idempotencyKey,
          completedAt: requestNow(),
          ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
        };
        progress.serverRequested();
        const claim = await input.backend.adRewards.claimAdReward(claimRequest);
        progress.serverResult(claim.granted);

        const result = {
          status: claim.granted ? 'granted' : (claim.disposition ?? 'rejected'),
          reward,
          claim,
          ...(claim.ledgerEntryId === undefined ? {} : { ledgerEntryId: claim.ledgerEntryId }),
        } satisfies GameServicesRewardedAdResult;

        await analytics.track({
          name: claim.granted ? 'rewarded_ad_granted' : claim.disposition === 'pending' ? 'rewarded_ad_pending' : 'rewarded_ad_rejected',
          properties: {
            placementId: rewardInput.placementId,
            status: result.status,
            ledgerEntryId: claim.ledgerEntryId,
            alreadyProcessed: claim.alreadyProcessed,
            reason: claim.reason,
          },
        });

        return result;
      });
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
      async getPurchaseLedgerStatus(body) {
        return sendGameServicesBackendRequest<
          PurchaseLedgerStatusRequest,
          PurchaseLedgerStatusResponse
        >(input.transport, gameServicesBackendEndpoints.getPurchaseLedgerStatus, body);
      },
      async getCommerceCapabilities() {
        return sendGameServicesBackendRequest<Record<string, never>, CommerceServiceCapabilities>(
          input.transport,
          gameServicesBackendEndpoints.getCommerceCapabilities,
          {},
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
        >(input.transport, gameServicesBackendEndpoints.recordLeaderboardScore, body);
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
      const headers = await resolveGameServicesRequestHeaders({
        headers: input.headers,
        getHeaders: input.getHeaders,
        requestHeaders: request.headers,
      });
      const response = await fetcher(joinUrl(input.baseUrl, request.endpoint), {
        method: request.method,
        headers: {
          ...headers,
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
    ...(input.headers === undefined && input.getHeaders === undefined
      ? {}
      : {
          headers: () => resolveGameServicesRequestHeaders(input),
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
      getPurchaseLedgerStatus(input) {
        return client.commerce.getPurchaseLedgerStatus(input);
      },
      getCommerceCapabilities() {
        return client.commerce.getCapabilities();
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

function isGameServicesLeaderboardTarget(
  target: GameServicesLedgerTarget,
): target is GameServicesLeaderboardTarget {
  return target === 'browser'
    || target === 'microsoft-store'
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
  let response: GameServicesBackendTransportResponse;
  try {
    response = await transport.send({
      method: 'POST',
      endpoint,
      body,
    });
  } catch (error) {
    if (error instanceof GameServicesHeaderResolutionError) {
      throw error;
    }
    // Do not leak SDK or native transport exceptions (which can contain
    // request headers); the caller must reconcile uncertain server outcomes.
    throw new GameServicesBackendTransportError(endpoint);
  }

  if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599
    || !Object.hasOwn(response, 'body')) {
    throw new GameServicesBackendTransportError(endpoint);
  }

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
