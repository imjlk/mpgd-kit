import type { AdPlacements } from '@mpgd/catalog';
import {
  createGameServicesBackend,
  createGameServicesBackendApiHandler,
  createGameServicesHttpFetchHandler,
  createGameServicesRpcFetchHandler,
  createGameServicesRouter,
  createInMemoryGameServicesStore,
  type ClaimAdRewardRequest,
  type GameServicesBackendApi,
  type GameServicesStore,
  type RecordLeaderboardScoreRequest,
  type VerifyPurchaseRequest,
} from '@mpgd/game-services';
import type { ProductCatalog } from '@mpgd/catalog';

import { createD1GameServicesStore } from './d1Store.js';

export interface GameServicesWorkerEnv {
  readonly DB?: D1Database;
  readonly MPGD_STORE?: 'memory' | 'd1';
}

export interface GameServicesWorkerService {
  verifyPurchase(input: VerifyPurchaseRequest): Promise<unknown>;
  claimAdReward(input: ClaimAdRewardRequest): Promise<unknown>;
  recordLeaderboardScore(input: RecordLeaderboardScoreRequest): Promise<unknown>;
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

export function createWorkerFetchHandler(
  env: GameServicesWorkerEnv,
): (request: Request) => Promise<Response> {
  const backend = createWorkerBackend(env);
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

  return (request) => {
    const pathname = new URL(request.url).pathname;

    if (pathname.startsWith('/rpc')) {
      return rpcFetch(request);
    }

    return httpFetch(request);
  };
}

export function createWorkerService(env: GameServicesWorkerEnv): GameServicesWorkerService {
  const backend = createWorkerBackend(env);

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
  if (env.MPGD_STORE === 'd1') {
    if (env.DB === undefined) {
      throw new Error('MPGD_STORE is d1 but DB binding is not configured.');
    }

    return createD1GameServicesStore(env.DB);
  }

  return fallbackMemoryStore;
}
