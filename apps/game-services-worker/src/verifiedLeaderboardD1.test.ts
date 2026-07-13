import { readFile } from 'node:fs/promises';

import { runVerifiedLeaderboardConformance } from '@mpgd/game-services/verified-leaderboard-conformance';
import { Miniflare } from 'miniflare';

import { createWorkerService } from './handler.js';
import { createD1VerifiedLeaderboardService } from './verifiedLeaderboardD1.js';

const miniflare = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response('ok'); } };`,
  d1Databases: {
    DB: 'verified-leaderboard-conformance',
  },
});

try {
  const db = await miniflare.getD1Database('DB') as unknown as D1Database;
  const migration = await readFile(
    new URL('../migrations/0002_verified_leaderboards.sql', import.meta.url),
    'utf8',
  );
  await db.exec(toD1ExecScript(migration));

  const report = await runVerifiedLeaderboardConformance({
    createFixture: ({ now }) => ({
      service: createD1VerifiedLeaderboardService(db, { now: () => now }),
    }),
  });
  assertEqual(report.passedScenarios.length, 7, 'D1 should pass every conformance scenario');

  const privateService = createWorkerService({
    DB: db,
    MPGD_STORE: 'd1',
  });
  const privateRecord = await privateService.recordVerifiedAttempt({
    definition: {
      leaderboardId: 'private-binding:board',
      scoreOrder: 'descending',
      attemptSelection: 'best',
    },
    attempt: {
      participantId: 'participant:private-binding',
      attemptId: 'attempt:private-binding',
      score: 123,
      completedAt: '2030-01-02T03:00:00.000Z',
      verification: {
        authorityId: 'private-worker',
        evidenceId: 'evidence:private-binding',
        verifiedAt: '2030-01-02T03:00:01.000Z',
      },
    },
  });
  const privateSnapshot = await privateService.getSnapshot({
    leaderboardId: 'private-binding:board',
    participantId: 'participant:private-binding',
  });
  assertEqual(privateRecord.retained, true, 'private binding writes should retain attempts');
  assertEqual(
    privateSnapshot?.participantEntry?.attemptId,
    'attempt:private-binding',
    'private binding reads should use the durable D1 provider',
  );
} finally {
  await miniflare.dispose();
}

console.log('D1 verified leaderboard conformance and private binding smoke passed');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function toD1ExecScript(migration: string): string {
  return migration
    .split(/\n\s*\n/u)
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter((statement) => statement.length > 0)
    .join('\n');
}
