import { describe, expect, it } from 'vitest';

import {
  createCommerceReconciler,
  createInMemoryMonetizationOperationStore,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import type { VerifyPurchaseRequest } from '@mpgd/game-services/types';
import { createGooglePlayTokenPurchaseKey } from '@mpgd/platform/commerce';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
  fakePlayPurchase,
  type FakePlayBillingPlugin,
} from '../test/play-billing-plugin-fixture.js';
import { createCapacitorPlayBillingCommerceProvider } from './commerce-provider.js';

/**
 * The JavaScript side of the OpenIAP engine swap (docs/specs/commerce/
 * openiap-migration.md). The Kotlin plugin keeps the 0.3 payloads (locked by
 * `PlayBillingPolicyTest`); these cases pin what the reconciler must keep
 * doing across the swap: a journal the Java engine wrote resumes under the
 * new engine, and OpenIAP's already-owned recovery (the owned purchase now
 * also arrives as `purchaseUpdated` next to the `PLAY_BILLING_ALREADY_OWNED`
 * rejection) never grants twice. Google Play finishes on the server only.
 */

const accountId = 'player-1';
const products = [{ logicalId: 'COINS_100', storeSku: 'coins_100', kind: 'consumable' as const }];

let grants = 0;

function reconcilerFor(
  plugin: FakePlayBillingPlugin,
  store: MonetizationOperationStore,
  requests: VerifyPurchaseRequest[],
  outage: () => boolean = () => false,
) {
  grants = 0;
  const provider = createCapacitorPlayBillingCommerceProvider({
    plugin,
    isAndroid: () => true,
    products,
    accountBinding: () => ({ kind: 'obfuscated-account-id', value: accountId }),
  });
  return createCommerceReconciler({
    provider,
    backend: {
      async verifyPurchase(request) {
        requests.push(request);
        if (outage()) {
          throw new Error('backend unavailable');
        }
        // The ledger grants a transaction once; the finalizer then consumes it.
        // The client never acknowledges or consumes.
        grants += 1;
        const evidence = request.evidence?.payload as { readonly purchaseToken?: string } | undefined;
        if (evidence?.purchaseToken !== undefined) {
          plugin.finalize(evidence.purchaseToken, 'consume');
        }
        return {
          verified: true,
          alreadyProcessed: grants > 1,
          ledgerEntryId: 'ledger-1',
          finalization: { status: 'completed', action: 'consume', alreadyCompleted: grants > 1 },
        };
      },
    },
    store,
    playerId: accountId,
    target: 'android',
    products,
  });
}

describe('Play Billing across the OpenIAP engine swap', () => {
  it('resumes a token-keyed journal from the Java engine once Play assigns the order id', async () => {
    const store = createInMemoryMonetizationOperationStore();
    const requests: VerifyPurchaseRequest[] = [];
    const token = 'token-swap-1';
    const key = await createGooglePlayTokenPurchaseKey(token);

    // The Java engine saw the purchase while it was pending, without an order id.
    const javaEngine = createFakePlayBillingPlugin({ products: [fakePlayProduct({ productId: 'coins_100' })] });
    javaEngine.upsert(fakePlayPurchase({
      products: ['coins_100'],
      purchaseToken: token,
      purchaseState: 'pending',
      obfuscatedAccountId: accountId,
    }));
    const before = reconcilerFor(javaEngine, store, requests);
    await before.start();
    await before.stop();
    expect((await before.read(key))?.state).toBe('pending');
    expect(requests).toHaveLength(0);

    // After the update the OpenIAP engine reports it purchased, with an order id.
    const openIapEngine = createFakePlayBillingPlugin({ products: [fakePlayProduct({ productId: 'coins_100' })] });
    openIapEngine.upsert(fakePlayPurchase({
      products: ['coins_100'],
      purchaseToken: token,
      orderId: 'GPA.3301-0000-0001',
      purchaseState: 'purchased',
      isAcknowledged: false,
      obfuscatedAccountId: accountId,
    }));
    const after = reconcilerFor(openIapEngine, store, requests);
    await after.start();
    const record = await after.read(key);
    await after.stop();

    expect(record?.state).toBe('finished');
    expect(requests.map((request) => request.idempotencyKey)).toEqual([key]);
    expect(await after.read('store:google-play:GPA.3301-0000-0001')).toBeUndefined();
    expect(openIapEngine.purchases).toHaveLength(0);
  });

  it('grants an already-owned purchase recovered through the event exactly once', async () => {
    const store = createInMemoryMonetizationOperationStore();
    const requests: VerifyPurchaseRequest[] = [];
    const owned = fakePlayPurchase({
      products: ['coins_100'],
      purchaseToken: 'token-owned',
      orderId: 'GPA.3301-0000-0002',
      purchaseState: 'purchased',
      isAcknowledged: false,
      obfuscatedAccountId: accountId,
    });
    const plugin = createFakePlayBillingPlugin({ products: [fakePlayProduct({ productId: 'coins_100' })] });
    plugin.upsert(owned);
    // Kotlin: OpenIAP resolves ITEM_ALREADY_OWNED with the owned purchase and
    // delivers it to listeners; the plugin still rejects as 0.3 did.
    const purchase = plugin.purchase.bind(plugin);
    plugin.purchase = async (input) => {
      plugin.emit({ status: 'purchased', purchase: owned });
      plugin.queuePurchase({
        throws: Object.assign(new Error('owned'), { code: 'PLAY_BILLING_ALREADY_OWNED' }),
      });
      return purchase(input);
    };
    let outage = true;
    const reconciler = reconcilerFor(plugin, store, requests, () => outage);
    // The backend was down when the app started: the owned purchase stays unfinalized.
    await reconciler.start();
    expect(plugin.purchases).toHaveLength(1);
    outage = false;
    const result = await reconciler.requestPurchase({
      logicalId: 'COINS_100',
      idempotencyKey: 'op-owned',
      source: 'shop',
    });
    await reconciler.runUntilIdle();
    // The next pass (app resume) retries the verification the outage left open.
    await reconciler.reconcile();
    await reconciler.stop();

    // ALREADY_OWNED keeps the attempt open for recovery (never a terminal failure).
    expect(result.outcome).toBe('launched');
    const granted = requests.filter((request) => request.platformTransactionId === 'GPA.3301-0000-0002');
    expect(granted.length).toBeGreaterThan(0);
    expect(new Set(granted.map((request) => request.idempotencyKey)).size).toBe(1);
    expect(grants).toBe(1);
    expect(plugin.purchases).toHaveLength(0);
  });
});
