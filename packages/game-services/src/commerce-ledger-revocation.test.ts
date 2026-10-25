import assert from 'node:assert/strict';

import type { ProductCatalog } from '@mpgd/catalog';

import {
  chunkLedgerEntryIds,
  listActiveEntitlementTransactions,
  readPurchaseLedgerStatuses,
  revokeEntitlementGrant,
} from './commerce-ledger.js';
import {
  createPlatformOrderLedgerGrant,
  createPlatformOrderVerifyRequest,
  revokePlatformOrder,
  type FulfillPlatformOrderInput,
  type RefundPlatformOrderInput,
} from './platform-order.js';
import { createInMemoryGameServicesStore, type GameServicesStore } from './server.js';
import {
  assertEntitlementLedgerPeriod,
  assertEntitlementLedgerRevocation,
  assertPurchaseLedgerStatusResponse,
  type EntitlementLedgerRevocation,
} from './types.js';

const product = {
  id: 'HINT_PACK_5',
  type: 'consumable',
  grant: { type: 'resource', resource: 'hint', amount: 5 },
  platformProductIds: { reddit: 'hints-5' },
} as const satisfies ProductCatalog['products'][number];

const paidOrder: FulfillPlatformOrderInput = {
  target: 'reddit',
  orderId: 'order-hints-1',
  playerId: 'player-1',
  platformSku: 'hints-5',
  paidAt: '2026-10-12T00:00:00.000Z',
  evidence: {
    schema: 'devvit.payment-order.v1',
    payload: { orderId: 'order-hints-1', status: 'PAID' },
  },
};
const refundedOrder: RefundPlatformOrderInput = {
  target: 'reddit',
  orderId: 'order-hints-1',
  playerId: 'player-1',
  platformSku: 'hints-5',
  refundedAt: '2026-10-13T00:00:00.000Z',
  evidence: {
    schema: 'devvit.payment-order.v1',
    payload: { orderId: 'order-hints-1', status: 'REVERTED' },
  },
};

const store = createInMemoryGameServicesStore();

// The fulfillment grant keeps the platform order key and the lookup shape.
const grant = createPlatformOrderLedgerGrant({
  order: paidOrder,
  product,
  grantedAt: '2026-10-12T00:00:01.000Z',
});
assert.equal(grant.idempotencyKey, 'reddit:order-hints-1');
assert.equal(grant.evidenceVerificationId, 'devvit:payment-order:order-hints-1');
assert.equal(grant.payload.target, 'reddit');
assert.equal(grant.payload.store, 'devvit');
assert.equal(grant.payload.platformTransactionId, 'order-hints-1');
assert.equal(grant.payload.evidenceSchema, 'devvit.payment-order.v1');
const verifyRequest = createPlatformOrderVerifyRequest({ order: paidOrder, productId: product.id });
assert.equal(verifyRequest.idempotencyKey, grant.idempotencyKey);
assert.equal(verifyRequest.store, 'devvit');
assert.equal(verifyRequest.platformTransactionId, 'order-hints-1');

// A refund before any fulfillment reverses nothing.
assert.deepEqual(await revokePlatformOrder({ store, order: refundedOrder }), {
  status: 'grant_not_found',
});

const recorded = await store.recordEntitlementGrant(grant);
const second = await store.recordEntitlementGrant({
  ...grant,
  playerId: 'player-2',
  idempotencyKey: 'reddit:order-hints-2',
  evidenceVerificationId: 'devvit:payment-order:order-hints-2',
  payload: { ...grant.payload, platformTransactionId: 'order-hints-2' },
});
assert.deepEqual(
  await readPurchaseLedgerStatuses(store, {
    ledgerEntryIds: [recorded.ledgerEntryId, second.ledgerEntryId],
    playerId: 'player-1',
  }),
  {
    statuses: [
      { ledgerEntryId: recorded.ledgerEntryId, status: 'active' },
      { ledgerEntryId: second.ledgerEntryId, status: 'unknown' },
    ],
  },
  "the read is scoped to the player: another player's grant is unknown",
);
assert.deepEqual(
  await readPurchaseLedgerStatuses(store, {
    ledgerEntryIds: [second.ledgerEntryId],
    playerId: 'player-2',
  }),
  { statuses: [{ ledgerEntryId: second.ledgerEntryId, status: 'active' }] },
);

// A refund of another player's order is a mismatch, never a revocation.
assert.deepEqual(
  await revokePlatformOrder({ store, order: { ...refundedOrder, playerId: 'player-9' } }),
  { status: 'grant_mismatch' },
);

// The refund writes one revoke entry; replays and a second revocation of the
// same grant answer the first entry.
const revoked = await revokePlatformOrder({ store, order: refundedOrder });
assert.equal(revoked.status, 'revoked');
const revokeEntryId = revoked.status === 'revoked' ? revoked.ledgerEntryId : '';
assert.equal(revoked.status === 'revoked' && revoked.alreadyProcessed, false);
assert.deepEqual(await revokePlatformOrder({ store, order: refundedOrder }), {
  status: 'revoked',
  ledgerEntryId: revokeEntryId,
  alreadyProcessed: true,
});
const chargeback: EntitlementLedgerRevocation = {
  playerId: 'player-1',
  revokesLedgerEntryId: recorded.ledgerEntryId,
  idempotencyKey: 'chargeback-77',
  reason: 'chargeback',
  revokedAt: '2026-10-14T00:00:00.000Z',
  payload: { source: 'bank' },
};
assert.deepEqual(await revokeEntitlementGrant(store, chargeback), {
  status: 'revoked',
  ledgerEntryId: revokeEntryId,
  alreadyProcessed: true,
});
// A key that reversed one grant cannot reverse another; a reused authority
// identity is a replay; an unknown grant is refused by the store itself.
const third = await store.recordEntitlementGrant({
  ...grant,
  idempotencyKey: 'reddit:order-hints-3',
  evidenceVerificationId: 'devvit:payment-order:order-hints-3',
  payload: { ...grant.payload, platformTransactionId: 'order-hints-3' },
});
assert.deepEqual(
  await revokeEntitlementGrant(store, {
    ...chargeback,
    revokesLedgerEntryId: third.ledgerEntryId,
    idempotencyKey: 'reddit:order-hints-1:refund',
  }),
  { status: 'key_conflict' },
);
assert.deepEqual(
  await revokeEntitlementGrant(store, {
    ...chargeback,
    revokesLedgerEntryId: third.ledgerEntryId,
    idempotencyKey: 'reddit:order-hints-3:refund',
    evidenceVerificationId: 'devvit:payment-order:order-hints-1:refund',
  }),
  { status: 'evidence_already_processed' },
);
await assert.rejects(
  store.recordEntitlementRevocation({ ...chargeback, revokesLedgerEntryId: 'missing' }),
  /unknown grant/u,
);
const revocations = await store.findEntitlementRevocations({
  ledgerEntryIds: [recorded.ledgerEntryId, second.ledgerEntryId],
});
assert.equal(revocations.length, 1);
assert.equal(revocations[0]?.reason, 'refund');
assert.equal(revocations[0]?.idempotencyKey, 'reddit:order-hints-1:refund');
assert.equal(revocations[0]?.evidenceVerificationId, 'devvit:payment-order:order-hints-1:refund');

// The ledger stays append-only: the grant is still listed, status reads
// report the reversal, and entitlement reads subtract it.
assert.equal((await store.listEntitlementTransactions()).length, 3);
assert.deepEqual(
  await readPurchaseLedgerStatuses(store, {
    ledgerEntryIds: [recorded.ledgerEntryId, second.ledgerEntryId, 'missing'],
    playerId: 'player-1',
  }),
  {
    statuses: [
      { ledgerEntryId: recorded.ledgerEntryId, status: 'reversed', reversedBy: revokeEntryId },
      { ledgerEntryId: second.ledgerEntryId, status: 'unknown' },
      { ledgerEntryId: 'missing', status: 'unknown' },
    ],
  },
);
// Reads are chunked to the store's parameter cap and keep request order.
const manyIds = Array.from({ length: 205 }, (_, index) =>
  (index % 2 === 0 ? recorded.ledgerEntryId : `missing-${String(index)}`));
const batchedReads: number[] = [];
const countingStore: GameServicesStore = {
  ...legacyStoreOf(store),
  async getEntitlementTransactions(ids) {
    batchedReads.push(ids.length);
    return store.getEntitlementTransactions(ids);
  },
  findEntitlementRevocations: (input) => store.findEntitlementRevocations(input),
};
const many = await readPurchaseLedgerStatuses(countingStore, {
  ledgerEntryIds: manyIds,
  playerId: 'player-1',
});
assert.equal(many.statuses.length, 205);
assert.deepEqual(batchedReads, [100, 3], 'unique ids are read in chunks of at most 100');
assert.throws(() => chunkLedgerEntryIds(['a'], 0), /positive integer/u);
assert.equal(many.statuses[0]?.status, 'reversed');
assert.equal(many.statuses[1]?.status, 'unknown');
assert.deepEqual(
  (await listActiveEntitlementTransactions(store)).map((entry) => entry.ledgerEntryId),
  [second.ledgerEntryId, third.ledgerEntryId],
);
assert.deepEqual(
  (await listActiveEntitlementTransactions(store, { playerId: 'player-1' })).map(
    (entry) => entry.ledgerEntryId,
  ),
  [third.ledgerEntryId],
);

// Revoking an unknown grant, or through a store without revocations, fails closed.
assert.deepEqual(
  await revokeEntitlementGrant(store, { ...chargeback, revokesLedgerEntryId: 'missing' }),
  { status: 'grant_not_found' },
);
function legacyStoreOf(base: typeof store): GameServicesStore {
  return {
    recordEntitlementGrant: (input) => base.recordEntitlementGrant(input),
    getEntitlementTransaction: (ledgerEntryId) => base.getEntitlementTransaction(ledgerEntryId),
    listEntitlementTransactions: () => base.listEntitlementTransactions(),
    recordLeaderboardScore: (input, options) => base.recordLeaderboardScore(input, options),
    getLeaderboardTransaction: (ledgerEntryId) => base.getLeaderboardTransaction(ledgerEntryId),
    listLeaderboardTransactions: () => base.listLeaderboardTransactions(),
  };
}
const legacyStore = legacyStoreOf(store);
await assert.rejects(
  revokeEntitlementGrant(legacyStore, chargeback),
  /does not record entitlement revocations/u,
);
assert.deepEqual(
  await readPurchaseLedgerStatuses(legacyStore, {
    ledgerEntryIds: [recorded.ledgerEntryId],
    playerId: 'player-1',
  }),
  { statuses: [{ ledgerEntryId: recorded.ledgerEntryId, status: 'active' }] },
  'a store without revocations answers active for the grants it holds',
);
assert.equal((await listActiveEntitlementTransactions(legacyStore)).length, 3);

// Validators.
assert.throws(
  () => assertEntitlementLedgerRevocation({ ...chargeback, reason: 'oops' as 'refund' }),
  /reason must be refund, chargeback, voided, admin, or transfer/u,
);
assert.throws(
  () =>
    assertPurchaseLedgerStatusResponse({
      statuses: [{ ledgerEntryId: 'x', status: 'reversed' }],
    }),
  /a reversed status names the entry that reversed it/u,
);
assert.throws(
  () =>
    assertPurchaseLedgerStatusResponse({
      statuses: [{ ledgerEntryId: 'x', status: 'active', reversedBy: 'y' }],
    }),
  /only a reversed status names a reversing entry/u,
);
const period = assertEntitlementLedgerPeriod({
  playerId: 'player-1',
  extendsLedgerEntryId: recorded.ledgerEntryId,
  idempotencyKey: 'membership:1:period:1',
  periodIndex: 1,
  startedAt: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  payload: {},
});
assert.equal(period.periodIndex, 1);
assert.throws(
  () => assertEntitlementLedgerPeriod({ ...period, expiresAt: period.startedAt }),
  /expiresAt must be a timestamp after startedAt/u,
);

console.log('commerce ledger revocation tests passed');
