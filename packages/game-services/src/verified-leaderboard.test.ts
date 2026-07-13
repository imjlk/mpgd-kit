import {
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

const bestService = createInMemoryVerifiedLeaderboardService({ now: () => now });
await bestService.recordVerifiedAttempt(
  createAttempt({
    leaderboardId: 'season:1',
    scoreOrder: 'descending',
    attemptSelection: 'best',
    participantId: 'player-3',
    attemptId: 'attempt-4',
    score: 10,
    completedAt: '2026-07-13T08:02:00.000Z',
  }),
);
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

assertEqual(worseBestAttempt.retained, false, 'best selection should ignore a worse score');
assertEqual(improvedBestAttempt.retained, true, 'best selection should retain an improved score');
assertEqual(
  improvedBestAttempt.entry.attemptId,
  'attempt-6',
  'improved attempt should replace entry',
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
  'attempt id reuse with different evidence should fail closed',
);

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
