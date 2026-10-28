import {
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
  createPlatformOrderVerifyRequest,
  microsoftStoreDigitalGoodsEvidenceSchema,
  readPurchaseBoundToAnotherAccount,
} from '@mpgd/game-services';

import {
  createWorkerFetchHandler,
  createWorkerService,
  resolveWorkerRestoreSharing,
  type GameServicesEvidenceVerifierBinding,
  type GameServicesPurchaseGrantFinalizerBinding,
  type GameServicesWorkerEnv,
} from './handler.js';

// Restore sharing settings: share by default, refuse on any other mode or a bad limit.
for (const [env, expected] of [
  [{}, { mode: 'share' }],
  [{ GAME_SERVICES_RESTORE_SHARING: 'share' }, { mode: 'share' }],
  [{ GAME_SERVICES_RESTORE_SHARING: 'refuse' }, { mode: 'refuse' }],
  [{ GAME_SERVICES_RESTORE_SHARING: 'shar' }, { mode: 'refuse' }],
  [{ GAME_SERVICES_RESTORE_MAX_HOLDERS: '2' }, { mode: 'share', maxHolders: 2 }],
  [{ GAME_SERVICES_RESTORE_MAX_HOLDERS: '0' }, { mode: 'refuse' }],
  [{ GAME_SERVICES_RESTORE_MAX_HOLDERS: '101' }, { mode: 'refuse' }],
  [{ GAME_SERVICES_RESTORE_MAX_HOLDERS: 'five' }, { mode: 'refuse' }],
] as const) {
  const resolved = resolveWorkerRestoreSharing(
    env as Parameters<typeof resolveWorkerRestoreSharing>[0],
  );
  if (JSON.stringify(resolved) !== JSON.stringify(expected)) {
    throw new Error(
      `restore sharing ${JSON.stringify(env)}: received ${JSON.stringify(resolved)}.`,
    );
  }
}

const workerEnv = {
  MPGD_STORE: 'memory',
  MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE: 'true',
  MPGD_ALLOW_PUBLIC_LEADERBOARD_RECORD: 'true',
  VERIFIED_LEADERBOARD_AUTH: {
    async authenticateVerifiedLeaderboardSnapshot(
      input: { readonly authorization: string },
    ) {
      return input.authorization === 'Bearer worker-read-token'
        ? { participantId: 'worker-player' }
        : undefined;
    },
  },
} satisfies GameServicesWorkerEnv;
const workerFetch = createWorkerFetchHandler(workerEnv);
const workerService = createWorkerService(workerEnv);
const baseUrl = 'https://game-services-worker.test';

const insecureDevelopmentMicrosoftStorePurchase = await workerService.verifyPurchase({
  target: 'microsoft-store',
  playerId: 'worker-development-store-player',
  productId: 'COINS_100',
  platformTransactionId: 'coins_100',
  idempotencyKey: 'worker-development-store-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
  evidence: {
    schema: microsoftStoreDigitalGoodsEvidenceSchema,
    payload: { purchaseToken: 'coins_100' },
  },
}) as { readonly verified: boolean; readonly reason?: string };
assertEqual(
  insecureDevelopmentMicrosoftStorePurchase.verified,
  false,
  'development evidence fallback must not grant Store consumables without consumption',
);
assertEqual(
  insecureDevelopmentMicrosoftStorePurchase.reason,
  'EVIDENCE_VERIFIER_UNAVAILABLE',
  'development Store evidence should fail closed with observable verifier state',
);

const defaultMemoryFetch = createWorkerFetchHandler({ MPGD_STORE: 'memory' });
const defaultMemoryPurchase = await defaultMemoryFetch(
  new Request(`${baseUrl}/game-services/purchases/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'android',
      playerId: 'worker-default-fail-closed',
      productId: 'COINS_100',
      platformTransactionId: 'worker-default-unverified',
      idempotencyKey: 'worker-default-unverified',
      purchasedAt: '2026-07-04T00:00:00.000Z',
    }),
  }),
);
const defaultMemoryPurchaseBody = await defaultMemoryPurchase.json() as {
  readonly verified: boolean;
  readonly reason?: string;
};

assertEqual(
  defaultMemoryPurchaseBody.verified,
  false,
  'deployable memory configuration should fail closed without an explicit development flag',
);
assertEqual(
  defaultMemoryPurchaseBody.reason,
  'EVIDENCE_VERIFIER_UNAVAILABLE',
  'deployable memory configuration should expose missing verifier state',
);

let verifierBindingReceivedSignal = true;
let verifierBindingTimeoutMs = 0;
let verifierBindingPurchaseCalls = 0;
let rewardVerifierBindingReceivedSignal = true;
const boundVerifierService = createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_EVIDENCE_VERIFIER: {
    async verifyPurchase(input) {
      verifierBindingPurchaseCalls += 1;
      verifierBindingReceivedSignal = Object.hasOwn(input, 'signal');
      verifierBindingTimeoutMs = input.timeoutMs;
      return {
        status: 'verified',
        verificationId: 'worker-binding:purchase',
        verifiedAt: '2026-07-04T00:00:00.000Z',
      };
    },
    async verifyAdReward(input) {
      rewardVerifierBindingReceivedSignal = Object.hasOwn(input, 'signal');
      return {
        status: 'verified',
        verificationId: 'worker-binding:reward',
        verifiedAt: '2026-07-04T00:00:00.000Z',
      };
    },
  },
});
const boundVerifierPurchase = await boundVerifierService.verifyPurchase({
  target: 'android',
  playerId: 'worker-binding-player',
  productId: 'COINS_100',
  platformTransactionId: 'worker-binding-txn',
  idempotencyKey: 'worker-binding-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const boundVerifierReward = await boundVerifierService.claimAdReward({
  target: 'android',
  playerId: 'worker-binding-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'worker-binding-impression',
  idempotencyKey: 'worker-binding-reward',
  evidence: { schema: 'mpgd.admob.client-reward.v1', payload: {} },
  completedAt: '2026-07-04T00:00:00.000Z',
});
const aggregateOnlyMicrosoftStorePurchase = await boundVerifierService.verifyPurchase({
  target: 'microsoft-store',
  playerId: 'worker-binding-player',
  productId: 'COINS_100',
  platformTransactionId: 'coins_100',
  idempotencyKey: 'worker-binding-microsoft-store-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
  evidence: {
    schema: microsoftStoreDigitalGoodsEvidenceSchema,
    payload: { purchaseToken: 'coins_100' },
  },
}) as { readonly verified: boolean; readonly reason?: string };

assertEqual(
  (boundVerifierPurchase as { readonly verified: boolean }).verified,
  true,
  'clone-safe verifier bindings should grant verified evidence',
);
assertEqual(
  verifierBindingReceivedSignal,
  false,
  'Worker RPC verifier bindings must not receive non-cloneable AbortSignal values',
);
assertEqual(
  verifierBindingTimeoutMs,
  10_000,
  'Worker RPC verifier bindings should receive the local timeout budget',
);
assertEqual(
  (boundVerifierReward as { readonly granted: boolean }).granted,
  true,
  'clone-safe reward verifier bindings should grant verified evidence',
);
assertEqual(
  rewardVerifierBindingReceivedSignal,
  false,
  'reward verifier bindings must not receive non-cloneable AbortSignal values',
);
assertEqual(
  aggregateOnlyMicrosoftStorePurchase.verified,
  false,
  'an aggregate verifier must not grant Store evidence without the paired finalizer boundary',
);
assertEqual(
  aggregateOnlyMicrosoftStorePurchase.reason,
  'EVIDENCE_VERIFIER_UNAVAILABLE',
  'aggregate-only Store verification should fail closed with observable verifier state',
);
assertEqual(
  verifierBindingPurchaseCalls,
  1,
  'Microsoft Store evidence must not reach the legacy aggregate verifier',
);

let configuredDeploymentTarget: string | undefined;
let configuredPlatformProductId: string | undefined;
const configuredDeploymentEnv = {
  MPGD_STORE: 'memory',
  GAME_SERVICES_ANDROID_DEPLOYMENT_TARGET: 'android-staging',
  GAME_SERVICES_EVIDENCE_VERIFIER: {
    async verifyPurchase(input) {
      configuredDeploymentTarget = input.request.deploymentTarget;
      configuredPlatformProductId = input.platformProductId;
      return verifiedDecision(`configured-deployment:${input.request.idempotencyKey}`);
    },
    async verifyAdReward() {
      return { status: 'rejected', reason: 'NOT_USED' } as const;
    },
  },
} satisfies GameServicesWorkerEnv;
const configuredDeploymentService = createWorkerService(configuredDeploymentEnv);
const configuredDeploymentPurchase = await configuredDeploymentService.verifyPurchase({
  target: 'android',
  playerId: 'configured-deployment-player',
  productId: 'COINS_100',
  platformTransactionId: 'configured-deployment-transaction',
  idempotencyKey: 'configured-deployment-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
}) as { readonly verified: boolean };

assertEqual(
  configuredDeploymentPurchase.verified,
  true,
  'the worker should derive custom deployment targets from trusted environment bindings',
);
assertEqual(
  configuredDeploymentTarget,
  'android-staging',
  'the worker should bind an omitted client deployment target before verification',
);
assertEqual(
  configuredPlatformProductId,
  'coins_100_android_staging',
  'the worker should resolve the server-bound catalog identifier',
);

const configuredDeploymentFetch = createWorkerFetchHandler(configuredDeploymentEnv);
const conflictingDeploymentResponse = await configuredDeploymentFetch(
  new Request(`${baseUrl}/game-services/purchases/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'android',
      deploymentTarget: 'android-production',
      playerId: 'configured-deployment-player',
      productId: 'COINS_100',
      platformTransactionId: 'conflicting-deployment-transaction',
      idempotencyKey: 'conflicting-deployment-purchase',
      purchasedAt: '2026-07-04T00:00:00.000Z',
    }),
  }),
);
const conflictingDeploymentBody = await conflictingDeploymentResponse.json() as {
  readonly error?: string;
  readonly message?: string;
};

assertEqual(
  conflictingDeploymentResponse.status,
  400,
  'the worker HTTP entry point should reject conflicting client deployment targets',
);
assertEqual(
  conflictingDeploymentBody.error,
  'INVALID_REQUEST',
  'the worker should expose the stable validation error code across HTTP',
);
assertEqual(
  conflictingDeploymentBody.message,
  'deploymentTarget must match the backend binding for android.',
  'the worker should preserve the backend binding error message across HTTP',
);

const targetVerifierCalls: string[] = [];
const targetVerifierReceivedSignals: boolean[] = [];
const targetVerifierTimeouts: number[] = [];
const androidFinalizerCalls: string[] = [];
const androidFinalizerBinding = {
  async finalizePurchaseGrant(input) {
    androidFinalizerCalls.push(`${input.request.target}:${input.product.type}`);
    return { status: 'completed', action: 'consume', alreadyCompleted: false };
  },
} satisfies GameServicesPurchaseGrantFinalizerBinding;
// Commerce v2 C2: the google-play registry entry declares finish: server, so an
// Android verifier without a Play finalizer closes the purchase routes (logged at
// startup) while the rewarded-ad and leaderboard routes keep serving.
const unfinalizedAndroidEnv = {
  MPGD_STORE: 'memory',
  GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER: {
    async verifyPurchase(input) {
      return verifiedDecision(`android-self:${input.request.idempotencyKey}`);
    },
    async verifyAdReward(input) {
      return verifiedDecision(`android-self:${input.request.idempotencyKey}`);
    },
  },
} satisfies GameServicesWorkerEnv;
const unfinalizedAndroidService = createWorkerService(unfinalizedAndroidEnv);
await assertRejects(
  () =>
    unfinalizedAndroidService.verifyPurchase({
      target: 'android',
      playerId: 'unfinalized-player',
      productId: 'COINS_100',
      platformTransactionId: 'unfinalized-txn',
      idempotencyKey: 'unfinalized-purchase',
      purchasedAt: '2026-07-04T00:00:00.000Z',
    }),
  /verified but never finalized/u,
  'an Android verifier without a Play finalizer closes the purchase route',
);
await assertRejects(
  () => unfinalizedAndroidService.getCommerceCapabilities(),
  /verified but never finalized/u,
  'the capabilities read reports the same misconfiguration',
);
const unfinalizedAndroidReward = await unfinalizedAndroidService.claimAdReward({
  target: 'android',
  playerId: 'unfinalized-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'unfinalized-impression',
  idempotencyKey: 'unfinalized-reward',
  evidence: { schema: 'mpgd.admob.client-reward.v1', payload: {} },
  completedAt: '2026-07-04T00:00:00.000Z',
}) as { readonly granted: boolean };
assertEqual(unfinalizedAndroidReward.granted, true, 'rewarded ads keep serving');
const unfinalizedPurchaseRoute = await createWorkerFetchHandler(unfinalizedAndroidEnv)(
  new Request(`${baseUrl}/game-services/purchases/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'android', playerId: 'p', productId: 'COINS_100' }),
  }),
);
assertEqual(unfinalizedPurchaseRoute.status, 500, 'the public purchase route fails closed');
// The explicit opt-out: the binding acknowledges purchases itself.
const selfFinalizingService = createWorkerService({
  ...unfinalizedAndroidEnv,
  GAME_SERVICES_ANDROID_VERIFIER_FINALIZES: 'true',
});
const selfFinalizingCapabilities = await selfFinalizingService.getCommerceCapabilities() as {
  readonly stores: readonly { readonly store: string; readonly finish: string }[];
};
assertEqual(
  selfFinalizingCapabilities.stores.find((entry) => entry.store === 'google-play')?.finish,
  'client',
  'a self-finalizing Android binding is published with the client finish owner',
);
const selfFinalized = await selfFinalizingService.verifyPurchase({
  target: 'android',
  playerId: 'self-finalized-player',
  productId: 'COINS_100',
  platformTransactionId: 'self-finalized-txn',
  idempotencyKey: 'self-finalized-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
}) as { readonly verified: boolean; readonly finalization?: unknown };
assertEqual(selfFinalized.verified, true, 'the binding verifies as in v1');
assertEqual(selfFinalized.finalization, undefined, 'nothing is finalized on the server');
await assertRejects(
  () =>
    createWorkerService({
      MPGD_STORE: 'memory',
      GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME: 'com.example.game',
    }).getCommerceCapabilities(),
  /must be configured together/u,
  'the Play package name needs the publisher auth service',
);
await assertRejects(
  () =>
    createWorkerService({
      MPGD_STORE: 'memory',
      GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME: 'com.example.game',
      GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH: {
        async getAccessToken() {
          return 'token';
        },
      },
    }).getCommerceCapabilities(),
  /ACCOUNT_BINDING or the explicit/u,
  'the in-Worker Play boundary needs account binding or the unbound opt-in',
);
// The unbound opt-in grants a token with no Google account id to the body playerId.
// That is safe only when ingress auth already binds playerId, so the Worker must
// refuse to start — not merely close the purchase route — when the flag is set alone.
const unboundPlayWithoutIngress = /refused unless GAME_SERVICES_INGRESS_AUTH is bound/;
const unboundPlayFlagOnly = {
  MPGD_STORE: 'memory',
  GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER: 'true',
} satisfies GameServicesWorkerEnv;
assertThrows(
  () => createWorkerFetchHandler(unboundPlayFlagOnly),
  unboundPlayWithoutIngress,
  'fetch handler must refuse unbound Play purchases without ingress auth',
);
assertThrows(
  () => createWorkerService(unboundPlayFlagOnly),
  unboundPlayWithoutIngress,
  'service must refuse unbound Play purchases without ingress auth',
);
const unboundPlayBoundaryEnv = {
  MPGD_STORE: 'memory',
  GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME: 'com.example.game',
  GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH: {
    async getAccessToken() {
      return 'token';
    },
  },
  GAME_SERVICES_GOOGLE_PLAY_ALLOW_UNBOUND_PLAYER: 'true',
} satisfies GameServicesWorkerEnv;
assertThrows(
  () => createWorkerFetchHandler(unboundPlayBoundaryEnv),
  unboundPlayWithoutIngress,
  'a configured Play boundary must not start unbound purchases without ingress auth',
);
assertThrows(
  () => createWorkerService(unboundPlayBoundaryEnv),
  unboundPlayWithoutIngress,
  'service must not start a configured Play boundary without ingress auth',
);
const boundIngressForUnboundPlay = {
  ...unboundPlayBoundaryEnv,
  GAME_SERVICES_INGRESS_AUTH: {
    async authenticateGameServicesRequest() {
      return { playerId: 'ingress-player' };
    },
  },
} satisfies GameServicesWorkerEnv;
createWorkerFetchHandler(boundIngressForUnboundPlay);
const boundUnboundPlayCapabilities = await createWorkerService(boundIngressForUnboundPlay)
  .getCommerceCapabilities() as {
    readonly stores: readonly { readonly store: string; readonly finish: string }[];
  };
assertEqual(
  boundUnboundPlayCapabilities.stores.find((entry) => entry.store === 'google-play')?.finish,
  'server',
  'unbound Play purchases stay available when ingress auth binds playerId',
);
await assertRejects(
  () =>
    createWorkerService({
      MPGD_STORE: 'memory',
      MPGD_COMMERCE_LOOKUP_STORES: ['oneplay' as 'devvit'],
    }).getCommerceCapabilities(),
  /only devvit and verse8/u,
  'lookup stores are limited to the server-push stores with a ledger lookup',
);
const targetVerifierService = createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER: createTargetVerifierBinding('android'),
  GAME_SERVICES_ANDROID_PURCHASE_FINALIZER: androidFinalizerBinding,
  GAME_SERVICES_IOS_EVIDENCE_VERIFIER: createTargetVerifierBinding('ios'),
  GAME_SERVICES_AIT_EVIDENCE_VERIFIER: createTargetVerifierBinding('ait'),
  GAME_SERVICES_VERSE8_EVIDENCE_VERIFIER: createTargetVerifierBinding('verse8'),
  MPGD_COMMERCE_LOOKUP_STORES: ['devvit', 'verse8'],
});
const targetAndroidPurchase = await targetVerifierService.verifyPurchase({
  target: 'android',
  playerId: 'target-binding-player',
  productId: 'COINS_100',
  platformTransactionId: 'target-binding-android-txn',
  idempotencyKey: 'target-binding-android-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const targetIosReward = await targetVerifierService.claimAdReward({
  target: 'ios',
  playerId: 'target-binding-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'target-binding-ios-impression',
  idempotencyKey: 'target-binding-ios-reward',
  evidence: { schema: 'mpgd.admob.client-reward.v1', payload: {} },
  completedAt: '2026-07-04T00:00:00.000Z',
});
const targetAitPurchase = await targetVerifierService.verifyPurchase({
  target: 'ait',
  playerId: 'target-binding-player',
  productId: 'COINS_100',
  platformTransactionId: 'target-binding-ait-txn',
  idempotencyKey: 'target-binding-ait-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const targetVerse8Reward = await targetVerifierService.claimAdReward({
  target: 'verse8',
  playerId: 'target-binding-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  platformImpressionId: 'target-binding-verse8-impression',
  idempotencyKey: 'target-binding-verse8-reward',
  evidence: { schema: 'verse8.ads.reward.v1', payload: {} },
  completedAt: '2026-07-04T00:00:00.000Z',
});

assertEqual(
  (targetAndroidPurchase as { readonly verified: boolean }).verified,
  true,
  'Android evidence should use the Android verifier binding',
);
assertEqual(
  (targetIosReward as { readonly granted: boolean }).granted,
  true,
  'iOS evidence should use the iOS verifier binding',
);
assertEqual(
  (targetAitPurchase as { readonly verified: boolean }).verified,
  true,
  'Apps in Toss evidence should use the Apps in Toss verifier binding',
);
assertEqual(
  (targetVerse8Reward as { readonly granted: boolean }).granted,
  true,
  'Verse8 evidence should use the Verse8 verifier binding',
);
assertDeepEqual(
  targetVerifierCalls,
  ['android:purchase:android', 'ios:ad-reward:ios', 'ait:purchase:ait', 'verse8:ad-reward:verse8'],
  'target-specific evidence should dispatch only to its matching binding',
);
assertDeepEqual(
  targetVerifierReceivedSignals,
  [false, false, false, false],
  'target-specific verifier bindings must not receive AbortSignal values',
);
assertDeepEqual(
  targetVerifierTimeouts,
  [10_000, 10_000, 10_000, 10_000],
  'target-specific verifier bindings should receive the local timeout budget',
);
assertDeepEqual(
  androidFinalizerCalls,
  ['android:consumable'],
  'the Android grant is finalized through the bound Play finalizer',
);
// A binding keeps its v1 contract: schemas of its own still reach it.
const customSchemaPurchase = await targetVerifierService.verifyPurchase({
  target: 'android',
  playerId: 'target-binding-player',
  productId: 'COINS_100',
  platformTransactionId: 'target-binding-custom-txn',
  idempotencyKey: 'target-binding-custom-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
  evidence: { schema: 'game.play-binding.v1', payload: { token: 't' } },
}) as { readonly verified: boolean };
assertEqual(customSchemaPurchase.verified, true, 'an unclaimed schema reaches the Android binding');
assertEqual(targetVerifierCalls.at(-1), 'android:purchase:android', 'the binding ran');
const bindingCallsAfterCustom = targetVerifierCalls.length;
assertEqual(
  (targetAndroidPurchase as { readonly finalization?: { readonly status: string } })
    .finalization?.status,
  'completed',
  'the verify answer reports the Play finalization',
);

// The capabilities endpoint derives from the composed registry.
const serviceCapabilities = await targetVerifierService.getCommerceCapabilities() as {
  readonly commerceProtocolVersion: string;
  readonly stores: readonly { readonly store: string; readonly finish: string; readonly schemas: readonly string[] }[];
};
assertDeepEqual(
  serviceCapabilities.stores.map(
    (entry) => `${entry.store}:${entry.finish}:${entry.schemas.join('+')}`,
  ),
  [
    'google-play:server:google-play.product-purchase.v2',
    'app-store:client:app-store.signed-transaction.v1',
    'apps-in-toss:host:apps-in-toss.iap.callback.v1',
    'devvit:none:devvit.order.v1',
    'verse8:none:verse8.agent8-event.v1',
  ],
  'the Worker publishes every store its bindings serve',
);
assertEqual(
  await createWorkerService({ MPGD_STORE: 'memory' }).getCommerceCapabilities(),
  undefined,
  'a Worker without registry entries publishes no capabilities',
);

// Server-push lookups answer pending until the fulfillment path wrote the ledger, never granted.
const devvitLookup = await targetVerifierService.verifyPurchase({
  target: 'reddit',
  store: 'devvit',
  playerId: 'reddit-player',
  productId: 'COINS_100',
  platformTransactionId: 'order-1',
  idempotencyKey: 'store:devvit:order-1',
  purchasedAt: '2026-07-04T00:00:00.000Z',
  evidence: {
    schema: 'devvit.order.v1',
    payload: { orderId: 'order-1', sku: 'coins_100', source: 'checkout' },
  },
}) as { readonly verified: boolean; readonly disposition?: string; readonly reason?: string };
assertEqual(devvitLookup.verified, false, 'a Devvit order envelope never grants by itself');
assertEqual(
  devvitLookup.disposition,
  'pending',
  'the lookup waits for the fulfillment ledger entry',
);
assertEqual(devvitLookup.reason, 'LEDGER_GRANT_PENDING', 'the pending reason is observable');
const verse8Lookup = await targetVerifierService.verifyPurchase({
  target: 'verse8',
  store: 'verse8',
  playerId: 'verse8-player',
  productId: 'COINS_100',
  platformTransactionId: '42',
  idempotencyKey: 'store:verse8:42',
  purchasedAt: '2026-07-04T00:00:00.000Z',
  evidence: {
    schema: 'verse8.agent8-event.v1',
    payload: { purchaseId: '42', productId: 'coins_100', quantity: 1 },
  },
}) as { readonly verified: boolean; readonly reason?: string };
assertEqual(verse8Lookup.verified, false, 'a Verse8 Agent8 envelope never grants by itself');
assertEqual(verse8Lookup.reason, 'LEDGER_GRANT_PENDING', 'the Verse8 lookup is pending too');
const mismatchedStore = await targetVerifierService.verifyPurchase({
  target: 'ios',
  store: 'app-store',
  playerId: 'target-binding-player',
  productId: 'COINS_100',
  platformTransactionId: 'order-2',
  idempotencyKey: 'store-mismatch',
  purchasedAt: '2026-07-04T00:00:00.000Z',
  evidence: {
    schema: 'devvit.order.v1',
    payload: { orderId: 'order-2', sku: 'coins_100', source: 'checkout' },
  },
}) as { readonly verified: boolean; readonly reason?: string };
assertEqual(
  mismatchedStore.reason,
  'EVIDENCE_SCHEMA_STORE_MISMATCH',
  'a schema registered for another store is refused before any binding runs',
);
assertEqual(
  targetVerifierCalls.length,
  bindingCallsAfterCustom,
  'the lookup and mismatch answers reached no verifier binding',
);
// An aggregate verifier publishes the reference stores it serves as the
// fallback, and Android only once a Play finalizer is bound.
const aggregateLookupService = createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_EVIDENCE_VERIFIER: {
    async verifyPurchase(input) {
      return verifiedDecision(`aggregate:${input.request.idempotencyKey}`);
    },
    async verifyAdReward() {
      return verifiedDecision('aggregate:ad-reward');
    },
  },
  MPGD_COMMERCE_LOOKUP_STORES: ['devvit'],
});
const aggregateCapabilities = await aggregateLookupService.getCommerceCapabilities() as {
  readonly stores: readonly { readonly store: string; readonly finish: string }[];
};
assertDeepEqual(
  aggregateCapabilities.stores.map((entry) => `${entry.store}:${entry.finish}`),
  ['devvit:none', 'google-play:client', 'app-store:client', 'apps-in-toss:host'],
  'the aggregate fallback publishes the stores it serves next to the lookup entry',
);
const aggregateIosPurchase = await aggregateLookupService.verifyPurchase({
  target: 'ios',
  playerId: 'aggregate-player',
  productId: 'COINS_100',
  platformTransactionId: 'aggregate-ios-txn',
  idempotencyKey: 'aggregate-ios-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
}) as { readonly verified: boolean };
assertEqual(aggregateIosPurchase.verified, true, 'a declared fallback store keeps the aggregate');
const aggregateAndroidPurchase = await aggregateLookupService.verifyPurchase({
  target: 'android',
  playerId: 'aggregate-player',
  productId: 'COINS_100',
  platformTransactionId: 'aggregate-android-txn',
  idempotencyKey: 'aggregate-android-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
}) as { readonly verified: boolean };
assertEqual(
  aggregateAndroidPurchase.verified,
  true,
  'Android purchases without a Play finalizer still reach the aggregate as in v1',
);
const aggregateBrowserPurchase = await aggregateLookupService.verifyPurchase({
  target: 'browser',
  playerId: 'aggregate-player',
  productId: 'COINS_100',
  platformTransactionId: 'aggregate-browser-txn',
  idempotencyKey: 'aggregate-browser-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
}) as { readonly verified: boolean };
assertEqual(
  aggregateBrowserPurchase.verified,
  true,
  'a ledger target the aggregate served before (no entry, not declared) still reaches it',
);
// A client cannot dodge the devvit lookup by labelling a reddit purchase with another store.
const dodgedLookup = await createWorkerFetchHandler({
  MPGD_STORE: 'memory',
  GAME_SERVICES_EVIDENCE_VERIFIER: {
    async verifyPurchase(input) {
      return verifiedDecision(`aggregate-dodge:${input.request.idempotencyKey}`);
    },
    async verifyAdReward() {
      return verifiedDecision('aggregate-dodge:ad-reward');
    },
  },
  MPGD_COMMERCE_LOOKUP_STORES: ['devvit'],
})(
  new Request(`${baseUrl}/game-services/purchases/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'reddit',
      store: 'verse8',
      playerId: 'dodging-player',
      productId: 'COINS_100',
      platformTransactionId: 'order-dodge',
      idempotencyKey: 'order-dodge',
      purchasedAt: '2026-07-04T00:00:00.000Z',
      evidence: { schema: 'devvit.order.v1', payload: { orderId: 'order-dodge', sku: 'coins_100', source: 'checkout' } },
    }),
  }),
);
assertEqual(dodgedLookup.status, 400, 'a reddit purchase under another store label is refused');
// Without a payments authority the fulfillment verify is refused with a
// clear reason; the fulfillment path writes the ledger directly instead.
const paidOrder = {
  target: 'reddit' as const,
  orderId: 'order-fulfilled-1',
  playerId: 'reddit-player',
  platformSku: 'coins_100',
  paidAt: '2026-07-04T00:00:00.000Z',
  evidence: {
    schema: 'devvit.payment-order.v1',
    payload: { orderId: 'order-fulfilled-1', status: 'PAID', playerIdSource: 'devvit-context' },
  },
};
const fulfillmentVerify = createPlatformOrderVerifyRequest({
  order: paidOrder,
  productId: 'COINS_100',
});
const unboundFulfillment = await aggregateLookupService.verifyPurchase(fulfillmentVerify) as {
  readonly verified: boolean;
  readonly reason?: string;
};
assertEqual(unboundFulfillment.verified, false, 'no authority, no fulfillment grant');
assertEqual(
  unboundFulfillment.reason,
  'DEVVIT_PAYMENT_ORDER_AUTHORITY_REQUIRED',
  'the refusal names the missing binding',
);
// With the authority bound, the fulfillment verify grants and the client lookup settles.
const authorityCalls: string[] = [];
const devvitAuthorityService = createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_EVIDENCE_VERIFIER: {
    async verifyPurchase(input) {
      return verifiedDecision(`aggregate-devvit:${input.request.idempotencyKey}`);
    },
    async verifyAdReward() {
      return verifiedDecision('aggregate-devvit:ad-reward');
    },
  },
  MPGD_COMMERCE_LOOKUP_STORES: ['devvit'],
  GAME_SERVICES_DEVVIT_PAYMENT_ORDER_AUTHORITY: {
    async getOrder(input) {
      authorityCalls.push(`${input.orderId}:${input.playerId}:${input.platformSku}`);
      return {
        decision: 'resolved',
        order: {
          orderId: input.orderId,
          playerId: input.playerId,
          sku: input.platformSku,
          status: 'PAID',
        },
      };
    },
  },
});
const fulfilled = await devvitAuthorityService.verifyPurchase(fulfillmentVerify) as {
  readonly verified: boolean;
  readonly ledgerEntryId?: string;
};
assertEqual(
  fulfilled.verified,
  true,
  "the fulfillment handler's record grants through the authority",
);
assertDeepEqual(
  authorityCalls,
  ['order-fulfilled-1:reddit-player:coins_100'],
  'the authority was asked once',
);
const settledLookup = await devvitAuthorityService.verifyPurchase({
  target: 'reddit',
  store: 'devvit',
  playerId: 'reddit-player',
  productId: 'COINS_100',
  platformTransactionId: 'order-fulfilled-1',
  idempotencyKey: 'store:devvit:order-fulfilled-1',
  purchasedAt: '2026-07-04T00:00:00.000Z',
  evidence: {
    schema: 'devvit.order.v1',
    payload: { orderId: 'order-fulfilled-1', sku: 'coins_100', source: 'checkout' },
  },
}) as { readonly verified: boolean; readonly ledgerEntryId?: string; readonly alreadyProcessed: boolean };
assertEqual(settledLookup.verified, true, 'the client envelope settles on the fulfillment grant');
assertEqual(settledLookup.alreadyProcessed, true, 'nothing new was granted');
assertEqual(settledLookup.ledgerEntryId, fulfilled.ledgerEntryId, 'the same ledger entry');
assertEqual(
  createWorkerService(workerEnv),
  workerService,
  'the service is built once per env object',
);
const aggregateWithFinalizer = await createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_EVIDENCE_VERIFIER: {
    async verifyPurchase() {
      return verifiedDecision('aggregate:purchase');
    },
    async verifyAdReward() {
      return verifiedDecision('aggregate:ad-reward');
    },
  },
  GAME_SERVICES_ANDROID_PURCHASE_FINALIZER: androidFinalizerBinding,
}).getCommerceCapabilities() as {
  readonly stores: readonly { readonly store: string; readonly finish: string }[];
};
assertEqual(
  aggregateWithFinalizer.stores.find((entry) => entry.store === 'google-play')?.finish,
  'server',
  'an aggregate verifier with a bound Play finalizer publishes google-play',
);
const ledgerStatus = await targetVerifierService.getPurchaseLedgerStatus({
  ledgerEntryIds: [
    (targetAndroidPurchase as { readonly ledgerEntryId: string }).ledgerEntryId,
    'missing',
  ],
  playerId: 'target-binding-player',
}) as { readonly statuses: readonly { readonly status: string }[] };
assertDeepEqual(
  ledgerStatus.statuses.map((status) => status.status),
  ['active', 'unknown'],
  'the ledger status read answers active for the recorded grant',
);

const originalFetch = globalThis.fetch;
const verse8VerifierRequests: Request[] = [];
let aggregateWithVerse8Calls = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  verse8VerifierRequests.push(request);

  return Response.json({
    verified: true,
    status: 'verified',
    requestId: 'worker-verse8-request',
    placementId: 'rewarded_continue',
    userId: '0xabcdef1234567890',
    adNetwork: 'google',
    verifiedAt: '2026-07-04T00:00:00.000Z',
  });
};

try {
  const verse8VerifierService = createWorkerService({
    MPGD_STORE: 'memory',
    VERSE8_ADS_VERIFIER_AUTHORIZATION: 'Bearer worker-verse8-secret',
    GAME_SERVICES_EVIDENCE_VERIFIER: {
      async verifyPurchase() {
        aggregateWithVerse8Calls += 1;
        return verifiedDecision('aggregate-with-verse8:purchase');
      },
      async verifyAdReward() {
        aggregateWithVerse8Calls += 1;
        return verifiedDecision('aggregate-with-verse8:ad-reward');
      },
    },
  });
  const aggregateAndroidPurchase = await verse8VerifierService.verifyPurchase({
    target: 'android',
    playerId: 'aggregate-with-verse8-player',
    productId: 'COINS_100',
    platformTransactionId: 'aggregate-with-verse8-transaction',
    idempotencyKey: 'aggregate-with-verse8-purchase',
    purchasedAt: '2026-07-04T00:00:00.000Z',
  }) as { readonly verified: boolean };
  const verse8Reward = await verse8VerifierService.claimAdReward({
    target: 'verse8',
    playerId: '0xabcdef1234567890',
    placementId: 'CONTINUE_AFTER_FAIL',
    platformImpressionId: 'worker-verse8-request',
    idempotencyKey: 'worker-verse8-reward',
    completedAt: '2026-07-04T00:00:00.000Z',
    evidence: {
      schema: 'verse8.ads.reward.v1',
      payload: {
        requestId: 'worker-verse8-request',
        placementId: 'rewarded_continue',
      },
    },
  }) as { readonly granted: boolean };

  assertEqual(
    aggregateAndroidPurchase.verified,
    true,
    'the Verse8 credential must preserve aggregate verification for other targets',
  );
  assertEqual(
    aggregateWithVerse8Calls,
    1,
    'the built-in Verse8 verifier should override the aggregate binding only for Verse8',
  );
  assertEqual(
    verse8Reward.granted,
    true,
    'the Worker should grant only after the concrete Verse8 verifier consumes evidence',
  );
  assertEqual(
    verse8VerifierRequests.length,
    1,
    'the Worker should consume Verse8 evidence exactly once',
  );
  assertEqual(
    verse8VerifierRequests[0]?.url,
    'https://ads-verifier.verse8.io/ads/verify',
    'the Worker should use the production Verse8 verifier endpoint by default',
  );
  assertEqual(
    verse8VerifierRequests[0]?.headers.get('Authorization'),
    'Bearer worker-verse8-secret',
    'the Worker should keep verifier authorization on the server request',
  );
} finally {
  globalThis.fetch = originalFetch;
}

let aggregateFallbackCalls = 0;
let partialAndroidBindingCalls = 0;
const partialTargetVerifierService = createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_EVIDENCE_VERIFIER: {
    async verifyPurchase() {
      aggregateFallbackCalls += 1;
      return verifiedDecision('aggregate-fallback:purchase');
    },
    async verifyAdReward() {
      aggregateFallbackCalls += 1;
      return verifiedDecision('aggregate-fallback:ad-reward');
    },
  },
  GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER: {
    async verifyPurchase() {
      partialAndroidBindingCalls += 1;
      return verifiedDecision('partial-android:purchase');
    },
    async verifyAdReward() {
      partialAndroidBindingCalls += 1;
      return verifiedDecision('partial-android:ad-reward');
    },
  },
  GAME_SERVICES_ANDROID_PURCHASE_FINALIZER: androidFinalizerBinding,
});
const partialAndroidPurchase = await partialTargetVerifierService.verifyPurchase({
  target: 'android',
  playerId: 'partial-binding-player',
  productId: 'COINS_100',
  platformTransactionId: 'partial-binding-android-txn',
  idempotencyKey: 'partial-binding-android-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
});
const missingIosPurchase = await partialTargetVerifierService.verifyPurchase({
  target: 'ios',
  playerId: 'partial-binding-player',
  productId: 'COINS_100',
  platformTransactionId: 'partial-binding-ios-txn',
  idempotencyKey: 'partial-binding-ios-purchase',
  purchasedAt: '2026-07-04T00:00:00.000Z',
}) as { readonly verified: boolean; readonly reason?: string };

assertEqual(
  (partialAndroidPurchase as { readonly verified: boolean }).verified,
  true,
  'a configured target binding should take precedence over the aggregate binding',
);
assertEqual(partialAndroidBindingCalls, 1, 'Android evidence should reach only Android');
assertEqual(
  missingIosPurchase.verified,
  false,
  'a missing target-specific verifier binding should fail closed',
);
assertEqual(
  missingIosPurchase.reason,
  'EVIDENCE_VERIFIER_UNAVAILABLE',
  'missing target-specific verifier state should remain observable',
);
assertEqual(
  partialAndroidBindingCalls,
  1,
  'iOS evidence must not fall back to the Android verifier binding',
);
assertEqual(
  aggregateFallbackCalls,
  0,
  'strict target-specific mode must not fall back to the aggregate binding',
);

let microsoftStoreFinalizerReceivedSignal = true;
let microsoftStoreFinalizerCalls = 0;
let microsoftStoreVerifierCalls = 0;
const microsoftStoreFinalizerBinding = {
  async finalizePurchaseGrant(input) {
    microsoftStoreFinalizerCalls += 1;
    microsoftStoreFinalizerReceivedSignal = Object.hasOwn(input, 'signal');
    return {
      status: 'completed',
      action: 'consume',
      alreadyCompleted: false,
    };
  },
} satisfies GameServicesPurchaseGrantFinalizerBinding;
await assertRejects(
  () =>
    createWorkerService({
      MPGD_STORE: 'memory',
      GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER: {
        async verifyPurchase() {
          return verifiedDecision('microsoft-store:missing-finalizer');
        },
        async verifyAdReward() {
          return { status: 'rejected', reason: 'NOT_SUPPORTED' };
        },
      },
    }).getCommerceCapabilities(),
  /must be configured together/u,
  'Microsoft Store verifier-only configuration must fail closed',
);
await assertRejects(
  () =>
    createWorkerService({
      MPGD_STORE: 'memory',
      GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER: microsoftStoreFinalizerBinding,
    }).getCommerceCapabilities(),
  /must be configured together/u,
  'Microsoft Store finalizer-only configuration must fail closed',
);
const microsoftStoreService = createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_MICROSOFT_STORE_EVIDENCE_VERIFIER: {
    async verifyPurchase(input) {
      microsoftStoreVerifierCalls += 1;
      return verifiedDecision(`microsoft-store:${input.request.idempotencyKey}`);
    },
    async verifyAdReward() {
      return { status: 'rejected', reason: 'NOT_SUPPORTED' };
    },
  },
  GAME_SERVICES_MICROSOFT_STORE_PURCHASE_FINALIZER: microsoftStoreFinalizerBinding,
});
const microsoftStorePurchase = await microsoftStoreService.verifyPurchase({
  target: 'microsoft-store',
  playerId: 'microsoft-store-player',
  productId: 'COINS_100',
  platformTransactionId: 'coins_100',
  idempotencyKey: 'microsoft-store-purchase',
  purchasedAt: '2026-08-11T00:00:00.000Z',
  evidence: {
    schema: microsoftStoreDigitalGoodsEvidenceSchema,
    payload: { purchaseToken: 'coins_100' },
  },
}) as {
  readonly verified: boolean;
  readonly finalization?: { readonly status: string; readonly action?: string };
};
assertEqual(microsoftStorePurchase.verified, true, 'Microsoft Store evidence should grant');
assertEqual(
  microsoftStorePurchase.finalization?.status,
  'completed',
  'Microsoft Store fulfillment should return the finalizer result',
);
assertEqual(
  microsoftStorePurchase.finalization?.action,
  'consume',
  'Microsoft Store fulfillment should expose consume completion',
);
assertEqual(microsoftStoreFinalizerCalls, 1, 'Microsoft Store consume should run exactly once');
assertEqual(
  microsoftStoreFinalizerReceivedSignal,
  false,
  'AbortSignal must not cross the Worker service binding boundary',
);
assertEqual(microsoftStoreVerifierCalls, 1, 'Microsoft Store verification should run once');

const microsoftStoreEvidenceLessRetry = await microsoftStoreService.verifyPurchase({
  target: 'microsoft-store',
  playerId: 'microsoft-store-player',
  productId: 'COINS_100',
  platformTransactionId: 'coins_100',
  idempotencyKey: 'microsoft-store-purchase',
  purchasedAt: '2026-08-11T00:00:00.000Z',
}) as {
  readonly verified: boolean;
  readonly alreadyProcessed?: boolean;
  readonly finalization?: { readonly status: string };
};
assertEqual(
  microsoftStoreEvidenceLessRetry.verified,
  true,
  'an existing Store grant should accept an evidence-less finalization retry',
);
assertEqual(
  microsoftStoreEvidenceLessRetry.alreadyProcessed,
  true,
  'an evidence-less Store retry should reuse the existing grant',
);
assertEqual(
  microsoftStoreEvidenceLessRetry.finalization?.status,
  'completed',
  'an evidence-less Store retry should still complete consumption',
);
assertEqual(
  microsoftStoreVerifierCalls,
  1,
  'an existing Store grant should not be reverified from retry request evidence',
);
assertEqual(
  microsoftStoreFinalizerCalls,
  2,
  'an existing Store grant should retry its finalizer from stored evidence',
);

const unsupportedMicrosoftStorePurchase = await microsoftStoreService.verifyPurchase({
  target: 'microsoft-store',
  playerId: 'microsoft-store-unsupported-player',
  productId: 'COINS_100',
  platformTransactionId: 'coins_100-unsupported',
  idempotencyKey: 'microsoft-store-unsupported-finalizer',
  purchasedAt: '2026-08-11T00:00:00.000Z',
}) as { readonly verified: boolean; readonly reason?: string };
assertEqual(
  unsupportedMicrosoftStorePurchase.verified,
  false,
  'unsupported Microsoft Store finalization must fail before the ledger grant',
);
assertEqual(
  unsupportedMicrosoftStorePurchase.reason,
  'MICROSOFT_STORE_PURCHASE_FINALIZER_UNSUPPORTED',
  'unsupported Store finalization should remain observable',
);
assertEqual(
  microsoftStoreVerifierCalls,
  1,
  'unsupported Store evidence must not reach a verifier that could authorize a grant',
);
assertEqual(
  microsoftStoreFinalizerCalls,
  2,
  'unsupported Store evidence must not reach the finalizer',
);

const correctedMicrosoftStorePurchase = await microsoftStoreService.verifyPurchase({
  target: 'microsoft-store',
  playerId: 'microsoft-store-unsupported-player',
  productId: 'COINS_100',
  platformTransactionId: 'coins_100-unsupported',
  idempotencyKey: 'microsoft-store-unsupported-finalizer',
  purchasedAt: '2026-08-11T00:00:00.000Z',
  evidence: {
    schema: microsoftStoreDigitalGoodsEvidenceSchema,
    payload: { purchaseToken: 'coins_100' },
  },
}) as { readonly verified: boolean };
assertEqual(
  correctedMicrosoftStorePurchase.verified,
  true,
  'corrected Store evidence should reuse the idempotency key because no grant was recorded',
);
assertEqual(microsoftStoreVerifierCalls, 2, 'corrected Store evidence should reach the verifier');
assertEqual(microsoftStoreFinalizerCalls, 3, 'corrected Store evidence should reach the finalizer');

const health = await workerFetch(new Request(`${baseUrl}/health`));
const healthBody = await health.json() as { readonly version: string };
assertEqual(health.status, 200, 'health should return 200');
assertEqual(healthBody.version, 'worker-default', 'health should expose worker version');

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

const verifiedAttempt = await workerService.recordVerifiedAttempt({
  definition: {
    leaderboardId: 'worker:verified',
    scoreOrder: 'descending',
    attemptSelection: 'best',
  },
  attempt: {
    participantId: 'worker-player',
    attemptId: 'worker-verified-run-1',
    score: 999,
    completedAt: '2026-07-04T00:00:04.000Z',
    verification: {
      authorityId: 'worker-smoke',
      evidenceId: 'worker-evidence-1',
      verifiedAt: '2026-07-04T00:00:05.000Z',
    },
  },
});
const verifiedSnapshot = await workerService.getSnapshot({
  leaderboardId: 'worker:verified',
  participantId: 'worker-player',
});
assertEqual(verifiedAttempt.retained, true, 'private verified writes should retain attempts');
assertEqual(
  verifiedSnapshot?.participantEntry?.attemptId,
  'worker-verified-run-1',
  'private verified reads should return the retained attempt',
);

const unauthorizedSnapshot = await workerFetch(
  new Request(
    `${baseUrl}/game-services/verified-leaderboard/snapshot?leaderboardId=worker%3Averified`,
  ),
);
assertEqual(
  unauthorizedSnapshot.status,
  401,
  'public snapshot reads should require authentication',
);

const publicSnapshot = await workerFetch(
  new Request(
    `${baseUrl}/game-services/verified-leaderboard/snapshot?leaderboardId=worker%3Averified`,
    {
      headers: {
        Authorization: 'Bearer worker-read-token',
      },
    },
  ),
);
const publicSnapshotBody = await publicSnapshot.json() as {
  readonly participantEntry?: { readonly participantId: string };
};
assertEqual(publicSnapshot.status, 200, 'authenticated public snapshot reads should succeed');
assertEqual(
  publicSnapshotBody.participantEntry?.participantId,
  'worker-player',
  'public snapshots should derive participant scope from the auth binding',
);

const forgedParticipantScope = await workerFetch(
  new Request(
    `${baseUrl}/game-services/verified-leaderboard/snapshot`
      + '?leaderboardId=worker%3Averified&participantId=untrusted-player',
    {
      headers: {
        Authorization: 'Bearer worker-read-token',
      },
    },
  ),
);
assertEqual(
  forgedParticipantScope.status,
  400,
  'public snapshot reads must reject client-controlled participant scope',
);

const untrustedWrite = await postJson('/game-services/verified-leaderboard/record', {
  definition: {
    leaderboardId: 'public:forbidden',
    scoreOrder: 'descending',
    attemptSelection: 'best',
  },
  attempt: {
    participantId: 'untrusted-player',
    attemptId: 'untrusted-attempt',
    score: 1,
    completedAt: '2026-07-04T00:00:06.000Z',
    verification: {
      authorityId: 'untrusted-client',
      evidenceId: 'untrusted-evidence',
      verifiedAt: '2026-07-04T00:00:06.000Z',
    },
  },
});
assertEqual(untrustedWrite.status, 404, 'verified writes must not be exposed over public HTTP');

// Public unverified leaderboard record is off by default; the opt-in env above enables it.
const unverifiedScoreRequest = {
  target: 'android',
  playerId: 'worker-public-score-player',
  leaderboardId: 'default',
  score: 777,
  runId: 'worker-public-score-run',
  submittedAt: '2026-07-04T00:00:07.000Z',
} as const;
const optInHttpScore = await postJson('/game-services/leaderboard/record', unverifiedScoreRequest);
assertEqual(optInHttpScore.status, 200, 'opt-in env should mount public HTTP leaderboard record');
assertEqual(
  (await optInHttpScore.json() as { readonly submitted: boolean }).submitted,
  true,
  'opt-in public HTTP leaderboard record should submit',
);

const defaultHttpScore = await defaultMemoryFetch(
  new Request(`${baseUrl}/game-services/leaderboard/record`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(unverifiedScoreRequest),
  }),
);
assertEqual(
  defaultHttpScore.status,
  404,
  'public HTTP leaderboard record must be hidden without MPGD_ALLOW_PUBLIC_LEADERBOARD_RECORD',
);
assertEqual(
  (await defaultHttpScore.json() as { readonly error: string }).error,
  'UNKNOWN_ENDPOINT',
  'hidden public leaderboard record should look like an unknown endpoint',
);

const defaultRpcScore = await defaultMemoryFetch(
  new Request(`${baseUrl}/rpc/leaderboard/recordScore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: unverifiedScoreRequest }),
  }),
);
assertEqual(
  defaultRpcScore.status,
  404,
  'public oRPC leaderboard record must be hidden without MPGD_ALLOW_PUBLIC_LEADERBOARD_RECORD',
);

const defaultRpcPurchase = await defaultMemoryFetch(
  new Request(`${baseUrl}/rpc/commerce/verifyPurchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      json: {
        target: 'android',
        playerId: 'worker-default-rpc-player',
        productId: 'COINS_100',
        platformTransactionId: 'worker-default-rpc-txn',
        idempotencyKey: 'worker-default-rpc-purchase',
        purchasedAt: '2026-07-04T00:00:00.000Z',
      },
    }),
  }),
);
assertEqual(
  defaultRpcPurchase.status,
  200,
  'hiding the leaderboard record route must not affect other public oRPC routes',
);

const defaultServiceScore = await createWorkerService({ MPGD_STORE: 'memory' })
  .recordLeaderboardScore(unverifiedScoreRequest) as { readonly submitted: boolean };
assertEqual(
  defaultServiceScore.submitted,
  true,
  'service binding leaderboard record must stay available without the public opt-in',
);

// The development evidence verifier must never be constructed for a durable deployment.
const d1StubEnv = {
  MPGD_STORE: 'd1',
  DB: {} as D1Database,
} satisfies GameServicesWorkerEnv;
const developmentEvidenceOnD1 = /refused when MPGD_STORE is d1/;
assertThrows(
  () => createWorkerFetchHandler({ ...d1StubEnv, MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE: 'true' }),
  developmentEvidenceOnD1,
  'fetch handler must refuse the development evidence verifier with a D1 store',
);
assertThrows(
  () => createWorkerService({ ...d1StubEnv, MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE: 'true' }),
  developmentEvidenceOnD1,
  'service must refuse the development evidence verifier with a D1 store',
);
createWorkerFetchHandler(d1StubEnv);
createWorkerFetchHandler({
  MPGD_STORE: 'memory',
  MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE: 'true',
});

// Optional ingress auth binding gates every public grant route.
const ingressAuthCalls: string[] = [];
const ingressAuthFetch = createWorkerFetchHandler({
  MPGD_STORE: 'memory',
  MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE: 'true',
  MPGD_ALLOW_PUBLIC_LEADERBOARD_RECORD: 'true',
  GAME_SERVICES_INGRESS_AUTH: {
    async authenticateGameServicesRequest(input) {
      ingressAuthCalls.push(input.authorization);
      if (input.authorization === 'Bearer ingress-player-token') {
        return { playerId: 'ingress-player' };
      }
      if (input.authorization === 'Bearer ingress-broken-token') {
        throw new Error('identity service unavailable');
      }
      return undefined;
    },
  },
});
const ingressPurchaseRequest = {
  target: 'android',
  playerId: 'ingress-player',
  productId: 'COINS_100',
  platformTransactionId: 'ingress-txn-1',
  idempotencyKey: 'ingress-purchase-1',
  purchasedAt: '2026-07-04T00:00:08.000Z',
} as const;
const postIngress = (
  pathname: string,
  body: unknown,
  authorization?: string,
): Promise<Response> => ingressAuthFetch(
  new Request(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify(body),
  }),
);
const readError = async (response: Response): Promise<string> =>
  (await response.json() as { readonly error: string }).error;

const ingressLedgerStatusMissingToken = await postIngress(
  '/game-services/purchases/ledger-status',
  { ledgerEntryIds: ['ledger-1'] },
);
assertEqual(
  ingressLedgerStatusMissingToken.status,
  401,
  'the ledger status read is gated by ingress auth',
);
const ingressLedgerStatusForeignPlayer = await postIngress(
  '/game-services/purchases/ledger-status',
  { ledgerEntryIds: ['ledger-1'] },
  'Bearer ingress-player-token',
);
assertEqual(
  ingressLedgerStatusForeignPlayer.status,
  403,
  'a ledger status read names the authenticated player like every grant route',
);
const ingressLedgerStatus = await postIngress(
  '/game-services/purchases/ledger-status',
  { ledgerEntryIds: ['ledger-1'], playerId: 'ingress-player' },
  'Bearer ingress-player-token',
);
assertEqual(ingressLedgerStatus.status, 200, 'an authenticated ledger status read passes');
assertEqual(
  JSON.stringify(await ingressLedgerStatus.json()),
  JSON.stringify({ statuses: [{ ledgerEntryId: 'ledger-1', status: 'unknown' }] }),
  'an unknown ledger entry answers unknown',
);
const ingressCapabilities = await postIngress('/game-services/purchases/capabilities', {});
assertEqual(
  ingressCapabilities.status,
  404,
  'the capabilities read is public and a Worker without registry entries has none',
);
assertEqual(
  ingressAuthCalls.length,
  2,
  'the public capabilities read does not consult the ingress auth binding',
);
const ingressHappyPurchase = await postIngress(
  '/game-services/purchases/verify',
  ingressPurchaseRequest,
  'Bearer ingress-player-token',
);
assertEqual(ingressHappyPurchase.status, 200, 'authenticated ingress purchase should pass through');
assertEqual(
  (await ingressHappyPurchase.json() as { readonly verified: boolean }).verified,
  true,
  'authenticated ingress purchase should verify',
);

const ingressMissingToken = await postIngress('/game-services/purchases/verify', {
  ...ingressPurchaseRequest,
  idempotencyKey: 'ingress-purchase-missing-token',
});
assertEqual(ingressMissingToken.status, 401, 'ingress auth must reject a missing token');
assertEqual(await readError(ingressMissingToken), 'UNAUTHORIZED', 'missing token error code');

const ingressUnknownToken = await postIngress(
  '/game-services/ad-rewards/claim',
  {
    target: 'android',
    playerId: 'ingress-player',
    placementId: 'CONTINUE_AFTER_FAIL',
    platformImpressionId: 'ingress-impression-1',
    idempotencyKey: 'ingress-reward-1',
    completedAt: '2026-07-04T00:00:09.000Z',
  },
  'Bearer ingress-unknown-token',
);
assertEqual(ingressUnknownToken.status, 401, 'ingress auth must reject an unresolvable token');
assertEqual(await readError(ingressUnknownToken), 'UNAUTHORIZED', 'unresolvable token error code');

const ingressMismatchedPlayer = await postIngress(
  '/game-services/purchases/verify',
  { ...ingressPurchaseRequest, playerId: 'someone-else', idempotencyKey: 'ingress-purchase-forged' },
  'Bearer ingress-player-token',
);
assertEqual(ingressMismatchedPlayer.status, 403, 'ingress auth must reject a forged body playerId');
assertEqual(
  await readError(ingressMismatchedPlayer),
  'PLAYER_ID_MISMATCH',
  'forged body playerId error code',
);

const ingressBrokenBinding = await postIngress(
  '/game-services/purchases/verify',
  ingressPurchaseRequest,
  'Bearer ingress-broken-token',
);
assertEqual(ingressBrokenBinding.status, 500, 'ingress auth binding failures must fail closed');
assertEqual(
  await readError(ingressBrokenBinding),
  'AUTHENTICATION_FAILED',
  'binding failure error code',
);

const ingressRpcScore = await postIngress(
  '/rpc/leaderboard/recordScore',
  { json: { ...unverifiedScoreRequest, playerId: 'ingress-player', runId: 'ingress-run-1' } },
  'Bearer ingress-player-token',
);
assertEqual(ingressRpcScore.status, 200, 'authenticated oRPC leaderboard record should pass');

const ingressRpcForgedScore = await postIngress(
  '/rpc/leaderboard/recordScore',
  { json: { ...unverifiedScoreRequest, runId: 'ingress-run-forged' } },
  'Bearer ingress-player-token',
);
assertEqual(ingressRpcForgedScore.status, 403, 'oRPC body playerId must match the principal');
assertEqual(
  await readError(ingressRpcForgedScore),
  'PLAYER_ID_MISMATCH',
  'oRPC forged body playerId error code',
);

const ingressRpcMissingToken = await postIngress('/rpc/ads/claimReward', {
  json: {
    target: 'android',
    playerId: 'ingress-player',
    placementId: 'CONTINUE_AFTER_FAIL',
    platformImpressionId: 'ingress-impression-2',
    idempotencyKey: 'ingress-reward-2',
    completedAt: '2026-07-04T00:00:10.000Z',
  },
});
assertEqual(ingressRpcMissingToken.status, 401, 'oRPC grant routes must require the token');

const ingressPreflight = await ingressAuthFetch(
  new Request(`${baseUrl}/game-services/purchases/verify`, { method: 'OPTIONS' }),
);
assertEqual(ingressPreflight.status, 204, 'CORS preflight must not require ingress auth');

const ingressHealth = await ingressAuthFetch(new Request(`${baseUrl}/health`));
assertEqual(ingressHealth.status, 200, 'non-grant routes must not require ingress auth');
assertEqual(
  ingressAuthCalls.includes('Bearer ingress-player-token'),
  true,
  'ingress auth binding should receive the complete Authorization header',
);

// The grant-route gate must match the same decoded path oRPC's RPCHandler resolves: it retries
// a non-matching path after percent-decoding each segment and also ignores a trailing slash, so
// an encoded or slash-suffixed spelling of a gated route must be gated identically.
const encodedRpcScorePaths = [
  '/rpc/leaderboard/%72ecordScore',
  '/rpc/%6Ceaderboard/recordScore',
  '/rpc/leaderboard/recordScore/',
  '/rpc//leaderboard/recordScore',
] as const;
for (const encodedPath of encodedRpcScorePaths) {
  const hiddenScore = await defaultMemoryFetch(
    new Request(`${baseUrl}${encodedPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { ...unverifiedScoreRequest, runId: `encoded-${encodedPath}` } }),
    }),
  );
  assertEqual(hiddenScore.status, 404, `${encodedPath} must stay hidden without the opt-in`);
  assertEqual(await readError(hiddenScore), 'UNKNOWN_ENDPOINT', `${encodedPath} hidden error code`);
}

const encodedGrantPaths = [
  '/rpc/%63ommerce/verifyPurchase',
  '/rpc/commerce/%76erifyPurchase',
  '/rpc/commerce/verifyPurchase/',
  '/rpc/%61ds/claimReward',
  '/rpc/ads/claimReward/',
  '/game-services/%70urchases/verify',
  '/game-services/purchases/verify/',
  '/game-services/ad-rewards/%63laim',
] as const;
for (const encodedPath of encodedGrantPaths) {
  const unauthenticated = await postIngress(encodedPath, { json: ingressPurchaseRequest });
  assertEqual(unauthenticated.status, 401, `${encodedPath} must require the ingress token`);
  assertEqual(await readError(unauthenticated), 'UNAUTHORIZED', `${encodedPath} error code`);
}

const malformedGrantPath = await postIngress('/rpc/commerce/%ZZverifyPurchase', {
  json: ingressPurchaseRequest,
});
assertEqual(malformedGrantPath.status, 404, 'undecodable path segments must not reach oRPC');
assertEqual(await readError(malformedGrantPath), 'UNKNOWN_ENDPOINT', 'malformed path error code');

const encodedPlainRoute = await ingressAuthFetch(new Request(`${baseUrl}/%68ealth`));
assertEqual(
  encodedPlainRoute.status === 401 || encodedPlainRoute.status === 403,
  false,
  'encoded non-grant paths must not be gated',
);

// Binding results that are not { playerId: string } must never throw out of the handler.
const ingressShapeFetch = createWorkerFetchHandler({
  MPGD_STORE: 'memory',
  MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE: 'true',
  GAME_SERVICES_INGRESS_AUTH: {
    async authenticateGameServicesRequest(input) {
      switch (input.authorization) {
        case 'Bearer null-principal':
          return null;
        case 'Bearer string-principal':
          return 'ingress-player' as never;
        case 'Bearer empty-principal':
          return {} as never;
        case 'Bearer blank-player-id':
          return { playerId: '' };
        default:
          return undefined;
      }
    },
  },
});
const postIngressShape = (authorization: string): Promise<Response> => ingressShapeFetch(
  new Request(`${baseUrl}/game-services/purchases/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: authorization },
    body: JSON.stringify(ingressPurchaseRequest),
  }),
);

const nullPrincipal = await postIngressShape('Bearer null-principal');
assertEqual(nullPrincipal.status, 401, 'a null principal must be treated as unauthenticated');
assertEqual(await readError(nullPrincipal), 'UNAUTHORIZED', 'null principal error code');
assertEqual(
  nullPrincipal.headers.get('Access-Control-Allow-Origin'),
  '*',
  'null principal rejection must carry CORS headers',
);

for (const authorization of [
  'Bearer string-principal',
  'Bearer empty-principal',
  'Bearer blank-player-id',
]) {
  const malformedPrincipal = await postIngressShape(authorization);
  assertEqual(malformedPrincipal.status, 500, `${authorization} must fail closed`);
  assertEqual(
    await readError(malformedPrincipal),
    'AUTHENTICATION_FAILED',
    `${authorization} error code`,
  );
}

let registeredAdCalls = 0;
const registeredAdService = createWorkerService({
  MPGD_STORE: 'memory',
  MPGD_DEPLOYMENT_TARGET_BINDINGS: { browser: 'browser-extra' },
  MPGD_AD_REWARD_VERIFIERS: [
    {
      providerId: 'new-provider',
      schema: 'new-provider.reward.v1',
      bindings: [{ target: 'browser', deploymentTarget: 'browser-extra' }],
    },
  ],
  GAME_SERVICES_AD_REWARD_EVIDENCE_VERIFIER: {
    async verifyAdReward(input) {
      registeredAdCalls += 1;
      assertEqual(
        input.providerId,
        'new-provider',
        'server-selected provider identity reaches its proof verifier',
      );
      assertEqual(Object.hasOwn(input, 'signal'), false, 'registered binding remains clone-safe');
      return {
        ...verifiedDecision('registered-ad:impression'),
        platformEvidenceId: 'registered-native-impression',
      };
    },
  },
});
const registeredAdRequest = {
  target: 'browser' as const,
  playerId: 'registered-ad-player',
  placementId: 'CONTINUE_AFTER_FAIL',
  deploymentTarget: 'browser-extra',
  idempotencyKey: 'registered-ad-key',
  completedAt: '2026-10-09T00:00:00.000Z',
  evidence: { schema: 'new-provider.reward.v1', payload: {} },
};
assertEqual(
  (await registeredAdService.claimAdReward({ ...registeredAdRequest, evidence: { schema: 'unknown', payload: {} } }) as { readonly granted: boolean }).granted,
  false,
  'unregistered providers cannot grant',
);
assertEqual(registeredAdCalls, 0, 'unknown schema cannot reach a registered service binding');
assertEqual(
  (await registeredAdService.claimAdReward(registeredAdRequest) as { readonly granted: boolean }).granted,
  true,
  'a new registered provider can grant on an existing build target',
);
assertEqual(
  (await registeredAdService.claimAdReward(registeredAdRequest) as { readonly granted: boolean }).granted,
  true,
  'same-key recovery preserves the grant',
);
assertEqual(registeredAdCalls, 1, 'recovery needs no second proof call for a recorded grant');
assertEqual(
  (await registeredAdService.claimAdReward({ ...registeredAdRequest, idempotencyKey: 'registered-another-key' }) as { readonly granted: boolean }).granted,
  false,
  'another key cannot replay a verified impression',
);

// Another account's purchase: every Worker surface answers the retryable
// PURCHASE_BOUND_TO_ANOTHER_ACCOUNT error (HTTP 409), never a rejected receipt.
{
  const anotherAccountEnv = {
    MPGD_STORE: 'memory',
    GAME_SERVICES_EVIDENCE_VERIFIER: {
      async verifyPurchase() {
        return {
          status: 'rejected' as const,
          reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
          anotherAccount: true as const,
        };
      },
      async verifyAdReward() {
        return verifiedDecision('another-account:ad-reward');
      },
    },
  } satisfies GameServicesWorkerEnv;
  const anotherAccountRequest = {
    target: 'android' as const,
    playerId: 'player-b',
    productId: 'COINS_100',
    platformTransactionId: 'GPA.another-account',
    idempotencyKey: 'play-token-sha256:another-account',
    purchasedAt: '2026-07-04T00:00:00.000Z',
  };
  const anotherAccountFetch = createWorkerFetchHandler(anotherAccountEnv);
  const anotherAccountHttp = await anotherAccountFetch(
    new Request(`${baseUrl}/game-services/purchases/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anotherAccountRequest),
    }),
  );
  assertEqual(anotherAccountHttp.status, 409, 'the HTTP route answers 409');
  assertEqual(
    JSON.stringify(await anotherAccountHttp.json()),
    JSON.stringify({
      error: 'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT',
      reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
    }),
    'the HTTP body names the answer and the binding mismatch',
  );
  const anotherAccountRpc = createGameServicesOrpcClient({
    url: `${baseUrl}/rpc`,
    fetch: (url, init) => anotherAccountFetch(new Request(url, init)),
  });
  let anotherAccountRpcError: unknown;
  try {
    await anotherAccountRpc.commerce.verifyPurchase(anotherAccountRequest);
  } catch (error) {
    anotherAccountRpcError = error;
  }
  assertEqual(
    readPurchaseBoundToAnotherAccount(anotherAccountRpcError)?.reason,
    'GOOGLE_PLAY_ACCOUNT_MISMATCH',
    'the oRPC route answers the code with its reason',
  );
  await assertRejects(
    () => createWorkerService(anotherAccountEnv).verifyPurchase(anotherAccountRequest),
    /^PURCHASE_BOUND_TO_ANOTHER_ACCOUNT: GOOGLE_PLAY_ACCOUNT_MISMATCH$/u,
    'the service binding throws the answer, its message led by the code',
  );
}

console.log('Game services Worker smoke passed: HTTP, oRPC, and private binding surfaces');

function createTargetVerifierBinding(
  bindingTarget: 'android' | 'ios' | 'ait' | 'verse8',
): GameServicesEvidenceVerifierBinding {
  return {
    async verifyPurchase(input) {
      targetVerifierCalls.push(`${bindingTarget}:purchase:${input.request.target}`);
      targetVerifierReceivedSignals.push(Object.hasOwn(input, 'signal'));
      targetVerifierTimeouts.push(input.timeoutMs);
      return verifiedDecision(`${bindingTarget}:purchase`);
    },
    async verifyAdReward(input) {
      targetVerifierCalls.push(`${bindingTarget}:ad-reward:${input.request.target}`);
      targetVerifierReceivedSignals.push(Object.hasOwn(input, 'signal'));
      targetVerifierTimeouts.push(input.timeoutMs);
      return verifiedDecision(`${bindingTarget}:ad-reward`);
    },
  };
}

function verifiedDecision(verificationId: string) {
  return {
    status: 'verified' as const,
    verificationId,
    verifiedAt: '2026-07-04T00:00:00.000Z',
  };
}

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

function assertDeepEqual<T>(
  actual: readonly T[],
  expected: readonly T[],
  message: string,
): void {
  if (
    actual.length !== expected.length
    || actual.some((value, index) => !Object.is(value, expected[index]))
  ) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

async function assertRejects(
  run: () => Promise<unknown>,
  expected: RegExp,
  message: string,
): Promise<void> {
  let error: unknown;

  try {
    await run();
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof Error) || !expected.test(error.message)) {
    throw new Error(`${message}: received ${String(error)}.`);
  }
}

function assertThrows(run: () => unknown, expected: RegExp, message: string): void {
  let error: unknown;

  try {
    run();
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof Error) || !expected.test(error.message)) {
    throw new Error(`${message}: received ${String(error)}.`);
  }
}
