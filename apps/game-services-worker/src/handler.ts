import type { AdPlacements } from '@mpgd/catalog';
import {
  createGameServicesBackend,
  createGameServicesBackendApiHandler,
  createGameServicesHttpFetchHandler,
  createGameServicesRpcFetchHandler,
  createGameServicesRouter,
  createInMemoryGameServicesStore,
  createInMemoryVerifiedLeaderboardService,
  createVerifiedLeaderboardSnapshotFetchHandler,
  type ClaimAdRewardRequest,
  type GameServicesBackendApi,
  type GameServicesStore,
  type GetVerifiedLeaderboardSnapshotRequest,
  type RecordLeaderboardScoreRequest,
  type RecordVerifiedLeaderboardAttemptRequest,
  type RecordVerifiedLeaderboardAttemptResponse,
  type VerifiedLeaderboardService,
  type VerifiedLeaderboardSnapshotPrincipal,
  type VerifiedLeaderboardSnapshot,
  type VerifyPurchaseRequest,
} from '@mpgd/game-services';
import type { ProductCatalog } from '@mpgd/catalog';

import { createD1GameServicesStore } from './d1Store.js';
import { createD1VerifiedLeaderboardService } from './verifiedLeaderboardD1.js';

export interface GameServicesWorkerEnv {
  readonly DB?: D1Database;
  readonly MPGD_STORE?: 'memory' | 'd1';
  readonly VERIFIED_LEADERBOARD_AUTH?: VerifiedLeaderboardAuthBinding;
}

export interface VerifiedLeaderboardAuthBindingRequest {
  readonly authorization: string;
}

export interface VerifiedLeaderboardAuthBinding {
  authenticateVerifiedLeaderboardSnapshot(
    input: VerifiedLeaderboardAuthBindingRequest,
  ): Promise<VerifiedLeaderboardSnapshotPrincipal | undefined>;
}

export interface GameServicesWorkerService {
  verifyPurchase(input: VerifyPurchaseRequest): Promise<unknown>;
  claimAdReward(input: ClaimAdRewardRequest): Promise<unknown>;
  recordLeaderboardScore(input: RecordLeaderboardScoreRequest): Promise<unknown>;
  recordVerifiedAttempt(
    input: RecordVerifiedLeaderboardAttemptRequest,
  ): Promise<RecordVerifiedLeaderboardAttemptResponse>;
  getSnapshot(
    input: GetVerifiedLeaderboardSnapshotRequest,
  ): Promise<VerifiedLeaderboardSnapshot | undefined>;
}

const productCatalog = {
  version: 'worker-default',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: {
        type: 'currency',
        currency: 'coin',
        amount: 100,
      },
      platformProductIds: {
        android: 'coins_100',
        ios: 'com.mpgd.game.coins100',
        ait: 'coins_100',
      },
    },
  ],
} as const satisfies ProductCatalog;
const adPlacements = {
  version: 'worker-default',
  placements: [
    {
      id: 'CONTINUE_AFTER_FAIL',
      type: 'rewarded',
      reward: {
        type: 'continue',
        amount: 1,
      },
      frequencyCap: {
        cooldownSeconds: 60,
        maxPerSession: 3,
      },
      platformPlacementIds: {
        android: 'reward_continue',
        ios: 'reward_continue',
        ait: 'reward_continue',
      },
    },
  ],
} as const satisfies AdPlacements;
const fallbackMemoryStore = createInMemoryGameServicesStore();
const fallbackVerifiedLeaderboardService = createInMemoryVerifiedLeaderboardService();

export function createWorkerFetchHandler(
  env: GameServicesWorkerEnv,
): (request: Request) => Promise<Response> {
  const backend = createWorkerBackend(env);
  const verifiedLeaderboard = createWorkerVerifiedLeaderboardService(env);
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const rpcFetch = createGameServicesRpcFetchHandler(
    createGameServicesRouter(backend),
    {
      prefix: '/rpc',
      corsHeaders,
      ...(backend.version === undefined ? {} : { version: backend.version }),
    },
  );
  const httpFetch = createGameServicesHttpFetchHandler(
    createGameServicesBackendApiHandler({
      catalog: productCatalog,
      placements: adPlacements,
      store: createWorkerStore(env),
    }),
    {
      corsHeaders,
      version: productCatalog.version,
    },
  );
  const snapshotFetch = createWorkerVerifiedLeaderboardSnapshotFetchHandler(
    env,
    verifiedLeaderboard,
    corsHeaders,
  );

  return async (request) => {
    const snapshotResponse = await snapshotFetch?.(request);

    if (snapshotResponse !== undefined) {
      return snapshotResponse;
    }

    const pathname = new URL(request.url).pathname;

    if (pathname.startsWith('/rpc')) {
      return rpcFetch(request);
    }

    return httpFetch(request);
  };
}

function createWorkerVerifiedLeaderboardSnapshotFetchHandler(
  env: GameServicesWorkerEnv,
  reader: VerifiedLeaderboardService,
  corsHeaders: Readonly<Record<string, string>>,
): ((request: Request) => Promise<Response | undefined>) | undefined {
  const auth = env.VERIFIED_LEADERBOARD_AUTH;

  if (auth === undefined) {
    return undefined;
  }

  return createVerifiedLeaderboardSnapshotFetchHandler({
    reader,
    corsHeaders,
    authenticate(request) {
      const authorization = request.headers.get('Authorization');

      if (authorization === null || authorization.length === 0) {
        return undefined;
      }

      return auth.authenticateVerifiedLeaderboardSnapshot({ authorization });
    },
  });
}

export function createWorkerService(env: GameServicesWorkerEnv): GameServicesWorkerService {
  const backend = createWorkerBackend(env);
  const verifiedLeaderboard = createWorkerVerifiedLeaderboardService(env);

  return {
    verifyPurchase(input) {
      return backend.purchases.verifyPurchase(input);
    },
    claimAdReward(input) {
      return backend.adRewards.claimAdReward(input);
    },
    recordLeaderboardScore(input) {
      return backend.leaderboard.recordScore(input);
    },
    recordVerifiedAttempt(input) {
      return verifiedLeaderboard.recordVerifiedAttempt(input);
    },
    getSnapshot(input) {
      return verifiedLeaderboard.getSnapshot(input);
    },
  };
}

function createWorkerBackend(env: GameServicesWorkerEnv): GameServicesBackendApi {
  return createGameServicesBackend({
    catalog: productCatalog,
    placements: adPlacements,
    store: createWorkerStore(env),
    version: productCatalog.version,
  });
}

function createWorkerStore(env: GameServicesWorkerEnv): GameServicesStore {
  const db = resolveD1Database(env);
  return db === undefined ? fallbackMemoryStore : createD1GameServicesStore(db);
}

function createWorkerVerifiedLeaderboardService(
  env: GameServicesWorkerEnv,
): VerifiedLeaderboardService {
  const db = resolveD1Database(env);
  return db === undefined
    ? fallbackVerifiedLeaderboardService
    : createD1VerifiedLeaderboardService(db);
}

function resolveD1Database(env: GameServicesWorkerEnv): D1Database | undefined {
  if (env.MPGD_STORE !== 'd1') {
    return undefined;
  }

  if (env.DB === undefined) {
    throw new Error('MPGD_STORE is d1 but DB binding is not configured.');
  }

  return env.DB;
}
