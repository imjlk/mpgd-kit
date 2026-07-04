import {
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
} from '@mpgd/game-services-client';

import { createWorkerFetchHandler, createWorkerService } from './handler.js';

const workerEnv = {
  MPGD_STORE: 'memory',
} as const;
const workerFetch = createWorkerFetchHandler(workerEnv);
const workerService = createWorkerService(workerEnv);
const baseUrl = 'https://game-services-worker.test';

const health = await workerFetch(new Request(`${baseUrl}/health`));
assertEqual(health.status, 200, 'health should return 200');

const directPurchase = await postJson('/game-services/purchases/verify', {
  target: 'android',
  playerId: 'worker-player',
  productId: 'COINS_100',
  platformTransactionId: 'worker-txn-1',
  idempotencyKey: 'worker-purchase-1',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const duplicatePurchase = await postJson('/game-services/purchases/verify', {
  target: 'android',
  playerId: 'worker-player',
  productId: 'COINS_100',
  platformTransactionId: 'worker-txn-1',
  idempotencyKey: 'worker-purchase-1',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});

assertEqual(directPurchase.status, 200, 'direct purchase endpoint should return 200');
assertEqual(
  (await directPurchase.json() as { readonly verified: boolean }).verified,
  true,
  'direct purchase should verify',
);
assertEqual(
  (await duplicatePurchase.json() as { readonly alreadyProcessed: boolean }).alreadyProcessed,
  true,
  'direct purchase should dedupe',
);

const orpcClient = createGameServicesOrpcClient({
  url: `${baseUrl}/rpc`,
  fetch: (url, init) => workerFetch(new Request(url, init)),
});
const backend = createGameServicesOrpcBackendApi(orpcClient);
const reward = await backend.adRewards.claimAdReward({
  target: 'android',
  playerId: 'worker-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'worker-impression-1',
  idempotencyKey: 'worker-reward-1',
  completedAt: '2026-07-04T00:00:01.000Z',
});
const score = await backend.leaderboard.recordScore({
  target: 'android',
  playerId: 'worker-player',
  leaderboardId: 'default',
  score: 12345,
  runId: 'worker-run-1',
  submittedAt: '2026-07-04T00:00:02.000Z',
});

assertEqual(reward.granted, true, 'oRPC reward should grant');
assertEqual(score.submitted, true, 'oRPC score should record');

const serviceBindingPurchase = await workerService.verifyPurchase({
  target: 'android',
  playerId: 'worker-player',
  productId: 'COINS_100',
  platformTransactionId: 'worker-txn-2',
  idempotencyKey: 'worker-purchase-service-binding-1',
  purchasedAt: '2026-07-04T00:00:03.000Z',
});

assertEqual(
  (serviceBindingPurchase as { readonly verified: boolean }).verified,
  true,
  'service binding purchase should verify',
);

console.log('Game services Worker smoke passed: HTTP, oRPC, and service binding surfaces');

async function postJson(pathname: string, body: unknown): Promise<Response> {
  return workerFetch(
    new Request(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
