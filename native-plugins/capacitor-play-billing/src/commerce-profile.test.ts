import { describe, expect, it } from 'vitest';

import type { PlatformProviderAvailability } from '@mpgd/platform';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
} from '../test/play-billing-plugin-fixture.js';
import {
  createPlayBillingCommerceCapabilities,
  googlePlayProductPurchaseEvidenceSchema,
  googlePlayStoreId,
  playBillingCommerceAuthority,
  playBillingStoreSdkCapabilities,
} from './commerce-profile.js';
import * as commerceProvider from './commerce-provider.js';
import * as index from './index.js';
import * as storeSdk from './store-sdk.js';

const products = [{ logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' as const }];

function providerFor(availability: PlatformProviderAvailability) {
  const sellsNothing = availability === 'configuration-required';
  const plugin = createFakePlayBillingPlugin({
    products: sellsNothing ? [] : [fakePlayProduct({ productId: 'gems.small' })],
    ...(availability === 'temporarily-unavailable'
      ? { failure: () => new Error('Play services are not reachable.') }
      : {}),
  });
  return commerceProvider.createCapacitorPlayBillingCommerceProvider({
    plugin,
    isAndroid: () => availability !== 'unsupported',
    products,
    accountBinding: () => ({ kind: 'obfuscated-account-id', value: 'player-hash-1' }),
  });
}

describe('Play Billing commerce profile', () => {
  it.each([
    'available',
    'configuration-required',
    'temporarily-unavailable',
    'unsupported',
  ] as const)('equals what the provider declares while the store is %s', async (availability) => {
    const provider = providerFor(availability);
    const declared = await provider.getCapabilities();
    expect(declared.availability).toBe(availability);
    expect(createPlayBillingCommerceCapabilities(availability)).toEqual(declared);
  });

  it('declares the RFC google-play profile for any availability', () => {
    expect(createPlayBillingCommerceCapabilities('action-required')).toEqual({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      catalog: { products: true, offers: true, localizedPrice: true },
      lifecycle: {
        availablePurchases: true,
        pending: true,
        restore: false,
        events: true,
        finish: 'server',
      },
      authority: { evidence: 'client-token', accountBinding: 'required' },
      availability: 'action-required',
    });
  });

  it('returns a fresh block on every call and never exposes a shared constant', () => {
    const first = createPlayBillingCommerceCapabilities('available');
    const second = createPlayBillingCommerceCapabilities('available');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    for (const key of ['purchase', 'catalog', 'lifecycle', 'authority'] as const) {
      expect(first[key]).not.toBe(second[key]);
    }
    expect(first.purchase).not.toBe(playBillingStoreSdkCapabilities.purchase);
    expect(first.authority).not.toBe(playBillingCommerceAuthority);
  });

  it('keeps the moved constants exported from their original modules', () => {
    expect(storeSdk.googlePlayStoreId).toBe(googlePlayStoreId);
    expect(storeSdk.playBillingStoreSdkCapabilities).toBe(playBillingStoreSdkCapabilities);
    expect(commerceProvider.playBillingCommerceAuthority).toBe(playBillingCommerceAuthority);
    expect(commerceProvider.googlePlayProductPurchaseEvidenceSchema)
      .toBe(googlePlayProductPurchaseEvidenceSchema);
    expect(index.googlePlayStoreId).toBe(googlePlayStoreId);
    expect(index.playBillingCommerceAuthority).toBe(playBillingCommerceAuthority);
    expect(index.createPlayBillingCommerceCapabilities).toBe(createPlayBillingCommerceCapabilities);
  });
});
