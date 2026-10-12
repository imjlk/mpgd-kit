import type { CommerceCapabilities, PlatformGateway, ProductInfo } from '@mpgd/platform';
import type { CommerceProvider } from '@mpgd/platform/commerce';

import {
  createGameServicesClient,
  createGameServicesFetchBackendTransport,
  createGameServicesHttpBackendApi,
  createGameServicesIdempotencyKey,
  gameServicesBackendEndpoints,
  resolveGameServicesRequestHeaders,
  type GameServicesBackendApi,
  type VerifyPurchaseRequest,
} from './index';

const canonicalHeaders = await resolveGameServicesRequestHeaders({
  headers: { Authorization: 'Bearer stale', 'X-Mode': 'static' },
  getHeaders: async () => ({ authorization: 'Bearer refreshed', 'x-mode': 'dynamic' }),
  requestHeaders: { AUTHORIZATION: 'Bearer operation' },
});
assertEqual(
  JSON.stringify(canonicalHeaders),
  JSON.stringify({ authorization: 'Bearer operation', 'x-mode': 'dynamic' }),
  'header layers must override names case-insensitively without forwarding stale credentials',
);

let purchaseClaims = 0;
let rewardClaims = 0;
let scoreRecords = 0;
let purchaseEvidenceSchema: string | undefined;
let rewardEvidenceSchema: string | undefined;
let rewardDeploymentTarget: string | undefined;
let rewardPlatformImpressionId: string | undefined;
const playerId = 'player-game-services';
const gateway = createMockGateway();
const backend = {
  purchases: {
    async verifyPurchase(input) {
      purchaseClaims += 1;
      purchaseEvidenceSchema = input.evidence?.schema;

      return {
        verified: true,
        ledgerEntryId: `purchase-ledger-${input.idempotencyKey}`,
        alreadyProcessed: purchaseClaims > 1,
      };
    },
  },
  adRewards: {
    async claimAdReward(input) {
      rewardClaims += 1;
      rewardEvidenceSchema = input.evidence?.schema;
      rewardDeploymentTarget = input.deploymentTarget;
      rewardPlatformImpressionId = input.platformImpressionId;

      return {
        granted: true,
        ledgerEntryId: `reward-ledger-${input.idempotencyKey}`,
        alreadyProcessed: rewardClaims > 1,
      };
    },
  },
  leaderboard: {
    async recordScore(input) {
      scoreRecords += 1;

      return {
        submitted: true,
        ledgerEntryId: `leaderboard-ledger-${input.runId}`,
        alreadyProcessed: false,
        rank: 1,
      };
    },
  },
} satisfies GameServicesBackendApi;
const client = createGameServicesClient({
  gateway,
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
});

const purchaseKey = createGameServicesIdempotencyKey({
  target: 'android',
  playerId,
  action: 'purchase',
  subjectId: 'COINS_100',
  runId: 'run-1',
});
const purchase = await client.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: purchaseKey,
});
const duplicatePurchase = await client.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: purchaseKey,
});

assertEqual(purchase.status, 'granted', 'purchase should be granted after verifier');
assertEqual(
  duplicatePurchase.verification?.alreadyProcessed,
  true,
  'purchase verifier should dedupe repeated grants',
);

const reward = await client.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: createGameServicesIdempotencyKey({
    target: 'android',
    playerId,
    action: 'rewarded-ad',
    subjectId: 'CONTINUE_AFTER_FAIL',
    runId: 'run-1',
  }),
});

assertEqual(reward.status, 'granted', 'reward should be granted after ad reward ledger claim');
assertEqual(
  purchaseEvidenceSchema,
  'test.purchase.v1',
  'purchase evidence should reach the backend verifier request',
);
assertEqual(
  rewardEvidenceSchema,
  'test.reward.v1',
  'reward evidence should reach the backend verifier request',
);

let customPurchaseDeploymentTarget: string | undefined;
const customPurchaseBackend = {
  ...backend,
  purchases: {
    async verifyPurchase(input) {
      customPurchaseDeploymentTarget = input.deploymentTarget;
      return {
        verified: true,
        ledgerEntryId: 'custom-purchase-ledger',
        alreadyProcessed: false,
      };
    },
  },
} satisfies GameServicesBackendApi;
const customPurchaseClient = createGameServicesClient({
  gateway: createMockGateway(),
  backend: customPurchaseBackend,
  playerId,
  target: 'android',
  deploymentTarget: 'android-staging',
});
const customPurchase = await customPurchaseClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'android-staging-purchase',
});

assertEqual(customPurchase.status, 'granted', 'custom deployment purchases should be granted');
assertEqual(
  customPurchaseDeploymentTarget,
  'android-staging',
  'purchases should carry the deployment target to backend verification',
);

const leaderboard = await client.submitLeaderboardScore({
  leaderboardId: 'default',
  score: 1234,
  runId: 'run-1',
  submittedAt: '2026-07-03T00:00:03.000Z',
});

assertEqual(leaderboard.submitted, true, 'leaderboard should be recorded');
assertEqual(leaderboard.platformSubmitted, true, 'leaderboard should submit to platform first');
assertEqual(purchaseClaims, 2, 'purchase backend should be called for both attempts');
assertEqual(rewardClaims, 1, 'reward backend should be called after platform reward');
assertEqual(scoreRecords, 1, 'leaderboard backend should be called after platform submit');

const analyticsFailureClient = createGameServicesClient({
  gateway: createMockGateway(),
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
  analytics: {
    track() {
      throw new Error('analytics unavailable');
    },
  },
});
const analyticsFailurePurchase = await analyticsFailureClient.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: 'analytics-failure-purchase',
});

assertEqual(
  analyticsFailurePurchase.status,
  'granted',
  'analytics failures should not break purchases',
);

const rejectedEvents: string[] = [];
const baseRejectedGateway = createMockGateway();
const rejectedGateway = {
  ...baseRejectedGateway,
  commerce: {
    ...baseRejectedGateway.commerce,
    async purchase() {
      return {
        status: 'cancelled',
        entitlementIds: [],
      };
    },
  },
  ads: {
    ...baseRejectedGateway.ads,
    async showRewarded() {
      return {
        status: 'skipped',
        rewardGranted: false,
      };
    },
  },
} satisfies PlatformGateway;
const rejectedClient = createGameServicesClient({
  gateway: rejectedGateway,
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
  analytics: {
    track(event) {
      rejectedEvents.push(event.name);
    },
  },
});
const rejectedPurchase = await rejectedClient.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: 'cancelled-purchase',
});
const rejectedReward = await rejectedClient.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'skipped-reward',
});

assertEqual(rejectedPurchase.status, 'cancelled', 'cancelled purchase should pass through');
assertEqual(rejectedReward.status, 'skipped', 'skipped rewarded ad should pass through');
assertEqual(
  rejectedEvents.join(','),
  'purchase_rejected,rewarded_ad_rejected',
  'non-completed platform flows should emit rejected analytics',
);

const pendingReasons: unknown[] = [];
const pendingBaseGateway = createMockGateway();
const pendingGateway = {
  ...pendingBaseGateway,
  target: 'android',
  commerce: {
    ...pendingBaseGateway.commerce,
    async purchase() {
      return {
        status: 'pending',
        entitlementIds: [],
        evidence: { schema: 'platform.pending.v1', payload: { receipt: 'pending' } },
      };
    },
  },
} satisfies PlatformGateway;
const purchaseClaimsBeforePending = purchaseClaims;
const pendingClient = createGameServicesClient({
  gateway: pendingGateway,
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
  analytics: {
    track(event) {
      pendingReasons.push(event.properties.reason);
    },
  },
});
const pendingPurchase = await pendingClient.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: 'pending-purchase',
});

assertEqual(pendingPurchase.status, 'pending', 'pending platform purchase should pass through');
assertEqual(
  pendingReasons.join(','),
  'purchase_pending',
  'pending purchases should not be mislabeled as missing a transaction ID',
);
assertEqual(
  purchaseClaims,
  purchaseClaimsBeforePending,
  'pending purchases should not call purchase verification',
);

const pendingServerEvents: string[] = [];
const pendingServerClient = createGameServicesClient({
  gateway,
  playerId,
  target: 'android',
  now: () => '2026-07-03T00:00:00.000Z',
  backend: {
    ...backend,
    purchases: {
      async verifyPurchase() {
        return {
          verified: false,
          alreadyProcessed: false,
          disposition: 'pending',
          reason: 'SSV_DELAYED',
        };
      },
    },
    adRewards: {
      async claimAdReward() {
        return {
          granted: false,
          alreadyProcessed: false,
          disposition: 'pending',
          reason: 'SSV_DELAYED',
        };
      },
    },
  },
  analytics: {
    track(event) {
      pendingServerEvents.push(event.name);
    },
  },
});
assertEqual(
  (await pendingServerClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'server-pending-purchase',
  })).status,
  'pending',
  'server-side purchase verification pending must not be a rejection',
);
assertEqual(
  (await pendingServerClient.claimRewardedAd({
    placementId: 'CONTINUE_AFTER_FAIL',
    idempotencyKey: 'server-pending-reward',
  })).status,
  'pending',
  'delayed SSV must not be a reward rejection',
);
assertEqual(
  pendingServerEvents.join(','),
  'purchase_pending,rewarded_ad_pending',
  'pending outcomes should be reported as pending analytics',
);

let unsupportedPurchaseCalls = 0;
let unsupportedRewardCalls = 0;
const purchaseClaimsBeforeUnsupported = purchaseClaims;
const rewardClaimsBeforeUnsupported = rewardClaims;
const unsupportedBaseGateway = createMockGateway();
const unsupportedGateway = {
  ...unsupportedBaseGateway,
  target: 'reddit',
  commerce: {
    ...unsupportedBaseGateway.commerce,
    async purchase() {
      unsupportedPurchaseCalls += 1;

      return {
        status: 'completed',
        transactionId: 'unexpected-unsupported-transaction',
        entitlementIds: [],
      };
    },
  },
  ads: {
    ...unsupportedBaseGateway.ads,
    async showRewarded() {
      unsupportedRewardCalls += 1;

      return {
        status: 'unavailable',
        rewardGranted: false,
      };
    },
  },
} satisfies PlatformGateway;
const unsupportedClient = createGameServicesClient({
  gateway: unsupportedGateway,
  playerId,
  target: 'reddit',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
});
const unsupportedPurchase = await unsupportedClient.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: 'unsupported-purchase',
});
const unsupportedReward = await unsupportedClient.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'unsupported-reward',
});

assertEqual(unsupportedPurchase.status, 'rejected', 'unsupported target purchase should reject');
assertEqual(
  unsupportedPurchase.purchase.status,
  'failed',
  'unsupported target purchase should return a failed platform result without a platform call',
);
assertEqual(
  unsupportedReward.status,
  'unavailable',
  'unsupported provider should remain unavailable',
);
assertEqual(
  unsupportedReward.reward.status,
  'unavailable',
  'a supported build target uses the adapter availability result',
);
assertEqual(
  unsupportedPurchaseCalls,
  0,
  'unsupported target purchase should not call platform commerce',
);
assertEqual(
  unsupportedRewardCalls,
  1,
  'reward eligibility is selected by the provider rather than a target allow-list',
);
assertEqual(
  purchaseClaims,
  purchaseClaimsBeforeUnsupported,
  'unsupported target purchase should not call purchase backend',
);
assertEqual(
  rewardClaims,
  rewardClaimsBeforeUnsupported,
  'unsupported target rewarded ad should not call ad reward backend',
);

let microsoftStoreVerificationCalls = 0;
const microsoftStoreBaseGateway = createMockGateway();
const microsoftStoreGateway = {
  ...microsoftStoreBaseGateway,
  target: 'microsoft-store',
  commerce: {
    ...microsoftStoreBaseGateway.commerce,
    async purchase() {
      return {
        status: 'completed',
        transactionId: 'microsoft-store-ledger',
        authoritativeGrant: { ledgerEntryId: 'microsoft-store-ledger' },
        entitlementIds: [],
        evidence: {
          schema: 'mpgd.microsoft-store.digital-goods.v1',
          payload: {
            itemId: 'coins_100',
            purchaseToken: 'coins_100',
          },
        },
      } as const;
    },
  },
} satisfies PlatformGateway;
const microsoftStoreClient = createGameServicesClient({
  gateway: microsoftStoreGateway,
  playerId,
  target: 'microsoft-store',
  backend: {
    ...backend,
    purchases: {
      async verifyPurchase() {
        microsoftStoreVerificationCalls += 1;
        throw new Error('authoritative Store completion must not be reverified');
      },
    },
  },
});
const microsoftStorePurchase = await microsoftStoreClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'microsoft-store-purchase',
});
const microsoftStoreLeaderboard = await microsoftStoreClient.submitLeaderboardScore({
  leaderboardId: 'daily',
  score: 987,
  runId: 'microsoft-store-run',
  submittedAt: '2026-07-03T00:00:04.000Z',
});

assertEqual(
  microsoftStorePurchase.status,
  'granted',
  'Microsoft Store should use the authoritative purchase client',
);
assertEqual(
  microsoftStorePurchase.ledgerEntryId,
  'microsoft-store-ledger',
  'Microsoft Store should preserve the authority ledger ID',
);
assertEqual(
  microsoftStoreVerificationCalls,
  0,
  'Microsoft Store authority completions should not be sent through verification twice',
);
assertEqual(
  microsoftStoreLeaderboard.submitted,
  true,
  'Microsoft Store should use the generic leaderboard flow',
);
assertEqual(
  microsoftStoreLeaderboard.platformSubmitted,
  true,
  'Microsoft Store should submit the score through its browser gateway',
);

// Commerce v2: a gateway with a commerce v2 provider purchases through the
// reconciler (`createCommerceReconciler`). Settlement is declared by the
// provider's capability block, and a settled purchase is still confirmed
// through one verify request the ledger answers from its existing entry (RFC
// vector `adapter-settled`); the v1 target-name rule applies only to gateways
// without a v2 provider.
interface MockCommerceV2 extends CommerceProvider {
  readonly purchaseUiOpened: number;
}

function createMockCommerceV2(
  evidence: CommerceCapabilities['authority']['evidence'],
  options: { readonly getCapabilities?: () => Promise<CommerceCapabilities> } = {},
): MockCommerceV2 {
  let purchaseUiOpened = 0;
  const capabilities = async (): Promise<CommerceCapabilities> => ({
    purchase: { consumable: true, durable: false, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: false,
      restore: true,
      events: true,
      finish: 'server',
    },
    authority: { evidence, accountBinding: 'required' },
    availability: 'available',
  });
  return {
    store: 'mock-store',
    get purchaseUiOpened() {
      return purchaseUiOpened;
    },
    getCapabilities: options.getCapabilities ?? capabilities,
    async fetchProducts() {
      return [
        {
          logicalId: 'COINS_100',
          store: 'mock-store',
          storeSku: 'coins_100',
          kind: 'consumable',
          title: '100 Coins',
          description: 'Adds 100 coins.',
          price: { formatted: '$0.99', currencyCode: 'USD' },
        },
      ];
    },
    async requestPurchase(request) {
      purchaseUiOpened += 1;
      // The store answered synchronously: the v1 wrapper of this provider
      // reports the Store purchase token as transactionId.
      return {
        outcome: 'purchased',
        purchase: {
          store: 'mock-store',
          transactionId: `tx-${request.idempotencyKey}`,
          storeSku: 'coins_100',
          logicalId: 'COINS_100',
          quantity: 1,
          state: 'purchased',
          // One token per purchase, as every real store reports it.
          token: `token-${request.idempotencyKey}`,
          evidence: {
            schema: 'mpgd.microsoft-store.digital-goods.v1',
            payload: { itemId: 'coins_100', purchaseToken: 'coins_100' },
          },
          ...(evidence === 'adapter-settled' ? { settlement: { ledgerEntryId: 'ledger-v2' } } : {}),
        },
      };
    },
    async getAvailablePurchases() {
      return [];
    },
    subscribe() {
      return () => {};
    },
  };
}

function createSettledCommerceGateway(
  target: PlatformGateway['target'],
  provider: CommerceProvider | undefined,
): PlatformGateway {
  const base = createMockGateway();
  return {
    ...base,
    target,
    ...(provider === undefined ? {} : { commerceV2: provider }),
    commerce: {
      ...base.commerce,
      async purchase() {
        return {
          status: 'completed',
          transactionId: 'coins_100',
          authoritativeGrant: { ledgerEntryId: 'ledger-v2', alreadyProcessed: true },
          entitlementIds: [],
          evidence: {
            schema: 'mpgd.microsoft-store.digital-goods.v1',
            payload: { itemId: 'coins_100', purchaseToken: 'coins_100' },
          },
        } as const;
      },
    },
  };
}

/** A backend whose verify answers a finalized grant, so a server-finish record ends `finished` in one call. */
function createVerifyingBackend(
  onVerify: (request: VerifyPurchaseRequest) => void,
): GameServicesBackendApi {
  return {
    ...backend,
    purchases: {
      async verifyPurchase(request) {
        onVerify(request);
        return {
          verified: true,
          ledgerEntryId: `verified-${request.platformTransactionId}`,
          alreadyProcessed: false,
          finalization: { status: 'completed', action: 'consume', alreadyCompleted: false },
        };
      },
    },
  };
}

const adapterSettledRequests: VerifyPurchaseRequest[] = [];
const adapterSettledEvents: string[] = [];
const adapterSettledStates: string[] = [];
const adapterSettledProvider = createMockCommerceV2('adapter-settled');
const adapterSettledClient = createGameServicesClient({
  gateway: createSettledCommerceGateway('microsoft-store', adapterSettledProvider),
  playerId,
  target: 'microsoft-store',
  warn: () => {},
  backend: createVerifyingBackend((request) => {
    adapterSettledRequests.push(request);
  }),
  analytics: {
    track(event) {
      adapterSettledEvents.push(`${event.name}:${String(event.properties.ledgerEntryId)}`);
    },
  },
  onCommerceEvent(event) {
    if (event.type === 'transition') {
      adapterSettledStates.push(event.record.state);
    }
  },
});
const adapterSettledPurchase = await adapterSettledClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'adapter-settled-purchase',
});

assertEqual(
  adapterSettledPurchase.status,
  'granted',
  'a commerce v2 adapter-settled completion is granted once the backend confirms the ledger entry',
);
assertEqual(
  adapterSettledPurchase.ledgerEntryId,
  'verified-tx-adapter-settled-purchase',
  'the ledger entry comes from the verify answer, never from the provider settlement pointer',
);
assertEqual(
  adapterSettledRequests.length,
  1,
  'an adapter-settled completion is confirmed through exactly one verify request',
);
assertEqual(
  adapterSettledRequests[0]?.idempotencyKey,
  'adapter-settled-purchase',
  'the game key is the purchase idempotency key',
);
assertEqual(
  adapterSettledRequests[0]?.platformTransactionId,
  'tx-adapter-settled-purchase',
  'the verify request names the store transaction',
);
assertEqual(
  adapterSettledRequests[0]?.evidence?.schema,
  'mpgd.microsoft-store.digital-goods.v1',
  'the verify request carries the purchase evidence',
);
assertEqual(adapterSettledProvider.purchaseUiOpened, 1, 'the store UI opened once');
assertEqual(
  adapterSettledStates.join(','),
  'requested,launched,purchased,verifying,granted,finishing,finished',
  'every RFC transition is its own journal revision',
);
assertEqual(
  adapterSettledEvents.join(','),
  'purchase_granted:verified-tx-adapter-settled-purchase',
  'the grant is tracked exactly once',
);
assertEqual(
  (await adapterSettledClient.commerceReconciler?.read('adapter-settled-purchase'))?.state,
  'finished',
  'the client exposes the reconciler and its journal',
);

const replayedAdapterSettledPurchase = await adapterSettledClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'adapter-settled-purchase',
});
assertEqual(
  replayedAdapterSettledPurchase.status,
  'granted',
  'a replayed key answers from the journal',
);
assertEqual(
  adapterSettledProvider.purchaseUiOpened,
  1,
  'a replayed key never reopens the store UI',
);
assertEqual(adapterSettledRequests.length, 1, 'a replayed key is not verified again');

let clientTokenVerificationCalls = 0;
const clientTokenClient = createGameServicesClient({
  gateway: createSettledCommerceGateway('microsoft-store', createMockCommerceV2('client-token')),
  playerId,
  target: 'microsoft-store',
  warn: () => {},
  backend: createVerifyingBackend(() => {
    clientTokenVerificationCalls += 1;
  }),
});
const clientTokenPurchase = await clientTokenClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'client-token-purchase',
});

assertEqual(
  clientTokenPurchase.status,
  'granted',
  'a client-token provider completion should be granted by the backend verifier',
);
assertEqual(
  clientTokenPurchase.ledgerEntryId,
  'verified-tx-client-token-purchase',
  'a client-token provider completion should take the verifier ledger entry',
);
assertEqual(
  clientTokenVerificationCalls,
  1,
  'a v2 provider without adapter settlement must still be verified, even on the microsoft-store target',
);

let capabilityReads = 0;
const cachedCapabilityClient = createGameServicesClient({
  gateway: createSettledCommerceGateway(
    'microsoft-store',
    createMockCommerceV2('adapter-settled', {
      async getCapabilities() {
        capabilityReads += 1;
        return createMockCommerceV2('adapter-settled').getCapabilities();
      },
    }),
  ),
  playerId,
  target: 'microsoft-store',
  warn: () => {},
  backend: createVerifyingBackend(() => {}),
});
for (const idempotencyKey of ['cached-capability-1', 'cached-capability-2']) {
  const cachedPurchase = await cachedCapabilityClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey,
  });
  assertEqual(cachedPurchase.status, 'granted', `${idempotencyKey} should be granted`);
}
assertEqual(
  capabilityReads,
  1,
  'the provider capability block is read once per reconciler, not on every checkout',
);

let retriedCapabilityReads = 0;
let retriedVerificationCalls = 0;
const retriedCapabilityClient = createGameServicesClient({
  gateway: createSettledCommerceGateway(
    'microsoft-store',
    createMockCommerceV2('adapter-settled', {
      async getCapabilities() {
        retriedCapabilityReads += 1;
        if (retriedCapabilityReads === 1) {
          throw new Error('capability probe failed once');
        }
        return createMockCommerceV2('adapter-settled').getCapabilities();
      },
    }),
  ),
  playerId,
  target: 'microsoft-store',
  warn: () => {},
  backend: createVerifyingBackend(() => {
    retriedVerificationCalls += 1;
  }),
});
const retriedFirstPurchase = await retriedCapabilityClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'retried-capability-1',
});
const retriedSecondPurchase = await retriedCapabilityClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'retried-capability-2',
});

assertEqual(
  retriedFirstPurchase.ledgerEntryId,
  'verified-tx-retried-capability-1',
  'a failed capability read at start is retried before the first checkout opens',
);
assertEqual(
  retriedCapabilityReads,
  2,
  'a failed capability read is not cached; the successful read is',
);
assertEqual(
  retriedSecondPurchase.ledgerEntryId,
  'verified-tx-retried-capability-2',
  'the second checkout is verified like the first',
);
assertEqual(retriedVerificationCalls, 2, 'every checkout is verified');

let unreadableCapabilityVerificationCalls = 0;
const unreadableCapabilityProvider = createMockCommerceV2('adapter-settled', {
  async getCapabilities() {
    throw new Error('capability probe failed');
  },
});
const unreadableCapabilityClient = createGameServicesClient({
  gateway: createSettledCommerceGateway('microsoft-store', unreadableCapabilityProvider),
  playerId,
  target: 'microsoft-store',
  warn: () => {},
  backend: createVerifyingBackend(() => {
    unreadableCapabilityVerificationCalls += 1;
  }),
});
const unreadableCapabilityPurchase = await unreadableCapabilityClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'unreadable-capability-purchase',
});

assertEqual(
  unreadableCapabilityPurchase.status,
  'failed',
  'a v2 provider whose capabilities cannot be read fails closed before the store UI opens',
);
assertEqual(
  unreadableCapabilityPurchase.purchase.diagnostic?.code,
  'NOT_PREPARED',
  'the failure names the unprepared provider',
);
assertEqual(unreadableCapabilityProvider.purchaseUiOpened, 0, 'no store UI opened');
assertEqual(unreadableCapabilityVerificationCalls, 0, 'nothing was verified');

let wrappedLegacyVerificationCalls = 0;
const wrappedLegacyClient = createGameServicesClient({
  gateway: createSettledCommerceGateway('microsoft-store', undefined),
  playerId,
  target: 'microsoft-store',
  backend: {
    ...backend,
    purchases: {
      async verifyPurchase(input) {
        wrappedLegacyVerificationCalls += 1;
        return {
          verified: true,
          ledgerEntryId: `verified-${input.platformTransactionId}`,
          alreadyProcessed: false,
        };
      },
    },
  },
});
const wrappedLegacyPurchase = await wrappedLegacyClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'wrapped-legacy-purchase',
});

assertEqual(
  wrappedLegacyVerificationCalls,
  1,
  'without commerceV2 the legacy target-name rule applies, which does not match a token transaction id',
);
assertEqual(
  wrappedLegacyPurchase.status,
  'granted',
  'the legacy path still grants through the backend verifier',
);
assertEqual(
  wrappedLegacyClient.commerceReconciler,
  undefined,
  'a gateway without a v2 provider has no reconciler',
);

let verse8PurchaseCalls = 0;
let verse8RewardCalls = 0;
let verse8LeaderboardCalls = 0;
const verse8BaseGateway = createMockGateway();
const verse8Gateway = {
  ...verse8BaseGateway,
  target: 'verse8',
  commerce: {
    ...verse8BaseGateway.commerce,
    async purchase() {
      verse8PurchaseCalls += 1;

      return {
        status: 'pending',
        entitlementIds: [],
      };
    },
  },
  ads: {
    ...verse8BaseGateway.ads,
    async showRewarded() {
      verse8RewardCalls += 1;

      // Verse8 SDK callbacks are claim candidates: no grant, no ledger entry.
      return {
        status: 'completed',
        rewardGranted: false,
        evidence: {
          schema: 'verse8.ads.reward.v1',
          payload: {
            requestId: 'verse8-request-1',
            placementId: 'rewarded_continue',
          },
        },
      };
    },
  },
  leaderboard: {
    ...verse8BaseGateway.leaderboard,
    async submitScore() {
      verse8LeaderboardCalls += 1;
      return { submitted: true };
    },
  },
} satisfies PlatformGateway;
const verse8Client = createGameServicesClient({
  gateway: verse8Gateway,
  playerId,
  target: 'verse8',
  deploymentTarget: 'verse8-staging',
  now: () => '2026-07-03T00:00:00.000Z',
  backend,
});
const purchaseClaimsBeforeVerse8 = purchaseClaims;
const verse8Purchase = await verse8Client.purchase({
  productId: 'COINS_100',
  source: 'result',
  idempotencyKey: 'verse8-purchase',
});
const verse8Reward = await verse8Client.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'verse8-reward',
});
const verse8Leaderboard = await verse8Client.submitLeaderboardScore({
  leaderboardId: 'default',
  score: 500,
  runId: 'verse8-run',
  submittedAt: '2026-07-03T00:00:00.000Z',
});

assertEqual(verse8Purchase.status, 'pending', 'Verse8 purchases should await Agent8 server events');
assertEqual(verse8Reward.status, 'granted', 'Verse8 rewarded ads should reach the backend');
assertEqual(verse8Leaderboard.submitted, false, 'Verse8 leaderboards should stay unsupported');
assertEqual(verse8PurchaseCalls, 1, 'Verse8 purchases should open platform commerce');
assertEqual(
  purchaseClaims,
  purchaseClaimsBeforeVerse8,
  'Verse8 purchases should not call the external purchase verifier',
);
assertEqual(verse8RewardCalls, 1, 'Verse8 rewards should call platform ads');
assertEqual(
  rewardDeploymentTarget,
  'verse8-staging',
  'Verse8 rewards should carry the deployment target to the backend claim',
);
assertEqual(
  rewardEvidenceSchema,
  'verse8.ads.reward.v1',
  'Verse8 client evidence should be forwarded to the backend claim',
);
assertEqual(
  rewardPlatformImpressionId,
  'verse8-request-1',
  'Verse8 claims should carry the evidence requestId as the platform impression id',
);
assertEqual(verse8LeaderboardCalls, 0, 'Verse8 should not call the platform leaderboard');

const rewardClaimsBeforeUntrustedVerse8 = rewardClaims;
const verse8UntrustedRewardGateway = {
  ...verse8Gateway,
  ads: {
    ...verse8Gateway.ads,
    async showRewarded() {
      return {
        status: 'completed',
        rewardGranted: false,
        evidence: {
          schema: 'untrusted.client.schema',
          payload: { requestId: 'forged' },
        },
      } as const;
    },
  },
} satisfies PlatformGateway;
const verse8UntrustedReward = await createGameServicesClient({
  gateway: verse8UntrustedRewardGateway,
  playerId,
  target: 'verse8',
  backend,
}).claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'verse8-untrusted-reward',
});

assertEqual(
  verse8UntrustedReward.status,
  'rejected',
  'Ungranted rewards with an unknown evidence schema should be rejected client-side',
);
assertEqual(
  rewardClaims,
  rewardClaimsBeforeUntrustedVerse8,
  'Unknown evidence schemas should never reach the backend claim',
);

const verse8CompletedGateway = {
  ...verse8Gateway,
  commerce: {
    ...verse8Gateway.commerce,
    async purchase() {
      return {
        status: 'completed',
        transactionId: 'untrusted-client-transaction',
        entitlementIds: ['untrusted-entitlement'],
      } as const;
    },
  },
} satisfies PlatformGateway;
const verse8CompletedClient = createGameServicesClient({
  gateway: verse8CompletedGateway,
  playerId,
  target: 'verse8',
  backend,
});
const verse8CompletedPurchase = await verse8CompletedClient.purchase({
  productId: 'REMOVE_ADS',
  source: 'shop',
  idempotencyKey: 'verse8-untrusted-completion',
});

assertEqual(
  verse8CompletedPurchase.status,
  'rejected',
  'Verse8 client-side completion should never grant a purchase',
);
assertEqual(
  purchaseClaims,
  purchaseClaimsBeforeVerse8,
  'Verse8 client-side completion should not reach the external verifier',
);

const transportCalls: string[] = [];
const httpBackend = createGameServicesHttpBackendApi({
  transport: {
    async send(request) {
      transportCalls.push(request.endpoint);

      switch (request.endpoint) {
        case gameServicesBackendEndpoints.verifyPurchase:
          return {
            status: 200,
            body: {
              verified: true,
              ledgerEntryId: 'http-purchase-ledger',
              alreadyProcessed: false,
            },
          };
        case gameServicesBackendEndpoints.claimAdReward:
          return {
            status: 200,
            body: {
              granted: true,
              ledgerEntryId: 'http-reward-ledger',
              alreadyProcessed: false,
            },
          };
        case gameServicesBackendEndpoints.recordLeaderboardScore:
          return {
            status: 200,
            body: {
              submitted: true,
              ledgerEntryId: 'http-score-ledger',
              alreadyProcessed: false,
              rank: 1,
            },
          };
      }
    },
  },
});
const httpPurchase = await httpBackend.purchases.verifyPurchase({
  target: 'android',
  playerId,
  productId: 'COINS_100',
  platformTransactionId: 'txn-http',
  idempotencyKey: 'http-purchase',
  purchasedAt: '2026-07-03T00:00:04.000Z',
});
const httpScore = await httpBackend.leaderboard.recordScore({
  target: 'android',
  playerId,
  leaderboardId: 'default',
  score: 4321,
  runId: 'run-http',
  submittedAt: '2026-07-03T00:00:05.000Z',
});

assertEqual(httpPurchase.verified, true, 'http backend should verify purchase');
assertEqual(httpScore.submitted, true, 'http backend should record score');
assertEqual(
  transportCalls.join(','),
  [
    gameServicesBackendEndpoints.verifyPurchase,
    gameServicesBackendEndpoints.recordLeaderboardScore,
  ].join(','),
  'http backend should route to typed endpoints',
);

let fetchUrl = '';
const fetchBackend = createGameServicesHttpBackendApi({
  transport: createGameServicesFetchBackendTransport({
    baseUrl: 'https://game-services.test/api/',
    async fetch(url, init) {
      fetchUrl = url;
      assertEqual(init.method, 'POST', 'fetch transport should use POST');
      assertEqual(
        init.headers['content-type'],
        'application/json',
        'fetch transport should send JSON',
      );

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            granted: true,
            ledgerEntryId: 'fetch-reward-ledger',
            alreadyProcessed: false,
          });
        },
      };
    },
  }),
});
const fetchReward = await fetchBackend.adRewards.claimAdReward({
  target: 'android',
  playerId,
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'fetch-reward',
  completedAt: '2026-07-03T00:00:06.000Z',
});

assertEqual(fetchReward.granted, true, 'fetch backend should decode JSON response');
assertEqual(
  fetchUrl,
  'https://game-services.test/api/game-services/ad-rewards/claim',
  'fetch transport should join base URL and endpoint',
);

console.log('GameServices client vertical slice smoke test passed.');

function createMockGateway(): PlatformGateway {
  const product = {
    id: 'COINS_100',
    type: 'consumable',
    title: '100 Coins',
    description: 'Adds 100 coins.',
    price: {
      formatted: '$0.99',
      currencyCode: 'USD',
    },
  } as const satisfies ProductInfo;

  return {
    target: 'android',
    async getCapabilities() {
      return {
        nativeIap: true,
        nativeAds: true,
        rewardedAds: true,
        interstitialAds: true,
        nativeLeaderboard: true,
        remoteLeaderboard: false,
        achievements: false,
        cloudSave: false,
        socialShare: false,
        haptics: false,
        localizedContent: true,
      };
    },
    identity: {
      async getPlayer() {
        return {
          playerId,
        };
      },
    },
    commerce: {
      async getProducts() {
        return [product];
      },
      async purchase(input) {
        return {
          status: 'completed',
          transactionId: `txn-${input.productId}-${input.idempotencyKey}`,
          entitlementIds: [],
          evidence: {
            schema: 'test.purchase.v1',
            payload: {
              signedTransaction: 'test-signed-transaction',
            },
          },
        };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded(input) {
        return {
          status: 'completed',
          rewardGranted: true,
          ledgerEntryId: `impression-${input.idempotencyKey}`,
          evidence: {
            schema: 'test.reward.v1',
            payload: {
              signedCallback: 'test-signed-callback',
            },
          },
        };
      },
    },
    leaderboard: {
      async submitScore() {
        return {
          submitted: true,
        };
      },
      async open() {},
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  };
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
