import { createInMemoryVerifiedLeaderboardService } from './verified-leaderboard';
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

console.log('Verified leaderboard provider conformance tests passed.');
