import { describe, expect, it, vi } from 'vitest';

import * as adapterCapacitor from '@mpgd/adapter-capacitor';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
  fakePlayPurchase,
} from '../test/play-billing-plugin-fixture.js';
import { createCapacitorPlayBillingCommerceProvider } from './commerce-provider.js';
import type { CommerceProvider } from '@mpgd/platform/commerce';

import {
  adapterSupportsPurchaseGate,
  refuseNewPurchasesUnlessGated,
  resolvePurchaseGateSupport,
} from './purchase-gate-support.js';

// An adapter from before the purchase gate: the same module whose gate
// exports read as missing (a real ESM namespace answers `undefined`; the
// vitest mock proxy throws on an absent key, so they are set to undefined).
vi.mock('@mpgd/adapter-capacitor', async (importOriginal) => ({
  ...await importOriginal<typeof import('@mpgd/adapter-capacitor')>(),
  purchasesPausedStoreCode: undefined,
  purchaseGateFailedStoreCode: undefined,
}));

describe('purchase gate on an adapter without gate support', () => {
  it('detects the missing gate support', () => {
    expect(adapterSupportsPurchaseGate()).toBe(false);
    expect(adapterSupportsPurchaseGate(adapterCapacitor)).toBe(false);
    expect(adapterSupportsPurchaseGate({ purchasesPausedStoreCode: 'PURCHASES_PAUSED' })).toBe(true);
    const gate = () => ({ allowed: true }) as const;
    expect(resolvePurchaseGateSupport(undefined, false)).toEqual({ refuseNewPurchases: false });
    expect(resolvePurchaseGateSupport(gate, true)).toEqual({ purchaseGate: gate, refuseNewPurchases: false });
    expect(resolvePurchaseGateSupport(gate, false)).toEqual({ refuseNewPurchases: true });
  });

  it('refuses every new purchase instead of selling, and keeps recovery', async () => {
    const plugin = createFakePlayBillingPlugin({
      products: [fakePlayProduct({ productId: 'gems.small' })],
    });
    plugin.upsert(fakePlayPurchase({ products: ['gems.small'], purchaseToken: 'paid', orderId: 'GPA.p' }));
    const gate = vi.fn(() => ({ allowed: true }) as const);
    const provider = createCapacitorPlayBillingCommerceProvider({
      plugin,
      isAndroid: () => true,
      products: [{ logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' }],
      accountBinding: () => ({ kind: 'obfuscated-account-id', value: 'player-hash-1' }),
      purchaseGate: gate,
    });
    await expect(provider.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: 'PURCHASE_GATE_UNSUPPORTED', retryable: false },
    });
    expect(plugin.purchaseCalls).toEqual([]);
    expect(gate).not.toHaveBeenCalled();
    expect((await provider.getAvailablePurchases()).map((purchase) => purchase.token)).toEqual(['paid']);

    // Without a gate nothing changes.
    plugin.queuePurchase({ status: 'cancelled' });
    const ungated = createCapacitorPlayBillingCommerceProvider({
      plugin,
      isAndroid: () => true,
      products: [{ logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' }],
      accountBinding: () => ({ kind: 'obfuscated-account-id', value: 'player-hash-1' }),
    });
    await expect(ungated.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-2', source: 'shop',
    })).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(plugin.purchaseCalls).toHaveLength(1);
  });

  it('answers at the plugin boundary, never reaching an old adapter that would throw', async () => {
    // An adapter from before the gate throws a binding refusal and drops its
    // store code over the bridge; the plugin must not depend on it at all.
    const requestPurchase = vi.fn(async () => {
      throw new Error('an old adapter must not be asked to open the store');
    });
    const getAvailablePurchases = vi.fn(async () => []);
    const old = { requestPurchase, getAvailablePurchases } as unknown as CommerceProvider;
    const guarded = refuseNewPurchasesUnlessGated(old, { refuseNewPurchases: true });
    await expect(guarded.requestPurchase({
      logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop',
    })).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: 'PURCHASE_GATE_UNSUPPORTED', retryable: false },
    });
    expect(requestPurchase).not.toHaveBeenCalled();
    await guarded.getAvailablePurchases();
    expect(getAvailablePurchases).toHaveBeenCalledTimes(1);
    const untouched = { requestPurchase } as unknown as CommerceProvider;
    expect(refuseNewPurchasesUnlessGated(untouched, { refuseNewPurchases: false }).requestPurchase)
      .toBe(requestPurchase);
  });
});
