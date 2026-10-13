import type {
  PlatformEvidenceEnvelope,
  PlatformGateway,
  PurchaseResult,
  RewardedAdResult,
} from '@mpgd/platform';
import type {
  CommerceProvider,
  RequestPurchaseInput,
  RequestPurchaseResult,
} from '@mpgd/platform/commerce';

import {
  createTestCommerceProvider,
  createTestStorePurchase,
} from './commerce-test-provider.test.js';
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

/** The store's answer for a platform result the way the fixtures spell it. */
function storeAnswer(request: RequestPurchaseInput, platform: PurchaseResult): RequestPurchaseResult {
  switch (platform.status) {
    case 'completed':
      return {
        outcome: 'purchased',
        purchase: createTestStorePurchase(request, {
          transactionId: platform.transactionId ?? 'private-transaction',
          token: `private-token-${platform.transactionId ?? 'private-transaction'}`,
          ...(platform.evidence === undefined ? {} : { evidence: platform.evidence }),
        }),
      };
    case 'pending':
      return { outcome: 'launched' };
    case 'cancelled':
      return { outcome: 'cancelled', error: { code: 'USER_CANCELLED', retryable: false } };
    case 'failed':
      return { outcome: 'failed', error: { code: 'UNKNOWN', retryable: false } };
  }
}

function harness(options: {
  target?: GameServicesLedgerTarget;
  purchase?: PurchaseResult;
  reward?: RewardedAdResult;
  verified?: boolean;
  claimed?: boolean;
  platformError?: Error;
  serverError?: Error;
  now?: () => string;
  /** The gateway sells nothing: it has no commerce provider. */
  noCommerce?: boolean;
  evidence?: 'client-token' | 'adapter-settled';
} = {}) {
  const calls = { purchase: 0, reward: 0, verify: 0, claim: 0 };
  const timeline: string[] = [];
  const provider = createTestCommerceProvider({
    evidence: options.evidence ?? 'client-token',
    answer(request) {
      calls.purchase += 1;
      timeline.push('gateway:purchase');
      if (options.platformError !== undefined) {
        throw options.platformError;
      }
      return storeAnswer(request, options.purchase ?? completedPurchase);
    },
  });
  const gateway = {
    ...(options.noCommerce === true ? {} : { commerce: provider satisfies CommerceProvider }),
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
          verified: options.verified ?? true,
          ledgerEntryId: 'private-purchase-ledger',
          alreadyProcessed: true,
          reason: 'private-server-detail',
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
          granted: options.claimed ?? true,
          ledgerEntryId: 'private-ad-ledger',
          alreadyProcessed: true,
          reason: 'private-server-detail',
        };
      },
    },
    leaderboard: {
      async recordScore() {
        return { submitted: false, alreadyProcessed: false, ledgerEntryId: 'unused', rank: 0 };
      },
    },
  };
  return {
    calls,
    timeline,
    gateway,
    backend,
    client: createGameServicesClient({
      gateway,
      backend,
      target: options.target ?? 'android',
      playerId: 'private-player',
      now: options.now ?? (() => '2026-09-13T00:00:00.000Z'),
      warn: () => {},
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
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  ok(condition(), 'The awaited condition was not reached');
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
    adEvents.push(event);
  },
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

const provisionalEvidence: PlatformEvidenceEnvelope = {
  schema: 'mpgd.admob.client-reward.v1',
  payload: { adUnitId: 'ca-app-pub-1234567890123456/1234567890' },
};
const provisionalReward: RewardedAdResult = {
  status: 'completed',
  rewardGranted: false,
  evidence: provisionalEvidence,
};
const provisionalAd = harness({ reward: provisionalReward });
const provisionalResult = await provisionalAd.client.claimRewardedAd(rewardInput);
equal(provisionalAd.calls.claim, 1, 'Provisional AdMob evidence reaches backend verification');
equal(provisionalResult.status, 'granted', 'Only the mocked backend decision grants the reward');
equal(provisionalResult.reward.rewardGranted, false, 'SDK callback never sets the grant flag');
const uncertainReward: RewardedAdResult = { ...provisionalReward, status: 'pending' };
const uncertainAd = harness({ reward: uncertainReward, claimed: false });
const uncertainResult = await uncertainAd.client.claimRewardedAd(rewardInput);
equal(uncertainAd.calls.claim, 1, 'Uncertain dismissal still reaches SSV verification');
equal(uncertainResult.status, 'rejected', 'Only a backend decision can settle an uncertain ad');
const malformedEvidence: PlatformEvidenceEnvelope = {
  schema: 'mpgd.admob.client-reward.v1',
  payload: { adUnitId: '' },
};
const malformedReward: RewardedAdResult = { ...provisionalReward, evidence: malformedEvidence };
const malformedProvisional = harness({ reward: malformedReward });
const malformedResult = await malformedProvisional.client.claimRewardedAd(rewardInput);
equal(malformedResult.status, 'rejected', 'Malformed SDK evidence must not dispatch a claim');
equal(malformedProvisional.calls.claim, 0, 'Invalid SDK evidence never reaches backend');

for (const status of ['cancelled', 'pending', 'failed'] as const) {
  const current = harness({ purchase: { status, entitlementIds: [] } });
  const events: GameServicesPurchaseProgress[] = [];
  const result = await current.client.purchase(purchaseInput, {
    onProgress: (event) => {
      events.push(event);
    },
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
      events.push(event);
    },
  });
  equal(result.status, status, `Ad ${status} remains distinct`);
  equal(
    phases(events),
    ['platform-requested', 'platform-result', 'completed'],
    'No fabricated claim',
  );
  equal(current.calls.claim, 0, 'No claim without rewarded completion');
}
{
  const current = harness({ verified: false });
  const events: GameServicesPurchaseProgress[] = [];
  equal(
    (await current.client.purchase(purchaseInput, { onProgress: (event) => {
      events.push(event); } })).status,
    'rejected',
    'Rejection is not an exception',
  );
  equal(events.at(-1)?.phase, 'completed', 'Rejected result completes normally');
  equal(
    phases(events),
    ['platform-requested', 'platform-result', 'server-requested', 'server-result', 'completed'],
    'A backend rejection reports both server phases',
  );
  equal(
    events.find((event) => event.phase === 'server-result'),
    { phase: 'server-result', accepted: false, kind: 'purchase', sequence: 4 },
    'The server verdict is not accepted',
  );
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
        events.push(event);
      },
    };
    if (kind === 'purchase' && at !== 'local') {
      // The reconciler journals a store failure as `failed` and a backend
      // outage as `pending`; neither reaches the caller as an exception.
      const result = await current.client.purchase(purchaseInput, options);
      equal(
        result.status,
        at === 'platform' ? 'failed' : 'pending',
        `A ${at} failure settles into a journaled state`,
      );
      equal(events.at(-1)?.phase, 'completed', 'The journaled state completes normally');
      ok(
        !JSON.stringify([events, result]).includes('PRIVATE'),
        'Progress and results never copy original exception details',
      );
      continue;
    }
    await rejects(
      kind === 'purchase'
        ? current.client.purchase(purchaseInput, options)
        : current.client.claimRewardedAd(rewardInput, options),
      error,
    );
    ok(
      !JSON.stringify(events).includes('PRIVATE'),
      'Progress never copies original exception details',
    );
    if (kind === 'purchase') {
      // The reconciler journals before it opens the store, so a failing clock
      // ends the call before any store UI or server call; the original
      // exception still reaches the caller untouched.
      equal(events.at(-1)?.phase, 'exception', 'A journal failure ends in an exception');
      equal(
        current.calls.purchase + current.calls.verify,
        0,
        'No store UI and no server call after a local journal failure',
      );
      continue;
    }
    equal(
      events.at(-1),
      { phase: 'exception', at, kind, sequence: events.length },
      'Failure location',
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

// A gateway without a commerce provider sells nothing: the purchase completes
// as `rejected` with no store phase, no server phase, and no store UI.
for (const target of ['reddit', 'verse8'] as const) {
  const unsupported = harness({
    target,
    noCommerce: true,
    reward: { status: 'unavailable', rewardGranted: false },
  });
  const unsupportedEvents: GameServicesOperationProgress[] = [];
  const unsupportedPurchase = await unsupported.client.purchase(purchaseInput, {
    onProgress: (event) => {
      unsupportedEvents.push(event);
    },
  });
  equal(unsupportedPurchase.status, 'rejected', `${target} without a provider rejects`);
  equal(unsupportedPurchase.purchase.status, 'failed', 'The platform result is a plain failure');
  equal(unsupportedPurchase.purchase.entitlementIds, [], 'Nothing is granted');
  await unsupported.client.claimRewardedAd(rewardInput, {
    onProgress: (event) => {
      unsupportedEvents.push(event);
    },
  });
  equal(
    phases(unsupportedEvents),
    ['completed', 'platform-requested', 'platform-result', 'completed'],
    'A purchase without a provider omits SDK stages; an unavailable ad provider omits server stages',
  );
  equal(
    unsupported.calls,
    { purchase: 0, reward: 1, verify: 0, claim: 0 },
    'Build-target support does not replace provider availability',
  );
}

// A provider that settles on its own is still confirmed through the backend:
// the progress carries the server phases and the ledger entry is the backend's.
{
  const settled = harness({ target: 'microsoft-store', evidence: 'adapter-settled' });
  const settledEvents: GameServicesPurchaseProgress[] = [];
  const settledResult = await settled.client.purchase(purchaseInput, {
    onProgress: (event) => {
      settledEvents.push(event);
    },
  });
  equal(settledResult.status, 'granted', 'An adapter-settled purchase is granted by the backend');
  equal(
    settledResult.ledgerEntryId,
    'private-purchase-ledger',
    'The backend answer owns the ledger entry',
  );
  equal(settled.calls.verify, 1, 'An adapter-settled completion is verified once');
  equal(
    phases(settledEvents),
    ['platform-requested', 'platform-result', 'server-requested', 'server-result', 'completed'],
    'No settlement shortcut hides the verification stages',
  );
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
  target: 'android',
  playerId: 'private-player',
  backend: concurrent.backend,
  warn: () => {},
  // One store sheet per product at a time, so the two operations buy two products.
  commerceProducts: [
    { logicalId: 'COINS_100', kind: 'consumable' },
    { logicalId: 'GEMS_50', kind: 'consumable' },
  ],
  gateway: {
    ...concurrent.gateway,
    commerce: createTestCommerceProvider({
      answer: (request) => new Promise<RequestPurchaseResult>((resolve) => {
        pending.push((platform) => resolve(storeAnswer(request, platform)));
      }),
    }),
  },
});
const firstEvents: GameServicesPurchaseProgress[] = [];
const secondEvents: GameServicesPurchaseProgress[] = [];
const first = concurrentClient.purchase(
  { ...purchaseInput, idempotencyKey: 'one' },
  {
    correlationId: 'view-one',
    onProgress: (event) => {
      firstEvents.push(event);
    },
  },
);
const second = concurrentClient.purchase(
  { ...purchaseInput, productId: 'GEMS_50', idempotencyKey: 'two' },
  {
    correlationId: 'view-two',
    onProgress: (event) => {
      secondEvents.push(event);
    },
  },
);
await until(() => pending.length === 2);
pending[1]?.({ ...completedPurchase, transactionId: 'private-transaction-two' });
await second;
equal(firstEvents.length, 1, 'First operation remains independently pending');
pending[0]?.({ ...completedPurchase, transactionId: 'private-transaction-one' });
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
    Object.keys(event).every((key) =>
      ['kind', 'phase', 'sequence', 'correlationId', 'status', 'accepted', 'at'].includes(key),
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
  purchase: async (_input) => ({
    status: 'pending',
    purchase: { status: 'pending', entitlementIds: [] },
  }),
  claimRewardedAd: async (_input) => ({
    status: 'unavailable',
    reward: { status: 'unavailable', rewardGranted: false },
  }),
  submitLeaderboardScore: async (_input) => ({
    submitted: false,
    platformSubmitted: false,
    alreadyProcessed: false,
  }),
};
equal(
  (await legacy.purchase(purchaseInput, { onProgress: () => {} })).status,
  'pending',
  'Legacy one-argument client remains assignable',
);
console.log('Game services operation progress smoke passed');
