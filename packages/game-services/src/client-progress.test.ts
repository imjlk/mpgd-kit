import type { PlatformGateway, PurchaseResult, RewardedAdResult } from '@mpgd/platform';

import {
  createGameServicesClient,
  type GameServicesBackendApi,
  type GameServicesClient,
  type GameServicesOperationProgress,
  type GameServicesPurchaseInput,
  type GameServicesPurchaseProgress,
  type GameServicesRewardedAdInput,
  type GameServicesRewardedAdProgress,
} from './client';
import type { GameServicesLedgerTarget } from './types';

const purchaseInput: GameServicesPurchaseInput = {
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'backend-purchase-key',
};
const rewardInput: GameServicesRewardedAdInput = {
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'backend-ad-key',
};
const completedPurchase: PurchaseResult = {
  status: 'completed',
  transactionId: 'private-transaction',
  entitlementIds: ['private-entitlement'],
  evidence: { schema: 'private-purchase-evidence', payload: { receipt: 'secret-receipt' } },
};
const completedReward: RewardedAdResult = {
  status: 'completed',
  rewardGranted: true,
  ledgerEntryId: 'private-impression',
  evidence: { schema: 'private-ad-evidence', payload: { token: 'secret-ad-token' } },
};

function harness(options: {
  target?: GameServicesLedgerTarget;
  purchase?: PurchaseResult;
  reward?: RewardedAdResult;
  verified?: boolean;
  claimed?: boolean;
  platformError?: Error;
  serverError?: Error;
  now?: () => string;
} = {}) {
  const calls = { purchase: 0, reward: 0, verify: 0, claim: 0 };
  const timeline: string[] = [];
  const gateway = {
    commerce: {
      async purchase(): Promise<PurchaseResult> {
        calls.purchase += 1;
        timeline.push('gateway:purchase');
        if (options.platformError !== undefined) {
          throw options.platformError;
        }
        return options.purchase ?? completedPurchase;
      },
    },
    ads: {
      async showRewarded(): Promise<RewardedAdResult> {
        calls.reward += 1;
        timeline.push('gateway:ad');
        if (options.platformError !== undefined) {
          throw options.platformError;
        }
        return options.reward ?? completedReward;
      },
    },
  } as unknown as PlatformGateway;
  const backend: GameServicesBackendApi = {
    purchases: {
      async verifyPurchase() {
        calls.verify += 1;
        timeline.push('backend:verify');
        if (options.serverError !== undefined) {
          throw options.serverError;
        }
        return {
          verified: options.verified ?? true, ledgerEntryId: 'private-purchase-ledger',
          alreadyProcessed: true, reason: 'private-server-detail',
        };
      },
    },
    adRewards: {
      async claimAdReward() {
        calls.claim += 1;
        timeline.push('backend:claim');
        if (options.serverError !== undefined) {
          throw options.serverError;
        }
        return {
          granted: options.claimed ?? true, ledgerEntryId: 'private-ad-ledger',
          alreadyProcessed: true, reason: 'private-server-detail',
        };
      },
    },
    leaderboard: {
      async recordScore() {
        return { submitted: false, alreadyProcessed: false, ledgerEntryId: 'unused', rank: 0 }; },
    },
  };
  return {
    calls,
    timeline,
    gateway,
    backend,
    client: createGameServicesClient({
      gateway, backend, target: options.target ?? 'android', playerId: 'private-player',
      now: options.now ?? (() => '2026-09-13T00:00:00.000Z'),
    }),
  };
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}
function ok(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
function phases(events: readonly GameServicesOperationProgress[]): string[] {
  return events.map((event) => event.phase);
}
async function rejects(promise: Promise<unknown>, expected: Error): Promise<void> {
  try {
    await promise;
  } catch (error) {
    ok(error === expected, 'Original business exception must be preserved');
    return;
  }
  throw new Error('Expected rejection');
}

const purchase = harness();
const purchaseEvents: GameServicesPurchaseProgress[] = [];
const purchaseResult = await purchase.client.purchase(purchaseInput, {
  correlationId: 'view-purchase',
  onProgress: (event) => {
    purchaseEvents.push(event);
    purchase.timeline.push(event.phase);
  },
});
equal(
  purchase.timeline,
  [
    'platform-requested',
    'gateway:purchase',
    'platform-result',
    'server-requested',
    'backend:verify',
    'server-result',
    'completed',
  ],
  'Purchase notifications must bracket actual calls',
);
equal(purchaseResult.status, 'granted', 'Verified purchase stays granted');
equal(
  purchaseResult.verification?.alreadyProcessed,
  true,
  'Existing deduplication result is retained',
);
equal(
  purchaseEvents.map((event) => event.sequence),
  [1, 2, 3, 4, 5],
  'Purchase sequence',
);
ok(
  purchaseEvents.every((event) => event.correlationId === 'view-purchase'),
  'Purchase correlation',
);
const noOptionsPurchase = harness();
equal(
  await noOptionsPurchase.client.purchase(purchaseInput),
  purchaseResult,
  'No-options result stays unchanged',
);
equal(noOptionsPurchase.calls, purchase.calls, 'No-options side effects stay unchanged');

const ad = harness();
const adEvents: GameServicesRewardedAdProgress[] = [];
const adResult = await ad.client.claimRewardedAd(rewardInput, {
  onProgress: (event) => {
    adEvents.push(event); },
});
equal(adResult.status, 'granted', 'Claimed ad stays granted');
equal(
  phases(adEvents),
  ['platform-requested', 'platform-result', 'server-requested', 'server-result', 'completed'],
  'Ad stages',
);
const noOptionsAd = harness();
equal(
  await noOptionsAd.client.claimRewardedAd(rewardInput),
  adResult,
  'No-options ad result unchanged',
);
equal(noOptionsAd.calls, ad.calls, 'No-options ad side effects unchanged');

for (const status of ['cancelled', 'pending', 'failed'] as const) {
  const current = harness({ purchase: { status, entitlementIds: [] } });
  const events: GameServicesPurchaseProgress[] = [];
  const result = await current.client.purchase(purchaseInput, {
    onProgress: (event) => {
      events.push(event); },
  });
  equal(result.status, status, `Purchase ${status} remains distinct`);
  equal(
    events.at(-1),
    { phase: 'completed', status, kind: 'purchase', sequence: 3 },
    `Completed ${status}`,
  );
  equal(
    phases(events),
    ['platform-requested', 'platform-result', 'completed'],
    'No verification for unresolved/cancelled/failed platform result',
  );
  equal(current.calls.verify, 0, 'No fabricated verification');
}
for (const status of ['skipped', 'unavailable', 'failed'] as const) {
  const current = harness({ reward: { status, rewardGranted: false } });
  const events: GameServicesRewardedAdProgress[] = [];
  const result = await current.client.claimRewardedAd(rewardInput, {
    onProgress: (event) => {
      events.push(event); },
  });
  equal(result.status, status, `Ad ${status} remains distinct`);
  equal(
    phases(events),
    ['platform-requested', 'platform-result', 'completed'],
    'No fabricated claim',
  );
  equal(current.calls.claim, 0, 'No claim without rewarded completion');
}
for (const configured of [
  { purchase: { status: 'completed', entitlementIds: [] } satisfies PurchaseResult },
  { verified: false },
]) {
  const current = harness(configured);
  const events: GameServicesPurchaseProgress[] = [];
  equal(
    (await current.client.purchase(purchaseInput, { onProgress: (event) => {
      events.push(event); } })).status,
    'rejected',
    'Rejection is not an exception',
  );
  equal(events.at(-1)?.phase, 'completed', 'Rejected result completes normally');
}
for (const configured of [
  { reward: { status: 'completed', rewardGranted: false } satisfies RewardedAdResult },
  { claimed: false },
]) {
  const current = harness(configured);
  const events: GameServicesRewardedAdProgress[] = [];
  equal(
    (await current.client.claimRewardedAd(rewardInput, { onProgress: (event) => {
      events.push(event); } })).status,
    'rejected',
    'Ad rejection is not an exception',
  );
  equal(events.at(-1)?.phase, 'completed', 'Rejected claim completes normally');
}

for (const kind of ['purchase', 'rewarded-ad'] as const) {
  for (const at of ['platform', 'server', 'local'] as const) {
    const error = new Error('PRIVATE provider error');
    const current = harness({
      ...(at === 'platform' ? { platformError: error } : {}),
      ...(at === 'server' ? { serverError: error } : {}),
      ...(at === 'local' ? { now: () => {
          throw error; } } : {}),
    });
    const events: GameServicesOperationProgress[] = [];
    const options = {
      onProgress: (event: GameServicesOperationProgress) => {
        events.push(event); },
    };
    await rejects(
      kind === 'purchase'
        ? current.client.purchase(purchaseInput, options)
        : current.client.claimRewardedAd(rewardInput, options),
      error,
    );
    equal(
      events.at(-1),
      { phase: 'exception', at, kind, sequence: events.length },
      'Failure location',
    );
    ok(
      !JSON.stringify(events).includes('PRIVATE'),
      'Progress never copies original exception details',
    );
    if (at === 'local') {
      equal(
        phases(events),
        ['platform-requested', 'platform-result', 'exception'],
        'Request construction failure is local, before a server request',
      );
      equal(
        current.calls.verify + current.calls.claim,
        0,
        'No server call after local construction failure',
      );
    }
  }
}

const unsupported = harness({ target: 'reddit' });
const unsupportedEvents: GameServicesOperationProgress[] = [];
await unsupported.client.purchase(purchaseInput, {
  onProgress: (event) => {
    unsupportedEvents.push(event); },
});
await unsupported.client.claimRewardedAd(rewardInput, {
  onProgress: (event) => {
    unsupportedEvents.push(event); },
});
equal(
  phases(unsupportedEvents),
  ['completed', 'completed'],
  'Unsupported targets do not emit uncalled stages',
);
equal(
  unsupported.calls,
  { purchase: 0, reward: 0, verify: 0, claim: 0 },
  'Unsupported target performs no SDK/server call',
);

const authoritative = harness({
  target: 'microsoft-store',
  purchase: {
    ...completedPurchase, transactionId: 'authoritative-ledger',
    authoritativeGrant: { ledgerEntryId: 'authoritative-ledger', alreadyProcessed: true },
  },
});
const authoritativeEvents: GameServicesPurchaseProgress[] = [];
const authoritativeResult = await authoritative.client.purchase(purchaseInput, {
  onProgress: (event) => {
    authoritativeEvents.push(event); },
});
equal(authoritativeResult.status, 'granted', 'Authoritative completion is preserved');
equal(authoritativeResult.ledgerEntryId, 'authoritative-ledger', 'Authority ledger retained');
equal(authoritative.calls.verify, 0, 'No duplicate verification');
equal(
  phases(authoritativeEvents),
  ['platform-requested', 'platform-result', 'completed'],
  'Authority path emits no fake verification',
);

for (const status of ['completed', 'pending'] as const) {
  const verse8 = harness({ target: 'verse8', purchase: { ...completedPurchase, status } });
  const events: GameServicesPurchaseProgress[] = [];
  const result = await verse8.client.purchase(purchaseInput, {
    onProgress: (event) => {
      events.push(event); },
  });
  equal(
    result.status,
    status === 'completed' ? 'rejected' : 'pending',
    'Verse8 server-event grant policy retained',
  );
  equal(verse8.calls.verify, 0, 'No alternate Verse8 grant path');
  equal(phases(events), ['platform-requested', 'platform-result', 'completed'], 'Verse8 stages');
}

for (const asynchronous of [false, true]) {
  const observerErrors: unknown[] = [];
  const current = harness();
  const options = {
    onProgress: () => {
      const error = new Error('observer failure');
      if (asynchronous) {
        return Promise.reject(error);
      }
      throw error;
    },
    onObserverError: (error: unknown) => {
      observerErrors.push(error);
      if (asynchronous) {
        return Promise.reject(new Error('observer error hook failure'));
      }
      throw new Error('observer error hook failure');
    },
  };
  equal(
    (await current.client.purchase(purchaseInput, options)).status,
    'granted',
    'Purchase survives observers',
  );
  equal(
    (await current.client.claimRewardedAd(rewardInput, options)).status,
    'granted',
    'Ad survives observers',
  );
  await Promise.resolve();
  await Promise.resolve();
  equal(observerErrors.length, 10, 'All observer errors isolated and observed');
  equal(current.calls.verify + current.calls.claim, 2, 'Grant paths not duplicated');
}
const nonBlocking = harness();
equal(
  (await nonBlocking.client.purchase(purchaseInput, { onProgress: () => new Promise<void>(() => {}) })).status,
  'granted',
  'Unsettled observer does not delay business completion',
);

const concurrent = harness();
const pending: ((value: PurchaseResult) => void)[] = [];
const concurrentClient = createGameServicesClient({
  target: 'android', playerId: 'private-player', backend: concurrent.backend,
  gateway: {
    ...concurrent.gateway,
    commerce: {
      ...concurrent.gateway.commerce,
      purchase: () => new Promise<PurchaseResult>((resolve) => {
        pending.push(resolve); }),
    },
  },
});
const firstEvents: GameServicesPurchaseProgress[] = [];
const secondEvents: GameServicesPurchaseProgress[] = [];
const first = concurrentClient.purchase(
  { ...purchaseInput, idempotencyKey: 'one' },
  { correlationId: 'view-one', onProgress: (event) => {
    firstEvents.push(event); } },
);
const second = concurrentClient.purchase(
  { ...purchaseInput, idempotencyKey: 'two' },
  { correlationId: 'view-two', onProgress: (event) => {
    secondEvents.push(event); } },
);
pending[1]?.(completedPurchase);
await second;
equal(firstEvents.length, 1, 'First operation remains independently pending');
pending[0]?.(completedPurchase);
await first;
for (const [events, correlation] of [
  [firstEvents, 'view-one'],
  [secondEvents, 'view-two'],
] as const) {
  equal(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 5],
    'Concurrent sequence stays local',
  );
  ok(
    events.every((event) => event.correlationId === correlation),
    'Concurrent correlation remains isolated',
  );
}

for (const event of [...purchaseEvents, ...adEvents]) {
  ok(Object.isFrozen(event), 'Progress data is immutable');
  ok(
    Object.keys(event).every(
      (key) => ['kind', 'phase', 'sequence', 'correlationId', 'status', 'accepted', 'at'].includes(
        key,
      ),
    ),
    'Progress contains only allowed fields',
  );
}
const serialized = JSON.stringify([...purchaseEvents, ...adEvents]);
for (const privateValue of ['secret', 'private', 'backend-purchase-key', 'backend-ad-key']) {
  ok(
    !serialized.includes(privateValue),
    'Receipt, identity, ledger, idempotency and raw response data must not leak',
  );
}

const legacy: GameServicesClient = {
  purchase: async (_input) => ({ status: 'pending', purchase: { status: 'pending', entitlementIds: [] } }),
  claimRewardedAd: async (_input) => ({ status: 'unavailable', reward: { status: 'unavailable', rewardGranted: false } }),
  submitLeaderboardScore: async (_input) => ({ submitted: false, platformSubmitted: false, alreadyProcessed: false }),
};
equal(
  (await legacy.purchase(purchaseInput, { onProgress: () => {} })).status,
  'pending',
  'Legacy one-argument client remains assignable',
);
console.log('Game services operation progress smoke passed');
