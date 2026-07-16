import { createInMemoryVerifiedLeaderboardService } from './verified-leaderboard';
import {
  createAmbiguousCommitVerifiedLeaderboardDurabilityFixture,
  runVerifiedLeaderboardDurabilityConformance,
  verifiedLeaderboardDurabilityConformanceScenarios,
} from './verified-leaderboard-durability-conformance';

let disposeCount = 0;
const report = await runVerifiedLeaderboardDurabilityConformance({
  createFixture: ({ now }) => createAmbiguousCommitVerifiedLeaderboardDurabilityFixture(
    createInMemoryVerifiedLeaderboardService({ now: () => now }),
    () => {
      disposeCount += 1;
    },
  ),
});

if (report.passedScenarios.length !== verifiedLeaderboardDurabilityConformanceScenarios.length) {
  throw new Error('Expected every verified leaderboard durability scenario to pass.');
}

if (disposeCount !== verifiedLeaderboardDurabilityConformanceScenarios.length) {
  throw new Error('Expected every verified leaderboard durability fixture to be disposed.');
}

const unarmedFixture = createAmbiguousCommitVerifiedLeaderboardDurabilityFixture(
  createInMemoryVerifiedLeaderboardService(),
);
let unarmedFailure: unknown;

try {
  await runVerifiedLeaderboardDurabilityConformance({
    createFixture: () => ({
      service: unarmedFixture.service,
      interruptNextRetainedRecord() {},
    }),
  });
} catch (error) {
  unarmedFailure = error;
}

if (
  !(unarmedFailure instanceof Error)
  || !unarmedFailure.message.includes('replacement-after-interrupted-retained-write')
) {
  throw new Error('Expected a fixture that does not interrupt writes to fail by scenario name.');
}

console.log('Verified leaderboard durability conformance tests passed.');
