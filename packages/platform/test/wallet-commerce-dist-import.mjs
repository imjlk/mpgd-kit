import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runCommerceConformanceVectors } from '@mpgd/platform/commerce-conformance';
import { assertCommerceConformanceVector } from '@mpgd/platform/commerce-vectors';
import {
  assertCreditLotGrant,
  compareCreditLotSpendOrder,
  createCreditCommerceProvider,
  createCreditSubscriptionEventId,
  createInMemoryCreditWallet,
  createMembershipRenewalKey,
  creditWalletSpendEvidenceSchema,
  deriveCreditLotSpendScope,
  planCreditDebits,
  readCreditWalletSpendEvidence,
  resolveCommerceBillingAuthority,
  selectEligibleCreditLots,
} from '@mpgd/platform/commerce-wallet';

const currency = 'wallet-unit';

assert.equal(resolveCommerceBillingAuthority('web'), 'host');
assert.equal(resolveCommerceBillingAuthority('microsoft-store'), 'store');
assert.throws(() => resolveCommerceBillingAuthority('google-play', 'host'), RangeError);
assert.equal(createMembershipRenewalKey('op-1', 3), 'membership:op-1:3');
assert.equal(createCreditSubscriptionEventId('op-1', 3, 'subscriptionRenewed'), 'op-1:3:subscriptionRenewed');
assert.deepEqual(
  deriveCreditLotSpendScope({ channel: 'off-store', store: 'web', titleId: 'title-a' }),
  { kind: 'cross-title' },
);
assert.throws(() => assertCreditLotGrant({ ledgerEntryId: 'le-1' }));

let at = '2026-10-01T00:00:00Z';
const wallet = createInMemoryCreditWallet({
  store: 'dist.wallet',
  currencies: [currency],
  now: () => at,
  offers: [
    {
      logicalId: 'booster',
      storeSku: 'booster.1',
      kind: 'consumable',
      title: 'Booster',
      description: 'One booster',
      price: { currency, amount: 4 },
    },
    {
      logicalId: 'membership_plus',
      storeSku: 'membership.plus',
      kind: 'subscription',
      title: 'Plus',
      description: 'Plus membership',
      price: { currency, amount: 30 },
      membership: { scope: 'platform', price: { currency, amount: 30 }, period: 'P30D' },
    },
  ],
});
wallet.creditFromGrant({
  ledgerEntryId: 'le-store',
  currency,
  amount: 10,
  origin: { channel: 'store', store: 'fixture.store', titleId: 'title-a' },
  createdAt: '2026-10-01T00:00:00Z',
});
wallet.creditFromGrant({
  ledgerEntryId: 'le-web',
  currency,
  amount: 60,
  origin: { channel: 'off-store', store: 'fixture.web', titleId: 'title-a' },
  createdAt: '2026-10-01T00:00:00Z',
});
assert.equal(wallet.creditFromGrant({
  ledgerEntryId: 'le-web',
  currency,
  amount: 60,
  origin: { channel: 'off-store', store: 'fixture.web', titleId: 'title-a' },
  createdAt: '2026-10-01T00:00:00Z',
}).lotId, 'le-web');
assert.equal(wallet.lots.length, 2);
const eligible = selectEligibleCreditLots(wallet.lots, { titleId: 'title-a', currency, now: at });
assert.deepEqual([...eligible].sort(compareCreditLotSpendOrder).map((lot) => lot.lotId), ['le-store', 'le-web']);
assert.deepEqual(planCreditDebits(eligible, 12), {
  status: 'debited',
  debits: [{ lotId: 'le-store', amount: 10 }, { lotId: 'le-web', amount: 2 }],
});

const provider = createCreditCommerceProvider(wallet, {
  titleId: 'title-a',
  billingAuthority: 'host',
  currencies: [currency],
  now: () => at,
});
const capabilities = await provider.getCapabilities();
assert.equal(capabilities.purchase.subscription, true);
assert.equal(capabilities.lifecycle.finish, 'server');
assert.equal(capabilities.authority.evidence, 'adapter-settled');
assert.equal(capabilities.authority.accountBinding, 'host');

const purchased = await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' });
assert.equal(purchased.outcome, 'purchased');
assert.equal(purchased.purchase.evidence.schema, creditWalletSpendEvidenceSchema);
assert.equal(purchased.purchase.settlement, undefined);
assert.deepEqual(readCreditWalletSpendEvidence(purchased.purchase.evidence).debits, [{ lotId: 'le-store', amount: 4 }]);
const replay = await provider.requestPurchase({ logicalId: 'booster', idempotencyKey: 'op-1', source: 'shop' });
assert.equal(replay.outcome, 'purchased');
assert.equal(wallet.debits.length, 1);

const membership = await provider.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-2', source: 'shop' });
assert.equal(membership.outcome, 'purchased');
assert.equal(membership.purchase.transactionId, 'membership:op-2:0');
assert.deepEqual(wallet.debits[1], { idempotencyKey: 'membership:op-2:0', lotId: 'le-web', amount: 30 });
at = '2026-10-31T00:00:00Z';
await wallet.renewDue();
await wallet.renewDue();
assert.equal(wallet.debits.length, 3);
assert.deepEqual(wallet.debits[2], { idempotencyKey: 'membership:op-2:1', lotId: 'le-web', amount: 30 });
at = '2026-11-30T00:00:00Z';
await wallet.renewDue();
assert.deepEqual(
  wallet.subscriptionEvents.map((event) => event.eventId),
  ['op-2:0:subscriptionStarted', 'op-2:1:subscriptionRenewed', 'op-2:2:subscriptionLapsed'],
);
assert.deepEqual(await provider.getActiveSubscriptions(), []);
assert.equal(wallet.lots[0].remaining, 6);

const storeBilled = createCreditCommerceProvider(wallet, { titleId: 'title-a', billingAuthority: 'store' });
assert.equal((await storeBilled.getCapabilities()).purchase.subscription, false);
assert.deepEqual((await storeBilled.fetchProducts({ type: 'all' })).map((product) => product.logicalId), ['booster']);
const refused = await storeBilled.requestPurchase({ logicalId: 'membership_plus', idempotencyKey: 'op-3', source: 'shop' });
assert.equal(refused.outcome, 'failed');
assert.equal(refused.error.code, 'ITEM_UNAVAILABLE');

await assert.rejects(
  provider.finishTransaction({ transactionId: 'op-1', ledgerEntryId: '', isConsumable: true }),
  (error) => error.code === 'INVALID_RESPONSE',
);
assert.deepEqual(
  await provider.finishTransaction({ transactionId: 'op-1', ledgerEntryId: 'le-grant', isConsumable: true }),
  { finished: true },
);

const vectorsDir = new URL('../../../docs/specs/commerce/vectors/', import.meta.url);
const walletVectors = ['credit-lot-title-scope', 'credit-membership-renewal', 'membership-store-billing-target']
  .map((name) => assertCommerceConformanceVector(JSON.parse(readFileSync(new URL(`${name}.json`, vectorsDir), 'utf8'))));
const results = await runCommerceConformanceVectors(walletVectors);
assert.deepEqual(
  results.map((result) => [result.vector, result.status, result.failures]),
  walletVectors.map((vector) => [vector.vector, 'passed', []]),
);

console.info('Commerce wallet dist entrypoint passed.');
