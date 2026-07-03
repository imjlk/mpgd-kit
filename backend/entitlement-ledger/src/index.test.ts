import { createInMemoryEntitlementLedger } from './index';

const ledger = createInMemoryEntitlementLedger();
const input = {
  playerId: 'player-1',
  grantId: 'COINS_100',
  source: 'purchase' as const,
  idempotencyKey: 'purchase-1',
  grantedAt: '2026-07-03T00:00:00.000Z',
  grant: {
    type: 'currency' as const,
    currency: 'coin' as const,
    amount: 100,
  },
  payload: {
    productId: 'COINS_100',
  },
};

const first = ledger.recordGrant(input);
const second = ledger.recordGrant(input);

assertEqual(first.alreadyProcessed, false, 'first grant should be new');
assertEqual(second.alreadyProcessed, true, 'second grant should be deduplicated');
assertEqual(second.ledgerEntryId, first.ledgerEntryId, 'deduplicated grant should reuse entry id');
assertEqual(ledger.listTransactions().length, 1, 'ledger should store one transaction');

console.log('InMemoryEntitlementLedger idempotency smoke test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
