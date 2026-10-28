import { describe, expect, it } from 'vitest';

import type { PlatformPurchasePresentationEvent } from '@mpgd/platform';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
  fakePlayPurchase,
  type FakePlayBillingPluginOptions,
} from '../test/play-billing-plugin-fixture.js';
import { createCapacitorPlayBillingCommerceProvider } from './commerce-provider.js';
import {
  createCapacitorPlayBillingStoreSdk,
  playBillingPresentationUnsupportedCode,
  type PlayBillingSdkPurchasePresentationEvent,
} from './store-sdk.js';

const binding = { kind: 'obfuscated-account-id', value: 'player-hash-1' } as const;

function createPlugin(options: FakePlayBillingPluginOptions = {}) {
  return createFakePlayBillingPlugin({
    products: [fakePlayProduct({ productId: 'gems.small' })],
    ...options,
  });
}

function createSdk(plugin = createPlugin(), purchasePresentation?: boolean) {
  const sdk = createCapacitorPlayBillingStoreSdk({
    plugin,
    isAndroid: () => true,
    products: [{ sku: 'gems.small', kind: 'consumable' }],
    ...(purchasePresentation === undefined ? {} : { purchasePresentation }),
  });
  const facts: string[] = [];
  const unsubscribe = sdk.purchasePresentation?.subscribe(
    (event: PlayBillingSdkPurchasePresentationEvent) => {
      facts.push(
        `${event.presentationId}:${event.state}${event.reason === undefined ? '' : `:${event.reason}`}`,
      );
    },
  );
  return { sdk, plugin, facts, unsubscribe };
}

describe('Play Billing sheet facts (SDK)', () => {
  it('declares facts by default and asks the native plugin once before the first sheet', async () => {
    const { sdk, plugin, facts } = createSdk();
    expect(sdk.purchasePresentation).toBeDefined();
    expect(plugin.presentationListenerCount).toBe(1);
    await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-1' });
    await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-2' });
    expect(plugin.presentationSupportCalls).toBe(1);
    expect(plugin.purchaseCalls.map((call) => call.presentationId)).toEqual(['p-1', 'p-2']);
    // The native event opened each sheet; the answer said it closed.
    expect(facts).toEqual(['p-1:open', 'p-1:closed', 'p-2:open', 'p-2:closed']);
  });

  it('keeps a sheet open past the answer until the native closed event', async () => {
    const { sdk, plugin, facts } = createSdk();
    plugin.queuePurchase({ status: 'pending', purchase: fakePlayPurchase({ purchaseToken: 't', purchaseState: 'pending' }), presentation: 'open' });
    await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-1' }))
      .resolves.toEqual({ outcome: 'launched' });
    expect(facts).toEqual(['p-1:open']);
    // Another call's fact and a repeated open change nothing.
    plugin.present({ presentationId: 'other', state: 'closed' });
    plugin.present({ presentationId: 'p-1', state: 'open' });
    expect(facts).toEqual(['p-1:open']);
    plugin.present({ presentationId: 'p-1', state: 'closed', reason: 'interrupted' });
    plugin.present({ presentationId: 'p-1', state: 'closed' });
    expect(facts).toEqual(['p-1:open', 'p-1:closed:interrupted']);
  });

  it('treats a requested answer (the call timed out first) as an open sheet', async () => {
    const { sdk, plugin, facts } = createSdk();
    plugin.queuePurchase({
      throws: Object.assign(new Error('timed out'), {
        code: 'PLAY_BILLING_TIMEOUT',
        data: { presentation: 'requested' },
      }),
    });
    await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-1' }))
      .resolves.toMatchObject({ outcome: 'failed', error: { code: 'PLAY_BILLING_TIMEOUT' } });
    expect(facts).toEqual(['p-1:open']);
    plugin.present({ presentationId: 'p-1', state: 'not-started' });
    expect(facts).toEqual(['p-1:open', 'p-1:not-started']);
  });

  it('reports not-started from a rejection that carries it', async () => {
    const { sdk, plugin, facts } = createSdk();
    plugin.queuePurchase({
      throws: Object.assign(new Error('busy'), {
        code: 'PLAY_BILLING_BUSY',
        data: { presentation: 'not-started' },
      }),
    });
    await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-1' });
    expect(facts).toEqual(['p-1:not-started']);
  });

  it('refuses a purchase that needs facts when the native build has none', async () => {
    for (const presentationSupport of ['unimplemented', 'absent'] as const) {
      const { sdk, plugin, facts } = createSdk(createPlugin({ presentationSupport }));
      await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-1' }))
        .rejects.toMatchObject({ code: playBillingPresentationUnsupportedCode, retryable: false });
      expect(plugin.purchaseCalls).toEqual([]);
      expect(facts).toEqual([]);
      // Recovery never asks for facts.
      plugin.upsert(fakePlayPurchase({ purchaseToken: 'paid', orderId: 'GPA.1' }));
      await expect(sdk.getAvailablePurchases({})).resolves.toHaveLength(1);
    }
  });

  it('asks again after a support check that failed for another reason', async () => {
    const plugin = createPlugin();
    let failures = 1;
    const check = plugin.getPresentationSupport?.bind(plugin);
    Object.assign(plugin, {
      async getPresentationSupport() {
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('bridge busy'), { code: 'PLAY_BILLING_ERROR' });
        }
        return check?.();
      },
    });
    const { sdk } = createSdk(plugin);
    await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-1' }))
      .rejects.toMatchObject({ code: playBillingPresentationUnsupportedCode });
    await expect(sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-2' }))
      .resolves.toEqual({ outcome: 'launched' });
  });

  it('runs a purchase without facts for an adapter that sends no presentation id', async () => {
    const { sdk, plugin, facts } = createSdk();
    await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding });
    expect(plugin.presentationSupportCalls).toBe(0);
    expect(plugin.purchaseCalls[0]).not.toHaveProperty('presentationId');
    expect(facts).toEqual([]);
  });

  it('declares no facts when turned off and ignores a presentation id', async () => {
    const { sdk, plugin } = createSdk(createPlugin(), false);
    expect(sdk.purchasePresentation).toBeUndefined();
    await sdk.requestPurchase({ sku: 'gems.small', accountBinding: binding, presentationId: 'p-1' });
    expect(plugin.presentationSupportCalls).toBe(0);
    expect(plugin.purchaseCalls[0]).not.toHaveProperty('presentationId');
  });

  it('detaches the native fact listener with the last subscriber', async () => {
    const { plugin, unsubscribe } = createSdk();
    expect(plugin.presentationListenerCount).toBe(1);
    unsubscribe?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plugin.presentationListenerCount).toBe(0);
  });
});

describe('Play Billing sheet facts (commerce provider)', () => {
  function createProvider(options: FakePlayBillingPluginOptions = {}, purchasePresentation?: boolean) {
    const plugin = createPlugin(options);
    const provider = createCapacitorPlayBillingCommerceProvider({
      plugin,
      isAndroid: () => true,
      products: [{ logicalId: 'gems_small', storeSku: 'gems.small', kind: 'consumable' }],
      accountBinding: () => binding,
      ...(purchasePresentation === undefined ? {} : { purchasePresentation }),
    });
    const facts: PlatformPurchasePresentationEvent[] = [];
    provider.presentation?.subscribe((event) => facts.push(event));
    return { plugin, provider, facts };
  }

  it('offers presentation keyed by idempotency key', async () => {
    const { provider, facts } = createProvider();
    expect(provider.presentation).toBeDefined();
    await provider.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' });
    expect(facts.map((fact) => [fact.idempotencyKey, fact.state])).toEqual([
      ['op-1', 'open'],
      ['op-1', 'closed'],
    ]);
  });

  it('refuses before any sheet, not-started, over a native build without facts', async () => {
    const { plugin, provider, facts } = createProvider({ presentationSupport: 'unimplemented' });
    await expect(provider.requestPurchase({ logicalId: 'gems_small', idempotencyKey: 'op-1', source: 'shop' }))
      .resolves.toMatchObject({
        outcome: 'failed',
        error: { code: 'CONFIGURATION_REQUIRED', storeCode: playBillingPresentationUnsupportedCode, retryable: false },
      });
    expect(facts.map((fact) => fact.state)).toEqual(['not-started']);
    expect(plugin.purchaseCalls).toEqual([]);
  });

  it('keeps the provider without presentation when turned off', () => {
    const { provider } = createProvider({}, false);
    expect(provider.presentation).toBeUndefined();
  });
});
