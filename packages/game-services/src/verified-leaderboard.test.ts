import {
  assertRecordVerifiedLeaderboardAttemptRequest,
  assertVerifiedLeaderboardSnapshot,
  createInMemoryVerifiedLeaderboardService,
  createVerifiedLeaderboardCursor,
  verifiedLeaderboardIdentifierMaximumLength,
  type RecordVerifiedLeaderboardAttemptRequest,
} from './verified-leaderboard';

const now = '2026-07-13T09:00:00.000Z';
const service = createInMemoryVerifiedLeaderboardService({ now: () => now });

const firstAttempt = createAttempt({
  participantId: 'player-1',
  participantLabel: 'Player One',
  attemptId: 'attempt-1',
  score: 9_000,
  metrics: { elapsedMs: 9_000, hints: 0, mistakes: 1 },
  completedAt: '2026-07-13T08:00:00.000Z',
});
const firstRecord = await service.recordVerifiedAttempt(firstAttempt);

assertEqual(firstRecord.recorded, true, 'verified attempt should be recorded');
assertEqual(firstRecord.alreadyProcessed, false, 'new attempt should not be a retry');
assertEqual(firstRecord.retained, true, 'first attempt should be retained');
assertEqual(firstRecord.entry.rank, 1, 'first attempt should initially rank first');
assertEqual(firstRecord.entry.metrics?.elapsedMs, 9_000, 'record responses should expose metrics');
assert(
  Object.isFrozen(firstRecord.entry.metrics),
  'record response metrics should be immutable copies',
);

const renamedFirstRetry = await service.recordVerifiedAttempt({
  ...firstAttempt,
  attempt: {
    ...firstAttempt.attempt,
    participantLabel: 'Renamed Player',
  },
});
const unlabeledFirstRetry = await service.recordVerifiedAttempt({
  ...firstAttempt,
  attempt: {
    participantId: firstAttempt.attempt.participantId,
    attemptId: firstAttempt.attempt.attemptId,
    score: firstAttempt.attempt.score,
    ...(firstAttempt.attempt.metrics === undefined
      ? {}
      : { metrics: firstAttempt.attempt.metrics }),
    completedAt: firstAttempt.attempt.completedAt,
    verification: firstAttempt.attempt.verification,
  },
});
const offsetFirstRetry = await service.recordVerifiedAttempt({
  ...firstAttempt,
  attempt: {
    ...firstAttempt.attempt,
    completedAt: '2026-07-13T17:00:00.000+09:00',
    verification: {
      ...firstAttempt.attempt.verification,
      verifiedAt: '2026-07-13T17:00:00.000+09:00',
    },
  },
});

assertEqual(renamedFirstRetry.alreadyProcessed, true, 'renamed retry should be idempotent');
assertEqual(unlabeledFirstRetry.alreadyProcessed, true, 'unlabeled retry should be idempotent');
assertEqual(
  offsetFirstRetry.alreadyProcessed,
  true,
  'equivalent timestamp retry should be idempotent',
);
assertEqual(
  unlabeledFirstRetry.entry.participantLabel,
  'Player One',
  'retry should preserve the original stored label',
);
assertEqual(
  offsetFirstRetry.entry.completedAt,
  firstAttempt.attempt.completedAt,
  'equivalent timestamp retry should preserve the original response timestamp',
);

await service.recordVerifiedAttempt(
  createAttempt({
    participantId: 'player-2',
    participantLabel: 'Player Two',
    attemptId: 'attempt-2',
    score: 8_000,
    completedAt: '2026-07-13T08:00:01.000Z',
  }),
);

const practiceAttempt = createAttempt({
  participantId: 'player-1',
  participantLabel: 'Player One',
  attemptId: 'attempt-3',
  score: 7_000,
  completedAt: '2026-07-13T08:01:00.000Z',
});
const practiceRecord = await service.recordVerifiedAttempt(practiceAttempt);
const practiceRetry = await service.recordVerifiedAttempt(practiceAttempt);

assertEqual(
  practiceRecord.retained,
  false,
  'first-attempt selection should reject a faster later attempt',
);
assertEqual(
  practiceRecord.reason,
  'ATTEMPT_NOT_RETAINED',
  'non-retained attempts should explain the decision',
);
assertEqual(practiceRetry.alreadyProcessed, true, 'attempt retries should be idempotent');
assertEqual(practiceRetry.retained, false, 'retry should preserve the retained attempt decision');

const snapshot = await service.getSnapshot({
  leaderboardId: 'daily:2026-07-13',
  participantId: 'player-1',
  limit: 1,
});

assert(snapshot !== undefined, 'recorded leaderboard should have a snapshot');
assertEqual(snapshot.entries.length, 1, 'snapshot should honor the entry limit');
assertEqual(snapshot.entries[0]?.participantId, 'player-2', 'lower score should rank first');
assertEqual(
  snapshot.participantEntry?.rank,
  2,
  'viewer rank should be available outside top entries',
);
assertEqual(snapshot.totalParticipants, 2, 'snapshot should count retained participants');
assertEqual(snapshot.generatedAt, now, 'snapshot should use the injected server clock');
assertEqual(
  snapshot.participantEntry?.metrics?.mistakes,
  1,
  'participant snapshots should expose retained metrics',
);
assert(snapshot.nextCursor !== undefined, 'limited snapshots should be continuable');
assertVerifiedLeaderboardSnapshot(snapshot);

const fullSnapshot = await service.getSnapshot({
  leaderboardId: 'daily:2026-07-13',
  limit: 2,
});
assert(fullSnapshot !== undefined, 'full snapshots should include the retained board');
assertEqual(fullSnapshot.nextCursor, undefined, 'full snapshots should terminate');
const snapshotPageEntry = snapshot.entries[0];
const firstFullEntry = fullSnapshot.entries[0];
const secondFullEntry = fullSnapshot.entries[1];
const finalFullEntry = fullSnapshot.entries.at(-1);
assert(snapshotPageEntry !== undefined, 'limited snapshots should contain their first entry');
assert(firstFullEntry !== undefined, 'full snapshots should contain their first entry');
assert(secondFullEntry !== undefined, 'full snapshots should contain their second entry');
assert(finalFullEntry !== undefined, 'full snapshots should contain their final entry');

assertThrows(
  () => assertVerifiedLeaderboardSnapshot({ ...snapshot, nextCursor: undefined }),
  'nextCursor must be present when snapshot entries remain',
  'snapshots must not silently truncate remaining entries',
);
assertThrows(
  () => assertVerifiedLeaderboardSnapshot({
    ...snapshot,
    nextCursor: createVerifiedLeaderboardCursor(
      { ...snapshot.definition, leaderboardId: 'daily:other-board' },
      snapshotPageEntry,
    ),
  }),
  'nextCursor must continue after the final snapshot entry',
  'snapshots must bind continuation cursors to their definition and final entry',
);
assertThrows(
  () => assertVerifiedLeaderboardSnapshot({
    ...fullSnapshot,
    entries: [
      { ...secondFullEntry, rank: 1 },
      { ...firstFullEntry, rank: 2 },
    ],
  }),
  'entries must follow the leaderboard ranking order',
  'snapshots must preserve stable leaderboard ordering',
);
assertThrows(
  () => assertVerifiedLeaderboardSnapshot({
    ...fullSnapshot,
    entries: [firstFullEntry, { ...secondFullEntry, rank: 3 }],
    totalParticipants: 3,
  }),
  'entry ranks must be contiguous within a snapshot page',
  'snapshots must not skip ranks inside a page',
);
assertVerifiedLeaderboardSnapshot({
  ...fullSnapshot,
  participantEntry: {
    ...firstFullEntry,
    completedAt: '2026-07-13T17:00:01.000+09:00',
  },
});
assertThrows(
  () => assertVerifiedLeaderboardSnapshot({
    ...fullSnapshot,
    participantEntry: { ...firstFullEntry, score: firstFullEntry.score + 1 },
  }),
  'participantEntry must match overlapping snapshot entries',
  'snapshots must reject conflicting participant entries on the current page',
);
assertThrows(
  () => assertVerifiedLeaderboardSnapshot({
    ...fullSnapshot,
    participantEntry: {
      ...firstFullEntry,
      participantId: 'conflicting-attempt-participant',
    },
  }),
  'participantEntry must match overlapping snapshot entries',
  'snapshots must reject attempt identities assigned to another participant',
);
assertThrows(
  () => assertVerifiedLeaderboardSnapshot({
    ...fullSnapshot,
    participantEntry: {
      ...firstFullEntry,
      participantId: 'conflicting-rank-participant',
      attemptId: 'conflicting-rank-attempt',
    },
  }),
  'participantEntry must match overlapping snapshot entries',
  'snapshots must reject different entries assigned to the same rank',
);
assertThrows(
  () => assertVerifiedLeaderboardSnapshot({
    ...snapshot,
    participantEntry: {
      rank: 2,
      participantId: 'out-of-order-participant',
      attemptId: 'out-of-order-attempt',
      score: snapshotPageEntry.score - 1,
      completedAt: snapshotPageEntry.completedAt,
    },
  }),
  'participantEntry must follow the leaderboard ranking order',
  'snapshots must reject off-page participant entries that contradict visible ordering',
);
assertThrows(
  () => assertVerifiedLeaderboardSnapshot({
    ...fullSnapshot,
    nextCursor: createVerifiedLeaderboardCursor(
      fullSnapshot.definition,
      finalFullEntry,
    ),
  }),
  'nextCursor must be omitted after the final snapshot entry',
  'terminal snapshots must not expose looping cursors',
);

const maximumIdentifier = '\u0000'.repeat(verifiedLeaderboardIdentifierMaximumLength);
const maximumIdentifierService = createInMemoryVerifiedLeaderboardService({ now: () => now });

for (const [index, suffix] of ['a', 'b'].entries()) {
  await maximumIdentifierService.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: maximumIdentifier,
      participantId: `maximum-identifier-player-${String(index + 1)}`,
      attemptId: `${maximumIdentifier.slice(1)}${suffix}`,
      score: index + 1,
      completedAt: `2026-07-13T08:00:0${String(index)}.000Z`,
    }),
  );
}

const maximumIdentifierFirstPage = await maximumIdentifierService.getSnapshot({
  leaderboardId: maximumIdentifier,
  limit: 1,
});
assert(
  maximumIdentifierFirstPage?.nextCursor !== undefined,
  'maximum-length identifiers should still produce a continuation cursor',
);
assert(
  maximumIdentifierFirstPage.nextCursor.length <= 65_536,
  'maximum-length identifiers should keep the continuation cursor within its public cap',
);
const maximumIdentifierPageUrl = new URL(
  'https://verified-leaderboard.test/game-services/verified-leaderboard/snapshot',
);
maximumIdentifierPageUrl.searchParams.set('leaderboardId', maximumIdentifier);
maximumIdentifierPageUrl.searchParams.set('limit', '1');
maximumIdentifierPageUrl.searchParams.set('cursor', maximumIdentifierFirstPage.nextCursor);
assert(
  maximumIdentifierPageUrl.href.length <= 16_384,
  'maximum-length identifiers should keep cursor reads within the Workers URL cap',
);
const maximumIdentifierSecondPage = await maximumIdentifierService.getSnapshot({
  leaderboardId: maximumIdentifier,
  limit: 1,
  cursor: maximumIdentifierFirstPage.nextCursor,
});
assertEqual(
  maximumIdentifierSecondPage?.entries[0]?.rank,
  2,
  'maximum-length identifiers should traverse to the next page',
);

await assertRejects(
  () => maximumIdentifierService.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: `${maximumIdentifier}x`,
      participantId: 'oversized-leaderboard-player',
      attemptId: 'oversized-leaderboard-attempt',
      score: 1,
      completedAt: '2026-07-13T08:00:02.000Z',
    }),
  ),
  'leaderboardId must contain at most',
  'leaderboard IDs beyond the public maximum should fail closed',
);
await assertRejects(
  () => maximumIdentifierService.recordVerifiedAttempt(
    createAttempt({
      participantId: 'oversized-attempt-player',
      attemptId: `${maximumIdentifier}x`,
      score: 1,
      completedAt: '2026-07-13T08:00:03.000Z',
    }),
  ),
  'attemptId must contain at most',
  'attempt IDs beyond the public maximum should fail closed',
);
await assertRejects(
  () => maximumIdentifierService.recordVerifiedAttempt(
    createAttempt({
      leaderboardId: 'invalid-unicode-\uD800',
      participantId: 'invalid-unicode-player',
      attemptId: 'invalid-unicode-attempt',
      score: 1,
      completedAt: '2026-07-13T08:00:04.000Z',
    }),
  ),
  'leaderboardId must contain only well-formed Unicode',
  'URL-lossy leaderboard IDs should fail closed',
);

const missing = await service.getSnapshot({ leaderboardId: 'missing' });
assertEqual(missing, undefined, 'unknown leaderboard should not invent a definition');

const firstChronologyService = createInMemoryVerifiedLeaderboardService({ now: () => now });
const laterFirstRequest = createAttempt({
  leaderboardId: 'daily:chronology',
  participantId: 'player-first',
  attemptId: 'attempt-later',
  score: 5,
  completedAt: '2026-07-13T08:10:00.000Z',
});
const laterFirstRecord = await firstChronologyService.recordVerifiedAttempt(laterFirstRequest);
const earlierFirstRecord = await firstChronologyService.recordVerifiedAttempt(
  createAttempt({
    leaderboardId: 'daily:chronology',
    participantId: 'player-first',
    attemptId: 'attempt-earlier',
    score: 10,
    completedAt: '2026-07-13T08:09:00.000Z',
  }),
);
const firstChronologySnapshot = await firstChronologyService.getSnapshot({
  leaderboardId: 'daily:chronology',
});
const laterFirstRetry = await firstChronologyService.recordVerifiedAttempt(laterFirstRequest);

assertEqual(laterFirstRecord.retained, true, 'first received attempt should initially be retained');
assertEqual(earlierFirstRecord.retained, true, 'earlier completed attempt should replace it');
assertEqual(
  firstChronologySnapshot?.entries[0]?.attemptId,
  'attempt-earlier',
  'first selection should use verified completion chronology',
);
assertEqual(laterFirstRetry.alreadyProcessed, true, 'superseded retry should be recognized');
assertEqual(
  laterFirstRetry.retained,
  true,
  'superseded retry should preserve its original retained decision',
);
assertEqual(
  laterFirstRetry.entry.attemptId,
  'attempt-later',
  'superseded retry should preserve its original response entry',
);

const ordinalTieService = createInMemoryVerifiedLeaderboardService({ now: () => now });
await ordinalTieService.recordVerifiedAttempt(
  createAttempt({
    leaderboardId: 'daily:ordinal-tie',
    participantId: 'player-ordinal',
    attemptId: 'ä',
    score: 10,
    completedAt: '2026-07-13T08:10:00.000Z',
  }),
);
await ordinalTieService.recordVerifiedAttempt(
  createAttempt({
    leaderboardId: 'daily:ordinal-tie',
    participantId: 'player-ordinal',
    attemptId: 'z',
    score: 10,
    completedAt: '2026-07-13T08:10:00.000Z',
  }),
);
const ordinalTieSnapshot = await ordinalTieService.getSnapshot({
  leaderboardId: 'daily:ordinal-tie',
});

assertEqual(
  ordinalTieSnapshot?.entries[0]?.attemptId,
  'z',
  'attempt id ties should use locale-independent ordinal ordering',
);

const bestService = createInMemoryVerifiedLeaderboardService({ now: () => now });
const initialBestRequest = createAttempt({
  leaderboardId: 'season:1',
  scoreOrder: 'descending',
  attemptSelection: 'best',
  participantId: 'player-3',
  attemptId: 'attempt-4',
  score: 10,
  completedAt: '2026-07-13T08:02:00.000Z',
});
await bestService.recordVerifiedAttempt(initialBestRequest);
const worseBestAttempt = await bestService.recordVerifiedAttempt(
  createAttempt({
    leaderboardId: 'season:1',
    scoreOrder: 'descending',
    attemptSelection: 'best',
    participantId: 'player-3',
    attemptId: 'attempt-5',
    score: 9,
    completedAt: '2026-07-13T08:03:00.000Z',
  }),
);
const improvedBestAttempt = await bestService.recordVerifiedAttempt(
  createAttempt({
    leaderboardId: 'season:1',
    scoreOrder: 'descending',
    attemptSelection: 'best',
    participantId: 'player-3',
    attemptId: 'attempt-6',
    score: 11,
    completedAt: '2026-07-13T08:04:00.000Z',
  }),
);
const initialBestRetry = await bestService.recordVerifiedAttempt(initialBestRequest);

assertEqual(worseBestAttempt.retained, false, 'best selection should ignore a worse score');
assertEqual(improvedBestAttempt.retained, true, 'best selection should retain an improved score');
assertEqual(
  improvedBestAttempt.entry.attemptId,
  'attempt-6',
  'improved attempt should replace entry',
);
assertEqual(initialBestRetry.alreadyProcessed, true, 'superseded best retry should be recognized');
assertEqual(
  initialBestRetry.retained,
  true,
  'superseded best retry should preserve its original retained decision',
);
assertEqual(
  initialBestRetry.entry.attemptId,
  'attempt-4',
  'superseded best retry should preserve its original response entry',
);

await assertRejects(
  () => service.recordVerifiedAttempt({
    ...firstAttempt,
    attempt: {
      ...firstAttempt.attempt,
      verification: {
        ...firstAttempt.attempt.verification,
        evidenceId: 'different-evidence',
      },
    },
  }),
  'Attempt id conflict',
  'attempt id reuse with different evidence should fail closed',
);

await assertRejects(
  () => service.recordVerifiedAttempt({
    ...firstAttempt,
    attempt: {
      ...firstAttempt.attempt,
      score: 1,
    },
  }),
  'Attempt id conflict',
  'attempt id reuse with a different score should fail closed',
);

await assertRejects(
  () => service.recordVerifiedAttempt({
    ...firstAttempt,
    attempt: {
      ...firstAttempt.attempt,
      metrics: { elapsedMs: 9_000, hints: 1, mistakes: 1 },
    },
  }),
  'Attempt id conflict',
  'attempt id reuse with different metrics should fail closed',
);

const mutationService = createInMemoryVerifiedLeaderboardService({ now: () => now });
const mutableRequest = {
  definition: {
    leaderboardId: 'daily:mutation',
    scoreOrder: 'ascending',
    attemptSelection: 'first',
  },
  attempt: {
    participantId: 'player-mutable',
    participantLabel: 'Mutable Player',
    attemptId: 'attempt-mutable',
    score: 42,
    metrics: { elapsedMs: 42, hints: 1 },
    completedAt: '2026-07-13T08:06:00.000Z',
    verification: {
      authorityId: 'test-attempt-coordinator',
      evidenceId: 'evidence:attempt-mutable',
      verifiedAt: '2026-07-13T08:06:00.000Z',
    },
  },
} satisfies RecordVerifiedLeaderboardAttemptRequest;

await mutationService.recordVerifiedAttempt(mutableRequest);
mutableRequest.attempt.score = 1;
mutableRequest.attempt.metrics.elapsedMs = 1;
mutableRequest.attempt.verification.evidenceId = 'mutated-evidence';
const mutationSnapshot = await mutationService.getSnapshot({ leaderboardId: 'daily:mutation' });

assertEqual(
  mutationSnapshot?.entries[0]?.score,
  42,
  'stored attempt should resist caller mutation',
);
assertEqual(
  mutationSnapshot?.entries[0]?.metrics?.elapsedMs,
  42,
  'stored metrics should resist caller mutation',
);
await assertRejects(
  () => mutationService.recordVerifiedAttempt(mutableRequest),
  'Attempt id conflict',
  'mutated caller input should conflict with the stored attempt snapshot',
);

await assertRejects(
  () => service.recordVerifiedAttempt(
    createAttempt({
      participantId: 'player-timezone',
      attemptId: 'attempt-timezone',
      score: 1,
      completedAt: '2026-07-13T08:07:00.000',
    }),
  ),
  'timezone-qualified timestamp',
  'offset-less completion timestamps should fail closed',
);

await assertRejects(
  () => service.recordVerifiedAttempt(
    createAttempt({
      participantId: 'player-invalid-calendar',
      attemptId: 'attempt-invalid-calendar',
      score: 1,
      completedAt: '2026-02-31T08:07:00.000Z',
    }),
  ),
  'timezone-qualified timestamp',
  'normalized invalid calendar timestamps should fail closed',
);

await assertRejects(
  () => service.recordVerifiedAttempt(
    createAttempt({
      participantId: 'player-sub-millisecond',
      attemptId: 'attempt-sub-millisecond',
      score: 1,
      completedAt: '2026-07-13T08:07:00.0001Z',
    }),
  ),
  'timezone-qualified timestamp',
  'unsupported sub-millisecond timestamps should fail closed',
);

await assertRejects(
  () => service.recordVerifiedAttempt(
    createAttempt({
      participantId: 'player-invalid-metric-key',
      attemptId: 'attempt-invalid-metric-key',
      score: 1,
      metrics: { '1elapsedMs': 1 },
      completedAt: '2026-07-13T08:07:00.000Z',
    }),
  ),
  'metric keys must start with an ASCII letter',
  'invalid metric keys should fail closed',
);

await assertRejects(
  () => service.recordVerifiedAttempt(
    createAttempt({
      participantId: 'player-invalid-metric-value',
      attemptId: 'attempt-invalid-metric-value',
      score: 1,
      metrics: { elapsedMs: -1 },
      completedAt: '2026-07-13T08:07:00.000Z',
    }),
  ),
  'metric values must be non-negative safe integers',
  'invalid metric values should fail closed',
);

await assertRejects(
  () => service.recordVerifiedAttempt(
    createAttempt({
      participantId: 'player-too-many-metrics',
      attemptId: 'attempt-too-many-metrics',
      score: 1,
      metrics: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`metric${String(index)}`, index]),
      ),
      completedAt: '2026-07-13T08:07:00.000Z',
    }),
  ),
  'metrics must contain at most 16 keys',
  'too many metrics should fail closed',
);

const invalidEvidenceTimestampRequest = createAttempt({
  participantId: 'player-evidence-timezone',
  attemptId: 'attempt-evidence-timezone',
  score: 1,
  completedAt: '2026-07-13T08:07:00.000Z',
});
await assertRejects(
  () => service.recordVerifiedAttempt({
    ...invalidEvidenceTimestampRequest,
    attempt: {
      ...invalidEvidenceTimestampRequest.attempt,
      verification: {
        authorityId: 'test-attempt-coordinator',
        evidenceId: 'evidence:attempt-evidence-timezone',
        verifiedAt: '2026-07-13T08:07:00.000',
      },
    },
  }),
  'timezone-qualified timestamp',
  'offset-less verification timestamps should fail closed',
);

const unknownRequest: unknown = createAttempt({
  participantId: 'player-unknown',
  attemptId: 'attempt-unknown',
  score: 1,
  completedAt: '2026-07-13T17:08:00.000+09:00',
});
assertRecordVerifiedLeaderboardAttemptRequest(unknownRequest);
const unknownRecord = await service.recordVerifiedAttempt(unknownRequest);
assertEqual(unknownRecord.recorded, true, 'runtime assertion should narrow unknown requests');

await assertRejects(
  () => service.recordVerifiedAttempt(
    createAttempt({
      scoreOrder: 'descending',
      participantId: 'player-4',
      attemptId: 'attempt-7',
      score: 1,
      completedAt: '2026-07-13T08:05:00.000Z',
    }),
  ),
  'Leaderboard definition conflict',
  'leaderboard ranking policy should be immutable',
);

console.log('Verified leaderboard service tests passed.');

function createAttempt(
  input: {
    readonly leaderboardId?: string;
    readonly scoreOrder?: 'ascending' | 'descending';
    readonly attemptSelection?: 'first' | 'best';
    readonly participantId: string;
    readonly participantLabel?: string;
    readonly attemptId: string;
    readonly score: number;
    readonly metrics?: Readonly<Record<string, number>>;
    readonly completedAt: string;
  },
): RecordVerifiedLeaderboardAttemptRequest {
  return {
    definition: {
      leaderboardId: input.leaderboardId ?? 'daily:2026-07-13',
      scoreOrder: input.scoreOrder ?? 'ascending',
      attemptSelection: input.attemptSelection ?? 'first',
    },
    attempt: {
      participantId: input.participantId,
      ...(input.participantLabel === undefined
        ? {}
        : { participantLabel: input.participantLabel }),
      attemptId: input.attemptId,
      score: input.score,
      ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
      completedAt: input.completedAt,
      verification: {
        authorityId: 'test-attempt-coordinator',
        evidenceId: `evidence:${input.attemptId}`,
        verifiedAt: input.completedAt,
      },
    },
  };
}

async function assertRejects(
  operation: () => Promise<unknown>,
  messageFragment: string,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(messageFragment)) {
      return;
    }

    throw new Error(`${message}: received an unexpected error.`);
  }

  throw new Error(`${message}: expected the operation to reject.`);
}

function assertThrows(
  operation: () => void,
  messageFragment: string,
  message: string,
): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(messageFragment)) {
      return;
    }

    throw new Error(`${message}: received an unexpected error.`);
  }

  throw new Error(`${message}: expected the operation to throw.`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
