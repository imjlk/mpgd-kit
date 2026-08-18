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

class ThrowingWebView extends FakeWebView {
  override postMessage(): void {
    throw new Error('transport unavailable');
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

  it('uses the requested SKU when a successful native purchase omits its token', async () => {
    const runtime = createMicrosoftStoreNativeCommerceRuntime({
      getDetails: vi.fn(),
      getCustomerCollectionsId: vi.fn(),
      listPurchases: vi.fn(),
      requestPurchase: vi.fn(async () => ({ status: 'succeeded' as const })),
      dispose: vi.fn(),
    });

    await expect(runtime.createPaymentRequest([{
      supportedMethods: 'https://store.microsoft.com/billing',
      data: { sku: 'hint_pack_20' },
    }]).show()).resolves.toEqual({ details: { purchaseToken: 'hint_pack_20' } });
  });

  it.each([
    ['network-error', 'NATIVE_PURCHASE_NETWORK_ERROR'],
    ['server-error', 'NATIVE_PURCHASE_SERVER_ERROR'],
  ] as const)('maps native %s purchases to %s', async (status, code) => {
    const runtime = createMicrosoftStoreNativeCommerceRuntime({
      getDetails: vi.fn(),
      getCustomerCollectionsId: vi.fn(),
      listPurchases: vi.fn(),
      requestPurchase: vi.fn(async () => ({ status })),
      dispose: vi.fn(),
    });

    await expect(runtime.createPaymentRequest([{
      supportedMethods: 'https://store.microsoft.com/billing',
      data: { sku: 'hint_pack_20' },
    }]).show()).rejects.toMatchObject({ code });
  });

  it('rejects an untyped payment request without Store method data', () => {
    const runtime = createMicrosoftStoreNativeCommerceRuntime({
      getDetails: vi.fn(),
      getCustomerCollectionsId: vi.fn(),
      listPurchases: vi.fn(),
      requestPurchase: vi.fn(),
      dispose: vi.fn(),
    });
    const invalid = [{
      supportedMethods: 'https://store.microsoft.com/billing',
    }] as unknown as Parameters<typeof runtime.createPaymentRequest>[0];

    expect(() => runtime.createPaymentRequest(invalid)).toThrow(
      'Microsoft Store item ID is invalid.',
    );
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

  it('maps a throwing native transport to NATIVE_OPERATION_FAILED', async () => {
    const client = createMicrosoftStoreNativeBridgeClient({
      webView: new ThrowingWebView(),
      createRequestId: () => 'transport-failure',
    });
    try {
      await expect(client.listPurchases()).rejects.toMatchObject({
        code: 'NATIVE_OPERATION_FAILED',
      } satisfies Partial<MicrosoftStoreNativeBridgeError>);
    } finally {
      client.dispose();
    }
  });

  it('rejects work above the pending native request limit', async () => {
    const webView = new FakeWebView();
    let requestSequence = 0;
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => `pending-${String(requestSequence++)}`,
    });
    const pending = Array.from({ length: 64 }, () => client.listPurchases());
    try {
      await expect(client.listPurchases()).rejects.toMatchObject({
        code: 'BRIDGE_PROTOCOL_ERROR',
      } satisfies Partial<MicrosoftStoreNativeBridgeError>);
      expect(webView.messages).toHaveLength(64);
    } finally {
      client.dispose();
      await Promise.allSettled(pending);
    }
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

  it('rejects a malformed native currency code', async () => {
    const webView = new FakeWebView();
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => 'catalog-currency',
    });
    const pending = client.getDetails(['hint_pack_20']);
    webView.respond({
      requestId: 'catalog-currency',
      method: 'catalog.getDetails',
      ok: true,
      result: {
        items: [{
          itemId: 'hint_pack_20',
          title: '20 hints',
          price: { currencyCode: '12$', formatted: '₩1,000' },
        }],
      },
    });

    await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_ERROR' });
    client.dispose();
  });

  it('allows description line breaks but rejects native display format controls', async () => {
    const webView = new FakeWebView();
    const requestIds = ['catalog-multiline', 'catalog-format'];
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => requestIds.shift() ?? 'unexpected-request',
    });
    const multiline = client.getDetails(['hint_pack_20']);
    webView.respond({
      requestId: 'catalog-multiline',
      method: 'catalog.getDetails',
      ok: true,
      result: {
        items: [{
          itemId: 'hint_pack_20',
          title: '20 hints',
          description: 'First line\r\nSecond line\tvalue',
          price: { currencyCode: 'KRW', formatted: '₩1,000' },
        }],
      },
    });
    await expect(multiline).resolves.toEqual([expect.objectContaining({
      description: 'First line\r\nSecond line\tvalue',
    })]);

    const formatted = client.getDetails(['hint_pack_20']);
    webView.respond({
      requestId: 'catalog-format',
      method: 'catalog.getDetails',
      ok: true,
      result: {
        items: [{
          itemId: 'hint_pack_20',
          title: '20 hints\u202e000,1',
          price: { currencyCode: 'KRW', formatted: '₩1,000' },
        }],
      },
    });
    await expect(formatted).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_ERROR' });
    client.dispose();
  });

  it('rejects native purchase tokens that differ from their item IDs', async () => {
    const webView = new FakeWebView();
    const requestIds = ['purchase-token-mismatch', 'list-token-mismatch'];
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => requestIds.shift() ?? 'unexpected-request',
    });

    const purchase = client.requestPurchase('hint_pack_20');
    webView.respond({
      requestId: 'purchase-token-mismatch',
      method: 'purchase.request',
      ok: true,
      result: { status: 'succeeded', purchaseToken: 'provider-transaction-1' },
    });
    await expect(purchase).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_ERROR' });

    const purchases = client.listPurchases();
    webView.respond({
      requestId: 'list-token-mismatch',
      method: 'purchase.list',
      ok: true,
      result: {
        items: [{ itemId: 'hint_pack_20', purchaseToken: 'provider-transaction-1' }],
      },
    });
    await expect(purchases).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_ERROR' });
    client.dispose();
  });

  it('classifies invalid host identifiers as bridge protocol errors', async () => {
    const webView = new FakeWebView();
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => 'invalid-native-identity',
    });
    const pending = client.getCustomerCollectionsId({
      serviceTicket: 'entra-service-ticket',
      publisherUserId: 'authenticated-player',
    });
    webView.respond({
      requestId: 'invalid-native-identity',
      method: 'identity.getCustomerCollectionsId',
      ok: true,
      result: { userStoreId: '  ' },
    });

    await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_ERROR' });
    client.dispose();
  });

  it('times out after ignoring a malformed native response', async () => {
    vi.useFakeTimers();
    const webView = new FakeWebView();
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => 'timeout-1',
      timeoutMs: 25,
    });
    try {
      const pending = client.listPurchases();
      webView.respond({
        requestId: 'timeout-1',
        method: 'purchase.list',
        ok: false,
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'BRIDGE_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
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

  it('bounds completed request identity retention in a long-lived bridge', async () => {
    const webView = new FakeWebView();
    let requestSequence = 0;
    const client = createMicrosoftStoreNativeBridgeClient({
      webView,
      createRequestId: () => requestSequence <= 4_096
        ? `retained-${String(requestSequence++)}`
        : 'retained-0',
    });

    for (let index = 0; index <= 4_096; index += 1) {
      const pending = client.listPurchases();
      webView.respond({
        requestId: `retained-${String(index)}`,
        method: 'purchase.list',
        ok: true,
        result: { items: [] },
      });
      await expect(pending).resolves.toEqual([]);
    }

    const reused = client.listPurchases();
    webView.respond({
      requestId: 'retained-0',
      method: 'purchase.list',
      ok: true,
      result: { items: [] },
    });
    await expect(reused).resolves.toEqual([]);
    client.dispose();
  });

  it('prefers native formatted prices and falls back to numeric Digital Goods values', async () => {
    const formattedDetail = {
      itemId: 'hint_pack_20',
      title: '20 hints',
      price: { currency: 'KRW', formatted: 'Store ₩1,000', value: '999' },
    };
    const createCommerce = (price: typeof formattedDetail.price) =>
      createMicrosoftStoreCommerceAdapter({
        products: [{
          info: {
            id: 'HINT_PACK_20',
            type: 'consumable',
            title: '20 hints',
            description: '20 hints',
            price: { formatted: 'fallback', currencyCode: 'KRW' },
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
        async getDigitalGoodsService() {
          return {
            async getDetails() {
              return [{ ...formattedDetail, price }];
            },
            async listPurchases() {
              return [];
            },
          };
        },
        locale: 'ko-KR',
      });

    await expect(createCommerce(formattedDetail.price).getProducts()).resolves.toEqual([
      expect.objectContaining({
        price: { formatted: 'Store ₩1,000', currencyCode: 'KRW' },
      }),
    ]);
    await expect(createCommerce({
      currency: 'KRW',
      formatted: '  ',
      value: '1000',
    }).getProducts()).resolves.toEqual([
      expect.objectContaining({
        price: { formatted: '₩1,000', currencyCode: 'KRW' },
      }),
    ]);
    await expect(createCommerce({
      currency: 'invalid',
      formatted: '₩1,000',
      value: '1000',
    }).getProducts()).resolves.toEqual([]);
  });
});
