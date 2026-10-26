import {
  createCommerceReconciler,
  createInMemoryMonetizationOperationStore,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import type { PurchaseVerificationApi } from '@mpgd/game-services/client';
import type { VerifyPurchaseRequest } from '@mpgd/game-services/types';

import {
  assertEqual,
  assertThrowsCode,
  createFakeStoreKitPlugin,
  fakeAccountToken,
  fakeProduct,
  fakeTransaction,
  type FakeStoreKitPlugin,
} from '../test/fake-storekit-plugin.js';
import { createCapacitorStoreKitCommerceProvider } from './commerce-provider.js';
import { createCapacitorStoreKitStoreSdk } from './store-sdk.js';

/**
 * The JavaScript side of the OpenIAP engine swap (docs/specs/commerce/
 * openiap-migration.md). The native plugin keeps its 0.3 payloads (locked by
 * the Swift `StoreKitTransactionPolicyTests`); what changes is when the
 * engine delivers them:
 *
 * - OpenIAP also hands the result of a `purchase` call to its listener, so the
 *   same transaction arrives as the call's result and as `transactionUpdated`.
 * - OpenIAP's query fails as a whole when StoreKit cannot verify one entry;
 *   `getTransactions` and `finishTransaction` now reject instead of skipping.
 * - A journal written while the 0.3 engine ran must finish under the new one.
 */

const storeSku = 'com.example.game.coins100';
const products = [{ logicalId: 'COINS_100', storeSku, kind: 'consumable' as const }];
const unverified = (): Error =>
  Object.assign(new Error('StoreKit transaction query failed.'), {
    code: 'STOREKIT_TRANSACTION_UNVERIFIED',
  });

function backendGranting(requests: VerifyPurchaseRequest[]): PurchaseVerificationApi {
  return {
    async verifyPurchase(request) {
      requests.push(request);
      // The ledger dedupes by transaction: a repeat verify answers the same entry.
      return {
        verified: true,
        alreadyProcessed: requests.length > 1,
        ledgerEntryId: `ledger-${request.platformTransactionId}`,
      };
    },
  };
}

function reconcilerFor(
  plugin: FakeStoreKitPlugin,
  store: MonetizationOperationStore,
  requests: VerifyPurchaseRequest[],
) {
  const provider = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    isIos: () => true,
    sdk: plugin,
  });
  return createCommerceReconciler({
    provider,
    backend: backendGranting(requests),
    store,
    playerId: 'player-1',
    target: 'ios',
    products,
  });
}

const finishes = (plugin: FakeStoreKitPlugin): string[] =>
  plugin.calls.filter((call) => call.startsWith('finish:'));

// 1. The purchase result and the listener deliver the same transaction:
// one journal record, one verification, one finish.
{
  const plugin = createFakeStoreKitPlugin({ products: [fakeProduct({ productId: storeSku })] });
  const transaction = fakeTransaction({ transactionId: '2000000000000101' });
  const purchase = plugin.purchase.bind(plugin);
  plugin.purchase = async (request) => {
    // OpenIAP emits to its listener before `requestPurchase` returns.
    plugin.emit(transaction);
    plugin.queuePurchase({ status: 'purchased', transaction });
    return purchase(request);
  };
  const requests: VerifyPurchaseRequest[] = [];
  const reconciler = reconcilerFor(plugin, createInMemoryMonetizationOperationStore(), requests);
  await reconciler.start();
  const result = await reconciler.requestPurchase({
    logicalId: 'COINS_100',
    idempotencyKey: 'op-dup',
    source: 'shop',
  });
  await reconciler.runUntilIdle();
  const record = await reconciler.read('op-dup');
  await reconciler.stop();
  assertEqual(result.outcome, 'purchased', 'the call answers purchased');
  assertEqual(record?.state, 'finished', 'the attempt finishes');
  assertEqual(
    requests.map((request) => request.platformTransactionId),
    ['2000000000000101'],
    'the duplicate delivery is verified once',
  );
  assertEqual(
    finishes(plugin),
    [`finish:2000000000000101:ledger-2000000000000101:${fakeAccountToken}`],
    'and finished once with that grant',
  );
  assertEqual((await reconciler.listRecoverable()).length, 0, 'no second record for the event');
}

// 2. A failed transaction query is a failure, never an empty list, and a
// finish behind it is never reported as done.
{
  const plugin = createFakeStoreKitPlugin({
    transactions: [fakeTransaction({ transactionId: '2000000000000201', unfinished: true })],
  });
  plugin.getTransactions = async () => {
    plugin.calls.push('getTransactions');
    throw unverified();
  };
  const sdk = createCapacitorStoreKitStoreSdk({
    products: [{ sku: storeSku, kind: 'consumable' }],
    getAppAccountToken: () => fakeAccountToken,
    isIos: () => true,
    sdk: plugin,
  });
  await assertThrowsCode(
    () => sdk.getAvailablePurchases({}),
    'STOREKIT_TRANSACTION_UNVERIFIED',
    'getAvailablePurchases rejects with the plugin code',
  );
  await assertThrowsCode(
    () =>
      sdk.finishTransaction!({
        transactionId: '2000000000000201',
        ledgerEntryId: 'ledger-1',
        isConsumable: true,
      }),
    'STOREKIT_TRANSACTION_UNVERIFIED',
    'finishTransaction rejects instead of answering finished: false',
  );
  assertEqual(finishes(plugin), [], 'nothing reached native finish');

  const provider = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    isIos: () => true,
    sdk: plugin,
  });
  await assertThrowsCode(
    () => provider.getAvailablePurchases(),
    'INVALID_RESPONSE',
    'the provider normalizes it through the StoreKit error map',
  );
}

// 3. A journal the 0.3 engine wrote (granted, finish not yet acknowledged)
// finishes under the new engine after a restart, with no second grant.
{
  const store = createInMemoryMonetizationOperationStore();
  const transaction = fakeTransaction({ transactionId: '2000000000000301', unfinished: true });
  const requests: VerifyPurchaseRequest[] = [];
  const legacyPlugin = createFakeStoreKitPlugin({
    products: [fakeProduct({ productId: storeSku })],
    transactions: [transaction],
  });
  legacyPlugin.queueFinish({ throws: Object.assign(new Error('app killed'), { code: 'NETWORK' }) });
  const legacy = reconcilerFor(legacyPlugin, store, requests);
  await legacy.start();
  await legacy.stop();
  const legacyRecord = (await store.listRecoverable('player-1'))[0];
  assertEqual(
    legacyRecord !== undefined && 'state' in legacyRecord ? legacyRecord.state : undefined,
    'finishing',
    'the old engine left the grant unfinished',
  );

  // The new engine lists the same transaction in the same 0.3 shape.
  const openIapPlugin = createFakeStoreKitPlugin({
    products: [fakeProduct({ productId: storeSku })],
    transactions: [transaction],
  });
  const resumed = reconcilerFor(openIapPlugin, store, requests);
  await resumed.start();
  const record = await resumed.read('store:app-store:2000000000000301');
  await resumed.stop();
  assertEqual(record?.state, 'finished', 'the new engine finishes the old record');
  assertEqual(
    finishes(openIapPlugin),
    [`finish:2000000000000301:ledger-2000000000000301:${fakeAccountToken}`],
    'with the grant the ledger already holds',
  );
  assertEqual(
    new Set(requests.map((request) => request.idempotencyKey)).size,
    1,
    'every verification used the same idempotency key',
  );
}

console.info('StoreKit OpenIAP engine-swap contract passed.');
