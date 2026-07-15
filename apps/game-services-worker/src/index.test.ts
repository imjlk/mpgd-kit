import {
  createGameServicesOrpcBackendApi,
  createGameServicesOrpcClient,
} from '@mpgd/game-services';

import {
  createWorkerFetchHandler,
  createWorkerService,
  type GameServicesEvidenceVerifierBinding,
} from './handler.js';

const workerEnv = {
  MPGD_STORE: 'memory',
  MPGD_ALLOW_INSECURE_DEVELOPMENT_EVIDENCE: 'true',
  VERIFIED_LEADERBOARD_AUTH: {
    async authenticateVerifiedLeaderboardSnapshot(
      input: { readonly authorization: string },
    ) {
      return input.authorization === 'Bearer worker-read-token'
        ? { participantId: 'worker-player' }
        : undefined;
    },
  },
} as const;
const workerFetch = createWorkerFetchHandler(workerEnv);
const workerService = createWorkerService(workerEnv);
const baseUrl = 'https://game-services-worker.test';

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
let rewardVerifierBindingReceivedSignal = true;
const boundVerifierService = createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_EVIDENCE_VERIFIER: {
    async verifyPurchase(input) {
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
  completedAt: '2026-07-04T00:00:00.000Z',
});

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

const targetVerifierCalls: string[] = [];
const targetVerifierReceivedSignals: boolean[] = [];
const targetVerifierTimeouts: number[] = [];
const targetVerifierService = createWorkerService({
  MPGD_STORE: 'memory',
  GAME_SERVICES_ANDROID_EVIDENCE_VERIFIER: createTargetVerifierBinding('android'),
  GAME_SERVICES_IOS_EVIDENCE_VERIFIER: createTargetVerifierBinding('ios'),
  GAME_SERVICES_AIT_EVIDENCE_VERIFIER: createTargetVerifierBinding('ait'),
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
assertDeepEqual(
  targetVerifierCalls,
  ['android:purchase:android', 'ios:ad-reward:ios', 'ait:purchase:ait'],
  'target-specific evidence should dispatch only to its matching binding',
);
assertDeepEqual(
  targetVerifierReceivedSignals,
  [false, false, false],
  'target-specific verifier bindings must not receive AbortSignal values',
);
assertDeepEqual(
  targetVerifierTimeouts,
  [10_000, 10_000, 10_000],
  'target-specific verifier bindings should receive the local timeout budget',
);

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
  new Request(`${baseUrl}/game-services/verified-leaderboard/snapshot?leaderboardId=worker%3Averified`),
);
assertEqual(unauthorizedSnapshot.status, 401, 'public snapshot reads should require authentication');

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

console.log('Game services Worker smoke passed: HTTP, oRPC, and private binding surfaces');

function createTargetVerifierBinding(
  bindingTarget: 'android' | 'ios' | 'ait',
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
