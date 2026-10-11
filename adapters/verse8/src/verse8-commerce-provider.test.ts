import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProductCatalog } from '@mpgd/catalog';
import { CommerceError, type CommerceEvent } from '@mpgd/platform/commerce';

import { createVerse8Agent8CommerceService, type Verse8Agent8Context } from './agent8.js';
import {
  assertVerse8Agent8EventEvidence,
  createVerse8CommerceCapabilities,
  maximumVerse8ReportedPurchases,
  verse8Agent8EventEvidenceSchema,
  type Verse8RecordedPurchase,
} from './commerce-contract.js';
import {
  createVerse8CommerceProvider,
  verse8CommerceStoreCodes,
  verse8PurchaseFollowUpDelaysMs,
  type Verse8CommerceDialogClosedPayload,
  type Verse8CommerceShopClient,
  type Verse8CommerceShopItem,
} from './commerce-provider.js';
import { createVerse8PlatformGateway } from './index.js';

const products = [
  { id: 'COINS_100', type: 'consumable', platformProductId: 'coins-100' },
  { id: 'REMOVE_ADS', type: 'non_consumable', platformProductId: 'remove-ads' },
] as const;
const request = { logicalId: 'COINS_100', idempotencyKey: 'op-1', source: 'shop' } as const;

function item(input: Partial<Verse8CommerceShopItem> & { readonly productId: string }): Verse8CommerceShopItem {
  return {
    name: input.productId,
    description: `Item ${input.productId}`,
    price: 10,
    purchasable: true,
    purchaseLimitReached: false,
    ...input,
  };
}

function createFixture(input: {
  readonly items?: readonly Verse8CommerceShopItem[];
  readonly recorded?: readonly Verse8RecordedPurchase[];
  readonly refreshError?: unknown;
  readonly buyError?: unknown;
  readonly canOpenShop?: boolean;
  readonly listError?: unknown;
  readonly products?: readonly { id: string; type: 'consumable' | 'non_consumable' | 'subscription'; platformProductId: string }[];
} = {}) {
  const items = [
    ...(input.items ?? [item({ productId: 'coins-100' }), item({ productId: 'remove-ads' })]),
  ];
  const recorded = [...(input.recorded ?? [])];
  const closeListeners = new Set<(payload: Verse8CommerceDialogClosedPayload) => void>();
  const client: Verse8CommerceShopClient = {
    init: vi.fn(),
    getItem: (productId) => items.find((candidate) => candidate.productId === productId),
    getItems: () => [...items],
    buyItem: vi.fn(() => {
      if (input.buyError !== undefined) {
        throw input.buyError;
      }
    }),
    refresh: vi.fn(async () => {
      if (input.refreshError !== undefined) {
        throw input.refreshError;
      }
    }),
    onClose: (callback) => {
      closeListeners.add(callback);
      return () => {
        closeListeners.delete(callback);
      };
    },
  };
  const listPurchases = vi.fn(async () => {
    if (input.listError !== undefined) {
      throw input.listError;
    }
    return [...recorded];
  });
  const provider = createVerse8CommerceProvider({
    products: input.products ?? products,
    client,
    purchases: { listPurchases },
    canOpenShop: () => input.canOpenShop ?? true,
  });
  return {
    provider,
    client,
    recorded,
    listPurchases,
    closeListeners,
    closeDialog: (purchased: boolean) => {
      for (const listener of closeListeners) {
        listener({ purchased });
      }
    },
  };
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

describe('createVerse8CommerceProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares the verse8 profile', async () => {
    const { provider } = createFixture();
    expect(provider.store).toBe('verse8');
    await expect(provider.getCapabilities()).resolves.toEqual(
      createVerse8CommerceCapabilities('available'),
    );
    expect(createVerse8CommerceCapabilities('available')).toMatchObject({
      purchase: { consumable: true, durable: true, subscription: false, quantity: false },
      lifecycle: {
        availablePurchases: false,
        pending: true,
        restore: true,
        events: true,
        finish: 'none',
      },
      authority: { evidence: 'server-push', accountBinding: 'host' },
    });
    const empty = createVerse8CommerceProvider({
      products: [],
      client: createFixture().client,
      purchases: { listPurchases: async () => [] },
    });
    await expect(empty.getCapabilities()).resolves.toMatchObject({
      availability: 'configuration-required',
    });
  });

  it('lists the configured products VXShop offers, priced in VX', async () => {
    const { provider, client } = createFixture({
      items: [item({ productId: 'coins-100', name: '100 Coins', description: 'Coins', price: 5 })],
    });
    await expect(provider.fetchProducts({})).resolves.toEqual([
      {
        logicalId: 'COINS_100',
        store: 'verse8',
        storeSku: 'coins-100',
        kind: 'consumable',
        title: '100 Coins',
        description: 'Coins',
        price: { formatted: '5 VX', currencyCode: 'VX' },
      },
    ]);
    expect(client.init).toHaveBeenCalledWith({ autoRefresh: false });
    await expect(provider.fetchProducts({ type: 'subscription' })).resolves.toEqual([]);
    await expect(provider.fetchProducts({ logicalIds: ['REMOVE_ADS'] })).resolves.toEqual([]);
    const failing = createFixture({ refreshError: new Error('offline') });
    await expect(failing.provider.fetchProducts({})).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
      storeCode: verse8CommerceStoreCodes.shopRefreshFailed,
      retryable: true,
    });
  });

  it('opens the VXShop dialog and answers launched', async () => {
    const { provider, client } = createFixture();
    await expect(provider.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    expect(client.refresh).toHaveBeenCalledTimes(1);
    expect(client.buyItem).toHaveBeenCalledWith('coins-100');
  });

  it('fails before the dialog opens when the item cannot be bought', async () => {
    const outsideIframe = createFixture({ canOpenShop: false });
    await expect(outsideIframe.provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'CONFIGURATION_REQUIRED', storeCode: verse8CommerceStoreCodes.shopUnavailable },
    });
    expect(outsideIframe.client.buyItem).not.toHaveBeenCalled();

    const unlisted = createFixture({ items: [] });
    await expect(unlisted.provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: verse8CommerceStoreCodes.productNotListed },
    });

    const limited = createFixture({
      items: [item({ productId: 'coins-100', purchaseLimitReached: true })],
    });
    await expect(limited.provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: verse8CommerceStoreCodes.purchaseLimitReached },
    });

    const blocked = createFixture({
      items: [item({ productId: 'coins-100', purchasable: false, purchaseBlockReason: 'sold out' })],
    });
    await expect(blocked.provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: {
        code: 'ITEM_UNAVAILABLE',
        storeCode: verse8CommerceStoreCodes.productNotPurchasable,
        message: expect.stringContaining('sold out'),
      },
    });

    const offline = createFixture({ refreshError: { code: 'fixture-unavailable' } });
    await expect(offline.provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'STORE_UNAVAILABLE', storeCode: 'fixture-unavailable', retryable: true },
    });

    const unknown = createFixture();
    await expect(unknown.provider.requestPurchase({ ...request, logicalId: 'NOPE' })).resolves.toMatchObject({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', storeCode: verse8CommerceStoreCodes.productNotConfigured },
    });
    await expect(unknown.provider.requestPurchase({ ...request, quantity: 2 })).rejects.toThrow(
      CommerceError,
    );

    const dialogFailure = createFixture({ buyError: new Error('dialog already open') });
    await expect(dialogFailure.provider.requestPurchase(request)).resolves.toMatchObject({
      outcome: 'failed',
      error: {
        code: 'STORE_UNAVAILABLE',
        storeCode: verse8CommerceStoreCodes.shopDialogFailed,
        retryable: true,
      },
    });

    const subscription = createFixture({
      products: [{ id: 'VIP', type: 'subscription', platformProductId: 'vip' }],
      items: [item({ productId: 'vip' })],
    });
    await expect(subscription.provider.requestPurchase({ ...request, logicalId: 'VIP' })).rejects
      .toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    expect(subscription.client.buyItem).not.toHaveBeenCalled();
  });

  it('lists no available purchases and reports recorded purchases as events', async () => {
    const fixture = createFixture({
      recorded: [
        { purchaseId: '7', productId: 'coins-100', quantity: 1, grantedAt: '2026-10-12T00:00:00.000Z' },
        { purchaseId: '8', productId: 'other-game', quantity: 1 },
        { purchaseId: ' 8 ', productId: 'coins-100', quantity: 1 },
      ],
    });
    await expect(fixture.provider.getAvailablePurchases({ includePending: true })).resolves.toEqual([]);
    await fixture.provider.restorePurchases();
    await fixture.provider.restorePurchases();
    const events: CommerceEvent[] = [];
    const unsubscribe = fixture.provider.subscribe((event) => events.push(event));
    expect(events).toEqual([
      {
        type: 'purchaseUpdated',
        purchase: {
          store: 'verse8',
          transactionId: '7',
          storeSku: 'coins-100',
          logicalId: 'COINS_100',
          quantity: 1,
          state: 'purchased',
          purchasedAt: '2026-10-12T00:00:00.000Z',
          token: '7',
          evidence: {
            schema: verse8Agent8EventEvidenceSchema,
            payload: { purchaseId: '7', productId: 'coins-100', quantity: 1 },
          },
          accountBinding: { kind: 'host-identity' },
        },
      },
    ]);
    expect(fixture.closeListeners.size).toBe(1);

    // The dialog closing after a purchase re-reads the server; closing without one does not.
    fixture.recorded.push({ purchaseId: '9', productId: 'remove-ads', quantity: 1 });
    fixture.closeDialog(false);
    await flush();
    expect(events).toHaveLength(1);
    fixture.closeDialog(true);
    await flush();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ purchase: { transactionId: '9', logicalId: 'REMOVE_ADS' } });

    // The dialog stays observed while nobody listens: a purchase signalled
    // then is buffered for the next listener, since no list could find it.
    unsubscribe();
    expect(fixture.closeListeners.size).toBe(1);
    fixture.recorded.push({ purchaseId: '10', productId: 'coins-100', quantity: 1 });
    fixture.closeDialog(true);
    await flush();
    const late: CommerceEvent[] = [];
    fixture.provider.subscribe((event) => late.push(event));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ purchase: { transactionId: '10' } });
    fixture.provider.dispose();
    expect(fixture.closeListeners.size).toBe(0);
  });

  it('reports the newest recorded purchases within the bound and surfaces an unreadable source', async () => {
    const many = createFixture({
      recorded: Array.from({ length: maximumVerse8ReportedPurchases + 1 }, (_, index) => ({
        purchaseId: String(index),
        productId: 'coins-100',
        quantity: 1,
      })),
    });
    const events: CommerceEvent[] = [];
    many.provider.subscribe((event) => events.push(event));
    await many.provider.restorePurchases();
    expect(events).toHaveLength(maximumVerse8ReportedPurchases);
    // The oldest purchase is the one left out: a reconciler has seen it long ago.
    expect(events.some((event) =>
      event.type === 'purchaseUpdated' && event.purchase.transactionId === '0')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      purchase: { transactionId: String(maximumVerse8ReportedPurchases) },
    });

    const broken = createFixture({ listError: new Error('agent8 down') });
    await expect(broken.provider.restorePurchases()).rejects.toMatchObject({
      code: 'STORE_UNAVAILABLE',
      storeCode: verse8CommerceStoreCodes.purchasesUnavailable,
      retryable: true,
    });
  });

  it('re-reads the server for the first listener, so a restart finds purchases recorded meanwhile', async () => {
    const fixture = createFixture({
      recorded: [{ purchaseId: '3', productId: 'coins-100', quantity: 1 }],
    });
    const events: CommerceEvent[] = [];
    fixture.provider.subscribe((event) => events.push(event));
    await flush();
    expect(events).toHaveLength(1);
    expect(fixture.listPurchases).toHaveBeenCalledTimes(1);
  });

  it('follows a purchase signal nothing was recorded for yet with spaced re-reads', async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const events: CommerceEvent[] = [];
    fixture.provider.subscribe((event) => events.push(event));
    await flush();
    fixture.listPurchases.mockClear();

    // The dialog closed before the Agent8 event landed.
    fixture.closeDialog(true);
    await flush();
    expect(fixture.listPurchases).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    fixture.recorded.push({ purchaseId: '4', productId: 'coins-100', quantity: 1 });
    await vi.advanceTimersByTimeAsync(verse8PurchaseFollowUpDelaysMs[0] ?? 0);
    expect(fixture.listPurchases).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ purchase: { transactionId: '4' } });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.listPurchases).toHaveBeenCalledTimes(verse8PurchaseFollowUpDelaysMs.length + 1);
    expect(events).toHaveLength(1);

    // A signal that reported something schedules nothing, and dispose cancels pending re-reads.
    fixture.recorded.push({ purchaseId: '5', productId: 'coins-100', quantity: 1 });
    fixture.closeDialog(true);
    await flush();
    expect(events).toHaveLength(2);
    fixture.closeDialog(true);
    await flush();
    fixture.provider.dispose();
    const calls = fixture.listPurchases.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.listPurchases).toHaveBeenCalledTimes(calls);
  });

  it('validates verse8.agent8-event.v1 evidence the way a server registry entry must', () => {
    expect(() => assertVerse8Agent8EventEvidence({ schema: 'other', payload: {} })).toThrow(TypeError);
    expect(() => assertVerse8Agent8EventEvidence({
      schema: verse8Agent8EventEvidenceSchema,
      payload: { purchaseId: ' 7', productId: 'coins-100', quantity: 1 },
    })).toThrow(TypeError);
    expect(() => assertVerse8Agent8EventEvidence({
      schema: verse8Agent8EventEvidenceSchema,
      payload: { purchaseId: '7', productId: 'coins-100', quantity: 0 },
    })).toThrow(TypeError);
    expect(() => assertVerse8Agent8EventEvidence({
      schema: verse8Agent8EventEvidenceSchema,
      payload: { purchaseId: '7', productId: '', quantity: 1 },
    })).toThrow(TypeError);
    expect(assertVerse8Agent8EventEvidence({
      schema: verse8Agent8EventEvidenceSchema,
      payload: { purchaseId: '7', productId: 'coins-100', quantity: 2 },
    })).toEqual({ purchaseId: '7', productId: 'coins-100', quantity: 2 });
  });
});

describe('Verse8 gateway commerce v2', () => {
  it('offers commerceV2 and the capability block only with the Agent8 purchase source', async () => {
    const { client } = createFixture();
    const vxShop = {
      purchaseEventAuthority: 'agent8-server' as const,
      products: [{ id: 'COINS_100', type: 'consumable' as const, platformProductId: 'coins-100' }],
      loadEntitlements: async () => [],
      client,
      canOpenShop: () => true,
    };
    const without = createVerse8PlatformGateway({ vxShop });
    expect(without.commerceV2).toBeUndefined();
    await expect(without.getCapabilities()).resolves.toMatchObject({ nativeIap: true });
    expect(await without.getCapabilities()).not.toHaveProperty('commerce');

    const gateway = createVerse8PlatformGateway({
      vxShop: { ...vxShop, purchases: { listPurchases: async () => [] } },
    });
    expect(gateway.commerceV2?.store).toBe('verse8');
    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: true,
      subscriptionIap: false,
      commerce: createVerse8CommerceCapabilities('available'),
    });
    await expect(gateway.commerceV2?.requestPurchase(request)).resolves.toEqual({ outcome: 'launched' });
    expect(client.buyItem).toHaveBeenCalledWith('coins-100');
  });
});

describe('Verse8 Agent8 commerce service purchases', () => {
  const catalog = {
    version: 'test',
    products: [{
      id: 'COINS_100',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: { verse8: 'coins-100' },
    }],
  } satisfies ProductCatalog;

  it('lists the recorded purchases of an account oldest first', async () => {
    let state: Readonly<Record<string, unknown>> = {};
    const context: Verse8Agent8Context = {
      getUserState: async () => state,
      updateUserState: async (_account, next) => {
        state = { ...state, ...next };
        return state;
      },
      lock: async (_key, callback) => callback(),
    };
    const service = createVerse8Agent8CommerceService({
      catalog,
      now: () => '2026-10-12T00:00:00.000Z',
    });
    await expect(service.listPurchases('0xplayer', context)).resolves.toEqual([]);
    await service.handleItemPurchased(
      { account: '0xplayer', purchaseId: 12, productId: 'coins-100', quantity: 1 },
      context,
    );
    await service.handleItemPurchased(
      { account: '0xplayer', purchaseId: 3, productId: 'coins-100', quantity: 2 },
      context,
    );
    await expect(service.listPurchases('0xplayer', context)).resolves.toEqual([
      { purchaseId: '3', productId: 'coins-100', quantity: 2, grantedAt: '2026-10-12T00:00:00.000Z' },
      { purchaseId: '12', productId: 'coins-100', quantity: 1, grantedAt: '2026-10-12T00:00:00.000Z' },
    ]);
  });
});
