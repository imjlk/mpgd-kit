import { createInMemoryLeaderboardLedger } from './index';

const ledger = createInMemoryLeaderboardLedger();
const first = ledger.recordScore({
  target: 'android',
  playerId: 'player-1',
  leaderboardId: 'default',
  score: 1000,
  runId: 'run-1',
  submittedAt: '2026-07-03T00:00:00.000Z',
});
const second = ledger.recordScore({
  target: 'android',
  playerId: 'player-2',
  leaderboardId: 'default',
  score: 2000,
  runId: 'run-2',
  submittedAt: '2026-07-03T00:00:01.000Z',
});
const duplicate = ledger.recordScore({
  target: 'android',
  playerId: 'player-1',
  leaderboardId: 'default',
  score: 1000,
  runId: 'run-1',
  submittedAt: '2026-07-03T00:00:00.000Z',
});

assertEqual(first.alreadyProcessed, false, 'first score should be new');
assertEqual(second.rank, 1, 'higher score should rank first');
assertEqual(duplicate.alreadyProcessed, true, 'duplicate run should be idempotent');
assertEqual(duplicate.ledgerEntryId, first.ledgerEntryId, 'duplicate should reuse entry id');
assertEqual(ledger.listTransactions().length, 2, 'ledger should store two unique scores');

console.log('InMemoryLeaderboardLedger idempotency smoke test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
