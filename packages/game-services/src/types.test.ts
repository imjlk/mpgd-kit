import {
  assertProductGrantTransaction,
  assertPurchaseGrantFinalization,
  type ProductGrantTransaction,
} from './types';

const resourceTransaction = Object.freeze({
  ledgerEntryId: 'ledger-resource-hints-1',
  playerId: 'player-resource-hints-1',
  grantId: 'HINT_PACK_5',
  source: 'purchase',
  idempotencyKey: 'reddit:order-hints-1',
  grantedAt: '2026-07-16T00:00:00.000Z',
  grant: Object.freeze({
    type: 'resource',
    resource: 'hint',
    amount: 5,
  }),
  payload: Object.freeze({ target: 'reddit', orderId: 'order-hints-1' }),
}) satisfies ProductGrantTransaction;

assertEqual(
  assertProductGrantTransaction(resourceTransaction),
  resourceTransaction,
  'transaction validation should preserve a resource grant without normalization',
);
assertProductGrantTransaction({
  ...resourceTransaction,
  grant: { type: 'currency', currency: 'coin', amount: 100 },
});
assertProductGrantTransaction({
  ...resourceTransaction,
  grant: { type: 'entitlement', entitlement: 'theme.ember' },
});
assertThrows(
  () => assertProductGrantTransaction({
    ...resourceTransaction,
    grant: { type: 'resource', resource: '', amount: 5 },
  }),
  'resource grants should require a non-empty resource name',
);
assertThrows(
  () => assertProductGrantTransaction({
    ...resourceTransaction,
    grant: { type: 'resource', resource: 'hint', amount: 0 },
  }),
  'resource grants should require a positive amount',
);
assertThrows(
  () => assertProductGrantTransaction({
    ...resourceTransaction,
    grant: { type: 'resource', resource: 'hint', amount: Number.POSITIVE_INFINITY },
  }),
  'resource grants should require a finite amount',
);
assertThrows(
  () => assertPurchaseGrantFinalization({
    status: 'completed',
    alreadyCompleted: false,
  }),
  'completed purchase finalization should require the provider action',
);

console.log('GameServices product grant transaction validation test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(message);
  }
}

function assertThrows(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(message);
}
