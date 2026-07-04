import { implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';

import type { AdPlacements } from '@mpgd/ad-placements';
import {
  assertClaimAdRewardRequest,
  assertClaimAdRewardResponse,
  type ClaimAdRewardRequest,
  type ClaimAdRewardResponse,
} from '@mpgd/backend-ad-reward-ledger';
import {
  assertEntitlementLedgerGrant,
  assertEntitlementLedgerResult,
  assertProductGrantTransaction,
  type EntitlementLedgerGrant,
  type EntitlementLedgerPayload,
  type EntitlementLedgerResult,
  type ProductGrantTransaction,
} from '@mpgd/backend-entitlement-ledger';
import {
  assertLeaderboardScoreTransaction,
  assertRecordLeaderboardScoreRequest,
  assertRecordLeaderboardScoreResponse,
  type LeaderboardScoreTransaction,
  type RecordLeaderboardScoreRequest,
  type RecordLeaderboardScoreResponse,
} from '@mpgd/backend-leaderboard-ledger';
import {
  assertVerifyPurchaseRequest,
  assertVerifyPurchaseResponse,
  type VerifyPurchaseRequest,
  type VerifyPurchaseResponse,
} from '@mpgd/backend-purchase-verifier';
import {
  gameServicesBackendEndpoints,
  type GameServicesBackendApi,
  type GameServicesBackendEndpoint,
  type GameServicesBackendTransport,
  type GameServicesBackendTransportRequest,
  type GameServicesBackendTransportResponse,
} from '@mpgd/game-services-client';
import {
  gameServicesContract,
  type GameServicesHealthResponse,
} from '@mpgd/game-services-contract';
import type { ProductCatalog } from '@mpgd/product-catalog';

type CorsHeaders = Record<string, string>;

export interface CreateGameServicesBackendInput {
  readonly catalog: ProductCatalog;
  readonly placements: AdPlacements;
  readonly store?: GameServicesStore;
  readonly now?: () => string;
  readonly version?: string;
}

export interface GameServicesBackendApiHandler {
  handle(
    request: GameServicesBackendTransportRequest,
  ): Promise<GameServicesBackendTransportResponse>;
}

export interface GameServicesBackendErrorResponse {
  readonly error: string;
}

export interface GameServicesStore {
  recordEntitlementGrant(input: EntitlementLedgerGrant): Promise<EntitlementLedgerResult>;
  getEntitlementTransaction(
    ledgerEntryId: string,
  ): Promise<ProductGrantTransaction | undefined>;
  listEntitlementTransactions(): Promise<readonly ProductGrantTransaction[]>;
  recordLeaderboardScore(
    input: RecordLeaderboardScoreRequest,
    options?: { readonly recordedAt?: string },
  ): Promise<RecordLeaderboardScoreResponse>;
  getLeaderboardTransaction(
    ledgerEntryId: string,
  ): Promise<LeaderboardScoreTransaction | undefined>;
  listLeaderboardTransactions(): Promise<readonly LeaderboardScoreTransaction[]>;
}

export interface CreateGameServicesFetchHandlerOptions {
  readonly corsHeaders?: CorsHeaders;
  readonly healthPath?: string;
}

export interface CreateGameServicesRpcFetchHandlerOptions
  extends CreateGameServicesFetchHandlerOptions {
  readonly prefix?: string;
}

export interface GameServicesOrpcContext {
  readonly request?: Request;
}

export class InMemoryGameServicesStore implements GameServicesStore {
  private readonly entitlementTransactionsByKey = new Map<string, ProductGrantTransaction>();
  private readonly entitlementTransactionsById = new Map<string, ProductGrantTransaction>();
  private readonly leaderboardTransactionsByRun = new Map<string, LeaderboardScoreTransaction>();
  private readonly leaderboardTransactionsById = new Map<string, LeaderboardScoreTransaction>();

  async recordEntitlementGrant(
    input: EntitlementLedgerGrant,
  ): Promise<EntitlementLedgerResult> {
    const grant = assertEntitlementLedgerGrant(input);
    const key = createEntitlementIdempotencyKey(grant);
    const existing = this.entitlementTransactionsByKey.get(key);

    if (existing !== undefined) {
      return assertEntitlementLedgerResult({
        ledgerEntryId: existing.ledgerEntryId,
        alreadyProcessed: true,
      });
    }

    const transaction = createEntitlementTransaction(grant);
    this.entitlementTransactionsByKey.set(key, transaction);
    this.entitlementTransactionsById.set(transaction.ledgerEntryId, transaction);

    return assertEntitlementLedgerResult({
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: false,
    });
  }

  async getEntitlementTransaction(
    ledgerEntryId: string,
  ): Promise<ProductGrantTransaction | undefined> {
    return this.entitlementTransactionsById.get(ledgerEntryId);
  }

  async listEntitlementTransactions(): Promise<readonly ProductGrantTransaction[]> {
    return [...this.entitlementTransactionsById.values()];
  }

  async recordLeaderboardScore(
    input: RecordLeaderboardScoreRequest,
    options: { readonly recordedAt?: string } = {},
  ): Promise<RecordLeaderboardScoreResponse> {
    const request = assertRecordLeaderboardScoreRequest(input);
    const runKey = createLeaderboardRunKey(request);
    const existing = this.leaderboardTransactionsByRun.get(runKey);

    if (existing !== undefined) {
      return assertRecordLeaderboardScoreResponse({
        submitted: true,
        ledgerEntryId: existing.ledgerEntryId,
        alreadyProcessed: true,
        rank: this.rankFor(existing),
      });
    }

    const transaction = assertLeaderboardScoreTransaction({
      ...request,
      ledgerEntryId: createLeaderboardLedgerEntryId(request),
      recordedAt: options.recordedAt ?? new Date().toISOString(),
    });

    this.leaderboardTransactionsByRun.set(runKey, transaction);
    this.leaderboardTransactionsById.set(transaction.ledgerEntryId, transaction);

    return assertRecordLeaderboardScoreResponse({
      submitted: true,
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: false,
      rank: this.rankFor(transaction),
    });
  }

  async getLeaderboardTransaction(
    ledgerEntryId: string,
  ): Promise<LeaderboardScoreTransaction | undefined> {
    return this.leaderboardTransactionsById.get(ledgerEntryId);
  }

  async listLeaderboardTransactions(): Promise<readonly LeaderboardScoreTransaction[]> {
    return this.sortedLeaderboardTransactions();
  }

  private rankFor(transaction: LeaderboardScoreTransaction): number {
    return (
      this.sortedLeaderboardTransactions()
        .filter((candidate) => candidate.leaderboardId === transaction.leaderboardId)
        .findIndex((candidate) => candidate.ledgerEntryId === transaction.ledgerEntryId) + 1
    );
  }

  private sortedLeaderboardTransactions(): readonly LeaderboardScoreTransaction[] {
    return [...this.leaderboardTransactionsById.values()].sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.submittedAt.localeCompare(right.submittedAt);
    });
  }
}

export function createInMemoryGameServicesStore(): InMemoryGameServicesStore {
  return new InMemoryGameServicesStore();
}

export function createGameServicesBackend(
  input: CreateGameServicesBackendInput,
): GameServicesBackendApi {
  const store = input.store ?? createInMemoryGameServicesStore();
  const now = input.now ?? (() => new Date().toISOString());

  return {
    purchases: {
      verifyPurchase(request) {
        return verifyPurchaseWithStore(request, {
          catalog: input.catalog,
          store,
          now,
        });
      },
    },
    adRewards: {
      claimAdReward(request) {
        return claimAdRewardWithStore(request, {
          placements: input.placements,
          store,
          now,
        });
      },
    },
    leaderboard: {
      recordScore(request) {
        return recordLeaderboardScoreWithStore(request, {
          store,
          now,
        });
      },
    },
  };
}

export function createGameServicesBackendApiHandler(
  input: CreateGameServicesBackendInput,
): GameServicesBackendApiHandler {
  const backend = createGameServicesBackend(input);

  return {
    async handle(request) {
      if (request.method !== 'POST') {
        return errorResponse(405, 'METHOD_NOT_ALLOWED');
      }

      try {
        return routeGameServicesRequest(request.endpoint, request.body, backend);
      } catch (error) {
        return errorResponse(
          400,
          error instanceof Error ? error.message : 'BAD_REQUEST',
        );
      }
    },
  };
}

export function createInProcessGameServicesBackendTransport(
  handler: GameServicesBackendApiHandler,
): GameServicesBackendTransport {
  return {
    async send(request) {
      return handler.handle(request) as Promise<GameServicesBackendTransportResponse<unknown>>;
    },
  };
}

export function createGameServicesRouter(backend: GameServicesBackendApi) {
  const contract = implement(gameServicesContract).$context<GameServicesOrpcContext>();

  return contract.router({
    health: contract.health.handler(() => createHealthResponse()),
    commerce: contract.commerce.router({
      verifyPurchase: contract.commerce.verifyPurchase.handler(({ input }) => {
        return backend.purchases.verifyPurchase(input);
      }),
    }),
    ads: contract.ads.router({
      claimReward: contract.ads.claimReward.handler(({ input }) => {
        return backend.adRewards.claimAdReward(input);
      }),
    }),
    leaderboard: contract.leaderboard.router({
      recordScore: contract.leaderboard.recordScore.handler(({ input }) => {
        return backend.leaderboard.recordScore(input);
      }),
    }),
  });
}

export function createGameServicesRpcFetchHandler(
  router: ReturnType<typeof createGameServicesRouter>,
  options: CreateGameServicesRpcFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const rpcHandler = new RPCHandler<GameServicesOrpcContext>(router as never);
  const prefix = options.prefix ?? '/rpc';
  const healthPath = options.healthPath ?? '/health';

  return async (request) => {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === healthPath) {
      return jsonResponse(createHealthResponse(), 200, options.corsHeaders);
    }

    if (request.method === 'OPTIONS') {
      return emptyResponse(204, options.corsHeaders);
    }

    const result = await rpcHandler.handle(
      request,
      {
        prefix,
        context: {
          request,
        },
      } as never,
    );

    if (!result.matched) {
      return textResponse('Not Found', 404, options.corsHeaders);
    }

    return withCors(result.response, options.corsHeaders);
  };
}

export function createGameServicesHttpFetchHandler(
  handler: GameServicesBackendApiHandler,
  options: CreateGameServicesFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const healthPath = options.healthPath ?? '/health';

  return async (request) => {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === healthPath) {
      return jsonResponse(createHealthResponse(), 200, options.corsHeaders);
    }

    if (request.method === 'OPTIONS') {
      return emptyResponse(204, options.corsHeaders);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405, options.corsHeaders);
    }

    if (!isGameServicesBackendEndpoint(requestUrl.pathname)) {
      return jsonResponse({ error: 'UNKNOWN_ENDPOINT' }, 404, options.corsHeaders);
    }

    const response = await handler.handle({
      method: 'POST',
      endpoint: requestUrl.pathname,
      body: await readRequestJson(request),
    });

    return jsonResponse(response.body, response.status, options.corsHeaders);
  };
}

async function verifyPurchaseWithStore(
  input: VerifyPurchaseRequest,
  context: {
    readonly catalog: ProductCatalog;
    readonly store: GameServicesStore;
    readonly now: () => string;
  },
): Promise<VerifyPurchaseResponse> {
  const request = assertVerifyPurchaseRequest(input);
  const product = context.catalog.products.find((entry) => entry.id === request.productId);

  if (product === undefined) {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'UNKNOWN_PRODUCT',
    });
  }

  const platformProductId = product.platformProductIds[request.target];

  if (platformProductId === undefined) {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'PRODUCT_NOT_AVAILABLE_ON_TARGET',
    });
  }

  const grant = await context.store.recordEntitlementGrant({
    playerId: request.playerId,
    grantId: product.id,
    source: 'purchase',
    idempotencyKey: request.idempotencyKey,
    grantedAt: context.now(),
    grant: product.grant,
    payload: {
      target: request.target,
      productId: request.productId,
      platformProductId,
      platformTransactionId: request.platformTransactionId,
      purchasedAt: request.purchasedAt,
    },
  });

  return assertVerifyPurchaseResponse({
    verified: true,
    ledgerEntryId: grant.ledgerEntryId,
    alreadyProcessed: grant.alreadyProcessed,
  });
}

async function claimAdRewardWithStore(
  input: ClaimAdRewardRequest,
  context: {
    readonly placements: AdPlacements;
    readonly store: GameServicesStore;
    readonly now: () => string;
  },
): Promise<ClaimAdRewardResponse> {
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

  const result = await context.store.recordEntitlementGrant({
    playerId: request.playerId,
    grantId: request.placementId,
    source: 'ad_reward',
    idempotencyKey: request.idempotencyKey,
    grantedAt: context.now(),
    payload,
  });

  return assertClaimAdRewardResponse({
    granted: true,
    ledgerEntryId: result.ledgerEntryId,
    alreadyProcessed: result.alreadyProcessed,
  });
}

async function recordLeaderboardScoreWithStore(
  input: RecordLeaderboardScoreRequest,
  context: {
    readonly store: GameServicesStore;
    readonly now: () => string;
  },
): Promise<RecordLeaderboardScoreResponse> {
  return context.store.recordLeaderboardScore(assertRecordLeaderboardScoreRequest(input), {
    recordedAt: context.now(),
  });
}

async function routeGameServicesRequest(
  endpoint: GameServicesBackendEndpoint,
  body: unknown,
  backend: GameServicesBackendApi,
): Promise<GameServicesBackendTransportResponse> {
  switch (endpoint) {
    case gameServicesBackendEndpoints.verifyPurchase:
      return okResponse(await backend.purchases.verifyPurchase(body as VerifyPurchaseRequest));
    case gameServicesBackendEndpoints.claimAdReward:
      return okResponse(await backend.adRewards.claimAdReward(body as ClaimAdRewardRequest));
    case gameServicesBackendEndpoints.recordLeaderboardScore:
      return okResponse(
        await backend.leaderboard.recordScore(body as RecordLeaderboardScoreRequest),
      );
  }

  return errorResponse(404, 'UNKNOWN_ENDPOINT');
}

function okResponse(body: unknown): GameServicesBackendTransportResponse {
  return {
    status: 200,
    body,
  };
}

function errorResponse(
  status: number,
  error: string,
): GameServicesBackendTransportResponse<GameServicesBackendErrorResponse> {
  return {
    status,
    body: {
      error,
    },
  };
}

function createHealthResponse(): GameServicesHealthResponse {
  return {
    ok: true,
    service: 'game-services',
    version: '0.0.0',
  };
}

function createEntitlementTransaction(
  grant: EntitlementLedgerGrant,
): ProductGrantTransaction {
  const baseTransaction = {
    ledgerEntryId: createEntitlementLedgerEntryId(grant),
    playerId: grant.playerId,
    grantId: grant.grantId,
    source: grant.source,
    idempotencyKey: grant.idempotencyKey,
    grantedAt: grant.grantedAt,
    payload: grant.payload,
  };

  return assertProductGrantTransaction(
    grant.grant === undefined ? baseTransaction : { ...baseTransaction, grant: grant.grant },
  );
}

function createEntitlementIdempotencyKey(grant: EntitlementLedgerGrant): string {
  return `${grant.source}:${grant.playerId}:${grant.idempotencyKey}`;
}

function createEntitlementLedgerEntryId(grant: EntitlementLedgerGrant): string {
  return [
    'ledger',
    grant.source,
    normalizeIdSegment(grant.playerId),
    normalizeIdSegment(grant.idempotencyKey),
  ].join('_');
}

function createLeaderboardRunKey(request: RecordLeaderboardScoreRequest): string {
  return [
    request.target,
    request.leaderboardId,
    request.playerId,
    request.runId,
  ].join(':');
}

function createLeaderboardLedgerEntryId(request: RecordLeaderboardScoreRequest): string {
  return [
    'leaderboard',
    normalizeIdSegment(request.target),
    normalizeIdSegment(request.leaderboardId),
    normalizeIdSegment(request.playerId),
    normalizeIdSegment(request.runId),
  ].join('_');
}

function normalizeIdSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]+/g, '-').replaceAll(/^-|-$/g, '').slice(0, 48);
}

function isGameServicesBackendEndpoint(pathname: string): pathname is GameServicesBackendEndpoint {
  return Object.values(gameServicesBackendEndpoints).includes(
    pathname as GameServicesBackendEndpoint,
  );
}

async function readRequestJson(request: Request): Promise<unknown> {
  const text = await request.text();

  if (text.length === 0) {
    return {};
  }

  return JSON.parse(text);
}

function jsonResponse(body: unknown, status: number, corsHeaders: CorsHeaders | undefined): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
  });
  applyCorsHeaders(headers, corsHeaders);

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function textResponse(body: string, status: number, corsHeaders: CorsHeaders | undefined): Response {
  const headers = new Headers();
  applyCorsHeaders(headers, corsHeaders);

  return new Response(body, {
    status,
    headers,
  });
}

function emptyResponse(status: number, corsHeaders: CorsHeaders | undefined): Response {
  const headers = new Headers();
  applyCorsHeaders(headers, corsHeaders);

  return new Response(null, {
    status,
    headers,
  });
}

function withCors(response: Response, corsHeaders: CorsHeaders | undefined): Response {
  if (corsHeaders === undefined) {
    return response;
  }

  const headers = new Headers(response.headers);
  applyCorsHeaders(headers, corsHeaders);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyCorsHeaders(headers: Headers, corsHeaders: CorsHeaders | undefined): void {
  if (corsHeaders === undefined) {
    return;
  }

  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
}
