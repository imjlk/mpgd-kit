import type { PlatformProviderAvailability } from '@mpgd/platform';

import {
  assertEqual,
  createFakeStoreKitPlugin,
  fakeAccountToken,
  fakeProduct,
} from '../test/fake-storekit-plugin.js';
import {
  appStoreStoreId,
  createStoreKitCommerceCapabilities,
  storeKitCommerceAuthority,
  storeKitStoreSdkCapabilities,
} from './commerce-profile.js';
import {
  appStoreSignedTransactionEvidenceSchema,
  createCapacitorStoreKitCommerceProvider,
} from './commerce-provider.js';
import * as index from './index.js';
import * as storeSdk from './store-sdk.js';

const storeSku = 'com.example.game.coins100';
const products = [{ logicalId: 'COINS_100', storeSku, kind: 'consumable' }] as const;

function providerFor(availability: PlatformProviderAvailability) {
  const plugin = createFakeStoreKitPlugin({
    products: availability === 'configuration-required' ? [] : [fakeProduct()],
  });
  if (availability === 'temporarily-unavailable') {
    plugin.productsError = new Error('The App Store is not reachable.');
  }
  return createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    sdk: plugin,
    isIos: () => availability !== 'unsupported',
  });
}

// The profile equals what the provider declares for every reachable availability.
for (const availability of [
  'available',
  'configuration-required',
  'temporarily-unavailable',
  'unsupported',
] as const) {
  const provider = providerFor(availability);
  const declared = await provider.getCapabilities();
  assertEqual(declared.availability, availability, `the provider reports ${availability}`);
  assertEqual(
    createStoreKitCommerceCapabilities(availability),
    declared,
    `the profile equals the provider block while the store is ${availability}`,
  );
  provider.dispose();
}

// The RFC app-store profile row, for any availability.
assertEqual(
  createStoreKitCommerceCapabilities('action-required'),
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
    availability: 'action-required',
  },
  'the profile declares the RFC app-store row',
);

// A fresh block on every call; no shared constant escapes.
{
  const first = createStoreKitCommerceCapabilities('available');
  const second = createStoreKitCommerceCapabilities('available');
  assertEqual(first, second, 'two calls agree');
  assertEqual(first === second, false, 'a fresh object per call');
  for (const key of ['purchase', 'catalog', 'lifecycle', 'authority'] as const) {
    assertEqual(first[key] === second[key], false, `a fresh ${key} block per call`);
  }
  assertEqual(
    first.purchase === storeKitStoreSdkCapabilities.purchase,
    false,
    'the SDK purchase declaration is copied',
  );
  assertEqual(
    first.authority === storeKitCommerceAuthority,
    false,
    'the authority declaration is copied',
  );
}

// The moved constants stay exported from their original modules.
assertEqual(
  storeSdk.storeKitStoreSdkCapabilities === storeKitStoreSdkCapabilities,
  true,
  'store-sdk re-exports the SDK capabilities',
);
assertEqual(
  index.storeKitStoreSdkCapabilities === storeKitStoreSdkCapabilities
    && index.appStoreStoreId === appStoreStoreId
    && index.storeKitCommerceAuthority === storeKitCommerceAuthority
    && index.createStoreKitCommerceCapabilities === createStoreKitCommerceCapabilities
    && index.appStoreSignedTransactionEvidenceSchema === appStoreSignedTransactionEvidenceSchema,
  true,
  'the package index exports the profile',
);

console.info('StoreKit commerce profile passed.');
