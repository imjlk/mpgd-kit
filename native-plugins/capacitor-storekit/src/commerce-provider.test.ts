import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { CommerceEvent } from '@mpgd/platform/commerce';

import {
  assertEqual,
  createFakeStoreKitPlugin,
  fakeAccountToken,
  fakeProduct,
  fakeTransaction,
} from '../test/fake-storekit-plugin.js';
import {
  appStoreSignedTransactionEvidenceSchema,
  createCapacitorStoreKitCommerceProvider,
  createCapacitorStoreKitServiceProvider,
} from './commerce-provider.js';

const products = [
  { logicalId: 'COINS_100', storeSku: 'com.example.game.coins100', kind: 'consumable' },
  { logicalId: 'REMOVE_ADS', storeSku: 'com.example.game.remove_ads', kind: 'durable' },
] as const;

function createPlugin() {
  return createFakeStoreKitPlugin({
    products: [
      fakeProduct(),
      fakeProduct({
        productId: 'com.example.game.remove_ads',
        type: 'non_consumable',
        title: 'No ads',
      }),
    ],
  });
}

function expectThrows(operation: () => unknown, message: string): void {
  let threw = false;
  try {
    operation();
  } catch {
    threw = true;
  }
  assertEqual(threw, true, message);
}

// Construction.
{
  const sdk = createPlugin();
  expectThrows(
    () =>
      createCapacitorStoreKitCommerceProvider({
        products: [],
        getAppAccountToken: () => fakeAccountToken,
        sdk,
        isIos: () => true,
      }),
    'at least one product mapping is required',
  );
  expectThrows(
    () =>
      createCapacitorStoreKitCommerceProvider({
        products: [{ logicalId: 'PLUS', storeSku: 'com.example.game.plus', kind: 'subscription' }],
        getAppAccountToken: () => fakeAccountToken,
        sdk,
        isIos: () => true,
      }),
    'StoreKit subscriptions are rejected at construction',
  );
  expectThrows(
    () =>
      createCapacitorStoreKitCommerceProvider({
        products,
        getAppAccountToken: () => fakeAccountToken,
        bundleId: ' ',
        sdk,
        isIos: () => true,
      }),
    'a blank bundle id is rejected',
  );
}

// Capabilities, purchase, evidence, and events.
{
  const plugin = createPlugin();
  const provider = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken.toUpperCase(),
    bundleId: 'com.example.game',
    sdk: plugin,
    isIos: () => true,
  });
  assertEqual(provider.store, 'app-store', 'the provider is the App Store');
  assertEqual(
    await provider.getCapabilities(),
    {
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      catalog: { products: true, offers: false, localizedPrice: true },
      lifecycle: {
        availablePurchases: true,
        pending: true,
        restore: true,
        events: true,
        finish: 'client',
      },
      authority: { evidence: 'client-token', accountBinding: 'required' },
      availability: 'available',
    },
    'capabilities are the App Store profile with client-token evidence and a required binding',
  );
  assertEqual(
    (await provider.fetchProducts({})).map((product) => [
      product.logicalId,
      product.kind,
      product.title,
    ]),
    [
      ['COINS_100', 'consumable', '100 Coins'],
      ['REMOVE_ADS', 'durable', 'No ads'],
    ],
    'products map by logical id',
  );

  const events: CommerceEvent[] = [];
  provider.subscribe((event) => {
    events.push(event);
  });
  const transaction = fakeTransaction({
    transactionId: '2000000123456789',
    originalTransactionId: '2000000123456000',
  });
  plugin.queuePurchase({ status: 'purchased', transaction });
  const result = await provider.requestPurchase({
    logicalId: 'COINS_100',
    idempotencyKey: 'op-1',
    source: 'shop',
  });
  assertEqual(
    result,
    {
      outcome: 'purchased',
      purchase: {
        store: 'app-store',
        transactionId: '2000000123456789',
        originalTransactionId: '2000000123456000',
        storeSku: 'com.example.game.coins100',
        logicalId: 'COINS_100',
        quantity: 1,
        state: 'purchased',
        purchasedAt: '2026-07-16T12:00:00Z',
        token: transaction.signedTransaction,
        evidence: {
          schema: appStoreSignedTransactionEvidenceSchema,
          payload: {
            signedTransaction: transaction.signedTransaction,
            transactionId: '2000000123456789',
            originalTransactionId: '2000000123456000',
            bundleId: 'com.example.game',
          },
        },
        accountBinding: { kind: 'app-account-token', value: fakeAccountToken },
      },
    },
    'a purchase carries the JWS as token and as app-store.signed-transaction.v1 evidence',
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('purchase:')),
    [`purchase:com.example.game.coins100:${fakeAccountToken}`],
    'the store opens with the lowercase app account token',
  );
  if (result.outcome !== 'purchased') {
    throw new Error('Expected a purchased outcome.');
  }
  assertEqual(
    await provider.getAvailablePurchases(),
    [result.purchase],
    'an unfinished purchase is available with the same evidence',
  );

  plugin.report(
    fakeTransaction({
      transactionId: '2000000123456790',
      productId: 'com.example.game.remove_ads',
      type: 'non_consumable',
    }),
  );
  plugin.report(
    fakeTransaction({
      transactionId: '2000000123456791',
      revokedAt: '2026-07-18T00:00:00Z',
    }),
  );
  assertEqual(
    events.map((event) =>
      event.type === 'purchaseUpdated'
        ? [event.purchase.logicalId, event.purchase.state, event.purchase.evidence.schema]
        : [event.type],
    ),
    [
      ['REMOVE_ADS', 'purchased', appStoreSignedTransactionEvidenceSchema],
      ['COINS_100', 'revoked', appStoreSignedTransactionEvidenceSchema],
    ],
    'delayed and revoked transactions reach subscribers as purchaseUpdated events',
  );
  assertEqual(
    (await provider.getAvailablePurchases()).map((purchase) => purchase.transactionId),
    ['2000000123456789', '2000000123456790'],
    'a revoked transaction is not available',
  );

  const finish = provider.finishTransaction;
  if (finish === undefined) {
    throw new Error('finishTransaction is required for finish: client.');
  }
  assertEqual(
    await finish.call(provider, {
      transactionId: '2000000123456789',
      ledgerEntryId: 'le-1',
      isConsumable: true,
    }),
    { finished: true },
    'the reconciler finishes with the ledger entry id',
  );
  assertEqual(
    plugin.calls.at(-1),
    'finish:2000000123456789:le-1',
    'the native finish receives the transaction and ledger entry',
  );
  await provider.restorePurchases?.();
  assertEqual(plugin.calls.at(-1), 'sync', 'restore is AppStore.sync');
  provider.dispose();
}

// Failure classes: uncertain stays recoverable, lookup failures keep the store code.
{
  const plugin = createPlugin();
  const provider = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    sdk: plugin,
    isIos: () => true,
  });
  plugin.queuePurchase({
    throws: Object.assign(new Error('uncertain'), { code: 'STOREKIT_PURCHASE_UNCERTAIN' }),
  });
  assertEqual(
    await provider.requestPurchase({ logicalId: 'COINS_100', idempotencyKey: 'op-2', source: 'shop' }),
    { outcome: 'launched' },
    'an uncertain purchase stays launched for the reconciler',
  );
  plugin.queuePurchase({
    throws: Object.assign(new Error('lookup'), { code: 'STOREKIT_PRODUCT_LOOKUP_FAILED' }),
  });
  assertEqual(
    await provider.requestPurchase({ logicalId: 'COINS_100', idempotencyKey: 'op-3', source: 'shop' }),
    {
      outcome: 'failed',
      error: {
        code: 'STORE_UNAVAILABLE',
        retryable: true,
        storeCode: 'STOREKIT_PRODUCT_LOOKUP_FAILED',
        message: 'lookup',
      },
    },
    'a lookup failure is STORE_UNAVAILABLE with the store code kept',
  );
  plugin.queuePurchase({ status: 'cancelled' });
  assertEqual(
    (await provider.requestPurchase({ logicalId: 'COINS_100', idempotencyKey: 'op-4', source: 'shop' }))
      .outcome,
    'cancelled',
    'a cancelled sheet is cancelled',
  );
  let threw: unknown;
  try {
    await provider.requestPurchase({ logicalId: 'PLUS', idempotencyKey: 'op-5', source: 'shop' });
  } catch (error) {
    threw = error;
  }
  assertEqual(
    (threw as { readonly code?: string }).code,
    'ITEM_UNAVAILABLE',
    'an unmapped logical id is unavailable',
  );
  provider.dispose();
}

// Account binding failures never open the store.
{
  const plugin = createPlugin();
  const invalid = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => 'not-a-uuid',
    sdk: plugin,
    isIos: () => true,
  });
  let error: unknown;
  try {
    await invalid.requestPurchase({
      logicalId: 'COINS_100',
      idempotencyKey: 'op-6',
      source: 'shop',
    });
  } catch (caught) {
    error = caught;
  }
  assertEqual(
    [(error as { code?: string }).code, (error as { storeCode?: string }).storeCode],
    ['CONFIGURATION_REQUIRED', 'STOREKIT_CONFIGURATION_ERROR'],
    'a non-UUID app account token is a configuration failure',
  );
  const unavailable = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => {
      throw new Error('session expired');
    },
    sdk: plugin,
    isIos: () => true,
  });
  try {
    await unavailable.requestPurchase({
      logicalId: 'COINS_100',
      idempotencyKey: 'op-7',
      source: 'shop',
    });
  } catch (caught) {
    error = caught;
  }
  assertEqual(
    (error as { code?: string }).code,
    'ACCOUNT_BINDING_REQUIRED',
    'a token that cannot be resolved is a missing account binding',
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('purchase:')),
    [],
    'no purchase sheet opened without a valid binding',
  );
  const web = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    sdk: plugin,
    isIos: () => false,
  });
  assertEqual(
    (await web.getCapabilities()).availability,
    'unsupported',
    'off iOS the provider is unsupported',
  );
  try {
    await web.requestPurchase({ logicalId: 'COINS_100', idempotencyKey: 'op-8', source: 'shop' });
  } catch (caught) {
    error = caught;
  }
  assertEqual(
    (error as { code?: string }).code,
    'STORE_UNAVAILABLE',
    'off iOS a purchase fails closed before the store',
  );
  invalid.dispose();
  unavailable.dispose();
  web.dispose();
}

// Registry and gateway integration.
{
  const plugin = createPlugin();
  const service = createCapacitorStoreKitServiceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    sdk: plugin,
    isIos: () => true,
  });
  assertEqual(service.id, 'apple-storekit', 'the registry id defaults to the v1 id');
  assertEqual(service.features, ['nativeIap'], 'the service provider serves native IAP');
  const gateway = createCapacitorPlatformGateway({
    target: 'ios',
    appVersion: '1.0.0',
    buildId: 'storekit-v2-test',
    bridge: {
      async request(input: BridgeRequest): Promise<BridgeResponse> {
        throw new Error(`The base bridge must not receive ${input.method}.`);
      },
    },
    providers: [service],
  });
  const commerce = gateway.commerceV2;
  if (commerce === undefined) {
    throw new Error('The gateway must expose the StoreKit commerce v2 provider.');
  }
  assertEqual(commerce.store, 'app-store', 'the bridged provider keeps the store id');
  const capabilities = await commerce.getCapabilities();
  assertEqual(
    [capabilities.lifecycle.finish, capabilities.authority.evidence, capabilities.availability],
    ['client', 'client-token', 'available'],
    'capabilities cross the bridge path',
  );
  const transaction = fakeTransaction({ transactionId: '2000000123456800' });
  plugin.queuePurchase({ status: 'purchased', transaction });
  commerce.subscribe(() => undefined);
  const purchased = await commerce.requestPurchase({
    logicalId: 'COINS_100',
    idempotencyKey: 'op-9',
    source: 'shop',
  });
  assertEqual(
    purchased.outcome === 'purchased'
      ? [purchased.purchase.token, purchased.purchase.evidence.schema]
      : [purchased.outcome],
    [transaction.signedTransaction, appStoreSignedTransactionEvidenceSchema],
    'a purchase through the validated bridge path keeps the JWS and evidence schema',
  );
  const custom = createCapacitorStoreKitServiceProvider({
    id: 'storekit-custom',
    products,
    getAppAccountToken: () => fakeAccountToken,
    sdk: plugin,
    isIos: () => true,
  });
  assertEqual(custom.id, 'storekit-custom', 'the registry id can be overridden');
}

console.info('StoreKit commerce v2 provider passed.');
