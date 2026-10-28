import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { PlatformPurchasePresentationEvent } from '@mpgd/platform';
import {
  createCommerceReconciler,
  createInMemoryMonetizationOperationStore,
} from '@mpgd/game-services';

import {
  assertEqual,
  assertThrowsCode,
  createFakeStoreKitPlugin,
  fakeAccountToken,
  fakeProduct,
  fakeTransaction,
} from '../test/fake-storekit-plugin.js';
import {
  createCapacitorStoreKitCommerceProvider,
  createCapacitorStoreKitServiceProvider,
} from './commerce-provider.js';
import { resolveStoreKitNativePurchasePresentation } from './purchase-presentation.js';
import {
  createCapacitorStoreKitStoreSdk,
  storeKitPresentationUnsupportedCode,
  type StoreKitSdkPurchasePresentationEvent,
} from './store-sdk.js';

const accountBinding = { kind: 'app-account-token', value: fakeAccountToken } as const;
const sku = 'com.example.game.coins100';

function createSdk(
  options: Parameters<typeof createFakeStoreKitPlugin>[0] = {},
  purchasePresentation?: boolean,
) {
  const plugin = createFakeStoreKitPlugin({ products: [fakeProduct()], ...options });
  const sdk = createCapacitorStoreKitStoreSdk({
    sdk: plugin,
    isIos: () => true,
    products: [{ sku, kind: 'consumable' }],
    getAppAccountToken: () => fakeAccountToken,
    ...(purchasePresentation === undefined ? {} : { purchasePresentation }),
  });
  const facts: string[] = [];
  const unsubscribe = sdk.purchasePresentation?.subscribe(
    (event: StoreKitSdkPurchasePresentationEvent) => {
      facts.push(`${event.presentationId}:${event.state}`);
    },
  );
  return { plugin, sdk, facts, unsubscribe };
}

// The SDK declares facts, asks the native plugin once, and reports open then
// closed around `Product.purchase()`.
{
  const { plugin, sdk, facts } = createSdk();
  assertEqual(sdk.purchasePresentation !== undefined, true, 'the SDK declares sheet facts');
  assertEqual(plugin.presentationListenerCount, 1, 'the native fact listener attaches');
  await sdk.requestPurchase({ sku, accountBinding, presentationId: 'p-1' });
  plugin.queuePurchase({
    status: 'purchased',
    transaction: fakeTransaction({ transactionId: '1001' }),
  });
  await sdk.requestPurchase({ sku, accountBinding, presentationId: 'p-2' });
  assertEqual(plugin.presentationSupportCalls, 1, 'support is asked once');
  assertEqual(plugin.presentationIds, ['p-1', 'p-2'], 'each purchase call carries its id');
  assertEqual(
    facts,
    ['p-1:open', 'p-1:closed', 'p-2:open', 'p-2:closed'],
    'open then closed per call',
  );
}

// Ask to Buy: the sheet is done when `Product.purchase()` returned pending.
{
  const { plugin, sdk, facts } = createSdk();
  plugin.queuePurchase({ status: 'pending' });
  const result = await sdk.requestPurchase({ sku, accountBinding, presentationId: 'p-1' });
  assertEqual(result, { outcome: 'launched' }, 'Ask to Buy stays launched');
  assertEqual(facts, ['p-1:open', 'p-1:closed'], 'and its sheet is closed');
}

// With an adapter from before the shared helper, the SDK declares no facts.
{
  const plugin = createFakeStoreKitPlugin({ products: [fakeProduct()] });
  assertEqual(
    resolveStoreKitNativePurchasePresentation(plugin, {}),
    undefined,
    'an old adapter gives no helper',
  );
  assertEqual(
    resolveStoreKitNativePurchasePresentation(plugin) !== undefined,
    true,
    'this adapter gives one',
  );
}

// A `requested` answer is reported `unknown`, never an invented `open`.
{
  const { plugin, sdk, facts } = createSdk();
  plugin.queuePurchase({
    throws: Object.assign(new Error('uncertain'), {
      code: 'STOREKIT_PURCHASE_UNCERTAIN',
      data: { presentation: 'requested' },
    }),
  });
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding, presentationId: 'p-9' }),
    'STOREKIT_PURCHASE_UNCERTAIN',
    'the rejection reaches the provider',
  );
  assertEqual(facts, ['p-9:unknown'], 'requested is unknown');
  plugin.present({ presentationId: 'p-9', state: 'closed' });
  assertEqual(facts, ['p-9:unknown', 'p-9:closed'], 'the native verdict ends it');
}

// A rejection carries the sheet state in its data.
{
  const { plugin, sdk, facts } = createSdk();
  plugin.queuePurchase({
    throws: Object.assign(new Error('unavailable'), {
      code: 'STOREKIT_PRODUCT_UNAVAILABLE',
      data: { presentation: 'not-started' },
    }),
  });
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding, presentationId: 'p-1' }),
    'STOREKIT_PRODUCT_UNAVAILABLE',
    'the rejection reaches the provider',
  );
  assertEqual(facts, ['p-1:not-started'], 'a refused sheet is not-started');
  // A late native fact for the ended call changes nothing.
  plugin.present({ presentationId: 'p-1', state: 'open' });
  assertEqual(facts, ['p-1:not-started'], 'facts end with the terminal one');
}

// A native build without facts sells nothing that would wait for them; recovery still reads.
for (const presentationSupport of ['unimplemented', 'absent'] as const) {
  const { plugin, sdk, facts } = createSdk({ presentationSupport });
  await assertThrowsCode(
    () => sdk.requestPurchase({ sku, accountBinding, presentationId: 'p-1' }),
    storeKitPresentationUnsupportedCode,
    `a ${presentationSupport} support check refuses the purchase`,
  );
  assertEqual(
    plugin.calls.filter((call) => call.startsWith('purchase:')),
    [],
    'no sheet opens',
  );
  assertEqual(facts, [], 'no fact for a call the SDK refused');
  plugin.upsert(fakeTransaction({ transactionId: '2001', unfinished: true }));
  assertEqual((await sdk.getAvailablePurchases({})).length, 1, 'recovery is unaffected');
}

// Over a stale native build, the store needs a rebuild only for an adapter that follows the facts.
{
  const followed = createSdk({ presentationSupport: 'unimplemented' });
  assertEqual(
    await followed.sdk.getAvailability?.(),
    'configuration-required',
    'a followed SDK reports a rebuild',
  );
  followed.unsubscribe?.();
  assertEqual(
    await followed.sdk.getAvailability?.(),
    'available',
    'an unfollowed SDK stays available',
  );
  assertEqual(
    await createSdk().sdk.getAvailability?.(),
    'available',
    'a current native build is available',
  );
}

// An adapter from before facts sends no id: no support check, no facts. Turned off: no declaration.
{
  const { plugin, sdk, facts } = createSdk();
  await sdk.requestPurchase({ sku, accountBinding });
  assertEqual(plugin.presentationSupportCalls, 0, 'no support check without an id');
  assertEqual(plugin.presentationIds, [undefined], 'no id is sent');
  assertEqual(facts, [], 'no facts');
  const off = createSdk({}, false);
  assertEqual(off.sdk.purchasePresentation, undefined, 'turned off, the SDK declares no facts');
  await off.sdk.requestPurchase({ sku, accountBinding, presentationId: 'p-1' });
  assertEqual(off.plugin.presentationIds, [undefined], 'and ignores an id');
}

// The commerce provider and the gateway expose the facts by idempotency key.
{
  const plugin = createFakeStoreKitPlugin({ products: [fakeProduct()] });
  const provider = createCapacitorStoreKitCommerceProvider({
    sdk: plugin,
    isIos: () => true,
    products: [{ logicalId: 'COINS_100', storeSku: sku, kind: 'consumable' }],
    getAppAccountToken: () => fakeAccountToken,
  });
  const facts: PlatformPurchasePresentationEvent[] = [];
  provider.presentation?.subscribe((event) => facts.push(event));
  await provider.requestPurchase({
    logicalId: 'COINS_100',
    idempotencyKey: 'op-1',
    source: 'shop',
  });
  assertEqual(
    facts.map((fact) => [fact.idempotencyKey, fact.state]),
    [
      ['op-1', 'open'],
      ['op-1', 'closed'],
    ],
    'the provider keys facts by idempotency key',
  );
  const off = createCapacitorStoreKitCommerceProvider({
    sdk: createFakeStoreKitPlugin({ products: [fakeProduct()] }),
    isIos: () => true,
    products: [{ logicalId: 'COINS_100', storeSku: sku, kind: 'consumable' }],
    getAppAccountToken: () => fakeAccountToken,
    purchasePresentation: false,
  });
  assertEqual(off.presentation, undefined, 'turned off, the provider has no presentation');

  const base = {
    async request(request: BridgeRequest): Promise<BridgeResponse> {
      return { id: request.id, ok: true, data: null };
    },
  };
  const gateway = createCapacitorPlatformGateway({
    target: 'ios',
    appVersion: '1',
    buildId: 'presentation',
    bridge: base,
    providers: [
      createCapacitorStoreKitServiceProvider({
        sdk: createFakeStoreKitPlugin({ products: [fakeProduct()] }),
        isIos: () => true,
        products: [{ logicalId: 'COINS_100', storeSku: sku, kind: 'consumable' }],
        getAppAccountToken: () => fakeAccountToken,
      }),
    ],
    visibility: null,
  });
  assertEqual(
    gateway.commerce?.presentation !== undefined,
    true,
    'the gateway offers presentation',
  );
  await gateway.lifecycle.dispose?.();
}

// A retryable refusal before the sheet stays retryable under the same key.
{
  const plugin = createFakeStoreKitPlugin({ products: [fakeProduct()] });
  let gateUp = false;
  let asked = 0;
  const provider = createCapacitorStoreKitCommerceProvider({
    sdk: plugin,
    isIos: () => true,
    products: [{ logicalId: 'COINS_100', storeSku: sku, kind: 'consumable' }],
    getAppAccountToken: () => fakeAccountToken,
    purchaseGate: async () => {
      asked += 1;
      if (!gateUp) {
        throw new Error('sales flag unreachable');
      }
      return { allowed: true };
    },
  });
  const reconciler = createCommerceReconciler({
    provider,
    backend: {
      async verifyPurchase() {
        return { verified: false, alreadyProcessed: false, reason: 'not used' };
      },
    },
    store: createInMemoryMonetizationOperationStore(),
    playerId: 'player-1',
    target: 'ios',
    products: [{ logicalId: 'COINS_100', kind: 'consumable', storeSku: sku }],
  });
  await reconciler.start();
  const request = { logicalId: 'COINS_100', idempotencyKey: 'op-gate', source: 'shop' } as const;
  const refused = await reconciler.requestPurchase(request);
  assertEqual(refused.outcome, 'failed', 'the gate failure answers failed');
  assertEqual(
    (await reconciler.read('op-gate'))?.state,
    'requested',
    'and keeps the key retryable',
  );
  gateUp = true;
  plugin.queuePurchase({ status: 'cancelled' });
  const retried = await reconciler.requestPurchase(request);
  assertEqual(retried.outcome, 'cancelled', 'the same key opens the sheet once the gate answers');
  assertEqual(asked, 2, 'the gate is asked again');
  await reconciler.stop();
}
