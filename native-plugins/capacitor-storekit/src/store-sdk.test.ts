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
  type CapacitorStoreKitDiagnostic,
  type CapacitorStoreKitStoreSdkProduct,
} from './store-sdk.js';

const sku = 'com.example.game.coins100';
const removeAdsSku = 'com.example.game.remove_ads';
const binding = { kind: 'app-account-token', value: fakeAccountToken.toUpperCase() } as const;
const catalog: readonly CapacitorStoreKitStoreSdkProduct[] = [
  { sku, kind: 'consumable' },
  { sku: removeAdsSku, kind: 'durable' },
];

function createSdk(input: {
  readonly plugin?: ReturnType<typeof createFakeStoreKitPlugin>;
  readonly isIos?: () => boolean;
  readonly products?: readonly CapacitorStoreKitStoreSdkProduct[];
  readonly getAppAccountToken?: () => string | Promise<string>;
} = {}) {
  const plugin = input.plugin ?? createFakeStoreKitPlugin({
    products: [fakeProduct(), fakeProduct({ productId: removeAdsSku, type: 'non_consumable' })],
  });
  const diagnostics: CapacitorStoreKitDiagnostic[] = [];
  const sdk = createCapacitorStoreKitStoreSdk({
    products: input.products ?? catalog,
    getAppAccountToken: input.getAppAccountToken ?? (() => fakeAccountToken),
    sdk: plugin,
    isIos: input.isIos ?? (() => true),
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });
  return { plugin, sdk, diagnostics };
}

async function settled(): Promise<void> {
  // Native events are filtered after the account token resolves; a macrotask
  // lets every chained admission finish.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
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
  for (const [products, message] of [
    [[{ sku: 'bad sku', kind: 'consumable' }], 'an invalid product id is rejected'],
    [[{ sku, kind: 'subscription' }], 'a non one-time kind is rejected'],
    [
      [
        { sku, kind: 'consumable' },
        { sku, kind: 'durable' },
      ],
      'a duplicate SKU is rejected',
    ],
  ] as const) {
    let threw = false;
    try {
      createCapacitorStoreKitStoreSdk({
        products: products as readonly CapacitorStoreKitStoreSdkProduct[],
        getAppAccountToken: () => fakeAccountToken,
        sdk: createFakeStoreKitPlugin(),
      });
    } catch {
      threw = true;
    }
    assertEqual(threw, true, `${message} at construction`);
  }
}

// fetchProducts maps StoreKit products to SDK products.
{
  const plugin = createFakeStoreKitPlugin({
    products: [
      fakeProduct(),
      fakeProduct({ productId: removeAdsSku, type: 'non_consumable', title: 'No ads' }),
      fakeProduct({ productId: 'com.example.game.unlisted' }),
    ],
  });
  const { sdk } = createSdk({ plugin });
  const products = await sdk.fetchProducts({ skus: [sku, removeAdsSku], type: 'all' });
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
        sku: removeAdsSku,
        kind: 'durable',
        title: 'No ads',
        description: 'Game currency',
        price: { formatted: '$1.00', currencyCode: 'USD' },
      },
    ],
    'consumable and non_consumable map to consumable and durable with the localized price',
  );
  assertEqual(plugin.calls, [`getProducts:${sku},${removeAdsSku}`], 'one lookup');
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

// requestPurchase: account binding, product kind, outcomes, and the JWS token.
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
    [`getProducts:${sku}`, `purchase:${sku}:${fakeAccountToken}`],
    'the product kind is checked once, then the purchase opens with the lowercase UUID token',
  );
  plugin.queuePurchase({ status: 'purchased', transaction });
  await sdk.requestPurchase({ sku, accountBinding: binding });
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('getProducts:')).length,
    1,
    'a product already seen is not looked up again before the next purchase',
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
    transaction: fakeTransaction({ transactionId: '5', type: 'non_consumable' }),
  });
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding: binding }),
    'STOREKIT_EVIDENCE_INVALID',
    'a transaction whose type disagrees with the catalog kind is invalid evidence',
  );
  plugin.queuePurchase({
    status: 'purchased',
    transaction: fakeTransaction({ transactionId: '6', signedTransaction: '' }),
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

// The declared kind is verified before the purchase sheet opens.
{
  const plugin = createFakeStoreKitPlugin({
    products: [fakeProduct({ productId: removeAdsSku, type: 'consumable' })],
  });
  const { sdk } = createSdk({ plugin });
  const mismatch = await assertThrowsCode(
    () => sdk.requestPurchase({ sku: removeAdsSku, accountBinding: binding }),
    'STOREKIT_CONFIGURATION_ERROR',
    'a mapping that declares durable for a store consumable fails before the sheet opens',
  );
  assertEqual(
    normalizeStoreSdkError(mismatch, capacitorStoreKitErrorCodeMap).code,
    'CONFIGURATION_REQUIRED',
    'the kind mismatch normalizes to CONFIGURATION_REQUIRED',
  );
  const missing = await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding: binding }),
    'STOREKIT_PRODUCT_UNAVAILABLE',
    'a configured SKU the store does not sell fails before the sheet opens',
  );
  assertEqual(
    normalizeStoreSdkError(missing, capacitorStoreKitErrorCodeMap).code,
    'ITEM_UNAVAILABLE',
    'a missing store product normalizes to ITEM_UNAVAILABLE',
  );
  const unknown = await assertThrowsCode(
    () => sdk.requestPurchase({ sku: 'com.example.game.retired', accountBinding: binding }),
    'STOREKIT_PRODUCT_UNKNOWN',
    'a SKU outside the catalog fails before the sheet opens',
  );
  assertEqual(
    normalizeStoreSdkError(unknown, capacitorStoreKitErrorCodeMap).code,
    'ITEM_UNAVAILABLE',
    'an unmapped SKU normalizes to ITEM_UNAVAILABLE',
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('purchase:')),
    [],
    'no purchase sheet opened for a mismatched, missing, or unmapped product',
  );
  plugin.productsError = Object.assign(new Error('offline'), {
    code: 'STOREKIT_PRODUCT_LOOKUP_FAILED',
  });
  const fresh = createSdk({ plugin }).sdk;
  await assertThrowsCode(
    () => fresh.requestPurchase({ sku: removeAdsSku, accountBinding: binding }),
    'STOREKIT_PRODUCT_LOOKUP_FAILED',
    'a lookup failure before the sheet keeps its store code',
  );
  plugin.productsError = undefined;
}

// getAvailablePurchases: unfinished only, the active account, the catalog, revoked mapped,
// malformed reported.
{
  const otherAccount = crypto.randomUUID();
  const unfinished = fakeTransaction({ transactionId: '10', unfinished: true });
  const legacy = fakeTransaction({ transactionId: '11' });
  const finishedEntitlement = fakeTransaction({
    transactionId: '12',
    type: 'non_consumable',
    productId: removeAdsSku,
    unfinished: false,
  });
  const finishedConsumable = fakeTransaction({
    transactionId: '19',
    unfinished: false,
  });
  const revoked = fakeTransaction({
    transactionId: '13',
    unfinished: true,
    revokedAt: '2026-07-17T12:00:00Z',
  });
  const malformed = { ...fakeTransaction({ transactionId: '14' }), signedTransaction: '' };
  const retired = fakeTransaction({
    transactionId: '15',
    productId: 'com.example.game.retired',
    unfinished: true,
  });
  const previousPlayer = fakeTransaction({
    transactionId: '16',
    appAccountToken: otherAccount,
    unfinished: true,
  });
  const unbound = {
    transactionId: '17',
    originalTransactionId: '17',
    productId: sku,
    type: 'consumable',
    purchasedAt: '2026-07-16T12:00:00Z',
    signedTransaction: 'header.payload.signature-17',
    unfinished: true,
  } as const;
  const wrongKind = fakeTransaction({
    transactionId: '18',
    productId: removeAdsSku,
    type: 'consumable',
    unfinished: true,
  });
  const plugin = createFakeStoreKitPlugin({
    transactions: [
      unfinished,
      legacy,
      finishedEntitlement,
      revoked,
      malformed,
      unfinished,
      retired,
      previousPlayer,
      unbound,
      wrongKind,
      finishedConsumable,
    ],
  });
  const { sdk, diagnostics } = createSdk({ plugin });
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
      ['12', 'purchased', finishedEntitlement.signedTransaction],
      ['13', 'revoked', revoked.signedTransaction],
    ],
    'unfinished transactions and a finished durable of the active account and catalog are listed once with the JWS; '
      + "a finished consumable, a retired SKU, another player's or an unbound transaction, "
      + 'and a kind mismatch are not; revokedAt maps to state revoked',
  );
  assertEqual(
    purchases.find((purchase) => purchase.transactionId === '12')?.raw,
    { type: 'non_consumable', unfinished: false },
    'a finished durable keeps unfinished:false so the reconciler can still verify it',
  );
  assertEqual(
    purchases.find((purchase) => purchase.transactionId === '13')?.raw,
    { type: 'consumable', revokedAt: '2026-07-17T12:00:00Z', unfinished: true },
    'raw keeps the native type, revocation, and flag for diagnostics',
  );
  assertEqual(
    events.map((event) => event.type === 'purchaseError' ? [event.sku, event.error.code] : []),
    [[sku, 'STOREKIT_EVIDENCE_INVALID']],
    'one malformed transaction is reported as a purchaseError and never blocks its siblings',
  );
  assertEqual(
    diagnostics,
    [
      { type: 'unmapped-sku', sku: 'com.example.game.retired', transactionId: '15' },
      { type: 'account-mismatch', sku, transactionId: '16', appAccountToken: otherAccount },
      { type: 'account-mismatch', sku, transactionId: '17' },
      {
        type: 'kind-mismatch',
        sku: removeAdsSku,
        transactionId: '18',
        expected: 'durable',
        reported: 'consumable',
      },
    ],
    'excluded transactions are surfaced as diagnostics, never as purchases',
  );

  // Account switch: the previous player's purchase waits for that player.
  const switched = createSdk({ plugin, getAppAccountToken: () => otherAccount });
  assertEqual(
    (await switched.sdk.getAvailablePurchases({})).map((purchase) => purchase.transactionId),
    ['16'],
    'after an account switch only the transactions bound to the new token are listed',
  );
  await assertThrowsCode(
    () => createSdk({
      plugin,
      getAppAccountToken: () => {
        throw new Error('signed out');
      },
    }).sdk.getAvailablePurchases({}),
    'ACCOUNT_BINDING_REQUIRED',
    'without a resolvable account token nothing is listed',
  );
  await assertThrowsCode(
    () => createSdk({ plugin, getAppAccountToken: () => 'nope' }).sdk.getAvailablePurchases({}),
    'STOREKIT_CONFIGURATION_ERROR',
    'a non-UUID account token is a configuration failure',
  );
}

// getAvailablePurchases({ restore: true }): the player's Restore Purchases read also lists
// durables bound to another or no token (a reinstall, a new device); consumables, unmapped
// SKUs, and kind mismatches stay filtered, and recovery reads keep every filter.
{
  const earlierGuest = crypto.randomUUID();
  const ownDurable = fakeTransaction({
    transactionId: '40',
    type: 'non_consumable',
    productId: removeAdsSku,
    unfinished: false,
  });
  const earlierDurable = fakeTransaction({
    transactionId: '41',
    type: 'non_consumable',
    productId: removeAdsSku,
    appAccountToken: earlierGuest,
    unfinished: false,
  });
  const unboundDurable = {
    transactionId: '42',
    originalTransactionId: '42',
    productId: removeAdsSku,
    type: 'non_consumable',
    purchasedAt: '2026-07-16T12:00:00Z',
    signedTransaction: 'header.payload.signature-42',
    unfinished: false,
  } as const;
  const earlierConsumable = fakeTransaction({
    transactionId: '43',
    appAccountToken: earlierGuest,
    unfinished: true,
  });
  const earlierRetired = fakeTransaction({
    transactionId: '44',
    type: 'non_consumable',
    productId: 'com.example.game.retired',
    appAccountToken: earlierGuest,
    unfinished: false,
  });
  // The consumable SKU reported as a non-consumable: the catalog kind is
  // consumable, so the token check excludes it before the kind check.
  const earlierConsumableSkuAsDurable = fakeTransaction({
    transactionId: '45',
    type: 'non_consumable',
    productId: sku,
    appAccountToken: earlierGuest,
    unfinished: false,
  });
  // The durable SKU reported as a consumable: never restorable across tokens.
  const earlierWrongKind = fakeTransaction({
    transactionId: '46',
    type: 'consumable',
    productId: removeAdsSku,
    appAccountToken: earlierGuest,
    unfinished: true,
  });
  const plugin = createFakeStoreKitPlugin({
    transactions: [
      ownDurable,
      earlierDurable,
      unboundDurable,
      earlierConsumable,
      earlierRetired,
      earlierConsumableSkuAsDurable,
      earlierWrongKind,
    ],
  });
  const { sdk, diagnostics } = createSdk({ plugin });
  assertEqual(
    (await sdk.getAvailablePurchases({})).map((purchase) => purchase.transactionId),
    ['40'],
    'a recovery read lists only the active token',
  );
  diagnostics.length = 0;
  const restored = await sdk.getAvailablePurchases({ restore: true });
  assertEqual(
    restored.map((purchase) => [purchase.transactionId, purchase.accountBinding?.value]),
    [
      ['40', fakeAccountToken],
      ['41', earlierGuest],
      ['42', undefined],
    ],
    "a restore read adds the durables of an earlier guest's token and of no token, with their own binding",
  );
  assertEqual(
    restored.find((purchase) => purchase.transactionId === '41')?.token,
    earlierDurable.signedTransaction,
    'a restored durable carries its JWS for the backend to verify',
  );
  assertEqual(
    diagnostics,
    [
      { type: 'account-mismatch', sku, transactionId: '43', appAccountToken: earlierGuest },
      { type: 'unmapped-sku', sku: 'com.example.game.retired', transactionId: '44' },
      { type: 'account-mismatch', sku, transactionId: '45', appAccountToken: earlierGuest },
      {
        type: 'account-mismatch',
        sku: removeAdsSku,
        transactionId: '46',
        appAccountToken: earlierGuest,
      },
    ],
    "an earlier guest's consumable (by catalog or by StoreKit type) and an unmapped SKU stay excluded on a restore read",
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
    [
      'getTransactions',
      `finish:20:le-1:${fakeAccountToken}`,
      'getTransactions',
      `finish:20:le-1:${fakeAccountToken}`,
    ],
    'the failed finish and the shared retry each reach native once, with the session token',
  );
  assertEqual(plugin.transactions, [], 'a finished transaction leaves the unfinished list');
  const callsBeforeUnknown = plugin.calls.length;
  plugin.queueFinish({ finished: false });
  assertEqual(
    await finish.call(sdk, { transactionId: '21', isConsumable: false, ledgerEntryId: 'le-2' }),
    { finished: false },
    'an unknown transaction reports unfinished',
  );
  assertEqual(
    plugin.calls.slice(callsBeforeUnknown),
    ['getTransactions'],
    'an unknown transaction never reaches the native finish',
  );

  const otherAccount = crypto.randomUUID();
  const mismatched = createFakeStoreKitPlugin({
    transactions: [
      fakeTransaction({ transactionId: '22', appAccountToken: otherAccount }),
      fakeTransaction({ transactionId: '23', revokedAt: '2026-07-17T12:00:00Z' }),
      {
        transactionId: '24',
        originalTransactionId: '24',
        productId: sku,
        type: 'consumable',
        purchasedAt: '2026-07-16T12:00:00Z',
        signedTransaction: 'header.payload.signature-24',
      },
    ],
  });
  const mismatchedSdk = createSdk({ plugin: mismatched }).sdk;
  const mismatchedFinish = mismatchedSdk.finishTransaction;
  if (mismatchedFinish === undefined) {
    throw new Error('finishTransaction is required for finish: client.');
  }
  for (const transactionId of ['22', '23', '24']) {
    assertEqual(
      await mismatchedFinish.call(mismatchedSdk, {
        transactionId,
        isConsumable: true,
        ledgerEntryId: 'forged-ledger',
      }),
      { finished: false },
      `transaction ${transactionId} is not finished`,
    );
  }
  assertEqual(
    mismatched.calls.filter((call) => call.startsWith('finish:')),
    [],
    'another account, a revoked transaction, and an unbound transaction never reach native finish',
  );

  // A durable StoreKit already finished has nothing left to finish, whatever
  // its token: a restore shared from an earlier guest's purchase ends there.
  // An unfinished one of another token is still never finished.
  const restoredPlugin = createFakeStoreKitPlugin({
    transactions: [
      fakeTransaction({
        transactionId: '25',
        type: 'non_consumable',
        productId: removeAdsSku,
        appAccountToken: otherAccount,
        unfinished: false,
      }),
      fakeTransaction({
        transactionId: '26',
        type: 'non_consumable',
        productId: removeAdsSku,
        appAccountToken: otherAccount,
        unfinished: true,
      }),
      fakeTransaction({
        transactionId: '27',
        type: 'non_consumable',
        productId: removeAdsSku,
        appAccountToken: otherAccount,
        unfinished: false,
        revokedAt: '2026-07-17T12:00:00Z',
      }),
    ],
  });
  const restoredSdk = createSdk({ plugin: restoredPlugin }).sdk;
  const restoredFinish = restoredSdk.finishTransaction;
  if (restoredFinish === undefined) {
    throw new Error('finishTransaction is required for finish: client.');
  }
  assertEqual(
    await Promise.all(['25', '26', '27'].map((transactionId) =>
      restoredFinish.call(restoredSdk, { transactionId, isConsumable: false, ledgerEntryId: 'le-share' }))),
    [{ finished: true }, { finished: false }, { finished: false }],
    'an already finished durable is finished; an unfinished or revoked one of another token is not',
  );
  assertEqual(
    restoredPlugin.calls.filter((call) => call.startsWith('finish:')),
    [],
    'none of them reaches the native finish',
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

// transactionUpdated becomes purchaseUpdated for the active account and catalog only; the
// native listener follows the subscribers of either derived event.
{
  const { plugin, sdk, diagnostics } = createSdk();
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
  await settled();
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
  const otherAccount = crypto.randomUUID();
  plugin.emit(fakeTransaction({ transactionId: '32', appAccountToken: otherAccount }));
  plugin.emit(fakeTransaction({ transactionId: '33', productId: 'com.example.game.retired' }));
  plugin.emit(fakeTransaction({ transactionId: '34', productId: removeAdsSku }));
  plugin.emit(fakeTransaction({ transactionId: '35' }));
  await settled();
  assertEqual(
    errors.map((event) => event.type === 'purchaseError' ? [event.sku, event.error.code] : []),
    [[sku, 'STOREKIT_EVIDENCE_INVALID']],
    'a malformed native event is a purchaseError, never a purchase',
  );
  assertEqual(
    events.slice(2).map((event) =>
      event.type === 'purchaseUpdated' ? event.purchase.transactionId : event.type),
    ['35', '35'],
    'events for another account, a retired SKU, or a kind mismatch never become purchases, '
      + 'and a later valid event still arrives in order',
  );
  assertEqual(
    diagnostics,
    [
      { type: 'account-mismatch', sku, transactionId: '32', appAccountToken: otherAccount },
      { type: 'unmapped-sku', sku: 'com.example.game.retired', transactionId: '33' },
      {
        type: 'kind-mismatch',
        sku: removeAdsSku,
        transactionId: '34',
        expected: 'durable',
        reported: 'consumable',
      },
    ],
    'excluded events are surfaced as diagnostics',
  );
  detachFirst();
  assertEqual(plugin.listenerCount, 1, 'the native listener stays while a subscriber remains');
  detachSecond();
  assertEqual(
    plugin.listenerCount,
    1,
    'the native listener stays while a purchaseError subscriber remains',
  );
}

// A purchaseError-only subscriber attaches the native listener too.
{
  const { plugin, sdk } = createSdk();
  const errors: StoreSdkEvent[] = [];
  const detach = sdk.addListener('purchaseError', (event) => {
    errors.push(event);
  });
  assertEqual(plugin.listenerCount, 1, 'a purchaseError subscriber attaches the native listener');
  plugin.emit({ productId: sku });
  await settled();
  assertEqual(
    errors.map((event) => event.type === 'purchaseError' ? event.error.code : event.type),
    ['STOREKIT_EVIDENCE_INVALID'],
    'a malformed update reaches a purchaseError-only subscriber',
  );
  detach();
  await settled();
  assertEqual(plugin.listenerCount, 0, 'the native listener is removed with the last subscriber');
  assertEqual(
    plugin.calls,
    ['addListener:transactionUpdated', 'removeListener:transactionUpdated'],
    'native attach and detach happen once each',
  );
}

// An event whose account token cannot be resolved is a purchaseError, not a purchase.
{
  const { plugin, sdk } = createSdk({
    getAppAccountToken: () => {
      throw new Error('signed out');
    },
  });
  const seen: StoreSdkEvent[] = [];
  sdk.addListener('purchaseUpdated', (event) => {
    seen.push(event);
  });
  sdk.addListener('purchaseError', (event) => {
    seen.push(event);
  });
  plugin.emit(fakeTransaction({ transactionId: '40' }));
  await settled();
  assertEqual(
    seen.map((event) => event.type === 'purchaseError' ? event.error.code : event.type),
    ['ACCOUNT_BINDING_REQUIRED'],
    'without an account token a native update is reported, never admitted',
  );
}

// Availability probes every configured batch.
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
    await createSdk({
      plugin,
      products: [{ sku: 'com.example.game.missing', kind: 'consumable' }],
    }).sdk.getAvailability?.(),
    'configuration-required',
    'no mapped product is a configuration problem',
  );
  assertEqual(
    await createSdk({ plugin, products: [] }).sdk.getAvailability?.(),
    'configuration-required',
    'no product ids at all is a configuration problem',
  );
  const manyProducts: CapacitorStoreKitStoreSdkProduct[] = Array.from(
    { length: 150 },
    (_, index) => ({ sku: `com.example.game.p${index}`, kind: 'consumable' }),
  );
  manyProducts.push({ sku, kind: 'consumable' });
  const batched = createSdk({ plugin, products: manyProducts });
  const lookupsBefore = plugin.calls.filter((call) => call.startsWith('getProducts:')).length;
  assertEqual(
    await batched.sdk.getAvailability?.(),
    'available',
    'a sellable product after the first 100 SKUs still makes the store available',
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('getProducts:')).length - lookupsBefore,
    2,
    'successive batches are probed until a configured product is found',
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
  plugin.productsError = Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' });
  assertEqual(
    await availability.call(sdk),
    'configuration-required',
    'a shell without the native plugin is a configuration problem',
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
