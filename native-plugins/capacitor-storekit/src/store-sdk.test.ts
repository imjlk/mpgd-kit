import { normalizeStoreSdkError, type StoreSdkEvent } from '@mpgd/adapter-capacitor';

import {
  assertEqual,
  assertThrowsCode,
  createFakeStoreKitPlugin,
  fakeAccountToken,
  fakeProduct,
  fakeTransaction,
} from '../test/fake-storekit-plugin.js';
import {
  capacitorStoreKitErrorCodeMap,
  createCapacitorStoreKitStoreSdk,
  isValidStoreKitTransaction,
  readAppAccountToken,
  storeKitStoreSdkCapabilities,
  storeKitStoreSdkErrorCodeMap,
  toSdkPurchase,
} from './store-sdk.js';

const sku = 'com.example.game.coins100';
const binding = { kind: 'app-account-token', value: fakeAccountToken.toUpperCase() } as const;

function createSdk(input: {
  readonly plugin?: ReturnType<typeof createFakeStoreKitPlugin>;
  readonly isIos?: () => boolean;
  readonly productIds?: readonly string[];
} = {}) {
  const plugin = input.plugin ?? createFakeStoreKitPlugin();
  const sdk = createCapacitorStoreKitStoreSdk({
    productIds: input.productIds ?? [sku, 'com.example.game.remove_ads'],
    sdk: plugin,
    isIos: input.isIos ?? (() => true),
  });
  return { plugin, sdk };
}

// Identity and capabilities.
{
  const { sdk } = createSdk();
  assertEqual(sdk.store, 'app-store', 'the SDK is the App Store');
  assertEqual(
    sdk.capabilities,
    storeKitStoreSdkCapabilities,
    'capabilities are the App Store profile',
  );
  assertEqual(
    storeKitStoreSdkCapabilities,
    {
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      offers: false,
      pending: true,
      restore: true,
      finish: 'client',
    },
    'the App Store profile matches the RFC capabilities table',
  );
  let threw = false;
  try {
    createCapacitorStoreKitStoreSdk({ productIds: ['bad sku'], sdk: createFakeStoreKitPlugin() });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, 'an invalid product id is rejected at construction');
}

// fetchProducts maps StoreKit products to SDK products.
{
  const plugin = createFakeStoreKitPlugin({
    products: [
      fakeProduct(),
      fakeProduct({
        productId: 'com.example.game.remove_ads',
        type: 'non_consumable',
        title: 'No ads',
      }),
      fakeProduct({ productId: 'com.example.game.unlisted' }),
    ],
  });
  const { sdk } = createSdk({ plugin });
  const products = await sdk.fetchProducts({
    skus: [sku, 'com.example.game.remove_ads'],
    type: 'all',
  });
  assertEqual(
    products,
    [
      {
        sku,
        kind: 'consumable',
        title: '100 Coins',
        description: 'Game currency',
        price: { formatted: '$1.00', currencyCode: 'USD' },
      },
      {
        sku: 'com.example.game.remove_ads',
        kind: 'durable',
        title: 'No ads',
        description: 'Game currency',
        price: { formatted: '$1.00', currencyCode: 'USD' },
      },
    ],
    'consumable and non_consumable map to consumable and durable with the localized price',
  );
  assertEqual(plugin.calls, [`getProducts:${sku},com.example.game.remove_ads`], 'one lookup');
  assertEqual(
    await sdk.fetchProducts({ skus: [sku], type: 'subscription' }),
    [],
    'StoreKit sells no subscriptions, so a subscription lookup is empty without a native call',
  );
  assertEqual(await sdk.fetchProducts({ skus: [], type: 'in-app' }), [], 'no SKUs, no call');
  assertEqual(plugin.calls.length, 1, 'subscription and empty lookups never reach native');
  const manySkus = Array.from({ length: 101 }, (_, index) => `com.example.game.p${index}`);
  await sdk.fetchProducts({ skus: manySkus, type: 'in-app' });
  assertEqual(plugin.calls.length, 3, 'more than 100 SKUs are looked up in chunks of 100');
  plugin.productsError = Object.assign(new Error('offline'), { code: 'STOREKIT_UNAVAILABLE' });
  await assertThrowsCode(
    () => sdk.fetchProducts({ skus: [sku], type: 'in-app' }),
    'STOREKIT_UNAVAILABLE',
    'a native lookup failure propagates with its store code',
  );
}

// requestPurchase: account binding, outcomes, and the JWS token.
{
  const { plugin, sdk } = createSdk();
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku }),
    'ACCOUNT_BINDING_REQUIRED',
    'a purchase without an account binding never opens the store',
  );
  await assertThrowsCode(
    () =>
      sdk.requestPurchase({ sku, accountBinding: { kind: 'obfuscated-account-id', value: 'p' } }),
    'STOREKIT_CONFIGURATION_ERROR',
    'StoreKit accepts only app-account-token bindings',
  );
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding: { kind: 'app-account-token', value: 'nope' } }),
    'STOREKIT_CONFIGURATION_ERROR',
    'the app account token must be a UUID',
  );
  await assertThrowsCode(
    () => sdk.requestPurchase({
      sku,
      accountBinding: { kind: 'app-account-token', value: '00000000-0000-0000-0000-000000000000' },
    }),
    'STOREKIT_CONFIGURATION_ERROR',
    'the nil UUID is not an account binding',
  );
  assertEqual(plugin.calls, [], 'rejected bindings never reach the native purchase sheet');

  const transaction = fakeTransaction({
    transactionId: '2000000123456789',
    originalTransactionId: '2000000123456000',
    appAccountToken: fakeAccountToken.toUpperCase(),
  });
  plugin.queuePurchase({ status: 'purchased', transaction });
  const purchased = await sdk.requestPurchase({ sku, accountBinding: binding });
  assertEqual(
    purchased,
    {
      outcome: 'purchased',
      purchase: {
        sku,
        transactionId: '2000000123456789',
        originalTransactionId: '2000000123456000',
        state: 'purchased',
        purchasedAt: '2026-07-16T12:00:00Z',
        token: transaction.signedTransaction,
        quantity: 1,
        accountBinding: { kind: 'app-account-token', value: fakeAccountToken },
        raw: { type: 'consumable' },
      },
    },
    'a purchased outcome maps the transaction with the signed JWS as the token',
  );
  assertEqual(
    plugin.calls,
    [`purchase:${sku}:${fakeAccountToken}`],
    'the purchase opens with the lowercase UUID app account token',
  );

  assertEqual(
    await sdk.requestPurchase({ sku, accountBinding: binding }),
    { outcome: 'launched' },
    'Ask to Buy (pending) is launched: the transaction arrives as an event',
  );
  plugin.queuePurchase({ status: 'cancelled' });
  assertEqual(
    await sdk.requestPurchase({ sku, accountBinding: binding }),
    {
      outcome: 'cancelled',
      error: { code: 'USER_CANCELLED', retryable: false, storeCode: 'userCancelled' },
    },
    'a cancelled sheet is a USER_CANCELLED outcome',
  );
  plugin.queuePurchase({
    status: 'purchased',
    transaction: fakeTransaction({ transactionId: '3', appAccountToken: crypto.randomUUID() }),
  });
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding: binding }),
    'STOREKIT_EVIDENCE_INVALID',
    'a transaction bound to another account is invalid evidence',
  );
  plugin.queuePurchase({
    status: 'purchased',
    transaction: fakeTransaction({ transactionId: '4', productId: 'com.example.game.other' }),
  });
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding: binding }),
    'STOREKIT_EVIDENCE_INVALID',
    'a transaction for another product is invalid evidence',
  );
  plugin.queuePurchase({
    status: 'purchased',
    transaction: fakeTransaction({ transactionId: '5', signedTransaction: '' }),
  });
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding: binding }),
    'STOREKIT_EVIDENCE_INVALID',
    'a transaction without the JWS is invalid evidence',
  );
  plugin.queuePurchase({
    throws: Object.assign(new Error('uncertain'), { code: 'STOREKIT_PURCHASE_UNCERTAIN' }),
  });
  const uncertain = await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding: binding }),
    'STOREKIT_PURCHASE_UNCERTAIN',
    'an uncertain purchase propagates its store code for the provider to keep recoverable',
  );
  assertEqual(
    normalizeStoreSdkError(uncertain, capacitorStoreKitErrorCodeMap).toCommerceErrorInfo(),
    {
      code: 'OUTCOME_UNKNOWN',
      retryable: false,
      storeCode: 'STOREKIT_PURCHASE_UNCERTAIN',
      message: 'uncertain',
    },
    'STOREKIT_PURCHASE_UNCERTAIN normalizes to OUTCOME_UNKNOWN with the store code kept',
  );
}

// getAvailablePurchases: unfinished only, revoked mapped, malformed reported.
{
  const unfinished = fakeTransaction({ transactionId: '10', unfinished: true });
  const legacy = fakeTransaction({ transactionId: '11' });
  const finishedEntitlement = fakeTransaction({
    transactionId: '12',
    type: 'non_consumable',
    productId: 'com.example.game.remove_ads',
    unfinished: false,
  });
  const revoked = fakeTransaction({
    transactionId: '13',
    unfinished: true,
    revokedAt: '2026-07-17T12:00:00Z',
  });
  const malformed = { ...fakeTransaction({ transactionId: '14' }), signedTransaction: '' };
  const plugin = createFakeStoreKitPlugin({
    transactions: [unfinished, legacy, finishedEntitlement, revoked, malformed, unfinished],
  });
  const { sdk } = createSdk({ plugin });
  const events: StoreSdkEvent[] = [];
  sdk.addListener('purchaseError', (event) => {
    events.push(event);
  });
  const purchases = await sdk.getAvailablePurchases({ includePending: true });
  assertEqual(
    purchases.map((purchase) => [purchase.transactionId, purchase.state, purchase.token]),
    [
      ['10', 'purchased', unfinished.signedTransaction],
      ['11', 'purchased', legacy.signedTransaction],
      ['13', 'revoked', revoked.signedTransaction],
    ],
    'unfinished transactions are listed once with the JWS, a finished entitlement is not, '
      + 'a transaction without the flag is listed, and revokedAt maps to state revoked',
  );
  assertEqual(
    purchases[2]?.raw,
    {
      type: 'consumable',
      revokedAt: '2026-07-17T12:00:00Z',
      unfinished: true,
    },
    'raw keeps the native type, revocation, and flag for diagnostics',
  );
  assertEqual(
    events.map((event) => event.type === 'purchaseError' ? [event.sku, event.error.code] : []),
    [[sku, 'STOREKIT_EVIDENCE_INVALID']],
    'one malformed transaction is reported as a purchaseError and never blocks its siblings',
  );
}

// finishTransaction: the ledger entry authorizes the native finish.
{
  const plugin = createFakeStoreKitPlugin({
    transactions: [fakeTransaction({ transactionId: '20' })],
  });
  const { sdk } = createSdk({ plugin });
  const finish = sdk.finishTransaction;
  if (finish === undefined) {
    throw new Error('finishTransaction is required for finish: client.');
  }
  await assertThrowsCode(
    () => finish.call(sdk, { transactionId: '', isConsumable: true, ledgerEntryId: 'le-1' }),
    'STOREKIT_FINISH_REQUIRES_GRANT',
    'an empty transaction id never reaches native',
  );
  await assertThrowsCode(
    () => finish.call(sdk, { transactionId: '20', isConsumable: true, ledgerEntryId: ' ' }),
    'STOREKIT_FINISH_REQUIRES_GRANT',
    'a blank ledger entry never reaches native',
  );
  assertEqual(plugin.calls, [], 'rejected finish inputs never reach native');
  plugin.queueFinish({ throws: Object.assign(new Error('offline'), { code: 'NETWORK' }) });
  await assertThrowsCode(
    () => finish.call(sdk, { transactionId: '20', isConsumable: true, ledgerEntryId: 'le-1' }),
    'NETWORK',
    'a failed native finish propagates',
  );
  const results = await Promise.all([
    finish.call(sdk, { transactionId: '20', isConsumable: true, ledgerEntryId: 'le-1' }),
    finish.call(sdk, { transactionId: '20', isConsumable: true, ledgerEntryId: 'le-1' }),
  ]);
  assertEqual(
    results,
    [{ finished: true }, { finished: true }],
    'both overlapping finishes resolve',
  );
  assertEqual(
    plugin.calls,
    ['finish:20:le-1', 'finish:20:le-1'],
    'the failed finish and the shared retry each reach native once',
  );
  assertEqual(plugin.transactions, [], 'a finished transaction leaves the unfinished list');
  plugin.queueFinish({ finished: false });
  assertEqual(
    await finish.call(sdk, { transactionId: '21', isConsumable: false, ledgerEntryId: 'le-2' }),
    { finished: false },
    'an unknown transaction reports unfinished',
  );
}

// restorePurchases asks the App Store to synchronize.
{
  const { plugin, sdk } = createSdk();
  const restore = sdk.restorePurchases;
  if (restore === undefined) {
    throw new Error('restorePurchases is required for restore: true.');
  }
  await restore.call(sdk);
  assertEqual(plugin.calls, ['sync'], 'restore is AppStore.sync');
  plugin.syncResult = { synced: false };
  await assertThrowsCode(
    () => restore.call(sdk),
    'STOREKIT_SYNC_FAILED',
    'an incomplete sync is a failure',
  );
  plugin.syncResult = { synced: true };
  plugin.syncError = Object.assign(new Error('sync failed'), { code: 'STOREKIT_SYNC_FAILED' });
  await assertThrowsCode(
    () => restore.call(sdk),
    'STOREKIT_SYNC_FAILED',
    'a native sync failure propagates',
  );
}

// transactionUpdated becomes purchaseUpdated; the native listener follows the subscribers.
{
  const { plugin, sdk } = createSdk();
  const events: StoreSdkEvent[] = [];
  assertEqual(plugin.listenerCount, 0, 'no native listener before a subscriber');
  const detachFirst = sdk.addListener('purchaseUpdated', (event) => {
    events.push(event);
  });
  const detachSecond = sdk.addListener('purchaseUpdated', (event) => {
    events.push(event);
  });
  assertEqual(plugin.listenerCount, 1, 'one native listener serves every subscriber');
  const transaction = fakeTransaction({ transactionId: '30', revokedAt: '2026-07-18T00:00:00Z' });
  plugin.emit(transaction);
  assertEqual(
    events.map((event) =>
      event.type === 'purchaseUpdated'
        ? [event.purchase.transactionId, event.purchase.state, event.purchase.token]
        : [],
    ),
    [
      ['30', 'revoked', transaction.signedTransaction],
      ['30', 'revoked', transaction.signedTransaction],
    ],
    'a delayed transaction reaches every subscriber with the JWS token and the revoked state',
  );
  const errors: StoreSdkEvent[] = [];
  sdk.addListener('purchaseError', (event) => {
    errors.push(event);
  });
  plugin.emit({ productId: sku, transactionId: '31' });
  assertEqual(
    errors.map((event) => event.type === 'purchaseError' ? [event.sku, event.error.code] : []),
    [[sku, 'STOREKIT_EVIDENCE_INVALID']],
    'a malformed native event is a purchaseError, never a purchase',
  );
  detachFirst();
  assertEqual(plugin.listenerCount, 1, 'the native listener stays while a subscriber remains');
  detachSecond();
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(plugin.listenerCount, 0, 'the native listener is removed with the last subscriber');
  assertEqual(
    plugin.calls,
    ['addListener:transactionUpdated', 'removeListener:transactionUpdated'],
    'native attach and detach happen once each',
  );
}

// Availability follows the v1 probe.
{
  const plugin = createFakeStoreKitPlugin();
  const { sdk } = createSdk({ plugin });
  const availability = sdk.getAvailability;
  if (availability === undefined) {
    throw new Error('getAvailability is implemented.');
  }
  assertEqual(
    await availability.call(sdk),
    'available',
    'a mapped product makes the store available',
  );
  assertEqual(
    await createSdk({ plugin, productIds: ['com.example.game.missing'] }).sdk.getAvailability?.(),
    'configuration-required',
    'no mapped product is a configuration problem',
  );
  assertEqual(
    await createSdk({ plugin, productIds: [] }).sdk.getAvailability?.(),
    'configuration-required',
    'no product ids at all is a configuration problem',
  );
  plugin.productsError = Object.assign(new Error('bad'), { code: 'STOREKIT_INVALID_PRODUCTS' });
  assertEqual(
    await availability.call(sdk),
    'configuration-required',
    'rejected product ids are a configuration problem',
  );
  plugin.productsError = Object.assign(new Error('offline'), { code: 'STOREKIT_UNAVAILABLE' });
  assertEqual(
    await availability.call(sdk),
    'temporarily-unavailable',
    'a lookup outage is temporary',
  );
  plugin.productsError = undefined;
  const web = createSdk({ plugin, isIos: () => false }).sdk;
  assertEqual(await web.getAvailability?.(), 'unsupported', 'StoreKit is iOS only');
  await assertThrowsCode(
    () => web.fetchProducts({ skus: [sku], type: 'all' }),
    'STOREKIT_IOS_REQUIRED',
    'off iOS every store call fails closed',
  );
  await assertThrowsCode(
    () => web.requestPurchase({ sku, accountBinding: binding }),
    'STOREKIT_IOS_REQUIRED',
    'off iOS a purchase never opens',
  );
  web.addListener('purchaseUpdated', () => undefined);
  assertEqual(plugin.listenerCount, 0, 'off iOS no native listener is attached');
}

// Error codes: every StoreKit code normalizes per the RFC "Errors" table.
{
  const expected: Record<string, string> = {
    STOREKIT_PURCHASE_UNCERTAIN: 'OUTCOME_UNKNOWN',
    STOREKIT_UNKNOWN_RESULT: 'OUTCOME_UNKNOWN',
    STOREKIT_UNAVAILABLE: 'STORE_UNAVAILABLE',
    STOREKIT_IOS_REQUIRED: 'STORE_UNAVAILABLE',
    STOREKIT_PRODUCT_LOOKUP_FAILED: 'STORE_UNAVAILABLE',
    STOREKIT_SYNC_FAILED: 'STORE_UNAVAILABLE',
    STOREKIT_PRODUCT_UNKNOWN: 'ITEM_UNAVAILABLE',
    STOREKIT_PRODUCT_UNAVAILABLE: 'ITEM_UNAVAILABLE',
    STOREKIT_CONFIGURATION_ERROR: 'CONFIGURATION_REQUIRED',
    STOREKIT_INVALID_PRODUCTS: 'CONFIGURATION_REQUIRED',
    STOREKIT_INVALID_PURCHASE: 'CONFIGURATION_REQUIRED',
    STOREKIT_FINISH_REQUIRES_GRANT: 'CONFIGURATION_REQUIRED',
    STOREKIT_EVIDENCE_INVALID: 'INVALID_RESPONSE',
    STOREKIT_TRANSACTION_UNVERIFIED: 'INVALID_RESPONSE',
  };
  assertEqual(
    Object.keys(storeKitStoreSdkErrorCodeMap).sort(),
    Object.keys(expected).sort(),
    'the StoreKit table covers every plugin code',
  );
  for (const [storeCode, code] of Object.entries(expected)) {
    const info = normalizeStoreSdkError({ code: storeCode }, capacitorStoreKitErrorCodeMap)
      .toCommerceErrorInfo();
    assertEqual([info.code, info.storeCode], [code, storeCode], `${storeCode} normalizes`);
  }
  assertEqual(
    normalizeStoreSdkError({ code: 'PLAY_BILLING_TIMEOUT' }, capacitorStoreKitErrorCodeMap).code,
    'OUTCOME_UNKNOWN',
    'the merged table keeps the defaults',
  );
}

// Helpers.
{
  assertEqual(readAppAccountToken(binding), fakeAccountToken, 'the token is lowercased');
  assertEqual(
    isValidStoreKitTransaction(fakeTransaction({ transactionId: 'tx-1' })),
    true,
    'a vector-style id is an acceptable shape; the native side owns the UInt64 format',
  );
  assertEqual(
    isValidStoreKitTransaction({ ...fakeTransaction({ transactionId: '1' }), unfinished: 'yes' }),
    false,
    'a non-boolean unfinished flag is rejected',
  );
  const { appAccountToken, ...unbound } = fakeTransaction({ transactionId: '1' });
  assertEqual(appAccountToken, fakeAccountToken, 'the fixture binds the fake account');
  assertEqual(
    toSdkPurchase(unbound).accountBinding,
    undefined,
    'a transaction without an app account token carries no binding',
  );
}

console.info('StoreKit StoreSdk mapping passed.');
