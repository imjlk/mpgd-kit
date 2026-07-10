import {
  createInMemoryProgressLinkStore,
  createProgressLinkService,
  gameProgressLimits,
  mergeGameProgressSnapshots,
  normalizeGameProgressSnapshot,
  type GameProgressSnapshot,
  type GuestProgressHandoffRequest,
  type GuestProgressVerifier,
  type ProgressHandoffVerifier,
  type ServerResolvedPlayerContext,
  type VerifiedProgressHandoff,
} from './progress-link';

const serverProgress = {
  completedIds: ['stage-1', 'stage-2'],
  bestTimesMs: {
    'stage-1': 1_200,
    'stage-2': 2_000,
  },
  bestScores: {
    endless: 100,
    puzzle: 500,
  },
  activeProgress: {
    id: 'run-server',
    updatedAt: '2026-07-10T00:00:00.000Z',
    payload: {
      checkpoint: 2,
      source: 'server',
    },
  },
} as const satisfies GameProgressSnapshot;

const guestProgress = {
  completedIds: ['stage-2', 'stage-3'],
  bestTimesMs: {
    'stage-1': 1_000,
    'stage-3': 3_000,
  },
  bestScores: {
    endless: 200,
    puzzle: 400,
  },
  activeProgress: {
    id: 'run-guest',
    updatedAt: '2026-07-10T00:01:00.000Z',
    payload: {
      checkpoint: 3,
      source: 'guest',
    },
  },
} as const satisfies GameProgressSnapshot;

const merged = mergeGameProgressSnapshots(serverProgress, guestProgress);

assertDeepEqual(
  merged.completedIds,
  ['stage-1', 'stage-2', 'stage-3'],
  'completed ids should merge as a sorted union',
);
assertEqual(merged.bestTimesMs['stage-1'], 1_000, 'lower best times should win');
assertEqual(merged.bestTimesMs['stage-2'], 2_000, 'server-only best times should remain');
assertEqual(merged.bestTimesMs['stage-3'], 3_000, 'guest-only best times should be added');
assertEqual(merged.bestScores.endless, 200, 'higher guest scores should win');
assertEqual(merged.bestScores.puzzle, 500, 'higher server scores should remain');
assertEqual(merged.activeProgress?.id, 'run-guest', 'the newest active progress should win');

const prototypeMetricMap = Object.fromEntries([['__proto__', 7]]);
const prototypeMetricMerge = mergeGameProgressSnapshots(
  {
    completedIds: [],
    bestTimesMs: {},
    bestScores: {},
  },
  {
    completedIds: [],
    bestTimesMs: {},
    bestScores: prototypeMetricMap,
  },
);

assertEqual(
  Object.hasOwn(prototypeMetricMerge.bestScores, '__proto__'),
  true,
  'metric merge must preserve prototype-shaped identifiers as data keys',
);
assertEqual(prototypeMetricMerge.bestScores.__proto__, 7, 'prototype-shaped metrics should merge');

const timestampTie = mergeGameProgressSnapshots(serverProgress, {
  ...guestProgress,
  activeProgress: {
    id: 'run-guest-tie',
    updatedAt: serverProgress.activeProgress.updatedAt,
    payload: {
      source: 'guest-tie',
    },
  },
});

assertEqual(
  timestampTie.activeProgress?.id,
  'run-server',
  'server active progress should win timestamp ties',
);

const store = createInMemoryProgressLinkStore([
  {
    authoritativePlayerId: 'player-1',
    progress: serverProgress,
  },
]);
const issuedHandoffs = new Map<string, VerifiedProgressHandoff>();

for (const handoffNonce of [
  'handoff-1',
  'handoff-idempotency-alias',
  'handoff-entitlements',
  'handoff-leaderboard',
  'handoff-invalid-time',
  'handoff-unverified-score',
]) {
  issuedHandoffs.set(handoffNonce, {
    handoffNonce,
    authoritativePlayerId: 'player-1',
    guestId: 'guest-1',
    issuedAt: '2026-07-10T00:00:00.000Z',
    expiresAt: '2026-07-10T02:00:00.000Z',
  });
}

issuedHandoffs.set('handoff-expired', {
  handoffNonce: 'handoff-expired',
  authoritativePlayerId: 'player-1',
  guestId: 'guest-1',
  issuedAt: '2026-07-09T22:00:00.000Z',
  expiresAt: '2026-07-09T23:00:00.000Z',
});

const handoffVerifier = {
  async verify({ handoffNonce }) {
    return issuedHandoffs.get(handoffNonce);
  },
} satisfies ProgressHandoffVerifier;
const progressVerifier = {
  async verify({ progress }) {
    if (Object.values(progress.bestScores).some((score) => score > 10_000)) {
      throw new Error('Guest score is not server-verified.');
    }

    return progress;
  },
} satisfies GuestProgressVerifier;
const service = createProgressLinkService({
  store,
  handoffVerifier,
  progressVerifier,
  now: () => '2026-07-10T01:00:00.000Z',
});
const playerContext = {
  authoritativePlayerId: 'player-1',
} as const satisfies ServerResolvedPlayerContext;
const request = {
  guestId: 'guest-1',
  handoffNonce: 'handoff-1',
  idempotencyKey: 'progress-link-1',
  guestProgress,
} as const satisfies GuestProgressHandoffRequest;
const first = await service.reconcileGuestProgress(playerContext, request);
const duplicateByIdempotency = await service.reconcileGuestProgress(playerContext, {
  ...request,
  handoffNonce: 'handoff-idempotency-alias',
});
const duplicateByNonce = await service.reconcileGuestProgress(playerContext, {
  ...request,
  idempotencyKey: 'progress-link-nonce-alias',
  guestProgress: {
    ...guestProgress,
    bestScores: {
      endless: 9_999,
    },
  },
});

assertEqual(first.alreadyProcessed, false, 'the first reconciliation should be new');
assertEqual(first.deduplicatedBy, 'none', 'the first reconciliation should not dedupe');
assertEqual(
  duplicateByIdempotency.deduplicatedBy,
  'idempotency-key',
  'an idempotency key should dedupe even when the handoff nonce changes',
);
assertEqual(
  duplicateByNonce.deduplicatedBy,
  'handoff-nonce',
  'a handoff nonce should dedupe even when the idempotency key changes',
);
assertEqual(
  duplicateByNonce.progress.bestScores.endless,
  200,
  'a duplicate handoff must not merge changed progress again',
);
(first.progress.bestScores as Record<string, number>).endless = 999;
assertEqual(
  (await store.getProgress('player-1'))?.bestScores.endless,
  200,
  'caller mutation must not alter the authoritative monotonic merge',
);

await assertRejects(
  () => service.reconcileGuestProgress(
    { authoritativePlayerId: 'player-2' },
    {
      ...request,
      idempotencyKey: 'progress-link-other-player',
    },
  ),
  'invalid or expired',
  'verified handoffs must stay bound to their authoritative player',
);
await assertRejects(
  () => service.reconcileGuestProgress(playerContext, {
    ...request,
    guestId: 'guest-2',
    idempotencyKey: 'progress-link-other-guest',
  }),
  'invalid or expired',
  'verified handoffs must stay bound to their guest',
);
await assertRejects(
  () => service.reconcileGuestProgress(playerContext, {
    ...request,
    handoffNonce: 'handoff-not-issued',
    idempotencyKey: 'progress-link-not-issued',
  }),
  'invalid or expired',
  'arbitrary handoff nonces must be rejected',
);
await assertRejects(
  () => service.reconcileGuestProgress(playerContext, {
    ...request,
    handoffNonce: 'handoff-expired',
    idempotencyKey: 'progress-link-expired',
  }),
  'invalid or expired',
  'expired handoffs must be rejected',
);

const progressWithEntitlements = {
  ...guestProgress,
  entitlements: ['premium'],
} as unknown as GameProgressSnapshot;
const progressWithLeaderboard = {
  ...guestProgress,
  leaderboard: {
    rank: 1,
  },
} as unknown as GameProgressSnapshot;
const progressWithInvalidTime = {
  ...guestProgress,
  bestTimesMs: {
    'stage-1': -1,
  },
} as GameProgressSnapshot;

await assertRejects(
  () => service.reconcileGuestProgress(playerContext, {
    ...request,
    handoffNonce: 'handoff-entitlements',
    idempotencyKey: 'progress-link-entitlements',
    guestProgress: progressWithEntitlements,
  }),
  'unsupported field entitlements',
  'progress snapshots must not carry entitlement state',
);
await assertRejects(
  () => service.reconcileGuestProgress(playerContext, {
    ...request,
    handoffNonce: 'handoff-leaderboard',
    idempotencyKey: 'progress-link-leaderboard',
    guestProgress: progressWithLeaderboard,
  }),
  'unsupported field leaderboard',
  'progress snapshots must not carry leaderboard state',
);
await assertRejects(
  () => service.reconcileGuestProgress(playerContext, {
    ...request,
    handoffNonce: 'handoff-invalid-time',
    idempotencyKey: 'progress-link-invalid-time',
    guestProgress: progressWithInvalidTime,
  }),
  'greater than or equal to zero',
  'negative best times should fail validation',
);
await assertRejects(
  () => service.reconcileGuestProgress(playerContext, {
    ...request,
    handoffNonce: 'handoff-unverified-score',
    idempotencyKey: 'progress-link-unverified-score',
    guestProgress: {
      ...guestProgress,
      bestScores: {
        endless: 1_000_000,
      },
    },
  }),
  'not server-verified',
  'guest best metrics must pass the server-owned progress verifier',
);

const inconsistentStoreService = createProgressLinkService({
  store: {
    async reconcile(reconcileRequest) {
      return {
        authoritativePlayerId: reconcileRequest.authoritativePlayerId,
        progress: reconcileRequest.guestProgress,
        alreadyProcessed: false,
        deduplicatedBy: 'idempotency-key',
      };
    },
  },
  handoffVerifier,
  progressVerifier,
  now: () => '2026-07-10T01:00:00.000Z',
});

await assertRejects(
  () => inconsistentStoreService.reconcileGuestProgress(playerContext, request),
  'inconsistent deduplication state',
  'custom stores must return a semantically consistent deduplication result',
);

const emptyProgress = {
  completedIds: [],
  bestTimesMs: {},
  bestScores: {},
} as const satisfies GameProgressSnapshot;
const sparseCompletedIds = new Array<string>(1);

assertThrows(
  () => normalizeGameProgressSnapshot({
    ...emptyProgress,
    completedIds: ['x'.repeat(gameProgressLimits.maxIdentifierLength + 1)],
  }),
  'must not exceed',
  'progress identifiers should have a fixed length bound',
);
assertThrows(
  () => normalizeGameProgressSnapshot({
    ...emptyProgress,
    completedIds: ['stage-1\nforged-log-entry'],
  }),
  'must not contain control characters',
  'progress identifiers should reject control characters',
);
assertThrows(
  () => normalizeGameProgressSnapshot({
    ...emptyProgress,
    completedIds: sparseCompletedIds,
  }),
  'must be a non-empty',
  'sparse completed-id arrays must not leak undefined entries',
);
assertThrows(
  () => normalizeGameProgressSnapshot({
    ...emptyProgress,
    completedIds: Array.from(
      { length: gameProgressLimits.maxCompletedIds + 1 },
      (_, index) => `stage-${String(index)}`,
    ),
  }),
  'must not contain more than',
  'completed ids should have a fixed entry bound',
);
assertThrows(
  () => normalizeGameProgressSnapshot({
    ...emptyProgress,
    bestScores: oversizedMetricMap(),
  }),
  'must not contain more than',
  'metric maps should enforce their entry bound before reading values',
);

let deeplyNestedPayload: unknown = true;

for (let depth = 0; depth <= gameProgressLimits.maxPayloadDepth; depth += 1) {
  deeplyNestedPayload = { next: deeplyNestedPayload };
}

const nodeHeavyProgress = progressWithPayload({
  values: Array.from({ length: gameProgressLimits.maxPayloadNodes }, () => true),
});
const sparseArrayProgress = progressWithPayload({
  values: new Array(gameProgressLimits.maxPayloadNodes + 1),
});
const sparsePayloadProgress = progressWithPayload({
  values: new Array(1),
});
const oversizedPayloadEntries = Array.from(
  { length: gameProgressLimits.maxPayloadNodes + 1 },
  (_, index) => [`field-${String(index)}`, true],
);
const oversizedPayloadObject = Object.fromEntries(oversizedPayloadEntries);
const stringHeavyProgress = progressWithPayload({
  text: 'x'.repeat(gameProgressLimits.maxPayloadStringUnits + 1),
});

assertThrows(
  () => normalizeGameProgressSnapshot(progressWithPayload({ root: deeplyNestedPayload })),
  'must not exceed depth',
  'active progress payloads should have a fixed depth bound',
);
assertThrows(
  () => normalizeGameProgressSnapshot(nodeHeavyProgress),
  'nodes',
  'active progress payloads should have a fixed node bound',
);
assertThrows(
  () => normalizeGameProgressSnapshot(sparseArrayProgress),
  'array must not contain more than',
  'sparse arrays should be bounded before allocating normalized output',
);
assertThrows(
  () => normalizeGameProgressSnapshot(sparsePayloadProgress),
  'must be JSON-compatible',
  'sparse payload arrays must not retain holes',
);
assertThrows(
  () => normalizeGameProgressSnapshot(progressWithPayload(oversizedPayloadObject)),
  'must not contain more than',
  'large payload objects should fail before entry sorting',
);
assertThrows(
  () => normalizeGameProgressSnapshot(stringHeavyProgress),
  'total characters',
  'active progress payloads should have a fixed string budget',
);
await assertRejects(
  () => service.reconcileGuestProgress(
    { authoritativePlayerId: 'x'.repeat(gameProgressLimits.maxIdentifierLength + 1) },
    request,
  ),
  'must not exceed',
  'server-resolved player identifiers should be bounded before verification',
);

console.log('GameServices progress link tests passed.');

function progressWithPayload(payload: unknown): GameProgressSnapshot {
  return {
    completedIds: [],
    bestTimesMs: {},
    bestScores: {},
    activeProgress: {
      id: 'bounded-payload',
      updatedAt: '2026-07-10T00:00:00.000Z',
      payload,
    },
  } as unknown as GameProgressSnapshot;
}

function oversizedMetricMap(): Readonly<Record<string, number>> {
  const metricMap: Record<string, number> = {};

  for (let index = 0; index <= gameProgressLimits.maxMetricEntries; index += 1) {
    Object.defineProperty(metricMap, `mode-${String(index)}`, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('oversized metric values must not be materialized');
      },
    });
  }

  return metricMap;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, received ${actualJson}.`);
  }
}

function assertThrows(
  operation: () => unknown,
  expectedMessage: string,
  message: string,
): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }

    throw error;
  }

  throw new Error(`${message}: expected operation to throw.`);
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expectedMessage: string,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }

    throw error;
  }

  throw new Error(`${message}: expected operation to reject.`);
}
