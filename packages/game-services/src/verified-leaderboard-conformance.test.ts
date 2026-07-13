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

console.log('Verified leaderboard provider conformance tests passed.');
