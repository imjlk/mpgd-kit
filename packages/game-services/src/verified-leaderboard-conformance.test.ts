import {
  createInMemoryVerifiedLeaderboardService,
  type VerifiedLeaderboardService,
} from './verified-leaderboard';
import {
  runVerifiedLeaderboardConformance,
  verifiedLeaderboardConformanceScenarios,
} from './verified-leaderboard-conformance';

let disposeCount = 0;
const report = await runVerifiedLeaderboardConformance({
  createFixture: ({ now }) => ({
    service: createInMemoryVerifiedLeaderboardService({ now: () => now }),
    dispose: () => {
      disposeCount += 1;
    },
  }),
});

if (report.passedScenarios.length !== verifiedLeaderboardConformanceScenarios.length) {
  throw new Error('Expected every verified leaderboard conformance scenario to pass.');
}

if (disposeCount !== verifiedLeaderboardConformanceScenarios.length) {
  throw new Error('Expected every verified leaderboard conformance fixture to be disposed.');
}

const failureService = createInMemoryVerifiedLeaderboardService();
let combinedFailure: unknown;

try {
  await runVerifiedLeaderboardConformance({
    createFixture: () => ({
      service: {
        recordVerifiedAttempt: (input) => failureService.recordVerifiedAttempt(input),
        getSnapshot: async () => {
          throw new Error('scenario failure');
        },
      } satisfies VerifiedLeaderboardService,
      dispose: () => {
        throw new Error('cleanup failure');
      },
    }),
  });
} catch (error) {
  combinedFailure = error;
}

if (
  !(combinedFailure instanceof Error)
  || !combinedFailure.message.includes('first-selection-and-snapshot')
  || !(combinedFailure.cause instanceof AggregateError)
) {
  throw new Error('Expected cleanup failures to preserve the named scenario failure.');
}

let acceptedInvalidInputFailure: unknown;

try {
  await runVerifiedLeaderboardConformance({
    createFixture: ({ scenario, now }) => {
      const service = createInMemoryVerifiedLeaderboardService({ now: () => now });

      if (scenario !== 'runtime-validation') {
        return { service };
      }

      const fallback = createInMemoryVerifiedLeaderboardService({ now: () => now });
      return {
        service: {
          async recordVerifiedAttempt(input) {
            try {
              return await service.recordVerifiedAttempt(input);
            } catch {
              return fallback.recordVerifiedAttempt({
                definition: {
                  leaderboardId: 'accepted-invalid:fallback',
                  scoreOrder: 'ascending',
                  attemptSelection: 'first',
                },
                attempt: {
                  participantId: 'participant:fallback',
                  attemptId: 'attempt:fallback',
                  score: 1,
                  completedAt: now,
                  verification: {
                    authorityId: 'accepted-invalid-provider',
                    evidenceId: 'evidence:fallback',
                    verifiedAt: now,
                  },
                },
              });
            }
          },
          getSnapshot: (input) => service.getSnapshot(input),
        } satisfies VerifiedLeaderboardService,
      };
    },
  });
} catch (error) {
  acceptedInvalidInputFailure = error;
}

if (
  !(acceptedInvalidInputFailure instanceof Error)
  || !acceptedInvalidInputFailure.message.includes('runtime-validation')
) {
  throw new Error('Expected providers that resolve invalid writes to fail conformance.');
}

console.log('Verified leaderboard provider conformance tests passed.');
