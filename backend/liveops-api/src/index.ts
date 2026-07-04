import type { AdPlacements } from '@mpgd/ad-placements';
import { claimAdReward } from '@mpgd/backend-ad-reward-ledger';
import {
  createInMemoryEntitlementLedger,
  type EntitlementLedger,
} from '@mpgd/backend-entitlement-ledger';
import {
  createInMemoryLeaderboardLedger,
  type LeaderboardLedger,
} from '@mpgd/backend-leaderboard-ledger';
import { verifyPurchase } from '@mpgd/backend-purchase-verifier';
import {
  liveOpsBackendEndpoints,
  type LiveOpsBackendEndpoint,
  type LiveOpsBackendTransport,
  type LiveOpsBackendTransportRequest,
  type LiveOpsBackendTransportResponse,
} from '@mpgd/liveops-client';
import type { ProductCatalog } from '@mpgd/product-catalog';

export interface CreateLiveOpsBackendApiHandlerInput {
  readonly catalog: ProductCatalog;
  readonly placements: AdPlacements;
  readonly entitlementLedger?: EntitlementLedger;
  readonly leaderboardLedger?: LeaderboardLedger;
  readonly now?: () => string;
}

export interface LiveOpsBackendApiHandler {
  handle(
    request: LiveOpsBackendTransportRequest,
  ): Promise<LiveOpsBackendTransportResponse>;
}

export interface LiveOpsBackendErrorResponse {
  readonly error: string;
}

export function createLiveOpsBackendApiHandler(
  input: CreateLiveOpsBackendApiHandlerInput,
): LiveOpsBackendApiHandler {
  const entitlementLedger = input.entitlementLedger ?? createInMemoryEntitlementLedger();
  const leaderboardLedger = input.leaderboardLedger ?? createInMemoryLeaderboardLedger();

  return {
    async handle(request) {
      if (request.method !== 'POST') {
        return errorResponse(405, 'METHOD_NOT_ALLOWED');
      }

      try {
        const context = {
          catalog: input.catalog,
          placements: input.placements,
          entitlementLedger,
          leaderboardLedger,
          ...(input.now === undefined ? {} : { now: input.now }),
        };

        return routeLiveOpsRequest(request.endpoint, request.body, context);
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : 'BAD_REQUEST',
        );
      }
    },
  };
}

export function createInProcessLiveOpsBackendTransport(
  handler: LiveOpsBackendApiHandler,
): LiveOpsBackendTransport {
  return {
    async send(request) {
      return handler.handle(request) as Promise<LiveOpsBackendTransportResponse<unknown>>;
    },
  };
}

function routeLiveOpsRequest(
  endpoint: LiveOpsBackendEndpoint,
  body: unknown,
  context: Required<Pick<CreateLiveOpsBackendApiHandlerInput, 'catalog' | 'placements'>> & {
    readonly entitlementLedger: EntitlementLedger;
    readonly leaderboardLedger: LeaderboardLedger;
    readonly now?: () => string;
  },
): LiveOpsBackendTransportResponse {
  switch (endpoint) {
    case liveOpsBackendEndpoints.verifyPurchase:
      return okResponse(
        verifyPurchase(body as Parameters<typeof verifyPurchase>[0], {
          catalog: context.catalog,
          ledger: context.entitlementLedger,
          ...(context.now === undefined ? {} : { now: context.now }),
        }),
      );
    case liveOpsBackendEndpoints.claimAdReward:
      return okResponse(
        claimAdReward(body as Parameters<typeof claimAdReward>[0], {
          placements: context.placements,
          ledger: context.entitlementLedger,
          ...(context.now === undefined ? {} : { now: context.now }),
        }),
      );
    case liveOpsBackendEndpoints.recordLeaderboardScore:
      return okResponse(
        context.leaderboardLedger.recordScore(
          body as Parameters<LeaderboardLedger['recordScore']>[0],
        ),
      );
  }

  return errorResponse(404, 'UNKNOWN_ENDPOINT');
}

function okResponse(body: unknown): LiveOpsBackendTransportResponse {
  return {
    status: 200,
    body,
  };
}

function errorResponse(
  status: number,
  error: string,
): LiveOpsBackendTransportResponse<LiveOpsBackendErrorResponse> {
  return {
    status,
    body: {
      error,
    },
  };
}
