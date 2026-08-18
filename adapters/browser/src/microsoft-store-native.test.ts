import { describe, expect, it, vi } from 'vitest';

import { createMicrosoftStoreCommerceAdapter } from './microsoft-store';
import {
  createMicrosoftStoreNativeBridgeClient,
  createMicrosoftStoreNativeCommerceRuntime,
  MicrosoftStoreNativeBridgeError,
  microsoftStoreNativeBridgeProtocol,
  type MicrosoftStoreNativeWebViewMessageEvent,
  type MicrosoftStoreNativeWebViewTransport,
} from './microsoft-store-native';

class FakeWebView implements MicrosoftStoreNativeWebViewTransport {
  readonly messages: unknown[] = [];
  private readonly listeners = new Set<(
    event: MicrosoftStoreNativeWebViewMessageEvent,
  ) => void>();

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  addEventListener(
    _type: 'message',
    listener: (event: MicrosoftStoreNativeWebViewMessageEvent) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'message',
    listener: (event: MicrosoftStoreNativeWebViewMessageEvent) => void,
  ): void {
    this.listeners.delete(listener);
  }

  respond(input: Readonly<Record<string, unknown>>): void {
    for (const listener of this.listeners) {
      listener({ data: { protocol: microsoftStoreNativeBridgeProtocol, ...input } });
    }
  }
}

describe('Microsoft Store native bridge', () => {
  it('requests a bounded User Collections ID without exposing a global host object', async () => {
    const webView = new FakeWebView();
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => 'identity-1',
    });
    const pending = client.getCustomerCollectionsId({
      serviceTicket: 'entra-service-ticket',
      publisherUserId: 'authenticated-player',
    });

    expect(webView.messages).toEqual([{
      protocol: microsoftStoreNativeBridgeProtocol,
      requestId: 'identity-1',
      method: 'identity.getCustomerCollectionsId',
      payload: {
        serviceTicket: 'entra-service-ticket',
        publisherUserId: 'authenticated-player',
      },
    }]);
    webView.respond({
      requestId: 'identity-1',
      method: 'identity.getCustomerCollectionsId',
      ok: true,
      result: { userStoreId: 'store-id-jwt' },
    });

    await expect(pending).resolves.toBe('store-id-jwt');
    client.dispose();
  });

  it('adapts native formatted prices, ownership, and purchase UI to the commerce adapter', async () => {
    const bridge = {
      getDetails: vi.fn(async () => [{
        itemId: 'hint_pack_20',
        title: '20 hints',
        price: { currencyCode: 'KRW', formatted: '₩1,000' },
      }]),
      getCustomerCollectionsId: vi.fn(),
      listPurchases: vi.fn(async () => [{
        itemId: 'hint_pack_20',
        purchaseToken: 'hint_pack_20',
      }]),
      requestPurchase: vi.fn(async () => ({
        status: 'succeeded' as const,
        purchaseToken: 'hint_pack_20',
      })),
      dispose: vi.fn(),
    };
    const runtime = createMicrosoftStoreNativeCommerceRuntime(bridge);
    const service = await runtime.getDigitalGoodsService();

    await expect(service.getDetails(['hint_pack_20'])).resolves.toEqual([{
      itemId: 'hint_pack_20',
      title: '20 hints',
      price: { currency: 'KRW', formatted: '₩1,000' },
    }]);
    await expect(service.listPurchases()).resolves.toEqual([{
      itemId: 'hint_pack_20',
      purchaseToken: 'hint_pack_20',
    }]);
    await expect(runtime.createPaymentRequest([{
      supportedMethods: 'https://store.microsoft.com/billing',
      data: { sku: 'hint_pack_20' },
    }]).show()).resolves.toEqual({ details: { purchaseToken: 'hint_pack_20' } });

    const commerce = createMicrosoftStoreCommerceAdapter({
      products: [{
        info: {
          id: 'HINT_PACK_20',
          type: 'consumable',
          title: '20 hints',
          description: '20 hints',
          price: { formatted: '₩1,000', currencyCode: 'KRW' },
        },
        inAppOfferToken: 'hint_pack_20',
      }],
      authority: {
        async getAvailability() {
          return 'available';
        },
        async claimRecoveryOwnership() {
          return { status: 'unavailable' };
        },
        async hasRecoveryOwnership() {
          return { status: 'unavailable' };
        },
        async verifyAndGrant() {
          return { status: 'pending' };
        },
        async getEntitlements() {
          return [];
        },
      },
      getRecoveryScope: () => 'authenticated-player',
      ...runtime,
    });
    await expect(commerce.getProducts()).resolves.toEqual([{
      id: 'HINT_PACK_20',
      type: 'consumable',
      title: '20 hints',
      description: '20 hints',
      price: { formatted: '₩1,000', currencyCode: 'KRW' },
    }]);
  });

  it('maps a native not-purchased result to cancellation', async () => {
    const runtime = createMicrosoftStoreNativeCommerceRuntime({
      getDetails: vi.fn(),
      getCustomerCollectionsId: vi.fn(),
      listPurchases: vi.fn(),
      requestPurchase: vi.fn(async () => ({ status: 'not-purchased' as const })),
      dispose: vi.fn(),
    });

    await expect(runtime.createPaymentRequest([{
      supportedMethods: 'https://store.microsoft.com/billing',
      data: { sku: 'hint_pack_20' },
    }]).show()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores unrelated responses and rejects all pending work when disposed', async () => {
    const webView = new FakeWebView();
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => 'catalog-1',
    });
    const pending = client.getDetails(['hint_pack_20']);
    webView.respond({
      requestId: 'different',
      method: 'catalog.getDetails',
      ok: true,
      result: { items: [] },
    });
    client.dispose();

    await expect(pending).rejects.toMatchObject({
      code: 'BRIDGE_DISPOSED',
    } satisfies Partial<MicrosoftStoreNativeBridgeError>);
  });

  it('rejects duplicated item identities returned by the native host', async () => {
    const webView = new FakeWebView();
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => 'catalog-1',
    });
    const pending = client.getDetails(['hint_pack_20', 'hint_pack_120']);
    webView.respond({
      requestId: 'catalog-1',
      method: 'catalog.getDetails',
      ok: true,
      result: {
        items: [
          {
            itemId: 'hint_pack_20',
            title: '20 hints',
            price: { currencyCode: 'KRW', formatted: '₩1,000' },
          },
          {
            itemId: 'hint_pack_20',
            title: '20 hints again',
            price: { currencyCode: 'KRW', formatted: '₩1,000' },
          },
        ],
      },
    });

    await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_ERROR' });
    client.dispose();
  });

  it('never reuses a completed request identity within one bridge lifetime', async () => {
    const webView = new FakeWebView();
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => 'fixed-request',
    });
    const first = client.listPurchases();
    webView.respond({
      requestId: 'fixed-request',
      method: 'purchase.list',
      ok: true,
      result: { items: [] },
    });
    await expect(first).resolves.toEqual([]);

    await expect(client.listPurchases()).rejects.toMatchObject({
      code: 'BRIDGE_PROTOCOL_ERROR',
    });
    expect(webView.messages).toHaveLength(1);
    client.dispose();
  });
});
