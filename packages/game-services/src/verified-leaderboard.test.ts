import {
  assertRecordVerifiedLeaderboardAttemptRequest,
  createInMemoryVerifiedLeaderboardService,
  type RecordVerifiedLeaderboardAttemptRequest,
} from './verified-leaderboard';

const now = '2026-07-13T09:00:00.000Z';
const service = createInMemoryVerifiedLeaderboardService({ now: () => now });

const firstAttempt = createAttempt({
  participantId: 'player-1',
  participantLabel: 'Player One',
  attemptId: 'attempt-1',
  score: 9_000,
  completedAt: '2026-07-13T08:00:00.000Z',
});
const firstRecord = await service.recordVerifiedAttempt(firstAttempt);

assertEqual(firstRecord.recorded, true, 'verified attempt should be recorded');
assertEqual(firstRecord.alreadyProcessed, false, 'new attempt should not be a retry');
assertEqual(firstRecord.retained, true, 'first attempt should be retained');
assertEqual(firstRecord.entry.rank, 1, 'first attempt should initially rank first');

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
    completedAt: firstAttempt.attempt.completedAt,
    verification: firstAttempt.attempt.verification,
  },
});

assertEqual(renamedFirstRetry.alreadyProcessed, true, 'renamed retry should be idempotent');
assertEqual(unlabeledFirstRetry.alreadyProcessed, true, 'unlabeled retry should be idempotent');
assertEqual(
  unlabeledFirstRetry.entry.participantLabel,
  'Player One',
  'retry should preserve the original stored label',
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
mutableRequest.attempt.verification.evidenceId = 'mutated-evidence';
const mutationSnapshot = await mutationService.getSnapshot({ leaderboardId: 'daily:mutation' });

assertEqual(
  mutationSnapshot?.entries[0]?.score,
  42,
  'stored attempt should resist caller mutation',
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
