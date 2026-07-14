import { implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';

import { createAnalyticsReporter, type AnalyticsSink } from '@mpgd/analytics';
import type { AdPlacements, ProductCatalog } from '@mpgd/catalog';

import {
  gameServicesBackendEndpoints,
  type GameServicesBackendApi,
  type GameServicesBackendEndpoint,
  type GameServicesBackendTransport,
  type GameServicesBackendTransportRequest,
  type GameServicesBackendTransportResponse,
} from './client';
import { gameServicesContract, type GameServicesHealthResponse } from './contract';
import {
  createRejectingGameServicesEvidenceVerifier,
  type EvidenceVerificationDecision,
  type GameServicesEvidenceVerifier,
} from './evidence-verification';
import {
  assertClaimAdRewardRequest,
  assertClaimAdRewardResponse,
  assertEntitlementLedgerGrant,
  assertEntitlementLedgerResult,
  assertLeaderboardScoreTransaction,
  assertProductGrantTransaction,
  assertRecordLeaderboardScoreRequest,
  assertRecordLeaderboardScoreResponse,
  assertVerifyPurchaseRequest,
  assertVerifyPurchaseResponse,
  type ClaimAdRewardRequest,
  type ClaimAdRewardResponse,
  type EntitlementLedgerGrant,
  type EntitlementLedgerPayload,
  type EntitlementLedgerResult,
  type LeaderboardScoreTransaction,
  type ProductGrantTransaction,
  type RecordLeaderboardScoreRequest,
  type RecordLeaderboardScoreResponse,
  type VerifyPurchaseRequest,
  type VerifyPurchaseResponse,
} from './types';

type CorsHeaders = Record<string, string>;

export interface CreateGameServicesBackendInput {
  readonly catalog: ProductCatalog;
  readonly placements: AdPlacements;
  readonly store?: GameServicesStore;
  readonly analytics?: AnalyticsSink;
  readonly analyticsSessionId?: string;
  readonly now?: () => string;
  readonly version?: string;
  readonly evidenceVerifier?: GameServicesEvidenceVerifier;
  readonly evidenceVerificationTimeoutMs?: number;
}

export interface GameServicesBackendApiHandler {
  readonly version?: string;
  handle(
    request: GameServicesBackendTransportRequest,
  ): Promise<GameServicesBackendTransportResponse>;
}

export interface GameServicesBackendErrorResponse {
  readonly error: string;
}

export interface GameServicesStore {
  recordEntitlementGrant(input: EntitlementLedgerGrant): Promise<EntitlementLedgerResult>;
  findEntitlementTransactionByIdempotency?(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly playerId: string;
    readonly idempotencyKey: string;
  }): Promise<ProductGrantTransaction | undefined>;
  findEntitlementTransactionByEvidenceVerificationId?(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly evidenceVerificationId: string;
  }): Promise<ProductGrantTransaction | undefined>;
  findEntitlementTransactionByPlatformEvidence?(input: EntitlementPlatformEvidenceIdentity):
    Promise<ProductGrantTransaction | undefined>;
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

export interface EntitlementPlatformEvidenceIdentity {
  readonly source: Extract<EntitlementLedgerGrant['source'], 'purchase' | 'ad_reward'>;
  readonly target: string;
  readonly platformEvidenceId: string;
}

export interface CreateGameServicesFetchHandlerOptions {
  readonly corsHeaders?: CorsHeaders;
  readonly healthPath?: string;
  readonly version?: string;
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
  private readonly entitlementTransactionsByEvidence = new Map<string, ProductGrantTransaction>();
  private readonly entitlementTransactionsByPlatformEvidence = new Map<
    string,
    ProductGrantTransaction
  >();
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

    if (grant.evidenceVerificationId !== undefined) {
      const evidenceKey = createEntitlementEvidenceKey({
        source: grant.source,
        evidenceVerificationId: grant.evidenceVerificationId,
      });

      if (this.entitlementTransactionsByEvidence.has(evidenceKey)) {
        throw new EvidenceAlreadyProcessedError();
      }
    }

    const platformEvidenceIdentity = getEntitlementPlatformEvidenceIdentity(grant);
    if (
      platformEvidenceIdentity !== undefined
      && this.entitlementTransactionsByPlatformEvidence.has(
        createEntitlementPlatformEvidenceKey(platformEvidenceIdentity),
      )
    ) {
      throw new EvidenceAlreadyProcessedError();
    }

    const transaction = createEntitlementTransaction(grant);
    this.entitlementTransactionsByKey.set(key, transaction);
    this.entitlementTransactionsById.set(transaction.ledgerEntryId, transaction);
    if (grant.evidenceVerificationId !== undefined) {
      this.entitlementTransactionsByEvidence.set(
        createEntitlementEvidenceKey({
          source: grant.source,
          evidenceVerificationId: grant.evidenceVerificationId,
        }),
        transaction,
      );
    }
    if (platformEvidenceIdentity !== undefined) {
      this.entitlementTransactionsByPlatformEvidence.set(
        createEntitlementPlatformEvidenceKey(platformEvidenceIdentity),
        transaction,
      );
    }

    return assertEntitlementLedgerResult({
      ledgerEntryId: transaction.ledgerEntryId,
      alreadyProcessed: false,
    });
  }

  async findEntitlementTransactionByIdempotency(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly playerId: string;
    readonly idempotencyKey: string;
  }): Promise<ProductGrantTransaction | undefined> {
    return this.entitlementTransactionsByKey.get(createEntitlementIdempotencyKey(input));
  }

  async findEntitlementTransactionByEvidenceVerificationId(input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly evidenceVerificationId: string;
  }): Promise<ProductGrantTransaction | undefined> {
    return this.entitlementTransactionsByEvidence.get(createEntitlementEvidenceKey(input));
  }

  async findEntitlementTransactionByPlatformEvidence(
    input: EntitlementPlatformEvidenceIdentity,
  ): Promise<ProductGrantTransaction | undefined> {
    return this.entitlementTransactionsByPlatformEvidence.get(
      createEntitlementPlatformEvidenceKey(input),
    );
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

export class EvidenceAlreadyProcessedError extends Error {
  constructor() {
    super('Evidence verification identity has already been processed.');
    this.name = 'EvidenceAlreadyProcessedError';
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
  const version = input.version ?? '0.0.0';
  const evidenceVerifier = input.evidenceVerifier ?? createRejectingGameServicesEvidenceVerifier();
  const evidenceVerificationTimeoutMs = resolveEvidenceVerificationTimeout(
    input.evidenceVerificationTimeoutMs,
  );
  const analytics = createAnalyticsReporter({
    target: 'server',
    sessionId: input.analyticsSessionId ?? 'game-services',
    now,
    ...(input.analytics === undefined ? {} : { sink: input.analytics }),
  });

  return {
    version,
    purchases: {
      async verifyPurchase(request) {
        const verification = await verifyPurchaseWithStore(request, {
          catalog: input.catalog,
          store,
          now,
          evidenceVerifier,
          evidenceVerificationTimeoutMs,
        });

        await analytics.track({
          name: verification.verified ? 'purchase_granted' : 'purchase_rejected',
          properties: {
            target: request.target,
            playerId: request.playerId,
            productId: request.productId,
            ledgerEntryId: verification.ledgerEntryId,
            alreadyProcessed: verification.alreadyProcessed,
            reason: verification.reason,
          },
        });

        return verification;
      },
    },
    adRewards: {
      async claimAdReward(request) {
        const claim = await claimAdRewardWithStore(request, {
          placements: input.placements,
          store,
          now,
          evidenceVerifier,
          evidenceVerificationTimeoutMs,
        });

        await analytics.track({
          name: claim.granted ? 'rewarded_ad_granted' : 'rewarded_ad_rejected',
          properties: {
            target: request.target,
            playerId: request.playerId,
            placementId: request.placementId,
            ledgerEntryId: claim.ledgerEntryId,
            alreadyProcessed: claim.alreadyProcessed,
            reason: claim.reason,
          },
        });

        return claim;
      },
    },
    leaderboard: {
      async recordScore(request) {
        const record = await recordLeaderboardScoreWithStore(request, {
          store,
          now,
        });

        await analytics.track({
          name: 'leaderboard_recorded',
          properties: {
            target: request.target,
            playerId: request.playerId,
            leaderboardId: request.leaderboardId,
            score: request.score,
            ledgerEntryId: record.ledgerEntryId,
            alreadyProcessed: record.alreadyProcessed,
            rank: record.rank,
          },
        });

        return record;
      },
    },
  };
}

export function createGameServicesBackendApiHandler(
  input: CreateGameServicesBackendInput,
): GameServicesBackendApiHandler {
  const backend = createGameServicesBackend(input);

  return {
    ...(backend.version === undefined ? {} : { version: backend.version }),
    async handle(request) {
      if (request.method !== 'POST') {
        return errorResponse(405, 'METHOD_NOT_ALLOWED');
      }

      try {
        return await routeGameServicesRequest(request.endpoint, request.body, backend);
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
    health: contract.health.handler(() => createHealthResponse(backend.version)),
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
      return jsonResponse(createHealthResponse(options.version), 200, options.corsHeaders);
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
      return jsonResponse(
        createHealthResponse(options.version ?? handler.version),
        200,
        options.corsHeaders,
      );
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

    try {
      const response = await handler.handle({
        method: 'POST',
        endpoint: requestUrl.pathname,
        body: await readRequestJson(request),
      });

      return jsonResponse(response.body, response.status, options.corsHeaders);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : 'BAD_REQUEST' },
        400,
        options.corsHeaders,
      );
    }
  };
}

async function verifyPurchaseWithStore(
  input: VerifyPurchaseRequest,
  context: {
    readonly catalog: ProductCatalog;
    readonly store: GameServicesStore;
    readonly now: () => string;
    readonly evidenceVerifier: GameServicesEvidenceVerifier;
    readonly evidenceVerificationTimeoutMs: number;
  },
): Promise<VerifyPurchaseResponse> {
  const request = assertVerifyPurchaseRequest(input);
  const retryIdentity = {
    source: 'purchase',
    playerId: request.playerId,
    idempotencyKey: request.idempotencyKey,
    grantId: request.productId,
    target: request.target,
  } as const;
  const existing = await findEntitlementTransactionByIdempotency(context.store, retryIdentity);

  if (existing !== undefined) {
    if (!matchesEntitlementRetry(existing, retryIdentity)) {
      return assertVerifyPurchaseResponse({
        verified: false,
        alreadyProcessed: false,
        reason: 'IDEMPOTENCY_KEY_CONFLICT',
      });
    }

    return assertVerifyPurchaseResponse({
      verified: true,
      ledgerEntryId: existing.ledgerEntryId,
      alreadyProcessed: true,
    });
  }

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

  const verification = await verifyEvidence((signal) => {
    return context.evidenceVerifier.verifyPurchase({
      request,
      product,
      platformProductId,
      signal,
      timeoutMs: context.evidenceVerificationTimeoutMs,
    });
  }, context.evidenceVerificationTimeoutMs);

  if (verification.status !== 'verified') {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: verification.status === 'pending'
        ? (verification.reason ?? 'EVIDENCE_PENDING')
        : verification.reason,
    });
  }

  const grant = await recordEntitlementGrantWithEvidence(context.store, {
    playerId: request.playerId,
    grantId: product.id,
    source: 'purchase',
    idempotencyKey: request.idempotencyKey,
    grantedAt: context.now(),
    grant: product.grant,
    evidenceVerificationId: verification.verificationId,
    payload: {
      ...verification.payload,
      target: request.target,
      productId: request.productId,
      platformProductId,
      platformTransactionId: request.platformTransactionId,
      purchasedAt: request.purchasedAt,
      evidenceVerificationId: verification.verificationId,
      evidenceVerifiedAt: verification.verifiedAt,
    },
  });

  if (grant.status === 'evidence_already_processed') {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'EVIDENCE_ALREADY_PROCESSED',
    });
  }

  if (
    grant.result.alreadyProcessed
    && !await recordedEntitlementMatchesRetry(context.store, grant.result, retryIdentity)
  ) {
    return assertVerifyPurchaseResponse({
      verified: false,
      alreadyProcessed: false,
      reason: 'IDEMPOTENCY_KEY_CONFLICT',
    });
  }

  return assertVerifyPurchaseResponse({
    verified: true,
    ledgerEntryId: grant.result.ledgerEntryId,
    alreadyProcessed: grant.result.alreadyProcessed,
  });
}

async function claimAdRewardWithStore(
  input: ClaimAdRewardRequest,
  context: {
    readonly placements: AdPlacements;
    readonly store: GameServicesStore;
    readonly now: () => string;
    readonly evidenceVerifier: GameServicesEvidenceVerifier;
    readonly evidenceVerificationTimeoutMs: number;
  },
): Promise<ClaimAdRewardResponse> {
  const request = assertClaimAdRewardRequest(input);
  const retryIdentity = {
    source: 'ad_reward',
    playerId: request.playerId,
    idempotencyKey: request.idempotencyKey,
    grantId: request.placementId,
    target: request.target,
  } as const;
  const existing = await findEntitlementTransactionByIdempotency(context.store, retryIdentity);

  if (existing !== undefined) {
    if (!matchesEntitlementRetry(existing, retryIdentity)) {
      return assertClaimAdRewardResponse({
        granted: false,
        alreadyProcessed: false,
        reason: 'IDEMPOTENCY_KEY_CONFLICT',
      });
    }

    return assertClaimAdRewardResponse({
      granted: true,
      ledgerEntryId: existing.ledgerEntryId,
      alreadyProcessed: true,
    });
  }

  const placement = context.placements.placements.find((entry) => entry.id === request.placementId);

  if (placement === undefined || placement.type !== 'rewarded' || placement.reward === undefined) {
    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
      reason: placement === undefined ? 'UNKNOWN_PLACEMENT' : 'NOT_REWARDED_PLACEMENT',
    });
  }

  const platformPlacementId = placement.platformPlacementIds[request.target];
  const verification = await verifyEvidence((signal) => {
    return context.evidenceVerifier.verifyAdReward({
      request,
      placement,
      ...(platformPlacementId === undefined ? {} : { platformPlacementId }),
      signal,
      timeoutMs: context.evidenceVerificationTimeoutMs,
    });
  }, context.evidenceVerificationTimeoutMs);

  if (verification.status !== 'verified') {
    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
      reason: verification.status === 'pending'
        ? (verification.reason ?? 'EVIDENCE_PENDING')
        : verification.reason,
    });
  }

  const payload: EntitlementLedgerPayload = {
    ...verification.payload,
    target: request.target,
    placementId: request.placementId,
    rewardType: placement.reward.type,
    amount: placement.reward.amount,
    completedAt: request.completedAt,
    evidenceVerificationId: verification.verificationId,
    evidenceVerifiedAt: verification.verifiedAt,
  };

  if (placement.reward.type === 'currency') {
    payload.currency = placement.reward.currency;
  }

  if (request.platformImpressionId !== undefined) {
    payload.platformImpressionId = request.platformImpressionId;
  }

  const result = await recordEntitlementGrantWithEvidence(context.store, {
    playerId: request.playerId,
    grantId: request.placementId,
    source: 'ad_reward',
    idempotencyKey: request.idempotencyKey,
    grantedAt: context.now(),
    evidenceVerificationId: verification.verificationId,
    payload,
  });

  if (result.status === 'evidence_already_processed') {
    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
      reason: 'EVIDENCE_ALREADY_PROCESSED',
    });
  }

  if (
    result.result.alreadyProcessed
    && !await recordedEntitlementMatchesRetry(context.store, result.result, retryIdentity)
  ) {
    return assertClaimAdRewardResponse({
      granted: false,
      alreadyProcessed: false,
      reason: 'IDEMPOTENCY_KEY_CONFLICT',
    });
  }

  return assertClaimAdRewardResponse({
    granted: true,
    ledgerEntryId: result.result.ledgerEntryId,
    alreadyProcessed: result.result.alreadyProcessed,
  });
}

async function verifyEvidence(
  verify: (signal: AbortSignal) => Promise<EvidenceVerificationDecision>,
  timeoutMs: number,
): Promise<EvidenceVerificationDecision> {
  const controller = new AbortController();
  const timeoutDecision = {
    status: 'rejected',
    reason: 'EVIDENCE_VERIFIER_TIMEOUT',
  } as const satisfies EvidenceVerificationDecision;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      verify(controller.signal)
        .then(assertEvidenceVerificationDecision)
        .catch((error: unknown) => {
          if (timedOut) {
            return timeoutDecision;
          }

          throw error;
        }),
      new Promise<EvidenceVerificationDecision>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve(timeoutDecision);
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch {
    return {
      status: 'rejected',
      reason: 'EVIDENCE_VERIFIER_ERROR',
    };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function assertEvidenceVerificationDecision(
  decision: EvidenceVerificationDecision,
): EvidenceVerificationDecision {
  if (decision.status === 'verified') {
    assertNonEmptyDecisionString(decision.verificationId, 'verificationId');
    assertNonEmptyDecisionString(decision.verifiedAt, 'verifiedAt');
    if (!Number.isFinite(Date.parse(decision.verifiedAt))) {
      throw new Error('Evidence verification verifiedAt must be a valid timestamp.');
    }
    if (decision.payload !== undefined) {
      if (
        typeof decision.payload !== 'object'
        || decision.payload === null
        || Array.isArray(decision.payload)
      ) {
        throw new Error('Evidence verification payload must be a record.');
      }

      for (const [key, value] of Object.entries(decision.payload)) {
        if (
          typeof value !== 'string'
          && (typeof value !== 'number' || !Number.isFinite(value))
          && typeof value !== 'boolean'
        ) {
          throw new Error(`Evidence verification payload.${key} must be primitive.`);
        }
      }
    }
    return decision;
  }

  if (decision.status === 'pending') {
    if (decision.reason !== undefined) {
      assertNonEmptyDecisionString(decision.reason, 'reason');
    }
    return decision;
  }

  if (decision.status === 'rejected') {
    assertNonEmptyDecisionString(decision.reason, 'reason');
    return decision;
  }

  throw new Error('Unknown evidence verification status.');
}

async function recordEntitlementGrantWithEvidence(
  store: GameServicesStore,
  grant: EntitlementLedgerGrant,
): Promise<
  | { readonly status: 'recorded'; readonly result: EntitlementLedgerResult }
  | { readonly status: 'evidence_already_processed' }
> {
  const evidenceVerificationId = grant.evidenceVerificationId;
  if (evidenceVerificationId !== undefined) {
    const evidenceIdentity = {
      source: grant.source,
      evidenceVerificationId,
    } as const;
    const platformEvidenceIdentity = getEntitlementPlatformEvidenceIdentity(grant);
    const lockKeys = [createEntitlementEvidenceKey(evidenceIdentity)];
    if (platformEvidenceIdentity !== undefined) {
      lockKeys.push(createEntitlementPlatformEvidenceKey(platformEvidenceIdentity));
    }

    return withEntitlementEvidenceLocks(store, lockKeys, async () => {
      const authorityMatch = await findEntitlementTransactionByEvidenceVerificationId(store, {
        source: grant.source,
        evidenceVerificationId,
      });
      const existing = authorityMatch ?? (platformEvidenceIdentity === undefined
        ? undefined
        : await findEntitlementTransactionByPlatformEvidence(
            store,
            platformEvidenceIdentity,
          ));

      if (existing !== undefined) {
        if (
          existing.source === grant.source
          && existing.playerId === grant.playerId
          && existing.idempotencyKey === grant.idempotencyKey
        ) {
          return {
            status: 'recorded',
            result: assertEntitlementLedgerResult({
              ledgerEntryId: existing.ledgerEntryId,
              alreadyProcessed: true,
            }),
          };
        }

        return { status: 'evidence_already_processed' };
      }

      return recordEntitlementGrantUnchecked(store, grant);
    });
  }

  return recordEntitlementGrantUnchecked(store, grant);
}

async function recordEntitlementGrantUnchecked(
  store: GameServicesStore,
  grant: EntitlementLedgerGrant,
): Promise<
  | { readonly status: 'recorded'; readonly result: EntitlementLedgerResult }
  | { readonly status: 'evidence_already_processed' }
> {
  try {
    return {
      status: 'recorded',
      result: await store.recordEntitlementGrant(grant),
    };
  } catch (error) {
    if (error instanceof EvidenceAlreadyProcessedError) {
      return { status: 'evidence_already_processed' };
    }

    throw error;
  }
}

const entitlementEvidenceLocks = new WeakMap<
  GameServicesStore,
  Map<string, Promise<void>>
>();

async function withEntitlementEvidenceLocks<T>(
  store: GameServicesStore,
  lockKeys: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  const orderedLockKeys = [...new Set(lockKeys)].sort((left, right) => left.localeCompare(right));

  async function runWithLock(index: number): Promise<T> {
    const lockKey = orderedLockKeys[index];
    return lockKey === undefined
      ? task()
      : withEntitlementEvidenceLockKey(store, lockKey, () => runWithLock(index + 1));
  }

  return runWithLock(0);
}

async function withEntitlementEvidenceLockKey<T>(
  store: GameServicesStore,
  lockKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const storeLocks = entitlementEvidenceLocks.get(store) ?? new Map<string, Promise<void>>();
  entitlementEvidenceLocks.set(store, storeLocks);

  const previous = storeLocks.get(lockKey) ?? Promise.resolve();
  const gate = createPromiseGate();
  const current = previous.then(() => gate.promise);
  storeLocks.set(lockKey, current);

  await previous;
  try {
    return await task();
  } finally {
    gate.release();
    if (storeLocks.get(lockKey) === current) {
      storeLocks.delete(lockKey);
      if (storeLocks.size === 0) {
        entitlementEvidenceLocks.delete(store);
      }
    }
  }
}

function createPromiseGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

interface EntitlementRetryIdentity {
  readonly source: EntitlementLedgerGrant['source'];
  readonly playerId: string;
  readonly idempotencyKey: string;
  readonly grantId: string;
  readonly target: string;
}

async function findEntitlementTransactionByIdempotency(
  store: GameServicesStore,
  identity: EntitlementRetryIdentity,
): Promise<ProductGrantTransaction | undefined> {
  if (store.findEntitlementTransactionByIdempotency !== undefined) {
    return store.findEntitlementTransactionByIdempotency(identity);
  }

  const transactions = await store.listEntitlementTransactions();
  return transactions.find((transaction) => {
    return transaction.source === identity.source
      && transaction.playerId === identity.playerId
      && transaction.idempotencyKey === identity.idempotencyKey;
  });
}

async function findEntitlementTransactionByEvidenceVerificationId(
  store: GameServicesStore,
  input: {
    readonly source: EntitlementLedgerGrant['source'];
    readonly evidenceVerificationId: string;
  },
): Promise<ProductGrantTransaction | undefined> {
  if (store.findEntitlementTransactionByEvidenceVerificationId !== undefined) {
    return store.findEntitlementTransactionByEvidenceVerificationId(input);
  }

  const transactions = await store.listEntitlementTransactions();
  return transactions.find((transaction) => {
    const storedEvidenceVerificationId = transaction.evidenceVerificationId
      ?? transaction.payload.evidenceVerificationId;

    return transaction.source === input.source
      && storedEvidenceVerificationId === input.evidenceVerificationId;
  });
}

async function findEntitlementTransactionByPlatformEvidence(
  store: GameServicesStore,
  input: EntitlementPlatformEvidenceIdentity,
): Promise<ProductGrantTransaction | undefined> {
  if (store.findEntitlementTransactionByPlatformEvidence !== undefined) {
    return store.findEntitlementTransactionByPlatformEvidence(input);
  }

  const transactions = await store.listEntitlementTransactions();
  return transactions.find((transaction) => {
    const identity = getEntitlementPlatformEvidenceIdentity(transaction);
    return identity !== undefined
      && identity.source === input.source
      && identity.target === input.target
      && identity.platformEvidenceId === input.platformEvidenceId;
  });
}

function getEntitlementPlatformEvidenceIdentity(
  transaction: Pick<ProductGrantTransaction, 'source' | 'payload'>,
): EntitlementPlatformEvidenceIdentity | undefined {
  if (transaction.source !== 'purchase' && transaction.source !== 'ad_reward') {
    return undefined;
  }

  const target = transaction.payload.target;
  const platformEvidenceId = transaction.source === 'purchase'
    ? transaction.payload.platformTransactionId
    : transaction.payload.platformImpressionId;

  if (
    typeof target !== 'string'
    || target.length === 0
    || typeof platformEvidenceId !== 'string'
    || platformEvidenceId.length === 0
  ) {
    return undefined;
  }

  return {
    source: transaction.source,
    target,
    platformEvidenceId,
  };
}

async function recordedEntitlementMatchesRetry(
  store: GameServicesStore,
  result: EntitlementLedgerResult,
  identity: EntitlementRetryIdentity,
): Promise<boolean> {
  const transaction = await store.getEntitlementTransaction(result.ledgerEntryId);
  return transaction !== undefined && matchesEntitlementRetry(transaction, identity);
}

function matchesEntitlementRetry(
  transaction: ProductGrantTransaction,
  identity: EntitlementRetryIdentity,
): boolean {
  return transaction.source === identity.source
    && transaction.playerId === identity.playerId
    && transaction.idempotencyKey === identity.idempotencyKey
    && transaction.grantId === identity.grantId
    && transaction.payload.target === identity.target;
}

function resolveEvidenceVerificationTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? 10_000;

  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error('evidenceVerificationTimeoutMs must be a positive finite number.');
  }

  return resolved;
}

function assertNonEmptyDecisionString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Evidence verification ${label} must be a non-empty string.`);
  }
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

function createHealthResponse(version = '0.0.0'): GameServicesHealthResponse {
  return {
    ok: true,
    service: 'game-services',
    version,
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
    ...(grant.evidenceVerificationId === undefined
      ? {}
      : { evidenceVerificationId: grant.evidenceVerificationId }),
  };

  return assertProductGrantTransaction(
    grant.grant === undefined ? baseTransaction : { ...baseTransaction, grant: grant.grant },
  );
}

function createEntitlementIdempotencyKey(grant: {
  readonly source: EntitlementLedgerGrant['source'];
  readonly playerId: string;
  readonly idempotencyKey: string;
}): string {
  return createCompositeKey([grant.source, grant.playerId, grant.idempotencyKey]);
}

function createEntitlementEvidenceKey(grant: {
  readonly source: EntitlementLedgerGrant['source'];
  readonly evidenceVerificationId: string;
}): string {
  return createCompositeKey([grant.source, grant.evidenceVerificationId]);
}

function createEntitlementPlatformEvidenceKey(
  identity: EntitlementPlatformEvidenceIdentity,
): string {
  return createCompositeKey([identity.source, identity.target, identity.platformEvidenceId]);
}

function createEntitlementLedgerEntryId(grant: EntitlementLedgerGrant): string {
  return [
    'ledger',
    encodeIdSegment(grant.source),
    encodeIdSegment(grant.playerId),
    encodeIdSegment(grant.idempotencyKey),
  ].join('_');
}

function createLeaderboardRunKey(request: RecordLeaderboardScoreRequest): string {
  return createCompositeKey([
    request.target,
    request.leaderboardId,
    request.playerId,
    request.runId,
  ]);
}

function createLeaderboardLedgerEntryId(request: RecordLeaderboardScoreRequest): string {
  return [
    'leaderboard',
    encodeIdSegment(request.target),
    encodeIdSegment(request.leaderboardId),
    encodeIdSegment(request.playerId),
    encodeIdSegment(request.runId),
  ].join('_');
}

function createCompositeKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function encodeIdSegment(value: string): string {
  return `${value.length}:${encodeURIComponent(value)}`;
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

export * from './notification-delivery';
export * from './progress-link';
