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
import type { CapacitorStoreKitDiagnostic } from './store-sdk.js';

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
  // Events are admitted after the active account token resolves.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
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
    'finish:2000000123456789:le-1:' + fakeAccountToken,
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
  // Binding failures are failed results, not throws, so the store code
  // survives the bridge.
  const invalidResult = await invalid.requestPurchase({
    logicalId: 'COINS_100',
    idempotencyKey: 'op-6',
    source: 'shop',
  });
  assertEqual(
    invalidResult.outcome === 'failed'
      ? [invalidResult.error.code, invalidResult.error.storeCode]
      : [invalidResult.outcome],
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
  const unavailableResult = await unavailable.requestPurchase({
    logicalId: 'COINS_100',
    idempotencyKey: 'op-7',
    source: 'shop',
  });
  assertEqual(
    unavailableResult.outcome === 'failed'
      ? [unavailableResult.error.code, unavailableResult.error.storeCode]
      : [unavailableResult.outcome],
    ['ACCOUNT_BINDING_REQUIRED', 'STOREKIT_ACCOUNT_LOOKUP_FAILED'],
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
  let error: unknown;
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

// The purchase gate refuses new sales only: recovery, finishing, and restore
// keep the app account token and never ask the gate.
{
  const plugin = createPlugin();
  const paid = fakeTransaction({ transactionId: '2000000123456700', unfinished: true });
  plugin.upsert(paid);
  let open = false;
  const gateCalls: string[] = [];
  const service = createCapacitorStoreKitServiceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    purchaseGate: (request) => {
      gateCalls.push(`${request.store}:${request.logicalId}:${request.storeSku}:${request.kind}`);
      return open ? { allowed: true } : { allowed: false };
    },
    sdk: plugin,
    isIos: () => true,
  });
  const gateway = createCapacitorPlatformGateway({
    target: 'ios',
    appVersion: '1.0.0',
    buildId: 'storekit-gate-test',
    bridge: {
      async request(input: BridgeRequest): Promise<BridgeResponse> {
        throw new Error(`The base bridge must not receive ${input.method}.`);
      },
    },
    providers: [service],
  });
  const commerce = gateway.commerce;
  if (commerce === undefined) {
    throw new Error('The gateway must expose the StoreKit commerce provider.');
  }
  assertEqual(
    await commerce.requestPurchase({ logicalId: 'COINS_100', idempotencyKey: 'op-g1', source: 'shop' }),
    {
      outcome: 'failed',
      error: {
        code: 'ITEM_UNAVAILABLE',
        retryable: false,
        storeCode: 'PURCHASES_PAUSED',
        message: 'New purchases of COINS_100 are paused.',
      },
    },
    'a paused sale is a failed result whose store code survives the bridge',
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('purchase:')),
    [],
    'a paused sale never opens the StoreKit sheet',
  );
  assertEqual(
    (await commerce.getAvailablePurchases()).map((purchase) => purchase.transactionId),
    ['2000000123456700'],
    'a paid, unfinished purchase is still recovered while sales are paused',
  );
  assertEqual(
    await commerce.finishTransaction?.({
      transactionId: '2000000123456700',
      ledgerEntryId: 'le-paused',
      isConsumable: true,
    }),
    { finished: true },
    'a granted purchase still finishes while sales are paused',
  );
  await commerce.restorePurchases?.();
  assertEqual(
    gateCalls,
    ['app-store:COINS_100:com.example.game.coins100:consumable'],
    'only the new purchase asked the gate',
  );
  open = true;
  plugin.queuePurchase({ status: 'cancelled' });
  assertEqual(
    (await commerce.requestPurchase({ logicalId: 'COINS_100', idempotencyKey: 'op-g2', source: 'shop' }))
      .outcome,
    'cancelled',
    'an open gate lets the store sheet open',
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('purchase:')),
    [`purchase:com.example.game.coins100:${fakeAccountToken}`],
    'the sheet opened once the gate allowed it',
  );
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
  assertEqual(service.id, 'apple-storekit', 'the registry id defaults to apple-storekit');
  assertEqual(
    [service.features, service.methods],
    [[], []],
    'the service provider declares no feature and no method; commerce is its capability block',
  );
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
  const commerce = gateway.commerce;
  if (commerce === undefined) {
    throw new Error('The gateway must expose the StoreKit commerce provider.');
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

// Transactions outside the catalog or bound to another account never reach the reconciler.
{
  const plugin = createPlugin();
  const otherAccount = crypto.randomUUID();
  const retired = fakeTransaction({
    transactionId: '2000000123456900',
    productId: 'com.example.game.retired',
    unfinished: true,
  });
  const previousPlayer = fakeTransaction({
    transactionId: '2000000123456901',
    appAccountToken: otherAccount,
    unfinished: true,
  });
  const valid = fakeTransaction({ transactionId: '2000000123456902', unfinished: true });
  plugin.upsert(retired);
  plugin.upsert(previousPlayer);
  plugin.upsert(valid);
  const diagnostics: CapacitorStoreKitDiagnostic[] = [];
  const provider = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    sdk: plugin,
    isIos: () => true,
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });
  const events: CommerceEvent[] = [];
  provider.subscribe((event) => {
    events.push(event);
  });
  assertEqual(
    (await provider.getAvailablePurchases()).map((purchase) => [
      purchase.transactionId,
      purchase.logicalId,
    ]),
    [['2000000123456902', 'COINS_100']],
    "a retired SKU and another player's transaction do not block the valid sibling, "
      + 'and every listed purchase resolves to a logical id',
  );
  plugin.emit(retired);
  plugin.emit(previousPlayer);
  plugin.emit(valid);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assertEqual(
    events.map((event) =>
      event.type === 'purchaseUpdated'
        ? [event.purchase.transactionId, event.purchase.logicalId]
        : [event.type],
    ),
    [['2000000123456902', 'COINS_100']],
    'the event path applies the same catalog and account filters',
  );
  assertEqual(
    diagnostics.map((diagnostic) => [diagnostic.type, diagnostic.transactionId]),
    [
      ['unmapped-sku', '2000000123456900'],
      ['account-mismatch', '2000000123456901'],
      ['unmapped-sku', '2000000123456900'],
      ['account-mismatch', '2000000123456901'],
    ],
    'excluded transactions are surfaced through onDiagnostic on both paths',
  );
  // Account switch: the previous player's purchase is listed for that player only.
  const switched = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => otherAccount,
    sdk: plugin,
    isIos: () => true,
  });
  assertEqual(
    (await switched.getAvailablePurchases()).map((purchase) => purchase.transactionId),
    ['2000000123456901'],
    'after an account switch the other player sees only their own unfinished purchase',
  );
  provider.dispose();
  switched.dispose();
}

// commerce.v2.finishTransaction is the webview bridge over the same finish gate.
{
  const otherAccount = crypto.randomUUID();
  const plugin = createFakeStoreKitPlugin({
    products: [fakeProduct()],
    transactions: [
      fakeTransaction({ transactionId: '300', appAccountToken: otherAccount }),
      fakeTransaction({ transactionId: '301' }),
    ],
  });
  const service = createCapacitorStoreKitServiceProvider({
    products: [products[0]],
    getAppAccountToken: () => fakeAccountToken,
    sdk: plugin,
    isIos: () => true,
  });
  const request = (transactionId: string): BridgeRequest => ({
    id: `finish-${transactionId}`,
    method: 'commerce.v2.finishTransaction',
    payload: { transactionId, ledgerEntryId: 'le-bridge', isConsumable: true },
    meta: {
      target: 'ios',
      appVersion: '1.0.0',
      buildId: 'storekit-finish-gate',
      sentAt: '2026-07-16T12:00:00.000Z',
    },
  });
  assertEqual(
    await service.bridge.request(request('300')),
    { id: 'finish-300', ok: true, data: { finished: false } },
    'commerce.v2.finishTransaction does not finish another account',
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('finish:')),
    [],
    'a mismatched bridge finish never reaches native',
  );
  assertEqual(
    await service.bridge.request(request('301')),
    { id: 'finish-301', ok: true, data: { finished: true } },
    'commerce.v2.finishTransaction finishes the session binding',
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('finish:')),
    [`finish:301:le-bridge:${fakeAccountToken}`],
    'the bridge finish carries the session app account token, not a caller-supplied one',
  );
}

console.info('StoreKit commerce v2 provider passed.');
