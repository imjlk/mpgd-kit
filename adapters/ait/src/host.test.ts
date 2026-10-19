import { afterEach, describe, expect, it, vi } from 'vitest';

import { rootRelativeRouteVectors } from '@mpgd/platform/route-vectors';

import type { BridgeRequest } from '@mpgd/bridge';
import type { CommerceDiagnostic, ProductInfo, PurchaseRestoreResult } from '@mpgd/platform';
import {
  createAitHostBridge,
  createAitSessionIdentityProvider,
  shareIntent,
  type AitHostDependencies,
  type AitIapProductGrantVerificationInput,
} from './host';
import { createAitIapController, type AitIapController } from './iap';

describe('AIT production host bridge', () => {
  it('uses the native game identity and persistent string storage', async () => {
    const values = new Map<string, string>();
    const bridge = createAitHostBridge({
      dependencies: createDependencies({
        identityProvider: async () => ({ type: 'HASH', hash: ' player-1 ' }),
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'identity.getSession', {})).resolves.toEqual({
      identityLevel: 'platform-anonymous',
      playerId: 'player-1',
      trustLevel: 'platform-asserted',
    });
    await request(bridge, 'storage.save', { key: 'save:v1', value: { hints: 3 } });
    expect(values.get('save:v1')).toBe('{"hints":3}');
    await expect(request(bridge, 'storage.load', { key: 'save:v1' })).resolves.toEqual({
      __mpgdBridgeProtocol: 'mpgd.storage.load.v1',
      found: true,
      value: { hints: 3 },
    });

    const firstLoad = await request(bridge, 'storage.load', { key: 'save:v1' }) as {
      value: { hints: number };
    };
    firstLoad.value.hints = -1;
    await expect(request(bridge, 'storage.load', { key: 'save:v1' })).resolves.toMatchObject({
      value: { hints: 3 },
    });
  });

  it('coalesces concurrent identity reads for one wrapper session', async () => {
    const identityProvider = vi.fn(async () => ({ type: 'HASH', hash: 'player-shared' }));
    const bridge = createAitHostBridge({
      dependencies: createDependencies({ identityProvider }),
    });

    await expect(Promise.all([
      request(bridge, 'identity.getPlayer', {}),
      request(bridge, 'identity.getSession', {}),
    ])).resolves.toEqual([
      { playerId: 'player-shared' },
      {
        identityLevel: 'platform-anonymous',
        playerId: 'player-shared',
        trustLevel: 'platform-asserted',
      },
    ]);
    expect(identityProvider).toHaveBeenCalledOnce();
  });

  it('retries a session identity read after a rejected native request', async () => {
    const nativeProvider = vi.fn()
      .mockRejectedValueOnce(new Error('native session unavailable'))
      .mockResolvedValueOnce({ type: 'HASH', hash: 'player-recovered' });
    const identityProvider = createAitSessionIdentityProvider(nativeProvider);

    await expect(identityProvider()).rejects.toThrow('native session unavailable');
    await expect(identityProvider()).resolves.toEqual({
      type: 'HASH',
      hash: 'player-recovered',
    });
    expect(nativeProvider).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the native game identity is invalid', async () => {
    const bridge = createAitHostBridge({
      dependencies: createDependencies({ identityProvider: async () => ({ type: 'HASH' }) }),
    });

    await expect(request(bridge, 'identity.getPlayer', {})).rejects.toThrow(
      'AIT user identity is unavailable.',
    );
    await expect(request(bridge, 'identity.getSession', {})).resolves.toEqual({
      identityLevel: 'guest',
      trustLevel: 'local',
    });
  });

  it('treats corrupted native storage as a missing save', async () => {
    const bridge = createAitHostBridge({
      dependencies: createDependencies({
        storage: {
          getItem: async () => '{not-valid-json',
          removeItem: async () => {},
          setItem: async () => {},
        },
      }),
    });

    await expect(request(bridge, 'storage.load', { key: 'save:v1' })).resolves.toEqual({
      __mpgdBridgeProtocol: 'mpgd.storage.load.v1',
      found: false,
    });
  });

  it('fails closed for commerce and unconfigured ads', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });

    const capabilities = await request(bridge, 'runtime.getCapabilities', {});
    expect(capabilities).toMatchObject({
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
      commerce: { availability: 'unsupported' },
    });
    // The boolean commerce flags are gone: the block is the only source.
    expect(capabilities).not.toHaveProperty('nativeIap');
    expect(capabilities).not.toHaveProperty('subscriptionIap');
    await expect(request(bridge, 'commerce.v2.fetchProducts', {})).resolves.toEqual({
      products: [],
    });
    await expect(request(bridge, 'commerce.v2.requestPurchase', {
      logicalId: 'HINT_PACK_5',
      source: 'shop',
      idempotencyKey: 'unconfigured-iap-attempt',
    })).resolves.toEqual({
      outcome: 'failed',
      error: {
        code: 'CONFIGURATION_REQUIRED',
        retryable: false,
        storeCode: 'AIT_IAP_UNAVAILABLE',
        message: expect.stringContaining('AIT_IAP_UNAVAILABLE'),
      },
    });
    await expect(requestError(bridge, 'commerce.v2.restorePurchases', {
      protocol: 'mpgd.commerce.v2',
    })).resolves.toMatchObject({
      code: 'CONFIGURATION_REQUIRED',
      retryable: false,
    });
    await expect(request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-1',
    })).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
  });

  it('serves no commerce method but the six commerce.v2 methods', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });

    // The v1 methods left the bridge protocol: a request for one is rejected
    // as a malformed bridge request, whatever the IAP configuration.
    for (const method of [
      'commerce.getProducts',
      'commerce.purchase',
      'commerce.restore',
      'commerce.getEntitlements',
    ]) {
      await expect(requestError(bridge, method as BridgeRequest['method'], {})).resolves
        .toMatchObject({ code: 'AIT_BRIDGE_REQUEST_FAILED' });
    }
  });

  it('maps configured native IAP products and completes only after server verification', async () => {
    let callbacks: IapPurchaseCallbacks | undefined;
    let cleanupCalls = 0;
    const verifyIapProductGrant = vi.fn(
      async (_input: AitIapProductGrantVerificationInput) => true,
    );
    const bridge = createAitHostBridge({
      iapProducts: [{
        productId: 'HINT_PACK_5',
        sku: 'ait.ttokdoku.hints.5',
      }],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: [{
            sku: 'ait.ttokdoku.hints.5',
            displayAmount: '₩1,100',
            displayName: 'Hint Pack',
            description: 'Adds five hints.',
            iconUrl: 'https://images.example/hints.png',
            type: 'CONSUMABLE',
          }],
          onPurchase: (input) => {
            callbacks = input;
          },
          onCleanup: () => {
            cleanupCalls += 1;
          },
        }),
      }),
    });

    const capabilities = await request(bridge, 'runtime.getCapabilities', {});
    expect(capabilities).toMatchObject({
      commerce: { availability: 'available', lifecycle: { finish: 'host' } },
    });
    expect(capabilities).not.toHaveProperty('nativeIap');
    await expect(request(bridge, 'commerce.v2.fetchProducts', {})).resolves.toEqual({
      products: [{
        logicalId: 'HINT_PACK_5',
        store: 'apps-in-toss',
        storeSku: 'ait.ttokdoku.hints.5',
        kind: 'consumable',
        title: 'Hint Pack',
        description: 'Adds five hints.',
        price: { formatted: '₩1,100', currencyCode: 'KRW' },
      }],
    });

    const purchase = request(bridge, 'commerce.v2.requestPurchase', {
      logicalId: 'HINT_PACK_5',
      source: 'shop',
      idempotencyKey: 'hint-pack-5-attempt',
    });
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await expect(callbacks.options.processProductGrant({ orderId: 'order-hints-5' }))
      .resolves.toBe(true);
    await callbacks.onEvent({
      type: 'success',
      data: {
        orderId: 'order-hints-5',
        displayName: 'Hint Pack',
        displayAmount: '₩1,100',
        amount: 1100,
        currency: 'KRW',
        fraction: 0,
        miniAppIconUrl: null,
      },
    });

    await expect(purchase).resolves.toMatchObject({
      outcome: 'purchased',
      purchase: {
        store: 'apps-in-toss',
        transactionId: 'order-hints-5',
        storeSku: 'ait.ttokdoku.hints.5',
        logicalId: 'HINT_PACK_5',
        state: 'purchased',
        token: 'order-hints-5',
        evidence: {
          schema: 'apps-in-toss.iap.callback.v1',
          payload: {
            orderId: 'order-hints-5',
            sku: 'ait.ttokdoku.hints.5',
            source: 'process-product-grant',
          },
        },
        accountBinding: { kind: 'host-identity' },
      },
    });
    expect(verifyIapProductGrant).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-hints-5',
      productId: 'HINT_PACK_5',
      platformSku: 'ait.ttokdoku.hints.5',
      idempotencyKey: 'apps-in-toss:purchase:order-hints-5',
      clientIdempotencyKey: 'hint-pack-5-attempt',
      source: 'process-product-grant',
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
    }));
    const verificationInput = verifyIapProductGrant.mock.calls[0]?.[0];
    if (verificationInput === undefined) {
      throw new Error('Expected the Apps in Toss product grant verifier to run.');
    }
    expect(verificationInput.timeoutMs).toBeGreaterThan(0);
    expect(verificationInput.timeoutMs).toBeLessThanOrEqual(25_000);
    expect(cleanupCalls).toBe(1);
  });

  it('rejects game storage access to adapter-reserved marker keys so a forged purchase still verifies', async () => {
    const values = new Map<string, string>();
    let callbacks: IapPurchaseCallbacks | undefined;
    const verifyIapProductGrant = vi.fn(async () => true);
    const bridge = createAitHostBridge({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: [createIapProduct()],
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });
    const reservedKeyError = 'AIT storage keys starting with "mpgd:ait:" are reserved for adapter-owned markers.';
    const forgedAttemptKey = 'mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:forged-attempt';

    await expect(request(bridge, 'storage.save', {
      key: forgedAttemptKey,
      value: {
        status: 'completed',
        productId: 'HINT_PACK_5',
        idempotencyKey: 'forged-attempt',
        orderId: 'order-forged',
      },
    })).rejects.toThrow(reservedKeyError);
    await expect(request(bridge, 'storage.save', {
      key: 'mpgd:ait:promotion-grant:v1:forged-promotion',
      value: { status: 'granted', campaignId: 'SEVEN_DAY_STREAK' },
    })).rejects.toThrow(reservedKeyError);
    await expect(request(bridge, 'storage.save', {
      key: 'mpgd:ait:iap-completed-purchase-index:v1',
      value: [forgedAttemptKey],
    })).rejects.toThrow(reservedKeyError);
    await expect(request(bridge, 'storage.load', { key: forgedAttemptKey }))
      .rejects.toThrow(reservedKeyError);
    expect(values.size).toBe(0);

    const purchase = request(bridge, 'commerce.v2.requestPurchase', {
      logicalId: 'HINT_PACK_5',
      source: 'shop',
      idempotencyKey: 'forged-attempt',
    });
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected the purchase to open a native checkout instead of trusting a marker.');
    }
    await expect(callbacks.options.processProductGrant({ orderId: 'order-real' }))
      .resolves.toBe(true);
    await callbacks.onEvent({ type: 'success', data: createIapSuccessEvent('order-real') });
    await expect(purchase).resolves.toMatchObject({
      outcome: 'purchased',
      purchase: { transactionId: 'order-real', logicalId: 'HINT_PACK_5' },
    });
    expect(verifyIapProductGrant).toHaveBeenCalledOnce();
    expect(verifyIapProductGrant).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-real',
      productId: 'HINT_PACK_5',
    }));

    // Only the exact adapter prefix is reserved; game and sandbox namespaces stay usable.
    await request(bridge, 'storage.save', { key: 'mpgd:game:save:v1', value: { hints: 1 } });
    await request(bridge, 'storage.save', { key: 'mpgd:ait-sandbox:tutorial:v1', value: true });
    expect(values.get('mpgd:game:save:v1')).toBe('{"hints":1}');
    expect(values.get('mpgd:ait-sandbox:tutorial:v1')).toBe('true');
  });

  // From here the IAP engine tests drive the controller the commerce provider
  // runs on (see `recover` below); the bridge itself is covered above and by
  // the commerce v2 bridge and conformance tests.
  it('reuses a completed client idempotency key without opening another native checkout', async () => {
    const values = new Map<string, string>();
    let callbacks: IapPurchaseCallbacks | undefined;
    let nativePurchaseStarts = 0;
    const dependencies = createDependencies({
      storage: createMemoryStorage(values),
      iap: createSupportedIap({
        products: [createIapProduct()],
        onPurchase: (input) => {
          nativePurchaseStarts += 1;
          callbacks = input;
        },
      }),
    });
    const options = {
      iapProducts: [{ productId: 'HINT_PACK_5' as const, sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies,
    };
    const iap = createAitIapController(options);
    const payload = {
      productId: 'HINT_PACK_5',
      idempotencyKey: 'completed-attempt',
    };

    const firstPurchase = iap.purchase(payload.productId, payload.idempotencyKey);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await expect(callbacks.options.processProductGrant({ orderId: 'order-completed' }))
      .resolves.toBe(true);
    await callbacks.onEvent({ type: 'success', data: createIapSuccessEvent('order-completed') });

    const completed = {
      status: 'completed' as const,
      transactionId: 'order-completed',
      entitlementIds: ['HINT_PACK_5'],
      evidence: {
        schema: 'apps-in-toss.iap.callback.v1',
        payload: {
          orderId: 'order-completed',
          sku: 'ait.ttokdoku.hints.5',
          source: 'process-product-grant' as const,
        },
      },
    };
    await expect(firstPurchase).resolves.toEqual(completed);
    await expect(iap.purchase(payload.productId, payload.idempotencyKey)).resolves.toEqual(completed);
    await expect(createAitIapController(options).purchase(payload.productId, payload.idempotencyKey))
      .resolves.toEqual(completed);
    expect(nativePurchaseStarts).toBe(1);
    await vi.waitFor(() => expect(values.get(
      'mpgd:ait:iap-completed-purchase-index:v1',
    )).toBeDefined());
    expect(JSON.parse(values.get('mpgd:ait:iap-completed-purchase-index:v1') ?? '[]')).toEqual([
      'mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:completed-attempt',
    ]);
  });

  it('keeps every completed attempt as a compact tombstone that still replays', async () => {
    const values = new Map<string, string>();
    const callbacks: IapPurchaseCallbacks[] = [];
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: [createIapProduct()],
          onPurchase: (input) => {
            callbacks.push(input);
          },
        }),
      }),
    });

    for (let index = 0; index < 101; index += 1) {
      const idempotencyKey = `retained-attempt-${index}`;
      const orderId = `order-retention-${index}`;
      const purchase = iap.purchase('HINT_PACK_5', idempotencyKey);
      await vi.waitFor(() => expect(callbacks).toHaveLength(index + 1));
      const callback = callbacks[index];
      if (callback === undefined) {
        throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
      }
      await expect(callback.options.processProductGrant({ orderId })).resolves.toBe(true);
      await callback.onEvent({ type: 'success', data: createIapSuccessEvent(orderId) });
      await expect(purchase).resolves.toMatchObject({
        status: 'completed',
        transactionId: orderId,
      });
    }

    const indexKey = 'mpgd:ait:iap-completed-purchase-index:v1';
    const attemptKey = (index: number) =>
      `mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:retained-attempt-${index}`;
    await vi.waitFor(() => expect(
      (JSON.parse(values.get(indexKey) ?? '[]') as string[]).at(-1),
    ).toBe(attemptKey(100)));
    // The index stays bounded bookkeeping; no completed marker is ever deleted.
    expect(JSON.parse(values.get(indexKey) ?? '[]')).toHaveLength(64);
    for (let index = 0; index < 101; index += 1) {
      expect(JSON.parse(values.get(attemptKey(index)) ?? 'null')).toEqual({
        v: 1,
        status: 'completed',
        productId: 'HINT_PACK_5',
        orderId: `order-retention-${index}`,
      });
    }
    for (const index of [0, 50, 100]) {
      await expect(iap.purchase('HINT_PACK_5', `retained-attempt-${index}`)).resolves.toMatchObject({
        status: 'completed',
        transactionId: `order-retention-${index}`,
      });
    }
    expect(callbacks).toHaveLength(101);
  }, 30_000);

  it('still replays completed attempt markers written in the full form', async () => {
    const startPurchase = vi.fn();
    const values = new Map<string, string>([
      ['mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:legacy-completed', JSON.stringify({
        status: 'completed',
        productId: 'HINT_PACK_5',
        idempotencyKey: 'legacy-completed',
        orderId: 'order-legacy',
        source: 'pending-order-restore',
      })],
      ['mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:mismatched-key', JSON.stringify({
        status: 'completed',
        productId: 'HINT_PACK_5',
        idempotencyKey: 'another-key',
        orderId: 'order-mismatched',
      })],
    ]);
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({ products: [createIapProduct()], onPurchase: startPurchase }),
      }),
    });

    await expect(iap.purchase('HINT_PACK_5', 'legacy-completed')).resolves.toMatchObject({
      status: 'completed',
      transactionId: 'order-legacy',
      evidence: { payload: { source: 'pending-order-restore' } },
    });
    // A full-form marker must still name its own client key.
    await expect(iap.purchase('HINT_PACK_5', 'mismatched-key')).resolves.toMatchObject({
      status: 'pending',
      diagnostic: { code: 'AIT_IAP_ATTEMPT_STORAGE_UNAVAILABLE' },
    });
    expect(startPurchase).not.toHaveBeenCalled();
  });

  it('fails closed when the native IAP callback cannot verify the product grant', async () => {
    let callbacks: IapPurchaseCallbacks | undefined;
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => false,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: [createIapProduct()],
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('HINT_PACK_5', 'hint-pack-5-rejected');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await expect(callbacks.options.processProductGrant({ orderId: 'order-rejected' }))
      .resolves.toBe(false);
    await callbacks.onEvent({
      type: 'success',
      data: {
        orderId: 'order-rejected',
        displayName: 'Hint Pack',
        displayAmount: '₩1,100',
        amount: 1100,
        currency: 'KRW',
        fraction: 0,
        miniAppIconUrl: null,
      },
    });
    await expect(purchase).resolves.toEqual({
      status: 'pending',
      transactionId: 'order-rejected',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_GRANT_PENDING', retryable: true },
    });
  });

  it('hides subscription products until a subscription authority is configured', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startPurchase = vi.fn();
    try {
      const iap = createAitIapController({
        iapProducts: [{ productId: 'PREMIUM_MONTHLY', sku: 'ait.ttokdoku.premium.monthly' }],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        dependencies: createDependencies({
          iap: createSupportedIap({
            products: [{
              sku: 'ait.ttokdoku.premium.monthly',
              displayAmount: '₩3,900',
              displayName: 'Premium',
              description: 'Monthly premium access.',
              iconUrl: 'https://images.example/premium.png',
              type: 'SUBSCRIPTION',
              renewalCycle: 'MONTHLY',
            }],
            onPurchase: startPurchase,
          }),
        }),
      });

      await expect(catalogError(iap)).resolves.toMatchObject({
        code: 'AIT_IAP_CONFIGURED_SKUS_NOT_VISIBLE',
        retryable: false,
      });
      await expect(iap.purchase('PREMIUM_MONTHLY', 'subscription-direct-purchase')).resolves.toEqual({
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_PRODUCT_TYPE_UNSUPPORTED', retryable: false },
      });
      expect(startPurchase).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        'AIT subscription IAP is unavailable through the one-time order bridge.',
        expect.objectContaining({
          productId: 'PREMIUM_MONTHLY',
          sku: 'ait.ttokdoku.premium.monthly',
        }),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('verifies the grant when success arrives before the server grant callback', async () => {
    let callbacks: IapPurchaseCallbacks | undefined;
    const verifyIapProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: [createIapProduct()],
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('HINT_PACK_5', 'hint-pack-5-early-success');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await callbacks.onEvent({
      type: 'success',
      data: {
        orderId: 'order-early-success',
        displayName: 'Hint Pack',
        displayAmount: '₩1,100',
        amount: 1100,
        currency: 'KRW',
        fraction: 0,
        miniAppIconUrl: null,
      },
    });

    await expect(purchase).resolves.toMatchObject({
      status: 'completed',
      transactionId: 'order-early-success',
      entitlementIds: ['HINT_PACK_5'],
    });
    expect(verifyIapProductGrant).toHaveBeenCalledOnce();
  });

  it('does not coalesce concurrent purchases for different products', async () => {
    const callbacksBySku = new Map<string, IapPurchaseCallbacks>();
    const verifyIapProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [
        { productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' },
        { productId: 'HINT_PACK_20', sku: 'ait.ttokdoku.hints.20' },
      ],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: [
            createIapProduct(),
            createIapProduct({
              sku: 'ait.ttokdoku.hints.20',
              displayName: 'Hint Pack 20',
              description: 'Adds twenty hints.',
              displayAmount: '₩3,900',
            }),
          ],
          onPurchase: (input) => {
            const sku = input.options.sku;
            if (typeof sku === 'string') {
              callbacksBySku.set(sku, input);
            }
          },
        }),
      }),
    });

    const sharedIdempotencyKey = 'shop-attempt-1';
    const firstPurchase = iap.purchase('HINT_PACK_5', sharedIdempotencyKey);
    await vi.waitFor(() => expect(callbacksBySku.size).toBe(1));
    // The same key for another product is not coalesced with the active
    // checkout, and one checkout at a time keeps provider orders unshared.
    await expect(iap.purchase('HINT_PACK_20', sharedIdempotencyKey)).resolves.toEqual({
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_CHECKOUT_IN_PROGRESS', retryable: true },
    });
    const firstCallbacks = callbacksBySku.get('ait.ttokdoku.hints.5');
    if (firstCallbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks for the first product.');
    }
    await expect(firstCallbacks.options.processProductGrant({ orderId: 'order-hints-5' }))
      .resolves.toBe(true);
    await firstCallbacks.onEvent({
      type: 'success',
      data: createIapSuccessEvent('order-hints-5'),
    });
    await expect(firstPurchase).resolves.toMatchObject({
      status: 'completed',
      transactionId: 'order-hints-5',
    });

    const secondPurchase = iap.purchase('HINT_PACK_20', sharedIdempotencyKey);
    await vi.waitFor(() => expect(callbacksBySku.size).toBe(2));
    const secondCallbacks = callbacksBySku.get('ait.ttokdoku.hints.20');
    if (secondCallbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks for the second product.');
    }
    await expect(secondCallbacks.options.processProductGrant({ orderId: 'order-hints-20' }))
      .resolves.toBe(true);
    await secondCallbacks.onEvent({
      type: 'success',
      data: createIapSuccessEvent('order-hints-20'),
    });
    await expect(secondPurchase).resolves.toMatchObject({
      status: 'completed',
      transactionId: 'order-hints-20',
    });
    expect(verifyIapProductGrant).toHaveBeenCalledTimes(2);
  });

  it('times out a verifier that ignores its abort signal', async () => {
    vi.useFakeTimers();
    try {
      let callbacks: IapPurchaseCallbacks | undefined;
      let verifierSignal: AbortSignal | undefined;
      const iap = createAitIapController({
        iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
        prepareIap: async () => true,
        verifyIapProductGrant: async ({ signal }) => {
          verifierSignal = signal;
          return await new Promise<boolean>(() => {});
        },
        iapProductGrantTimeoutMs: 10,
        dependencies: createDependencies({
          iap: createSupportedIap({
            products: [createIapProduct()],
            onPurchase: (input) => {
              callbacks = input;
            },
          }),
        }),
      });

      const purchase = iap.purchase('HINT_PACK_5', 'hint-pack-5-timeout');
      // Flush microtasks only: vi.waitFor would advance fake time past the
      // 10ms deadlines of the pre-checkout steps.
      for (let turn = 0; turn < 200 && callbacks === undefined; turn += 1) {
        await Promise.resolve();
      }
      if (callbacks === undefined) {
        throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
      }
      const processGrant = callbacks.options.processProductGrant({ orderId: 'order-timeout' });
      await vi.advanceTimersByTimeAsync(10);
      await expect(processGrant).resolves.toBe(false);
      expect(verifierSignal?.aborted).toBe(true);
      await callbacks.onEvent({
        type: 'success',
        data: {
          orderId: 'order-timeout',
          displayName: 'Hint Pack',
          displayAmount: '₩1,100',
          amount: 1100,
          currency: 'KRW',
          fraction: 0,
          miniAppIconUrl: null,
        },
      });
      await expect(purchase).resolves.toEqual({
        status: 'pending',
        transactionId: 'order-timeout',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_GRANT_PENDING', retryable: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a server-granted purchase pending when the native terminal callback is lost', async () => {
    vi.useFakeTimers();
    try {
      const values = new Map<string, string>();
      let callbacks: IapPurchaseCallbacks | undefined;
      let nativePurchaseStarts = 0;
      const iap = createAitIapController({
        iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        dependencies: createDependencies({
          storage: createMemoryStorage(values),
          iap: createSupportedIap({
            products: [createIapProduct()],
            onPurchase: (input) => {
              nativePurchaseStarts += 1;
              callbacks = input;
            },
          }),
        }),
      });
      const payload = {
        productId: 'HINT_PACK_5',
        idempotencyKey: 'lost-terminal-callback',
      };

      const purchase = iap.purchase(payload.productId, payload.idempotencyKey);
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      if (callbacks === undefined) {
        throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
      }
      await expect(callbacks.options.processProductGrant({ orderId: 'order-lost-callback' }))
        .resolves.toBe(true);

      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const pending = {
        status: 'pending' as const,
        transactionId: 'order-lost-callback',
        entitlementIds: [],
      };
      await expect(purchase).resolves.toEqual({
        ...pending,
        diagnostic: { code: 'AIT_IAP_CHECKOUT_TIMEOUT', retryable: true },
      });
      await expect(iap.purchase(payload.productId, payload.idempotencyKey)).resolves.toEqual({
        ...pending,
        diagnostic: { code: 'AIT_IAP_GRANT_COMPLETION_FAILED', retryable: true },
      });
      expect(nativePurchaseStarts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists the provider order before committing an authoritative grant', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    let purchaseAttemptWrites = 0;
    let callbacks: IapPurchaseCallbacks | undefined;
    let nativePurchaseStarts = 0;
    const verifyIapProductGrant = vi.fn(async () => true);
    const storage: AitHostDependencies['storage'] = {
      ...memoryStorage,
      setItem: async (key, value) => {
        if (key.startsWith('mpgd:ait:iap-purchase-attempt:v1:')) {
          purchaseAttemptWrites += 1;
          if (purchaseAttemptWrites === 3) {
            throw new Error('server-granted marker unavailable');
          }
        }
        await memoryStorage.setItem(key, value);
      },
    };
    const dependencies = createDependencies({
      storage,
      iap: createSupportedIap({
        products: [createIapProduct()],
        onPurchase: (input) => {
          nativePurchaseStarts += 1;
          callbacks = input;
        },
      }),
    });
    const options = {
      iapProducts: [{ productId: 'HINT_PACK_5' as const, sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies,
    };
    const payload = {
      productId: 'HINT_PACK_5' as const,
      idempotencyKey: 'grant-persist-failure',
    };
    const purchase = createAitIapController(options).purchase(payload.productId, payload.idempotencyKey);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }

    await expect(callbacks.options.processProductGrant({ orderId: 'order-persist-failure' }))
      .resolves.toBe(false);
    expect(verifyIapProductGrant).toHaveBeenCalledOnce();
    expect(JSON.parse(values.get(
      'mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:grant-persist-failure',
    ) ?? '{}')).toMatchObject({
      status: 'pending',
      orderId: 'order-persist-failure',
    });
    await callbacks.onEvent({
      type: 'success',
      data: createIapSuccessEvent('order-persist-failure'),
    });
    const pending = {
      status: 'pending',
      transactionId: 'order-persist-failure',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_GRANT_PENDING', retryable: true },
    };
    await expect(purchase).resolves.toEqual(pending);
    await expect(createAitIapController(options).purchase(payload.productId, payload.idempotencyKey))
      .resolves.toEqual(pending);
    expect(nativePurchaseStarts).toBe(1);
  });

  it('retries a stale pre-checkout marker only after provider recovery finds no order', async () => {
    const values = new Map<string, string>();
    const storageKey = 'mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:stale-attempt';
    values.set(storageKey, JSON.stringify({
      status: 'pending',
      productId: 'HINT_PACK_5',
      idempotencyKey: 'stale-attempt',
      pendingSince: new Date(Date.now() - (30 * 60_000) - 1).toISOString(),
    }));
    let callbacks: IapPurchaseCallbacks | undefined;
    const getPendingOrders = vi.fn(async () => ({ orders: [] }));
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: [createIapProduct()],
          getPendingOrders,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('HINT_PACK_5', 'stale-attempt');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await callbacks.onError({ name: 'AbortError' });

    await expect(purchase).resolves.toEqual({ status: 'cancelled', entitlementIds: [] });
    // Once for the stale marker, once for the pre-checkout duplicate-charge check.
    expect(getPendingOrders).toHaveBeenCalledTimes(2);
    expect(values.has(storageKey)).toBe(false);
  });

  it('preserves the retry barrier when cancellation races grant verification', async () => {
    const values = new Map<string, string>();
    const storageKey = 'mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:racing-cancellation';
    let callbacks: IapPurchaseCallbacks | undefined;
    let resolveVerification: ((granted: boolean) => void) | undefined;
    let nativePurchaseStarts = 0;
    const options = {
      iapProducts: [{ productId: 'HINT_PACK_5' as const, sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => await new Promise<boolean>((resolve) => {
        resolveVerification = resolve;
      }),
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: [createIapProduct()],
          onPurchase: (input) => {
            callbacks = input;
            nativePurchaseStarts += 1;
          },
        }),
      }),
    };
    const payload = {
      productId: 'HINT_PACK_5',
      idempotencyKey: 'racing-cancellation',
    };
    const purchase = createAitIapController(options).purchase(payload.productId, payload.idempotencyKey);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    const grant = callbacks.options.processProductGrant({ orderId: 'racing-order' });
    await vi.waitFor(() => expect(resolveVerification).toBeDefined());
    await callbacks.onError({ name: 'AbortError' });

    // The result (and the IAP lock) waits for the racing grant to settle.
    let purchaseSettled = false;
    void purchase.then(() => {
      purchaseSettled = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(purchaseSettled).toBe(false);
    expect(values.has(storageKey)).toBe(true);
    resolveVerification?.(true);
    await expect(grant).resolves.toBe(true);
    await expect(purchase).resolves.toEqual({
      status: 'pending',
      transactionId: 'racing-order',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_GRANT_PENDING', retryable: true },
    });
    expect(JSON.parse(values.get(storageKey) ?? '{}')).toMatchObject({
      status: 'server-granted',
      orderId: 'racing-order',
    });
    await expect(createAitIapController(options).purchase(payload.productId, payload.idempotencyKey))
      .resolves.toEqual({
        status: 'pending',
        transactionId: 'racing-order',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_GRANT_COMPLETION_FAILED', retryable: true },
      });
    expect(nativePurchaseStarts).toBe(1);
  });

  it('blocks queued grant startup after cancellation begins deleting its marker', async () => {
    const values = new Map<string, string>();
    const storageKey = 'mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:queued-after-cancel';
    let callbacks: IapPurchaseCallbacks | undefined;
    let completeRemoval: (() => void) | undefined;
    const verifyIapProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => await new Promise<void>((resolve) => {
            completeRemoval = () => {
              values.delete(key);
              resolve();
            };
          }),
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
        iap: createSupportedIap({
          products: [createIapProduct()],
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });
    const purchase = iap.purchase('HINT_PACK_5', 'queued-after-cancel');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }

    await callbacks.onError({ name: 'AbortError' });
    await vi.waitFor(() => expect(completeRemoval).toBeDefined());
    expect(values.has(storageKey)).toBe(true);
    await expect(callbacks.options.processProductGrant({ orderId: 'late-queued-order' }))
      .resolves.toBe(false);
    expect(verifyIapProductGrant).not.toHaveBeenCalled();
    completeRemoval?.();

    await expect(purchase).resolves.toEqual({ status: 'cancelled', entitlementIds: [] });
    expect(values.has(storageKey)).toBe(false);
  });

  it('keeps a stale pre-checkout marker pending while the provider still has its SKU', async () => {
    const values = new Map<string, string>();
    values.set('mpgd:ait:iap-purchase-attempt:v1:HINT_PACK_5:stale-pending-order', JSON.stringify({
      status: 'pending',
      productId: 'HINT_PACK_5',
      idempotencyKey: 'stale-pending-order',
      pendingSince: new Date(Date.now() - (30 * 60_000) - 1).toISOString(),
    }));
    const startPurchase = vi.fn();
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          pendingOrders: {
            orders: [{
              orderId: 'provider-pending-order',
              sku: 'ait.ttokdoku.hints.5',
              paymentCompletedDate: '2026-08-08T10:00:00.000Z',
            }],
          },
          onPurchase: startPurchase,
        }),
      }),
    });

    await expect(iap.purchase('HINT_PACK_5', 'stale-pending-order')).resolves.toEqual({
      status: 'pending',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_ATTEMPT_PENDING', retryable: true },
    });
    expect(startPurchase).not.toHaveBeenCalled();
  });

  it('recovers only verified pending IAP orders before completing the native grant', async () => {
    const completeProductGrant = vi.fn(async () => true);
    const verifyIapProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        iap: createSupportedIap({
          pendingOrders: {
            orders: [
              {
                orderId: 'pending-order-1',
                sku: 'ait.ttokdoku.hints.5',
                paymentCompletedDate: '2026-08-08T10:00:00.000Z',
              },
              {
                orderId: 'unmapped-order',
                sku: 'ait.unknown',
                paymentCompletedDate: '2026-08-08T10:00:00.000Z',
              },
            ],
          },
          completeProductGrant,
        }),
      }),
    });

    await expect(recover(iap)).resolves.toEqual({
      restoredEntitlements: [{
        id: 'HINT_PACK_5',
        source: 'purchase',
        grantedAt: '2026-08-08T10:00:00.000Z',
      }],
      settledPurchases: [{
        transactionId: 'pending-order-1',
        productId: 'HINT_PACK_5',
        status: 'granted',
      }],
    });
    expect(verifyIapProductGrant).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'pending-order-1',
      source: 'pending-order-restore',
      idempotencyKey: 'apps-in-toss:purchase:pending-order-1',
    }));
    expect(completeProductGrant).toHaveBeenCalledWith({
      params: { orderId: 'pending-order-1' },
    });
    expect(verifyIapProductGrant).toHaveBeenCalledTimes(1);
    expect(completeProductGrant).toHaveBeenCalledTimes(1);
  });

  it('does not let ineligible pending orders consume the restore work limit', async () => {
    const completeProductGrant = vi.fn(async () => true);
    const verifyIapProductGrant = vi.fn(async () => true);
    const ignoredOrders = Array.from({ length: 20 }, (_, index) => ({
      orderId: `unmapped-order-${index}`,
      sku: 'ait.unknown',
      paymentCompletedDate: '2026-08-08T10:00:00.000Z',
    }));
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        iap: createSupportedIap({
          pendingOrders: {
            orders: [
              ...ignoredOrders,
              {
                orderId: 'eligible-order',
                sku: 'ait.ttokdoku.hints.5',
                paymentCompletedDate: '2026-08-08T10:00:00.000Z',
              },
              {
                orderId: 'eligible-order',
                sku: 'ait.ttokdoku.hints.5',
                paymentCompletedDate: '2026-08-08T10:00:00.000Z',
              },
            ],
          },
          completeProductGrant,
        }),
      }),
    });

    await expect(recover(iap)).resolves.toEqual({
      restoredEntitlements: [{
        id: 'HINT_PACK_5',
        source: 'purchase',
        grantedAt: '2026-08-08T10:00:00.000Z',
      }],
      settledPurchases: [{
        transactionId: 'eligible-order',
        productId: 'HINT_PACK_5',
        status: 'granted',
      }],
    });
    expect(verifyIapProductGrant).toHaveBeenCalledTimes(1);
    expect(completeProductGrant).toHaveBeenCalledTimes(1);
  });

  it('rotates eligible pending orders so rejected work cannot starve later recovery', async () => {
    const values = new Map<string, string>();
    const completeProductGrant = vi.fn(async () => true);
    const pendingOrders = Array.from({ length: 21 }, (_, index) => ({
      orderId: `eligible-order-${index}`,
      sku: 'ait.ttokdoku.hints.5',
      paymentCompletedDate: '2026-08-08T10:00:00.000Z',
    }));
    const verifyIapProductGrant = vi.fn(async ({ orderId }: { readonly orderId: string }) => (
      orderId === 'eligible-order-20'
    ));
    const iap = createAitIapController({
      iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          pendingOrders: { orders: pendingOrders },
          completeProductGrant,
        }),
      }),
    });

    await expect(recover(iap)).resolves.toEqual({
      restoredEntitlements: [],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
    });
    expect(verifyIapProductGrant).toHaveBeenCalledTimes(20);
    expect(completeProductGrant).not.toHaveBeenCalled();

    await expect(recover(iap)).resolves.toEqual({
      restoredEntitlements: [{
        id: 'HINT_PACK_5',
        source: 'purchase',
        grantedAt: '2026-08-08T10:00:00.000Z',
      }],
      settledPurchases: [{
        transactionId: 'eligible-order-20',
        productId: 'HINT_PACK_5',
        status: 'granted',
      }],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
    });
    expect(verifyIapProductGrant.mock.calls[20]?.[0]).toEqual(expect.objectContaining({
      orderId: 'eligible-order-20',
      source: 'pending-order-restore',
    }));
    expect(completeProductGrant).toHaveBeenCalledWith({
      params: { orderId: 'eligible-order-20' },
    });
  });

  it('fails closed when IAP preparation does not settle before its deadline', async () => {
    vi.useFakeTimers();
    try {
      let nativePurchaseStarted = false;
      const iap = createAitIapController({
        iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
        prepareIap: async () => await new Promise<boolean>(() => {}),
        verifyIapProductGrant: async () => true,
        iapProductGrantTimeoutMs: 10,
        dependencies: createDependencies({
          iap: createSupportedIap({
            products: [createIapProduct()],
            onPurchase: () => {
              nativePurchaseStarted = true;
            },
          }),
        }),
      });

      const purchase = iap.purchase('HINT_PACK_5', 'hung-iap-preparation');
      await vi.advanceTimersByTimeAsync(10);

      await expect(purchase).resolves.toEqual({
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_PREPARATION_FAILED', retryable: true },
      });
      expect(nativePurchaseStarted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a hung native IAP catalog before listing or purchasing', async () => {
    vi.useFakeTimers();
    try {
      let nativePurchaseStarted = false;
      const iap = createAitIapController({
        iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        iapProductGrantTimeoutMs: 10,
        dependencies: createDependencies({
          iap: createSupportedIap({
            getProductItemList: async () => await new Promise<IapProductListResult>(() => {}),
            onPurchase: () => {
              nativePurchaseStarted = true;
            },
          }),
        }),
      });

      const products = catalogError(iap);
      await vi.advanceTimersByTimeAsync(10);
      await expect(products).resolves.toMatchObject({
        code: 'AIT_IAP_CATALOG_UNAVAILABLE',
        retryable: true,
      });

      const purchase = iap.purchase('HINT_PACK_5', 'hung-iap-catalog');
      await vi.advanceTimersByTimeAsync(10);
      await expect(purchase).resolves.toEqual({
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_CATALOG_UNAVAILABLE', retryable: true },
      });
      expect(nativePurchaseStarted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the native-call deadline when an SDK method throws synchronously', async () => {
    vi.useFakeTimers();
    try {
      const iap = createAitIapController({
        iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        iapProductGrantTimeoutMs: 10,
        dependencies: createDependencies({
          iap: createSupportedIap({
            getProductItemList: () => {
              throw new Error('native catalog unavailable');
            },
          }),
        }),
      });

      await expect(catalogError(iap)).resolves.toEqual({
        code: 'AIT_IAP_CATALOG_UNAVAILABLE',
        retryable: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds pending-order and completion calls during restore', async () => {
    vi.useFakeTimers();
    try {
      const commonOptions = {
        iapProducts: [{ productId: 'HINT_PACK_5' as const, sku: 'ait.ttokdoku.hints.5' }],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        iapProductGrantTimeoutMs: 10,
      };
      const hungPendingOrders = createAitIapController({
        ...commonOptions,
        dependencies: createDependencies({
          iap: createSupportedIap({
            getPendingOrders: async () => await new Promise<IapPendingOrdersResult>(() => {}),
          }),
        }),
      });

      const pendingRestore = recoverError(hungPendingOrders);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pendingRestore).resolves.toMatchObject({
        code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED',
        retryable: true,
      });

      const hungCompletion = createAitIapController({
        ...commonOptions,
        dependencies: createDependencies({
          iap: createSupportedIap({
            pendingOrders: {
              orders: [{
                orderId: 'pending-completion-order',
                sku: 'ait.ttokdoku.hints.5',
                paymentCompletedDate: '2026-08-08T10:00:00.000Z',
              }],
            },
            completeProductGrant: async () => await new Promise<boolean>(() => {}),
          }),
        }),
      });

      const completionRestore = recover(hungCompletion);
      await vi.advanceTimersByTimeAsync(10);
      await expect(completionRestore).resolves.toEqual({
        restoredEntitlements: [],
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one deadline for all pending-order restore work', async () => {
    vi.useFakeTimers();
    try {
      const values = new Map<string, string>();
      let firstOrderAttempts = 0;
      const verifyIapProductGrant = vi.fn(async ({ orderId }: { readonly orderId: string }) => {
        if (orderId === 'restore-budget-order-1' && firstOrderAttempts === 0) {
          firstOrderAttempts += 1;
          return await new Promise<boolean>(() => {});
        }
        return orderId === 'restore-budget-order-2';
      });
      const completeProductGrant = vi.fn(async () => true);
      const iap = createAitIapController({
        iapProducts: [{ productId: 'HINT_PACK_5', sku: 'ait.ttokdoku.hints.5' }],
        prepareIap: async () => true,
        verifyIapProductGrant,
        iapProductGrantTimeoutMs: 10,
        dependencies: createDependencies({
          storage: createMemoryStorage(values),
          iap: createSupportedIap({
            pendingOrders: {
              orders: [
                {
                  orderId: 'restore-budget-order-1',
                  sku: 'ait.ttokdoku.hints.5',
                  paymentCompletedDate: '2026-08-08T10:00:00.000Z',
                },
                {
                  orderId: 'restore-budget-order-2',
                  sku: 'ait.ttokdoku.hints.5',
                  paymentCompletedDate: '2026-08-08T10:00:00.000Z',
                },
              ],
            },
            completeProductGrant,
          }),
        }),
      });

      const restore = recover(iap);
      await vi.advanceTimersByTimeAsync(10);

      await expect(restore).resolves.toEqual({
        restoredEntitlements: [],
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
      });
      expect(verifyIapProductGrant).toHaveBeenCalledTimes(1);
      expect(completeProductGrant).not.toHaveBeenCalled();
      expect(values.get('mpgd:ait:pending-order-cursor:v1')).toBe('restore-budget-order-1');

      await expect(recover(iap)).resolves.toEqual({
        restoredEntitlements: [{
          id: 'HINT_PACK_5',
          source: 'purchase',
          grantedAt: '2026-08-08T10:00:00.000Z',
        }],
        settledPurchases: [{
          transactionId: 'restore-budget-order-2',
          productId: 'HINT_PACK_5',
          status: 'granted',
        }],
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
      });
      expect(verifyIapProductGrant.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        orderId: 'restore-budget-order-2',
      }));
      expect(completeProductGrant).toHaveBeenCalledWith({
        params: { orderId: 'restore-budget-order-2' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves v1 notification requests from the v2 provider with a v1-only session cache', async () => {
    let callbacks: NotificationAgreementCallbacks | undefined;
    let cleanupCount = 0;
    const requestAgreement = Object.assign(
      (input: NotificationAgreementCallbacks) => {
        callbacks = input;
        return () => {
          cleanupCount += 1;
        };
      },
      { isSupported: () => true },
    );
    const bridge = createAitHostBridge({
      notificationTemplateCodes: { 'streak-at-risk': 'TTOKDOKU_STREAK_ALERT' },
      dependencies: createDependencies({ requestNotificationAgreement: requestAgreement }),
    });

    await expect(request(bridge, 'notifications.getStatus', {
      topic: 'daily-ready',
    })).resolves.toBe('configuration-required');
    await expect(request(bridge, 'notifications.requestSubscription', {
      topic: 'daily-ready',
    })).resolves.toBe('unavailable');
    await expect(request(bridge, 'notifications.getStatus', {
      topic: 'streak-at-risk',
    })).resolves.toBe('not-subscribed');

    const subscription = request(bridge, 'notifications.requestSubscription', {
      topic: 'streak-at-risk',
    });
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    expect(callbacks?.options).toEqual({ templateCode: 'TTOKDOKU_STREAK_ALERT' });
    callbacks?.onEvent({ type: 'newAgreement' });
    await expect(subscription).resolves.toBe('subscribed');
    // The host gives no read: v1 remembers this bridge's agreement, while
    // v2 keeps reading `unknown` so the runtime takes the backend record.
    await expect(request(bridge, 'notifications.getStatus', {
      topic: 'streak-at-risk',
    })).resolves.toBe('subscribed');
    expect(cleanupCount).toBe(1);

    const v2 = await request(bridge, 'notifications.v2.getPermission', {
      topics: ['streak-at-risk', 'daily-ready'],
    });
    expect(v2).toEqual({ topics: { 'streak-at-risk': 'unknown', 'daily-ready': 'unsupported' } });

    // A denial through v2 clears it; an agreement through v2 sets it again.
    // Read through a function: TypeScript would narrow the reassigned variable.
    const latestCallbacks = (): NotificationAgreementCallbacks | undefined => callbacks;
    callbacks = undefined;
    const denied = request(bridge, 'notifications.v2.requestPermission', { topics: ['streak-at-risk'] });
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    latestCallbacks()?.onEvent({ type: 'agreementRejected' });
    await denied;
    await expect(request(bridge, 'notifications.getStatus', {
      topic: 'streak-at-risk',
    })).resolves.toBe('not-subscribed');
    callbacks = undefined;
    const agreed = request(bridge, 'notifications.v2.requestPermission', { topics: ['streak-at-risk'] });
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    latestCallbacks()?.onEvent({ type: 'alreadyAgreed' });
    await agreed;
    await expect(request(bridge, 'notifications.getStatus', {
      topic: 'streak-at-risk',
    })).resolves.toBe('subscribed');
    // A new bridge (a restart) starts without the cache.
    const restarted = createAitHostBridge({
      notificationTemplateCodes: { 'streak-at-risk': 'TTOKDOKU_STREAK_ALERT' },
      dependencies: createDependencies({ requestNotificationAgreement: requestAgreement }),
    });
    await expect(request(restarted, 'notifications.getStatus', {
      topic: 'streak-at-risk',
    })).resolves.toBe('not-subscribed');
  });

  it('maps v1 requests through the v2 outcomes: rejected, dismissed, and too-old hosts', async () => {
    vi.useFakeTimers();
    try {
      let callbacks: NotificationAgreementCallbacks | undefined;
      let supported = true;
      const requestAgreement = Object.assign(
        (input: NotificationAgreementCallbacks) => {
          callbacks = input;
          return () => {};
        },
        { isSupported: () => supported },
      );
      const bridge = createAitHostBridge({
        notificationTemplateCodes: { 'streak-at-risk': 'TTOKDOKU_STREAK_ALERT' },
        dependencies: createDependencies({ requestNotificationAgreement: requestAgreement }),
      });

      const rejected = request(bridge, 'notifications.requestSubscription', { topic: 'streak-at-risk' });
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      callbacks?.onEvent({ type: 'agreementRejected' });
      await expect(rejected).resolves.toBe('rejected');

      callbacks = undefined;
      const dismissed = request(bridge, 'notifications.requestSubscription', { topic: 'streak-at-risk' });
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(dismissed).resolves.toBe('unavailable');

      supported = false;
      await expect(request(bridge, 'notifications.getStatus', {
        topic: 'streak-at-risk',
      })).resolves.toBe('unsupported');
      await expect(request(bridge, 'notifications.requestSubscription', {
        topic: 'streak-at-risk',
      })).resolves.toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves notifications v2 methods and answers the methods Apps in Toss lacks', async () => {
    const bridge = createAitHostBridge({
      notificationTopics: {
        receipt: { templateSetCode: 'ttokdoku-receipt', agreement: 'none' },
      },
      dependencies: createDependencies(),
    });

    await expect(request(bridge, 'notifications.v2.getCapabilities', {
      protocol: 'mpgd.notifications.v2',
    })).resolves.toMatchObject({
      provider: 'apps-in-toss',
      capabilities: {
        availability: 'available',
        permission: { scope: 'topic', prompt: 'host', readable: false, userGesture: true },
        remote: { supported: true, addressing: 'platform-user', content: 'host-template' },
        local: { supported: false },
        open: 'landing-url',
      },
    });
    await expect(request(bridge, 'notifications.v2.requestPermission', {
      topics: ['receipt'],
    })).resolves.toEqual({
      snapshot: { topics: { receipt: 'granted' } },
      outcomes: { receipt: 'already-granted' },
    });
    await expect(request(bridge, 'notifications.v2.register', {
      protocol: 'mpgd.notifications.v2',
    })).resolves.toMatchObject({
      registration: { provider: 'apps-in-toss', address: { kind: 'platform-user' } },
    });
    await expect(request(bridge, 'notifications.v2.openSettings', {
      protocol: 'mpgd.notifications.v2',
    })).resolves.toEqual({ status: 'unavailable' });
    for (const [method, payload] of [
      ['notifications.v2.scheduleLocal', {
        key: 'k',
        topic: 'receipt',
        fireAt: '2026-10-19T00:00:00Z',
        title: 't',
        body: 'b',
      }],
      ['notifications.v2.revokePermission', { topics: ['receipt'] }],
      ['notifications.v2.listLocal', { protocol: 'mpgd.notifications.v2' }],
      ['notifications.v2.cancelLocal', { keys: ['k'] }],
    ] as const) {
      await expect(requestError(bridge, method, payload)).resolves.toMatchObject({
        code: 'NOTIFICATIONS_UNSUPPORTED',
        retryable: false,
      });
    }
    await expect(requestError(bridge, 'notifications.v2.getPermission', { topics: 'receipt' }))
      .resolves.toMatchObject({ code: 'NOTIFICATIONS_INVALID_INPUT', retryable: false });
  });

  it('reads a v1 topic mapped without agreement as subscribed without a sheet', async () => {
    const requestAgreement = vi.fn(() => () => {});
    const bridge = createAitHostBridge({
      notificationTopics: {
        'friend-challenge': { templateSetCode: 'ttokdoku-challenge', agreement: 'none' },
      },
      dependencies: createDependencies({
        requestNotificationAgreement: Object.assign(requestAgreement, { isSupported: () => true }),
      }),
    });
    await expect(request(bridge, 'notifications.getStatus', { topic: 'friend-challenge' }))
      .resolves.toBe('subscribed');
    await expect(request(bridge, 'notifications.requestSubscription', { topic: 'friend-challenge' }))
      .resolves.toBe('subscribed');
    expect(requestAgreement).not.toHaveBeenCalled();
  });

  it('answers home for a launch from a Toss push and leaves its route to the cold open', async () => {
    const bridge = createAitHostBridge({
      notificationTopics: {
        'energy-full': { templateSetCode: 'ttokdoku-energy-full', agreement: 'required' },
      },
      dependencies: createDependencies({
        readInitialUrl: () => 'intoss://ttokdoku/daily?entry=daily&puzzleId=p1&referrer=push',
      }),
    });
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((event) => events.push(event));

    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'home',
    });
    expect(events).toEqual([
      {
        protocol: 'mpgd.notifications.v2',
        sequence: 0,
        event: {
          type: 'opened',
          channel: 'remote',
          source: 'cold',
          referrer: 'push',
          route: '/daily?entry=daily&puzzleId=p1',
        },
      },
    ]);
  });

  it('preserves the original dispatch timestamp when a delayed native exception is recorded', async () => {
    vi.useFakeTimers();
    try {
      const start = '2026-10-19T00:00:00.000Z';
      vi.setSystemTime(new Date(start));
      const values = new Map<string, string>();
      const bridge = createAitHostBridge({
        promotionRewards: { DAILY: { promotionCode: 'PROMO', amount: 1 } },
        authorizePromotionGrant: async () => ({ status: 'authorized' }),
        dependencies: createDependencies({ grantPromotionReward: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          throw new Error('native reply lost');
        }, storage: {
          getItem: async (key) => values.get(key) ?? null,
          setItem: async (key, value) => { values.set(key, value); },
          removeItem: async (key) => { values.delete(key); },
        } }),
      });
      const work = request(bridge, 'promotions.grantReward', { campaignId: 'DAILY', idempotencyKey: 'delayed' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await work).toEqual({ status: 'pending' });
      for (const value of values.values()) {
        expect(JSON.parse(value)).toMatchObject({ pendingSince: start, errorCode: 'NATIVE_EXCEPTION' });
      }
    } finally { vi.useRealTimers(); }
  });

  it.each(['undefined', 'malformed', 'exception', 'coded-exception'] as const)(
    'replays %s diagnostics after restart without issuing another payment', async (kind) => {
      const values = new Map<string, string>();
      const grant = vi.fn(async () => {
        if (kind === 'exception') { throw new Error('private native detail'); }
        if (kind === 'coded-exception') { throw { errorCode: '4110', message: 'private detail' }; }
        return kind === 'undefined' ? undefined : { key: '' };
      });
      const observation = vi.fn(async () => {});
      const create = () => createAitHostBridge({
        promotionRewards: { DAILY: { promotionCode: 'PROMO', amount: 1 } },
        authorizePromotionGrant: async () => ({ status: 'authorized' }),
        observePromotionGrant: observation,
        dependencies: createDependencies({ grantPromotionReward: grant, storage: {
          getItem: async (key) => values.get(key) ?? null,
          setItem: async (key, value) => { values.set(key, value); },
          removeItem: async (key) => { values.delete(key); },
        } }),
      });
      const payload = { campaignId: 'DAILY', idempotencyKey: `diagnostic-${kind}` };
      expect(await request(create(), 'promotions.grantReward', payload)).toEqual({ status: 'pending' });
      observation.mockClear();
      expect(await request(create(), 'promotions.recoverReward', payload)).toEqual({ status: 'pending' });
      const code = kind === 'undefined' ? 'UNSUPPORTED_VERSION' : kind === 'malformed' ? 'UNKNOWN_RESPONSE' : kind === 'coded-exception' ? '4110' : 'NATIVE_EXCEPTION';
      expect(observation).toHaveBeenCalledWith({ ...payload, status: 'pending', errorCode: code });
      expect(grant).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([...values.values()])).not.toContain('private');
    },
  );

  it('recovers a successful SDK response from bridge memory when receipt storage and observer fail', async () => {
    const values = new Map<string, string>();
    const grant = vi.fn(async () => ({ key: 'late-success' }));
    const authorize = vi.fn(async () => ({ status: 'authorized' as const }));
    const observer = vi.fn(async (): Promise<void> => { throw new Error('offline'); });
    const bridge = createAitHostBridge({
      promotionRewards: { DAILY: { promotionCode: 'PROMO', amount: 1 } },
      authorizePromotionGrant: authorize, observePromotionGrant: observer,
      dependencies: createDependencies({ grantPromotionReward: grant, storage: {
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
          if (value.includes('late-success')) { throw new Error('storage full'); }
          values.set(key, value);
        },
        removeItem: async (key) => { values.delete(key); },
      } }),
    });
    const payload = { campaignId: 'DAILY', idempotencyKey: 'memory-success' };
    expect(await request(bridge, 'promotions.grantReward', payload)).toEqual({ status: 'granted', receiptKey: 'late-success' });
    observer.mockResolvedValue(undefined);
    expect(await request(bridge, 'promotions.recoverReward', payload)).toEqual({ status: 'granted', receiptKey: 'late-success' });
    expect(grant).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenLastCalledWith({ ...payload, status: 'granted', receiptKey: 'late-success' });
  });

  it('reads a persisted receipt even when native payout is currently unsupported', async () => {
    const grant = vi.fn(async () => ({ key: 'must-not-pay' }));
    const bridge = createAitHostBridge({
      promotionRewards: { DAILY: { promotionCode: 'PROMO', amount: 1 } },
      dependencies: createDependencies({ grantPromotionReward: grant, isMinVersionSupported: () => false, storage: {
        getItem: async () => JSON.stringify({ status: 'granted', receiptKey: 'cached-success' }),
        setItem: async () => {}, removeItem: async () => {},
      } }),
    });
    expect(await request(bridge, 'promotions.recoverReward', { campaignId: 'DAILY', idempotencyKey: 'cached' })).toEqual({ status: 'granted', receiptKey: 'cached-success' });
    expect(grant).not.toHaveBeenCalled();
  });

  it.each([false, true])('persists markerless authority receipts without inventing time (read failure: %s)', async (readFails) => {
    const values = new Map<string, string>();
    let failRead = readFails;
    const receiptKey = 'r'.repeat(600);
    const resolver = vi.fn(async () => ({ status: 'granted' as const, receiptKey }));
    const grant = vi.fn(async () => ({ key: 'must-not-pay' }));
    const create = () => createAitHostBridge({
      promotionRewards: { DAILY: { promotionCode: 'PROMO', amount: 1 } },
      resolvePendingPromotionGrant: resolver,
      dependencies: createDependencies({ grantPromotionReward: grant, isMinVersionSupported: () => false, storage: {
        getItem: async (key) => { if (failRead) { throw new Error('temporary storage failure'); } return values.get(key) ?? null; },
        setItem: async (key, value) => { values.set(key, value); },
        removeItem: async (key) => { values.delete(key); },
      } }),
    });
    const payload = { campaignId: 'DAILY', idempotencyKey: 'markerless' };
    expect(await request(create(), 'promotions.recoverReward', payload)).toEqual({ status: 'granted', receiptKey });
    expect(resolver).toHaveBeenCalledWith(payload);
    expect(values.size).toBe(1);
    failRead = false;
    resolver.mockRejectedValue(new Error('authority offline'));
    expect(await request(create(), 'promotions.recoverReward', payload)).toEqual({ status: 'granted', receiptKey });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(grant).not.toHaveBeenCalled();
  });

  it('recovers without storage by consulting the authority and never dispatches a new payment', async () => {
    const grant = vi.fn(async () => ({ key: 'must-not-pay' }));
    const authorize = vi.fn(async () => ({ status: 'authorized' as const }));
    const observer = vi.fn(async () => {});
    const bridge = createAitHostBridge({
      promotionRewards: { DAILY: { promotionCode: 'PROMO', amount: 1 } },
      authorizePromotionGrant: authorize,
      resolvePendingPromotionGrant: async () => ({ status: 'granted', receiptKey: 'server-receipt' }),
      observePromotionGrant: observer,
      dependencies: createDependencies({ grantPromotionReward: grant }),
    });
    expect(await request(bridge, 'promotions.recoverReward', { campaignId: 'DAILY', idempotencyKey: 'old-claim' })).toEqual({ status: 'granted', receiptKey: 'server-receipt' });
    expect(grant).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ status: 'granted', receiptKey: 'server-receipt' }));
  });
  it('never turns a recovery-only retry resolution into a payout or removes its pending fence', async () => {
    const grant = vi.fn(async () => ({ key: 'must-not-pay' }));
    const removeItem = vi.fn(async () => {});
    const bridge = createAitHostBridge({
      promotionRewards: { DAILY: { promotionCode: 'PROMO', amount: 1 } },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      resolvePendingPromotionGrant: async () => ({ status: 'retry' }),
      dependencies: createDependencies({ grantPromotionReward: grant, storage: {
        getItem: async () => JSON.stringify({ status: 'pending', pendingSince: new Date().toISOString() }),
        setItem: async () => {}, removeItem,
      } }),
    });
    expect(await request(bridge, 'promotions.recoverReward', { campaignId: 'DAILY', idempotencyKey: 'pending' })).toEqual({ status: 'pending' });
    expect(grant).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('deduplicates promotion grants with the server-issued claim id', async () => {
    const values = new Map<string, string>();
    const grantPromotion = vi.fn(async () => ({ key: 'promotion-receipt-1' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        grantPromotionReward: grantPromotion,
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.getAvailability', {
      campaignId: 'SEVEN_DAY_STREAK',
    })).resolves.toBe('available');
    await expect(request(bridge, 'promotions.getAvailability', {
      campaignId: 'UNCONFIGURED',
    })).resolves.toBe('configuration-required');

    const claim = {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-7d-1',
    };
    await expect(request(bridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'granted',
      receiptKey: 'promotion-receipt-1',
    });
    await expect(request(bridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'granted',
      receiptKey: 'promotion-receipt-1',
    });
    expect(grantPromotion).toHaveBeenCalledOnce();
    expect(grantPromotion).toHaveBeenCalledWith({
      params: { promotionCode: 'PROMOTION_7D', amount: 100 },
    });
  });

  it('keeps an ambiguous promotion attempt pending instead of double granting', async () => {
    const values = new Map<string, string>();
    let providerResponseLost = true;
    const grantPromotion = vi.fn(async () => {
      if (providerResponseLost) {
        throw new Error('native response lost');
      }
      return { key: 'promotion-receipt-recovered' };
    });
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      removeItem: async (key: string) => {
        values.delete(key);
      },
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const promotionRewards = {
      SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
    } as const;
    const bridge = createAitHostBridge({
      promotionRewards,
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({ grantPromotionReward: grantPromotion, storage }),
    });
    const claim = {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-ambiguous-1',
    };

    await expect(request(bridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'pending',
    });
    await expect(request(bridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'pending',
    });
    expect(grantPromotion).toHaveBeenCalledOnce();

    providerResponseLost = false;
    const resolvePendingPromotionGrant = vi.fn(async () => ({ status: 'retry' as const }));
    const recoveredBridge = createAitHostBridge({
      promotionRewards,
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      resolvePendingPromotionGrant,
      dependencies: createDependencies({ grantPromotionReward: grantPromotion, storage }),
    });
    await expect(request(recoveredBridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'granted',
      receiptKey: 'promotion-receipt-recovered',
    });
    expect(resolvePendingPromotionGrant).toHaveBeenCalledWith({
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-ambiguous-1',
      pendingSince: expect.any(String),
    });
    expect(grantPromotion).toHaveBeenCalledTimes(2);
  });

  it.each(['cached', 'resolved'] as const)('replays %s successful receipts to a restarted observer without native payout', async (kind) => {
    const values = new Map<string, string>();
    const grantPromotionReward = vi.fn(async () => ({ key: 'observed-receipt' }));
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); },
    };
    const claim = { campaignId: 'DAILY', idempotencyKey: 'observer-recovery' };
    const promotionRewards = { DAILY: { promotionCode: 'TEST_DAILY', amount: 1 } };
    const failedObserver = vi.fn(async () => { throw new Error('authority unavailable'); });
    const first = createAitHostBridge({ promotionRewards, observePromotionGrant: failedObserver,
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({ grantPromotionReward, storage }),
    });
    await expect(request(first, 'promotions.grantReward', claim)).resolves.toEqual({ status: 'granted', receiptKey: 'observed-receipt' });
    expect(failedObserver).toHaveBeenCalledTimes(1);
    if (kind === 'resolved') {
      for (const key of values.keys()) { values.set(key, JSON.stringify({ status: 'pending', pendingSince: new Date().toISOString() })); }
    }
    const observePromotionGrant = vi.fn(async () => {});
    const resolvePendingPromotionGrant = vi.fn(async () => ({ status: 'granted' as const, receiptKey: 'observed-receipt' }));
    const restarted = createAitHostBridge({ promotionRewards, observePromotionGrant, resolvePendingPromotionGrant,
      dependencies: createDependencies({ grantPromotionReward, storage }),
    });
    await expect(request(restarted, 'promotions.grantReward', claim)).resolves.toEqual({ status: 'granted', receiptKey: 'observed-receipt' });
    expect(observePromotionGrant).toHaveBeenCalledWith({ ...claim, status: 'granted', receiptKey: 'observed-receipt' });
    expect(grantPromotionReward).toHaveBeenCalledTimes(1);
    expect(resolvePendingPromotionGrant).toHaveBeenCalledTimes(kind === 'resolved' ? 1 : 0);
  });

  it('retains provider failure codes and the dispatch fence across host restarts', async () => {
    const values = new Map<string, string>();
    const providerResponses: unknown[] = [
      {
        errorCode: 'PROMOTION_NOT_ELIGIBLE',
        message: 'The promotion is not available for this user.',
      },
      'ERROR',
    ];
    const grantPromotionReward = vi.fn(async () => providerResponses.shift());
    const observePromotionGrant = vi.fn(async () => {});
    const create = () => createAitHostBridge({
      observePromotionGrant,
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        // Exercise provider-declared failure shapes that are intentionally wider
        // than the optimistic SDK return type.
        grantPromotionReward: grantPromotionReward as unknown as AitHostDependencies[
          'grantPromotionReward'
        ],
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(create(), 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-provider-rejected',
    })).resolves.toEqual({ status: 'failed' });
    expect(values.size).toBe(1);
    await expect(request(create(), 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-provider-rejected',
    })).resolves.toEqual({ status: 'failed' });
    expect(values.size).toBe(1);
    expect(grantPromotionReward).toHaveBeenCalledTimes(1);
    expect(observePromotionGrant).toHaveBeenCalledWith({ campaignId: 'SEVEN_DAY_STREAK', idempotencyKey: 'server-claim-provider-rejected', status: 'failed', errorCode: 'PROMOTION_NOT_ELIGIBLE' });
    expect(JSON.stringify([...values.values()])).not.toContain('not available for this user');
    expect(JSON.stringify(observePromotionGrant.mock.calls)).not.toContain('message');
  });

  it('does not lose a successful receipt when its observer rejects or stalls', async () => {
    vi.useFakeTimers();
    try {
      for (const observer of [async () => { throw new Error('report offline'); }, () => new Promise<void>(() => {})]) {
        const observePromotionGrant = vi.fn(observer);
        const grantPromotionReward = vi.fn(async () => ({ key: 'safe-receipt' }));
        const bridge = createAitHostBridge({
          promotionRewards: { DAILY: { promotionCode: 'TEST_DAILY', amount: 1 } },
          authorizePromotionGrant: async () => ({ status: 'authorized' }),
          observePromotionGrant,
          dependencies: createDependencies({ grantPromotionReward }),
        });
        const result = request(bridge, 'promotions.grantReward', { campaignId: 'DAILY', idempotencyKey: 'observer-claim' });
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(result).resolves.toEqual({ status: 'granted', receiptKey: 'safe-receipt' });
        expect(grantPromotionReward).toHaveBeenCalledTimes(1);
        expect(observePromotionGrant).toHaveBeenCalledWith({ campaignId: 'DAILY', idempotencyKey: 'observer-claim', status: 'granted', receiptKey: 'safe-receipt' });
      }
    } finally { vi.useRealTimers(); }
  });

  it('keeps an undocumented promotion response pending for server reconciliation', async () => {
    const values = new Map<string, string>();
    const grantPromotionReward = vi.fn(async () => ({ unexpected: true }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        // Native bridges can return undocumented data even when the SDK type is
        // narrower, so keep this malformed-response test at the dependency edge.
        grantPromotionReward: grantPromotionReward as unknown as AitHostDependencies[
          'grantPromotionReward'
        ],
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-undocumented-response',
    })).resolves.toEqual({ status: 'pending' });
    expect(values.size).toBe(1);
  });

  it('preserves the original dispatch marker if storing the failure code fails', async () => {
    const values = new Map<string, string>();
    let writes = 0;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        promotionRewards: {
          SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
        },
        authorizePromotionGrant: async () => ({ status: 'authorized' }),
        dependencies: createDependencies({
          grantPromotionReward: vi.fn(async () => 'ERROR') as unknown as AitHostDependencies[
            'grantPromotionReward'
          ],
          storage: {
            getItem: async (key) => values.get(key) ?? null,
            removeItem: async () => {
              throw new Error('storage unavailable');
            },
            setItem: async (key, value) => {
              if (++writes > 1) { throw new Error('disk full'); }
              values.set(key, value);
            },
          },
        }),
      });

      await expect(request(bridge, 'promotions.grantReward', {
        campaignId: 'SEVEN_DAY_STREAK',
        idempotencyKey: 'server-claim-provider-rejected-storage-error',
      })).resolves.toEqual({ status: 'failed' });
      expect(values.size).toBe(1);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('disables an invalid promotion without blocking the remaining bridge', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        promotionRewards: {
          INVALID: { promotionCode: 'PROMOTION_INVALID', amount: 0 },
        },
        dependencies: createDependencies(),
      });

      await expect(request(bridge, 'promotions.getAvailability', {
        campaignId: 'INVALID',
      })).resolves.toBe('configuration-required');
      await expect(request(bridge, 'identity.getSession', {})).resolves.toMatchObject({
        playerId: 'test-player',
      });
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it('keeps configured promotions unavailable without initial server authorization', async () => {
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      dependencies: createDependencies({ grantPromotionReward }),
    });

    await expect(request(bridge, 'promotions.getAvailability', {
      campaignId: 'SEVEN_DAY_STREAK',
    })).resolves.toBe('configuration-required');
    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'invented-client-claim',
    })).resolves.toEqual({ status: 'unavailable' });
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('does not dispatch a provider grant when the game backend rejects the claim', async () => {
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const authorizePromotionGrant = vi.fn(async () => ({ status: 'rejected' as const }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant,
      dependencies: createDependencies({ grantPromotionReward }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'invented-client-claim',
    })).resolves.toEqual({ status: 'unavailable' });
    expect(authorizePromotionGrant).toHaveBeenCalledWith({
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'invented-client-claim',
    });
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('does not reopen a reconciled grant when receipt caching fails', async () => {
    const storageKey = 'mpgd:ait:promotion-grant:v1:server-claim-cache-failure';
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const resolvePendingPromotionGrant = vi.fn(async () => ({
      status: 'granted' as const,
      receiptKey: 'server-reconciled-receipt',
    }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      resolvePendingPromotionGrant,
      dependencies: createDependencies({
        grantPromotionReward,
        storage: {
          getItem: async (key) => key === storageKey
            ? JSON.stringify({ status: 'pending', pendingSince: '2026-07-22T00:00:00.000Z' })
            : null,
          removeItem: async () => {},
          setItem: async () => {
            throw new Error('storage unavailable');
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-cache-failure',
    })).resolves.toEqual({ status: 'granted', receiptKey: 'server-reconciled-receipt' });
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('returns a native receipt even when its terminal cache write fails', async () => {
    let writeCount = 0;
    const grantPromotionReward = vi.fn(async () => ({ key: 'native-receipt' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        grantPromotionReward,
        storage: {
          getItem: async () => null,
          removeItem: async () => {},
          setItem: async () => {
            writeCount += 1;
            if (writeCount === 2) {
              throw new Error('terminal cache unavailable');
            }
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-native-cache-failure',
    })).resolves.toEqual({ status: 'granted', receiptKey: 'native-receipt' });
    expect(grantPromotionReward).toHaveBeenCalledOnce();
  });

  it('fails closed when a persisted promotion marker is corrupt', async () => {
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        grantPromotionReward,
        storage: {
          getItem: async () => '{not-json',
          removeItem: async () => {},
          setItem: async () => {},
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-corrupt-marker',
    })).resolves.toEqual({ status: 'pending' });
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('fails closed for legacy pending state and an invalid reconciled receipt', async () => {
    const values = new Map<string, string>([
      [
        'mpgd:ait:promotion-grant:v1:legacy-claim',
        JSON.stringify({ status: 'pending' }),
      ],
    ]);
    const resolvePendingPromotionGrant = vi.fn(async () => ({
      status: 'granted' as const,
      receiptKey: '   ',
    }));
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      resolvePendingPromotionGrant,
      dependencies: createDependencies({
        grantPromotionReward,
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'legacy-claim',
    })).resolves.toEqual({ status: 'pending' });
    expect(resolvePendingPromotionGrant).not.toHaveBeenCalled();
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('returns a protocol error for a malformed runtime bridge call', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });
    const response: unknown = await Reflect.apply(bridge.request, bridge, [null]);
    const legacyResponse: unknown = await Reflect.apply(bridge.request, bridge, [{
      id: 'legacy-request',
      method: 'runtime.getCapabilities',
      payload: {},
    }]);

    expect(response).toMatchObject({
      id: 'ait-invalid-request',
      ok: false,
      error: {
        code: 'AIT_BRIDGE_REQUEST_FAILED',
        retryable: true,
      },
    });
    expect(legacyResponse).toMatchObject({
      id: 'legacy-request',
      ok: false,
      error: { code: 'AIT_BRIDGE_REQUEST_FAILED' },
    });
  });

  it('treats a configured preload as a no-op when Ads 2.0 is unsupported', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        dependencies: createDependencies(),
      });

      await expect(request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      })).resolves.toEqual({});
      await expect(request(bridge, 'ads.preload', {
        placementId: 'UNKNOWN_PLACEMENT',
      })).rejects.toThrow('AIT ad placement is unavailable: UNKNOWN_PLACEMENT');
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        'AIT full-screen ads are not supported; configured preload is a no-op.',
        'SUDOKU_HINT_REWARDED',
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('mounts and destroys a configured inline banner by game-owned surface id', async () => {
    const destroy = vi.fn();
    const surface = {} as HTMLElement;
    const getElementById = vi.fn((id: string) => id === '1.game-banner' ? surface : null);
    const initialize = Object.assign(
      vi.fn((options: Parameters<AitHostDependencies['tossAds']['initialize']>[0]) => {
        options.callbacks?.onInitialized?.();
      }),
      { isSupported: () => true },
    );
    const attachBanner = Object.assign(
      vi.fn((
        _adGroupId: string,
        _target: string | HTMLElement,
        options?: Parameters<AitHostDependencies['tossAds']['attachBanner']>[2],
      ) => {
        globalThis.queueMicrotask(() => options?.callbacks?.onAdRendered?.({
          slotId: 'slot-1',
          adGroupId: 'ait-banner-group',
          adMetadata: { creativeId: 'creative-1', requestId: 'request-1' },
        }));
        return { destroy };
      }),
      { isSupported: () => true },
    );
    vi.stubGlobal('document', { getElementById });

    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_GAMEPLAY_BANNER: 'ait-banner-group' },
        adPlacementTypes: { SUDOKU_GAMEPLAY_BANNER: 'banner' },
        dependencies: createDependencies({ tossAds: { initialize, attachBanner } }),
      });

      await expect(request(bridge, 'runtime.getCapabilities', {})).resolves.toMatchObject({
        nativeAds: true,
        bannerAds: true,
        rewardedAds: false,
        interstitialAds: false,
      });
      await expect(request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_GAMEPLAY_BANNER',
      })).resolves.toEqual({});
      await expect(request(bridge, 'ads.mountBanner', {
        placementId: 'SUDOKU_GAMEPLAY_BANNER',
        surfaceId: '1.game-banner',
      })).resolves.toEqual({ status: 'mounted' });
      expect(initialize).toHaveBeenCalledOnce();
      expect(attachBanner).toHaveBeenCalledWith(
        'ait-banner-group',
        surface,
        expect.objectContaining({ theme: 'dark', variant: 'expanded' }),
      );

      await expect(request(bridge, 'ads.unmountBanner', {
        surfaceId: '1.game-banner',
      })).resolves.toEqual({});
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps only the newest concurrent mount for one inline banner surface', async () => {
    let initializeOptions: Parameters<AitHostDependencies['tossAds']['initialize']>[0] | undefined;
    let renderBanner: (() => void) | undefined;
    const destroy = vi.fn();
    const surface = {} as HTMLElement;
    const initialize = Object.assign(
      vi.fn((options: Parameters<AitHostDependencies['tossAds']['initialize']>[0]) => {
        initializeOptions = options;
      }),
      { isSupported: () => true },
    );
    const attachBanner = Object.assign(
      vi.fn((
        adGroupId: string,
        _target: string | HTMLElement,
        options?: Parameters<AitHostDependencies['tossAds']['attachBanner']>[2],
      ) => {
        renderBanner = () => options?.callbacks?.onAdRendered?.({
          slotId: 'newest-slot',
          adGroupId,
          adMetadata: { creativeId: 'creative-2', requestId: 'request-2' },
        });
        return { destroy };
      }),
      { isSupported: () => true },
    );
    vi.stubGlobal('document', { getElementById: () => surface });

    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_GAMEPLAY_BANNER: 'ait-banner-group' },
        adPlacementTypes: { SUDOKU_GAMEPLAY_BANNER: 'banner' },
        dependencies: createDependencies({ tossAds: { initialize, attachBanner } }),
      });
      const payload = {
        placementId: 'SUDOKU_GAMEPLAY_BANNER',
        surfaceId: 'gameplay-banner',
      };
      const firstMount = request(bridge, 'ads.mountBanner', payload);
      const secondMount = request(bridge, 'ads.mountBanner', payload);

      await vi.waitFor(() => expect(initializeOptions).toBeDefined());
      initializeOptions?.callbacks?.onInitialized?.();
      await vi.waitFor(() => expect(attachBanner).toHaveBeenCalledOnce());
      renderBanner?.();

      await expect(firstMount).resolves.toEqual({ status: 'unavailable' });
      await expect(secondMount).resolves.toEqual({ status: 'mounted' });
      await request(bridge, 'ads.unmountBanner', { surfaceId: 'gameplay-banner' });
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('settles an attached pending banner immediately when a newer mount replaces it', async () => {
    const renderBanners: Array<() => void> = [];
    const destroyFirst = vi.fn();
    const destroySecond = vi.fn();
    const surface = {} as HTMLElement;
    const initialize = Object.assign(
      vi.fn((options: Parameters<AitHostDependencies['tossAds']['initialize']>[0]) => {
        options.callbacks?.onInitialized?.();
      }),
      { isSupported: () => true },
    );
    const attachBanner = Object.assign(
      vi.fn((
        adGroupId: string,
        _target: string | HTMLElement,
        options?: Parameters<AitHostDependencies['tossAds']['attachBanner']>[2],
      ) => {
        const callIndex = renderBanners.length;
        renderBanners.push(() => options?.callbacks?.onAdRendered?.({
          slotId: `slot-${String(callIndex + 1)}`,
          adGroupId,
          adMetadata: {
            creativeId: `creative-${String(callIndex + 1)}`,
            requestId: `request-${String(callIndex + 1)}`,
          },
        }));
        return { destroy: callIndex === 0 ? destroyFirst : destroySecond };
      }),
      { isSupported: () => true },
    );
    vi.stubGlobal('document', { getElementById: () => surface });

    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_GAMEPLAY_BANNER: 'ait-banner-group' },
        adPlacementTypes: { SUDOKU_GAMEPLAY_BANNER: 'banner' },
        dependencies: createDependencies({ tossAds: { initialize, attachBanner } }),
      });
      const payload = {
        placementId: 'SUDOKU_GAMEPLAY_BANNER',
        surfaceId: 'gameplay-banner',
      };
      const firstMount = request(bridge, 'ads.mountBanner', payload);
      await vi.waitFor(() => expect(attachBanner).toHaveBeenCalledOnce());

      const secondMount = request(bridge, 'ads.mountBanner', payload);
      await expect(firstMount).resolves.toEqual({ status: 'unavailable' });
      await vi.waitFor(() => expect(attachBanner).toHaveBeenCalledTimes(2));
      renderBanners[1]?.();

      await expect(secondMount).resolves.toEqual({ status: 'mounted' });
      expect(destroyFirst).toHaveBeenCalledOnce();
      await request(bridge, 'ads.unmountBanner', { surfaceId: 'gameplay-banner' });
      expect(destroySecond).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('settles an attached pending banner immediately when its surface unmounts', async () => {
    const destroy = vi.fn();
    const surface = {} as HTMLElement;
    const initialize = Object.assign(
      vi.fn((options: Parameters<AitHostDependencies['tossAds']['initialize']>[0]) => {
        options.callbacks?.onInitialized?.();
      }),
      { isSupported: () => true },
    );
    const attachBanner = Object.assign(
      vi.fn(() => ({ destroy })),
      { isSupported: () => true },
    );
    vi.stubGlobal('document', { getElementById: () => surface });

    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_GAMEPLAY_BANNER: 'ait-banner-group' },
        adPlacementTypes: { SUDOKU_GAMEPLAY_BANNER: 'banner' },
        dependencies: createDependencies({ tossAds: { initialize, attachBanner } }),
      });
      const payload = {
        placementId: 'SUDOKU_GAMEPLAY_BANNER',
        surfaceId: 'gameplay-banner',
      };
      const mount = request(bridge, 'ads.mountBanner', payload);
      await vi.waitFor(() => expect(attachBanner).toHaveBeenCalledOnce());

      await expect(request(bridge, 'ads.unmountBanner', {
        surfaceId: 'gameplay-banner',
      })).resolves.toEqual({});
      await expect(mount).resolves.toEqual({ status: 'unavailable' });
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats missing Ads 2.0 support constants as unsupported without blocking startup', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diagnostic = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const missingSupportConstant = Object.assign(
      () => () => {},
      {
        isSupported: () => {
          throw new Error('native support constant is unavailable');
        },
      },
    );

    try {
      const bridge = createAitHostBridge({
        adGroupIds: {
          SUDOKU_HINT_REWARDED: 'ait-ad-group-1',
          SUDOKU_BREAK_INTERSTITIAL: 'ait-ad-group-2',
        },
        adPlacementTypes: {
          SUDOKU_HINT_REWARDED: 'rewarded',
          SUDOKU_BREAK_INTERSTITIAL: 'interstitial',
        },
        dependencies: createDependencies({
          loadFullScreenAd: missingSupportConstant,
          showFullScreenAd: missingSupportConstant,
        }),
      });

      await expect(request(bridge, 'runtime.getCapabilities', {})).resolves.toMatchObject({
        nativeAds: false,
        rewardedAds: false,
        interstitialAds: false,
      });
      await expect(request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      })).resolves.toEqual({});
      await expect(request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-1',
      })).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
      await expect(request(bridge, 'ads.showInterstitial', {
        placementId: 'SUDOKU_BREAK_INTERSTITIAL',
      })).resolves.toEqual({ status: 'unavailable' });
      expect(warning).toHaveBeenCalledOnce();
      expect(diagnostic).toHaveBeenCalledWith(
        'AIT capability support check failed; disabling the feature.',
        expect.objectContaining({ message: 'native support constant is unavailable' }),
      );
    } finally {
      diagnostic.mockRestore();
      warning.mockRestore();
    }
  });

  it('returns ungranted candidate evidence after userEarnedReward and dismissal', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    let markShowRegistered = (): void => {};
    const showRegistered = new Promise<void>((resolve) => {
      markShowRegistered = resolve;
    });
    const dependencies = createDependencies({
      loadFullScreenAd: Object.assign(
        (callbacks: LoadAdCallbacks) => {
          loadCallbacks = callbacks;
          return () => {};
        },
        { isSupported: () => true },
      ),
      showFullScreenAd: Object.assign(
        (callbacks: ShowAdCallbacks) => {
          showCallbacks = callbacks;
          markShowRegistered();
          return () => {};
        },
        { isSupported: () => true },
      ),
    });
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies,
    });

    const preload = request(bridge, 'ads.preload', { placementId: 'SUDOKU_HINT_REWARDED' });
    loadCallbacks?.onEvent({ type: 'loaded' });
    await expect(preload).resolves.toEqual({});

    const reward = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-correlation-1',
    });
    await showRegistered;
    showCallbacks?.onEvent({
      type: 'userEarnedReward',
      data: { unitType: 'hint', unitAmount: 1 },
    });
    showCallbacks?.onEvent({ type: 'dismissed' });

    await expect(reward).resolves.toEqual({
      status: 'completed',
      rewardGranted: false,
      evidence: {
        schema: 'apps-in-toss.rewarded-ad.callback.v1',
        payload: {
          event: 'user-earned-reward',
          correlationId: 'reward-correlation-1',
          placementId: 'ait-ad-group-1',
        },
      },
    });
  });

  it('bounds the client-supplied rewarded ad correlation key before touching the ad slot', async () => {
    const loadFullScreenAd = vi.fn(
      Object.assign((_callbacks: LoadAdCallbacks) => () => {}, { isSupported: () => true }),
    );
    const showFullScreenAd = vi.fn(
      Object.assign((_callbacks: ShowAdCallbacks) => () => {}, { isSupported: () => true }),
    );
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({ loadFullScreenAd, showFullScreenAd }),
    });
    const message = 'AIT rewarded ad idempotencyKey must contain 1 to 256 visible characters.';

    for (const idempotencyKey of ['x'.repeat(257), '', 'reward\u0000', 'reward\u200b', 42]) {
      await expect(request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey,
      })).rejects.toThrow(message);
    }
    expect(loadFullScreenAd).not.toHaveBeenCalled();
    expect(showFullScreenAd).not.toHaveBeenCalled();
  });

  it('accepts a maximum-length correlation key and falls back to the request id without one', async () => {
    const loadCallbacks: LoadAdCallbacks[] = [];
    const showCallbacks: ShowAdCallbacks[] = [];
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loadCallbacks.push(callbacks);
            return () => {};
          },
          { isSupported: () => true },
        ),
        showFullScreenAd: Object.assign(
          (callbacks: ShowAdCallbacks) => {
            showCallbacks.push(callbacks);
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });
    const attempts = [
      [
        { placementId: 'SUDOKU_HINT_REWARDED', idempotencyKey: 'x'.repeat(256) },
        'x'.repeat(256),
      ],
      [{ placementId: 'SUDOKU_HINT_REWARDED' }, 'ads.showRewarded:test'],
    ] as const;

    for (const [index, [payload, expectedCorrelationId]] of attempts.entries()) {
      const reward = request(bridge, 'ads.showRewarded', payload);
      await vi.waitFor(() => expect(loadCallbacks).toHaveLength(index + 1));
      loadCallbacks[index]?.onEvent({ type: 'loaded' });
      await vi.waitFor(() => expect(showCallbacks).toHaveLength(index + 1));
      showCallbacks[index]?.onEvent({
        type: 'userEarnedReward',
        data: { unitType: 'hint', unitAmount: 1 },
      });
      showCallbacks[index]?.onEvent({ type: 'dismissed' });
      await expect(reward).resolves.toEqual({
        status: 'completed',
        rewardGranted: false,
        evidence: {
          schema: 'apps-in-toss.rewarded-ad.callback.v1',
          payload: {
            event: 'user-earned-reward',
            correlationId: expectedCorrelationId,
            placementId: 'ait-ad-group-1',
          },
        },
      });
    }
  });

  it('preserves an earned reward during a long displayed ad', async () => {
    vi.useFakeTimers();
    try {
      let loadCallbacks: LoadAdCallbacks | undefined;
      let showCallbacks: ShowAdCallbacks | undefined;
      let markShowRegistered = (): void => {};
      const showRegistered = new Promise<void>((resolve) => {
        markShowRegistered = resolve;
      });
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        adTimeoutMs: 50,
        adDisplayStartTimeoutMs: 100,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            (callbacks: ShowAdCallbacks) => {
              showCallbacks = callbacks;
              markShowRegistered();
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const preload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      loadCallbacks?.onEvent({ type: 'loaded' });
      await preload;

      const reward = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-long-display',
      });
      await showRegistered;
      showCallbacks?.onEvent({ type: 'show' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      showCallbacks?.onEvent({
        type: 'userEarnedReward',
        data: { unitType: 'hint', unitAmount: 1 },
      });
      showCallbacks?.onEvent({ type: 'dismissed' });

      await expect(reward).resolves.toMatchObject({
        status: 'completed',
        rewardGranted: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a long displayed interstitial after native dismissal', async () => {
    vi.useFakeTimers();
    try {
      let loadCallbacks: LoadAdCallbacks | undefined;
      let showCallbacks: ShowAdCallbacks | undefined;
      let markShowRegistered = (): void => {};
      const showRegistered = new Promise<void>((resolve) => {
        markShowRegistered = resolve;
      });
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_BREAK_INTERSTITIAL: 'ait-ad-group-interstitial' },
        adPlacementTypes: { SUDOKU_BREAK_INTERSTITIAL: 'interstitial' },
        adTimeoutMs: 50,
        adDisplayStartTimeoutMs: 100,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            (callbacks: ShowAdCallbacks) => {
              showCallbacks = callbacks;
              markShowRegistered();
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const preload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_BREAK_INTERSTITIAL',
      });
      loadCallbacks?.onEvent({ type: 'loaded' });
      await preload;

      const interstitial = request(bridge, 'ads.showInterstitial', {
        placementId: 'SUDOKU_BREAK_INTERSTITIAL',
      });
      await showRegistered;
      showCallbacks?.onEvent({ type: 'show' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      showCallbacks?.onEvent({ type: 'dismissed' });

      await expect(interstitial).resolves.toEqual({ status: 'shown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains unknown presentation until a late native dismissal', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let loadCallbacks: LoadAdCallbacks | undefined;
      let showCallbacks: ShowAdCallbacks | undefined;
      let markShowRegistered = (): void => {};
      const showRegistered = new Promise<void>((resolve) => {
        markShowRegistered = resolve;
      });
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        adTimeoutMs: 50,
        adMaximumDisplayMs: 100,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            (callbacks: ShowAdCallbacks) => {
              showCallbacks = callbacks;
              markShowRegistered();
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const preload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      loadCallbacks?.onEvent({ type: 'loaded' });
      await preload;

      const reward = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-missing-dismissal',
      });
      await showRegistered;
      showCallbacks?.onEvent({ type: 'show' });
      showCallbacks?.onEvent({
        type: 'userEarnedReward',
        data: { unitType: 'hint', unitAmount: 1 },
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(reward).resolves.toMatchObject({
        status: 'pending',
        rewardGranted: false,
      });
      expect(warning).not.toHaveBeenCalled();
      showCallbacks?.onEvent({ type: 'dismissed' });
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the requested-to-display wait inside the total show timeout', async () => {
    vi.useFakeTimers();
    try {
      let loadCallbacks: LoadAdCallbacks | undefined;
      let showCallbacks: ShowAdCallbacks | undefined;
      let markShowRegistered = (): void => {};
      const showRegistered = new Promise<void>((resolve) => {
        markShowRegistered = resolve;
      });
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        adTimeoutMs: 50,
        adDisplayStartTimeoutMs: 100,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            (callbacks: ShowAdCallbacks) => {
              showCallbacks = callbacks;
              markShowRegistered();
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const preload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      loadCallbacks?.onEvent({ type: 'loaded' });
      await preload;

      const reward = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-total-timeout',
      });
      await showRegistered;
      await vi.advanceTimersByTimeAsync(40);
      showCallbacks?.onEvent({ type: 'requested' });
      await vi.advanceTimersByTimeAsync(10);

      await expect(reward).resolves.toEqual({ status: 'pending', rewardGranted: false });
      showCallbacks?.onEvent({ type: 'failedToShow' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a shared explicit preload failure as non-fatal and logs it once', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const firstPreload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      const secondPreload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      loadCallbacks?.onError(new Error('native load failed'));

      await expect(firstPreload).resolves.toEqual({});
      await expect(secondPreload).resolves.toEqual({});
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('serializes native loads for different full-screen ad groups', async () => {
    const loads: Array<{
      readonly adGroupId: string;
      readonly callbacks: LoadAdCallbacks;
    }> = [];
    const bridge = createAitHostBridge({
      adGroupIds: {
        SUDOKU_HINT_REWARDED: 'ait-ad-group-rewarded',
        SUDOKU_BREAK_INTERSTITIAL: 'ait-ad-group-interstitial',
      },
      adPlacementTypes: {
        SUDOKU_HINT_REWARDED: 'rewarded',
        SUDOKU_BREAK_INTERSTITIAL: 'interstitial',
      },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loads.push({ adGroupId: callbacks.options?.adGroupId ?? 'missing-ad-group', callbacks });
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const rewardedPreload = request(bridge, 'ads.preload', {
      placementId: 'SUDOKU_HINT_REWARDED',
    });
    const interstitialPreload = request(bridge, 'ads.preload', {
      placementId: 'SUDOKU_BREAK_INTERSTITIAL',
    });

    expect(loads.map(({ adGroupId }) => adGroupId)).toEqual(['ait-ad-group-rewarded']);
    loads[0]?.callbacks.onEvent({ type: 'loaded' });
    await rewardedPreload;
    await vi.waitFor(() => {
      expect(loads.map(({ adGroupId }) => adGroupId)).toEqual([
        'ait-ad-group-rewarded',
        'ait-ad-group-interstitial',
      ]);
    });
    loads[1]?.callbacks.onEvent({ type: 'loaded' });

    await expect(interstitialPreload).resolves.toEqual({});
  });

  it('does not let a hung native load extend the next group timeout', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const nativeLoadGroups: string[] = [];
      const bridge = createAitHostBridge({
        adGroupIds: {
          SUDOKU_HINT_REWARDED: 'ait-ad-group-rewarded',
          SUDOKU_BREAK_INTERSTITIAL: 'ait-ad-group-interstitial',
        },
        adPlacementTypes: {
          SUDOKU_HINT_REWARDED: 'rewarded',
          SUDOKU_BREAK_INTERSTITIAL: 'interstitial',
        },
        adTimeoutMs: 50,
        adLoadQueueTimeoutMs: 20,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              nativeLoadGroups.push(callbacks.options?.adGroupId ?? 'missing-ad-group');
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const rewardedPreload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      const interstitialPreload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_BREAK_INTERSTITIAL',
      });
      await vi.advanceTimersByTimeAsync(20);

      await expect(interstitialPreload).resolves.toEqual({});
      expect(nativeLoadGroups).toEqual(['ait-ad-group-rewarded']);
      expect(warning).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30);
      await expect(rewardedPreload).resolves.toEqual({});
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('loads a configured rewarded ad before a direct show request', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    let markShowRegistered = (): void => {};
    const showRegistered = new Promise<void>((resolve) => {
      markShowRegistered = resolve;
    });
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loadCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
        showFullScreenAd: Object.assign(
          (callbacks: ShowAdCallbacks) => {
            showCallbacks = callbacks;
            markShowRegistered();
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const reward = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-direct-show',
    });

    expect(loadCallbacks).toBeDefined();
    expect(showCallbacks).toBeUndefined();
    loadCallbacks?.onEvent({ type: 'loaded' });
    await showRegistered;
    showCallbacks?.onEvent({
      type: 'userEarnedReward',
      data: { unitType: 'hint', unitAmount: 1 },
    });
    showCallbacks?.onEvent({ type: 'dismissed' });

    await expect(reward).resolves.toMatchObject({
      status: 'completed',
      rewardGranted: false,
    });
  });

  it('rejects overlapping shows and reports the first native load failure', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            () => () => {},
            { isSupported: () => true },
          ),
        }),
      });

      const firstShow = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-load-failure-1',
      });
      const secondShow = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-load-failure-2',
      });
      loadCallbacks?.onError(new Error('native load failed'));

      await expect(firstShow).resolves.toEqual({
        status: 'failed',
        rewardGranted: false,
      });
      await expect(secondShow).resolves.toEqual({
        status: 'unavailable',
        rewardGranted: false,
      });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('does not grant a reward when the ad is dismissed without the reward event', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    let markShowRegistered = (): void => {};
    const showRegistered = new Promise<void>((resolve) => {
      markShowRegistered = resolve;
    });
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loadCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
        showFullScreenAd: Object.assign(
          (callbacks: ShowAdCallbacks) => {
            showCallbacks = callbacks;
            markShowRegistered();
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const preload = request(bridge, 'ads.preload', { placementId: 'SUDOKU_HINT_REWARDED' });
    loadCallbacks?.onEvent({ type: 'loaded' });
    await preload;
    const reward = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-correlation-2',
    });
    await showRegistered;
    showCallbacks?.onEvent({ type: 'dismissed' });

    await expect(reward).resolves.toEqual({ status: 'pending', rewardGranted: false });
  });

  it('consumes a preloaded ad before awaiting the native show result', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    let showCount = 0;
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loadCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
        showFullScreenAd: Object.assign(
          (callbacks: ShowAdCallbacks) => {
            showCount += 1;
            showCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const preload = request(bridge, 'ads.preload', { placementId: 'SUDOKU_HINT_REWARDED' });
    loadCallbacks?.onEvent({ type: 'loaded' });
    await preload;

    const firstShow = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-concurrent-1',
    });
    const secondShow = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-concurrent-2',
    });

    await expect(secondShow).resolves.toEqual({
      status: 'unavailable',
      rewardGranted: false,
    });
    showCallbacks?.onEvent({
      type: 'userEarnedReward',
      data: { unitType: 'hint', unitAmount: 1 },
    });
    showCallbacks?.onEvent({ type: 'dismissed' });
    await expect(firstShow).resolves.toMatchObject({
      status: 'completed',
      rewardGranted: false,
    });
    expect(showCount).toBe(1);
  });

  it('treats a missing Game Center environment constant as unsupported', async () => {
    const diagnostic = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const submitScore = vi.fn(async () => ({ statusCode: 'SUCCESS' as const }));
    const openLeaderboard = vi.fn(async () => {});

    try {
      const bridge = createAitHostBridge({
        dependencies: createDependencies({
          isMinVersionSupported: () => {
            throw new Error('getOperationalEnvironment is not a constant handler');
          },
          submitGameCenterLeaderBoardScore: submitScore,
          openGameCenterLeaderboard: openLeaderboard,
        }),
      });

      await expect(request(bridge, 'runtime.getCapabilities', {})).resolves.toMatchObject({
        nativeLeaderboard: false,
        remoteLeaderboard: false,
      });
      await expect(request(bridge, 'leaderboard.submitScore', { score: 42 })).resolves.toEqual({
        submitted: false,
      });
      await expect(request(bridge, 'leaderboard.open', {})).resolves.toEqual({});
      expect(submitScore).not.toHaveBeenCalled();
      expect(openLeaderboard).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith(
        'AIT capability support check failed; disabling the feature.',
        expect.objectContaining({
          message: 'getOperationalEnvironment is not a constant handler',
        }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('delegates supported Game Center score submission and opening', async () => {
    const submittedScores: string[] = [];
    let openCount = 0;
    const bridge = createAitHostBridge({
      dependencies: createDependencies({
        submitGameCenterLeaderBoardScore: async ({ score }) => {
          submittedScores.push(score);
          return { statusCode: 'SUCCESS' };
        },
        openGameCenterLeaderboard: async () => {
          openCount += 1;
        },
      }),
    });

    await expect(request(bridge, 'leaderboard.submitScore', { score: 42 })).resolves.toEqual({
      submitted: true,
    });
    await expect(request(bridge, 'leaderboard.open', {})).resolves.toEqual({});
    expect(submittedScores).toEqual(['42']);
    expect(openCount).toBe(1);
  });
});

describe('AIT IAP recovery hardening', () => {
  const coinsSku = 'ait.game.coins.100';
  const gemsSku = 'ait.game.gems.10';
  const coinsProduct = { productId: 'COINS_100' as const, sku: coinsSku };
  const gemsProduct = { productId: 'GEMS_10' as const, sku: gemsSku };
  const coinsCatalog = [createIapProduct({ sku: coinsSku }), createIapProduct({ sku: gemsSku })];

  function pendingOrder(orderId: string, sku = coinsSku) {
    return { orderId, sku, paymentCompletedDate: '2026-09-01T10:00:00.000Z' };
  }

  it('passes the client purchase key to a verifier on the grant callback and on restore', async () => {
    const values = new Map<string, string>();
    let callbacks: IapPurchaseCallbacks | undefined;
    let nativePurchaseStarts = 0;
    let pendingOrders: IapPendingOrdersResult = { orders: [] };
    let serverAvailable = false;
    // The verifier is a plain boolean authority: it never echoes a key back.
    const verifyIapProductGrant = vi.fn(
      async (_input: AitIapProductGrantVerificationInput) => serverAvailable,
    );
    const completeProductGrant = vi.fn(async () => true);
    const options = {
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => pendingOrders,
          completeProductGrant,
          onPurchase: (input) => {
            nativePurchaseStarts += 1;
            callbacks = input;
          },
        }),
      }),
    };
    const payload = { productId: 'COINS_100', idempotencyKey: 'game-operation-1' };

    const purchase = createAitIapController(options).purchase(payload.productId, payload.idempotencyKey);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await expect(callbacks.options.processProductGrant({ orderId: 'order-linked' }))
      .resolves.toBe(false);
    await callbacks.onEvent({ type: 'success', data: createIapSuccessEvent('order-linked') });
    await expect(purchase).resolves.toMatchObject({
      status: 'pending',
      transactionId: 'order-linked',
      diagnostic: { code: 'AIT_IAP_GRANT_PENDING' },
    });
    expect(verifyIapProductGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      orderId: 'order-linked',
      idempotencyKey: 'apps-in-toss:purchase:order-linked',
      clientIdempotencyKey: 'game-operation-1',
      source: 'process-product-grant',
    }));

    // A reloaded controller recovers the order from the provider list and still
    // carries the game's key, although the verifier never returned it.
    serverAvailable = true;
    pendingOrders = { orders: [pendingOrder('order-linked'), pendingOrder('order-unlinked')] };
    await expect(recover(createAitIapController(options))).resolves.toEqual({
      // One restored entitlement per settled order.
      restoredEntitlements: [
        { id: 'COINS_100', source: 'purchase', grantedAt: '2026-09-01T10:00:00.000Z' },
        { id: 'COINS_100', source: 'purchase', grantedAt: '2026-09-01T10:00:00.000Z' },
      ],
      settledPurchases: [
        {
          transactionId: 'order-linked',
          productId: 'COINS_100',
          status: 'granted',
          idempotencyKey: 'game-operation-1',
        },
        {
          transactionId: 'order-unlinked',
          productId: 'COINS_100',
          status: 'granted',
        },
      ],
    });
    const restoreCalls = verifyIapProductGrant.mock.calls.slice(1).map(([input]) => input);
    expect(restoreCalls).toEqual([
      expect.objectContaining({
        orderId: 'order-linked',
        idempotencyKey: 'apps-in-toss:purchase:order-linked',
        clientIdempotencyKey: 'game-operation-1',
        source: 'pending-order-restore',
      }),
      expect.objectContaining({ orderId: 'order-unlinked', source: 'pending-order-restore' }),
    ]);
    expect(restoreCalls[1]).not.toHaveProperty('clientIdempotencyKey');

    // Replaying the game's key now reports the recovered order without a new checkout.
    pendingOrders = { orders: [] };
    await expect(createAitIapController(options).purchase(payload.productId, payload.idempotencyKey))
      .resolves.toEqual({
        status: 'completed',
        transactionId: 'order-linked',
        entitlementIds: ['COINS_100'],
        evidence: {
          schema: 'apps-in-toss.iap.callback.v1',
          payload: { orderId: 'order-linked', sku: coinsSku, source: 'pending-order-restore' },
        },
      });
    expect(nativePurchaseStarts).toBe(1);
  });

  it('settles a paid but ungranted same-product order before opening another checkout', async () => {
    const values = new Map<string, string>();
    const startPurchase = vi.fn();
    const completeProductGrant = vi.fn(async () => true);
    let serverAvailable = false;
    const verifyIapProductGrant = vi.fn(async () => serverAvailable);
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: coinsCatalog,
          pendingOrders: { orders: [pendingOrder('order-paid-earlier')] },
          completeProductGrant,
          onPurchase: startPurchase,
        }),
      }),
    });

    await expect(iap.purchase('COINS_100', 'second-tap')).resolves.toEqual({
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
    });
    expect(verifyIapProductGrant).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-paid-earlier',
      source: 'pending-order-restore',
    }));
    expect(completeProductGrant).not.toHaveBeenCalled();

    serverAvailable = true;
    await expect(iap.purchase('COINS_100', 'third-tap')).resolves.toEqual({
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_RECOVERED', retryable: true },
    });
    expect(completeProductGrant).toHaveBeenCalledWith({
      params: { orderId: 'order-paid-earlier' },
    });
    expect(startPurchase).not.toHaveBeenCalled();
    // Nothing was charged, so no retry barrier blocks the same keys later.
    expect([...values.keys()].filter((key) => key.includes('iap-purchase-attempt'))).toEqual([]);
  });

  it('opens a checkout after recovering an order that belongs to another product', async () => {
    let callbacks: IapPurchaseCallbacks | undefined;
    const completeProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [coinsProduct, gemsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: coinsCatalog,
          pendingOrders: { orders: [pendingOrder('order-gems', gemsSku)] },
          completeProductGrant,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('COINS_100', 'coins-after-gems');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    expect(completeProductGrant).toHaveBeenCalledWith({ params: { orderId: 'order-gems' } });
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await callbacks.options.processProductGrant({ orderId: 'order-coins' });
    await callbacks.onEvent({ type: 'success', data: createIapSuccessEvent('order-coins') });
    await expect(purchase).resolves.toMatchObject({
      status: 'completed',
      transactionId: 'order-coins',
    });
  });

  it('does not open a checkout when pending orders cannot be checked', async () => {
    const startPurchase = vi.fn();
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => {
            throw Object.assign(new Error('pending orders failed for user 1234'), {
              code: 'INTERNAL_ERROR',
            });
          },
          onPurchase: startPurchase,
        }),
      }),
    });

    await expect(iap.purchase('COINS_100', 'blind-checkout')).resolves.toEqual({
      status: 'failed',
      entitlementIds: [],
      diagnostic: {
        code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED',
        retryable: true,
        providerCode: 'INTERNAL_ERROR',
      },
    });
    expect(startPurchase).not.toHaveBeenCalled();
  });

  it('holds the IAP lock from restore preparation through reconciliation', async () => {
    let releasePreparation: ((prepared: boolean) => void) | undefined;
    let releaseVerification: ((granted: boolean) => void) | undefined;
    const getPendingOrders = vi.fn(async () => ({ orders: [pendingOrder('order-restore')] }));
    const verifyIapProductGrant = vi.fn(async () => await new Promise<boolean>((resolve) => {
      releaseVerification = resolve;
    }));
    const completeProductGrant = vi.fn(async () => true);
    const startPurchase = vi.fn();
    const prepareIap = vi.fn(async (input: { readonly intent: string }) => (
      input.intent === 'restore'
        ? await new Promise<boolean>((resolve) => {
            releasePreparation = resolve;
          })
        : true
    ));
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap,
      verifyIapProductGrant,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders,
          completeProductGrant,
          onPurchase: startPurchase,
        }),
      }),
    });
    const blocked = {
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_CHECKOUT_IN_PROGRESS', retryable: true },
    };

    const restore = recover(iap);
    await vi.waitFor(() => expect(releasePreparation).toBeDefined());
    // Restore is still preparing: a purchase must not start its own check.
    await expect(iap.purchase('COINS_100', 'during-restore-preparation')).resolves.toEqual(blocked);
    releasePreparation?.(true);
    await vi.waitFor(() => expect(releaseVerification).toBeDefined());
    // Restore is reconciling: still blocked, and a second restore is too.
    await expect(iap.purchase('COINS_100', 'during-restore-reconciliation')).resolves.toEqual(blocked);
    await expect(recoverError(iap)).resolves.toMatchObject({
      code: 'AIT_IAP_CHECKOUT_IN_PROGRESS',
    });
    releaseVerification?.(true);

    await expect(restore).resolves.toMatchObject({
      settledPurchases: [{ transactionId: 'order-restore', status: 'granted' }],
    });
    expect(prepareIap).toHaveBeenCalledOnce();
    expect(getPendingOrders).toHaveBeenCalledOnce();
    expect(verifyIapProductGrant).toHaveBeenCalledOnce();
    expect(completeProductGrant).toHaveBeenCalledOnce();
    expect(startPurchase).not.toHaveBeenCalled();
  });

  it('re-verifies the known order directly after PRODUCT_NOT_GRANTED_BY_PARTNER', async () => {
    const values = new Map<string, string>();
    let callbacks: IapPurchaseCallbacks | undefined;
    const getPendingOrders = vi.fn(async () => ({ orders: [] }));
    const completeProductGrant = vi.fn(async () => true);
    const verifyIapProductGrant = vi.fn(
      async (input: AitIapProductGrantVerificationInput) => input.source === 'pending-order-restore',
    );
    const options = {
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders,
          completeProductGrant,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    };
    const payload = { productId: 'COINS_100', idempotencyKey: 'not-granted-attempt' };

    const purchase = createAitIapController(options).purchase(payload.productId, payload.idempotencyKey);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await expect(callbacks.options.processProductGrant({ orderId: 'order-not-granted' }))
      .resolves.toBe(false);
    await callbacks.onError({ code: 'PRODUCT_NOT_GRANTED_BY_PARTNER' });

    const completed = {
      status: 'completed',
      transactionId: 'order-not-granted',
      entitlementIds: ['COINS_100'],
      evidence: {
        schema: 'apps-in-toss.iap.callback.v1',
        payload: {
          orderId: 'order-not-granted',
          sku: coinsSku,
          source: 'pending-order-restore',
        },
      },
    };
    await expect(purchase).resolves.toEqual(completed);
    expect(verifyIapProductGrant).toHaveBeenCalledTimes(2);
    expect(verifyIapProductGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      orderId: 'order-not-granted',
      idempotencyKey: 'apps-in-toss:purchase:order-not-granted',
      clientIdempotencyKey: 'not-granted-attempt',
      source: 'pending-order-restore',
    }));
    expect(completeProductGrant).toHaveBeenCalledWith({
      params: { orderId: 'order-not-granted' },
    });
    // The direct re-verify does not depend on the (possibly lagging) pending list.
    expect(getPendingOrders).toHaveBeenCalledOnce();
    // The settled order's client link is removed.
    expect([...values.keys()].some((key) => key.startsWith('mpgd:ait:iap-order-attempt:v1:')))
      .toBe(false);
    await expect(createAitIapController(options).purchase(payload.productId, payload.idempotencyKey))
      .resolves.toEqual(completed);
  });

  it('keeps a not-granted order pending after one bounded direct re-verify', async () => {
    let callbacks: IapPurchaseCallbacks | undefined;
    const completeProductGrant = vi.fn(async () => true);
    const verifyIapProductGrant = vi.fn(async () => false);
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: coinsCatalog,
          completeProductGrant,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('COINS_100', 'still-not-granted');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    await callbacks.options.processProductGrant({ orderId: 'order-still-pending' });
    await callbacks.onError(new Error('PRODUCT_NOT_GRANTED_BY_PARTNER'));

    await expect(purchase).resolves.toEqual({
      status: 'pending',
      transactionId: 'order-still-pending',
      entitlementIds: [],
      diagnostic: {
        code: 'AIT_IAP_GRANT_PENDING',
        retryable: true,
        providerCode: 'PRODUCT_NOT_GRANTED_BY_PARTNER',
      },
    });
    expect(verifyIapProductGrant).toHaveBeenCalledTimes(2);
    expect(completeProductGrant).not.toHaveBeenCalled();
  });

  it('surfaces recovery failures as coded diagnostics instead of an empty success', async () => {
    const options = {
      iapProducts: [coinsProduct],
      verifyIapProductGrant: async () => true,
    };
    const rejectedPreparation = createAitIapController({
      ...options,
      prepareIap: async () => false,
      dependencies: createDependencies({ iap: createSupportedIap({ products: coinsCatalog }) }),
    });
    await expect(recoverError(rejectedPreparation)).resolves.toEqual({
      code: 'AIT_IAP_PREPARATION_FAILED',
      retryable: true,
    });

    const oldTossApp = createAitIapController({
      ...options,
      prepareIap: async () => true,
      dependencies: createDependencies({
        iap: createSupportedIap({
          getPendingOrders: async () => undefined as unknown as IapPendingOrdersResult,
        }),
      }),
    });
    await expect(recoverError(oldTossApp)).resolves.toMatchObject({
      code: 'AIT_IAP_UNSUPPORTED_APP_VERSION',
      retryable: false,
    });
  });

  it('opens one checkout when two keys buy the same product concurrently', async () => {
    const values = new Map<string, string>();
    const callbacks: IapPurchaseCallbacks[] = [];
    const getPendingOrders = vi.fn(async () => ({ orders: [] }));
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders,
          onPurchase: (input) => {
            callbacks.push(input);
          },
        }),
      }),
    });

    const first = iap.purchase('COINS_100', 'double-tap-1');
    const second = iap.purchase('COINS_100', 'double-tap-2');
    await expect(second).resolves.toEqual({
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_CHECKOUT_IN_PROGRESS', retryable: true },
    });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    const [checkout] = callbacks;
    if (checkout === undefined) {
      throw new Error('Expected one Apps in Toss checkout.');
    }
    await checkout.options.processProductGrant({ orderId: 'order-double-tap' });
    await checkout.onEvent({ type: 'success', data: createIapSuccessEvent('order-double-tap') });
    await expect(first).resolves.toMatchObject({
      status: 'completed',
      transactionId: 'order-double-tap',
    });
    expect(callbacks).toHaveLength(1);
    expect(getPendingOrders).toHaveBeenCalledOnce();
    expect(values.has(
      'mpgd:ait:iap-purchase-attempt:v1:COINS_100:double-tap-2',
    )).toBe(false);

    // The barrier is released once the first checkout settles.
    const later = iap.purchase('COINS_100', 'double-tap-2');
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    await callbacks[1]?.onError({ name: 'AbortError' });
    await expect(later).resolves.toEqual({ status: 'cancelled', entitlementIds: [] });
  });

  it('fails closed when the pending-order payload has no order list', async () => {
    for (const malformed of [{}, { orders: null }, { orders: 'order-1' }]) {
      const startPurchase = vi.fn();
      const options = {
        iapProducts: [coinsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        dependencies: createDependencies({
          iap: createSupportedIap({
            products: coinsCatalog,
            getPendingOrders: async () => malformed as unknown as IapPendingOrdersResult,
            onPurchase: startPurchase,
          }),
        }),
      };
      await expect(createAitIapController(options).purchase('COINS_100', 'malformed-pending-orders')).resolves.toEqual({
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED', retryable: true },
      });
      expect(startPurchase).not.toHaveBeenCalled();
      await expect(recoverError(createAitIapController(options)))
        .resolves.toMatchObject({ code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED', retryable: true });
    }
  });

  it('completes a linked attempt whose order-correlation write failed', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    const attemptKey = 'mpgd:ait:iap-purchase-attempt:v1:COINS_100:lost-correlation';
    let callbacks: IapPurchaseCallbacks | undefined;
    let nativePurchaseStarts = 0;
    let pendingOrders: IapPendingOrdersResult = { orders: [] };
    const verifyIapProductGrant = vi.fn(async () => true);
    const options = {
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: {
          ...memoryStorage,
          setItem: async (key: string, value: string) => {
            if (key === attemptKey) {
              const marker = JSON.parse(value) as {
                readonly status?: string;
                readonly orderId?: string;
              };
              if (marker.status === 'pending' && marker.orderId !== undefined) {
                throw new Error('order correlation unavailable');
              }
            }
            await memoryStorage.setItem(key, value);
          },
        },
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => pendingOrders,
          onPurchase: (input) => {
            nativePurchaseStarts += 1;
            callbacks = input;
          },
        }),
      }),
    };
    const payload = { productId: 'COINS_100', idempotencyKey: 'lost-correlation' };

    const purchase = createAitIapController(options).purchase(payload.productId, payload.idempotencyKey);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    if (callbacks === undefined) {
      throw new Error('Expected Apps in Toss purchase callbacks to be registered.');
    }
    // The marker cannot name the order, so the grant is refused, but the link survives.
    await expect(callbacks.options.processProductGrant({ orderId: 'order-lost-correlation' }))
      .resolves.toBe(false);
    await callbacks.onEvent({
      type: 'success',
      data: createIapSuccessEvent('order-lost-correlation'),
    });
    await expect(purchase).resolves.toMatchObject({ status: 'pending' });
    expect(verifyIapProductGrant).not.toHaveBeenCalled();
    expect(JSON.parse(values.get(attemptKey) ?? '{}')).not.toHaveProperty('orderId');

    pendingOrders = { orders: [pendingOrder('order-lost-correlation')] };
    await expect(recover(createAitIapController(options)))
      .resolves.toMatchObject({
        settledPurchases: [{
          transactionId: 'order-lost-correlation',
          idempotencyKey: 'lost-correlation',
        }],
      });
    expect(JSON.parse(values.get(attemptKey) ?? '{}')).toMatchObject({
      status: 'completed',
      orderId: 'order-lost-correlation',
    });

    pendingOrders = { orders: [] };
    await expect(createAitIapController(options).purchase(payload.productId, payload.idempotencyKey))
      .resolves.toMatchObject({
        status: 'completed',
        transactionId: 'order-lost-correlation',
      });
    expect(nativePurchaseStarts).toBe(1);
  });

  it('fails closed on malformed pending-order entries for configured or unknown SKUs', async () => {
    for (const malformed of [
      { sku: coinsSku },
      { sku: coinsSku, orderId: '' },
      { sku: coinsSku, orderId: 42 },
      { orderId: 'order-without-sku' },
      'order-1',
      null,
    ]) {
      const startPurchase = vi.fn();
      const options = {
        iapProducts: [coinsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        dependencies: createDependencies({
          iap: createSupportedIap({
            products: coinsCatalog,
            getPendingOrders: async () => ({
              orders: [pendingOrder('order-other', 'ait.other'), malformed],
            }) as unknown as IapPendingOrdersResult,
            onPurchase: startPurchase,
          }),
        }),
      };
      await expect(createAitIapController(options).purchase('COINS_100', 'malformed-entry')).resolves.toEqual({
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED', retryable: true },
      });
      expect(startPurchase).not.toHaveBeenCalled();
      await expect(recoverError(createAitIapController(options)))
        .resolves.toMatchObject({ code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED' });
    }

    // A well-formed entry for an unconfigured SKU is still ignored.
    const ignored = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        iap: createSupportedIap({
          pendingOrders: {
            orders: [{ ...pendingOrder('order-other', 'ait.other') }],
          },
        }),
      }),
    });
    await expect(recover(ignored)).resolves.toEqual({
      restoredEntitlements: [],
    });
  });

  it('secures the linked attempt marker before acknowledging a restored order', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    const attemptKey = 'mpgd:ait:iap-purchase-attempt:v1:COINS_100:secure-before-ack';
    let markerWritesFail = false;
    let callbacks: IapPurchaseCallbacks | undefined;
    let pendingOrders: IapPendingOrdersResult = { orders: [] };
    let serverAvailable = false;
    const markerAtCompletion: unknown[] = [];
    const completeProductGrant = vi.fn(async () => {
      markerAtCompletion.push(JSON.parse(values.get(attemptKey) ?? '{}'));
      return true;
    });
    const options = {
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => serverAvailable,
      dependencies: createDependencies({
        storage: {
          ...memoryStorage,
          setItem: async (key: string, value: string) => {
            if (markerWritesFail && key === attemptKey) {
              throw new Error('marker storage unavailable');
            }
            await memoryStorage.setItem(key, value);
          },
        },
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => pendingOrders,
          completeProductGrant,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    };

    const purchase = createAitIapController(options).purchase('COINS_100', 'secure-before-ack');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await callbacks?.options.processProductGrant({ orderId: 'order-secure' });
    await callbacks?.onEvent({ type: 'success', data: createIapSuccessEvent('order-secure') });
    await expect(purchase).resolves.toMatchObject({ status: 'pending' });
    await vi.waitFor(() => expect(
      values.has('mpgd:ait:iap-order-attempt:v1:order-secure'),
    ).toBe(true));

    serverAvailable = true;
    markerWritesFail = true;
    pendingOrders = { orders: [pendingOrder('order-secure')] };
    await expect(recover(createAitIapController(options))).resolves.toEqual({
      restoredEntitlements: [],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
    });
    expect(completeProductGrant).not.toHaveBeenCalled();
    expect(JSON.parse(values.get(attemptKey) ?? '{}')).toMatchObject({ status: 'pending' });

    markerWritesFail = false;
    await expect(recover(createAitIapController(options)))
      .resolves.toMatchObject({
        settledPurchases: [{ transactionId: 'order-secure', idempotencyKey: 'secure-before-ack' }],
      });
    expect(completeProductGrant).toHaveBeenCalledOnce();
    expect(markerAtCompletion).toEqual([expect.objectContaining({
      status: 'completed',
      orderId: 'order-secure',
    })]);
  });

  it('passes through only structured or allowlisted provider codes', async () => {
    const pendingOrderFailure = (error: unknown) => createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => {
            throw error;
          },
        }),
      }),
    });
    const purchase = { productId: 'COINS_100', idempotencyKey: 'provider-code' };

    await expect(pendingOrderFailure(new Error('lookup failed for USER_ACCOUNT_1234 ORDER_ID_99')).purchase(purchase.productId, purchase.idempotencyKey)).resolves.toEqual({
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED', retryable: true },
    });
    await expect(pendingOrderFailure({ errorCode: 'NETWORK_ERROR', message: 'USER_ACCOUNT_1234' }).purchase(purchase.productId, purchase.idempotencyKey)).resolves.toMatchObject({ diagnostic: { providerCode: 'NETWORK_ERROR' } });
    await expect(pendingOrderFailure({ code: 'user account 1234' }).purchase(purchase.productId, purchase.idempotencyKey)).resolves.toEqual({
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED', retryable: true },
    });
    await expect(pendingOrderFailure(new Error('PRODUCT_NOT_GRANTED_BY_PARTNER: order 1234')).purchase(purchase.productId, purchase.idempotencyKey)).resolves.toMatchObject({
      diagnostic: { providerCode: 'PRODUCT_NOT_GRANTED_BY_PARTNER' },
    });
  });

  it('keeps the grant deadline when the best-effort order link write stalls', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    let callbacks: IapPurchaseCallbacks | undefined;
    const verifyIapProductGrant = vi.fn(async (_input: AitIapProductGrantVerificationInput) => true);
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      iapProductGrantTimeoutMs: 200,
      dependencies: createDependencies({
        storage: {
          ...memoryStorage,
          setItem: async (key: string, value: string) => {
            if (key.startsWith('mpgd:ait:iap-order-attempt:v1:')) {
              return await new Promise<void>(() => {});
            }
            await memoryStorage.setItem(key, value);
          },
        },
        iap: createSupportedIap({
          products: coinsCatalog,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('COINS_100', 'stalled-link');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await expect(callbacks?.options.processProductGrant({ orderId: 'order-stalled-link' }))
      .resolves.toBe(true);
    expect(verifyIapProductGrant).toHaveBeenCalledOnce();
    expect(verifyIapProductGrant.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(100);
    await callbacks?.onEvent({
      type: 'success',
      data: createIapSuccessEvent('order-stalled-link'),
    });
    await expect(purchase).resolves.toMatchObject({ status: 'completed' });
  });

  it('does not let restore reconcile an order while its checkout callback is active', async () => {
    let callbacks: IapPurchaseCallbacks | undefined;
    let acknowledged = false;
    let releaseVerification: ((granted: boolean) => void) | undefined;
    const getPendingOrders = vi.fn(async () => ({
      orders: acknowledged || callbacks === undefined ? [] : [pendingOrder('order-active')],
    }));
    const completeProductGrant = vi.fn(async () => {
      acknowledged = true;
      return true;
    });
    const verifyIapProductGrant = vi.fn(
      async (input: AitIapProductGrantVerificationInput) => (
        input.source === 'process-product-grant'
          ? await new Promise<boolean>((resolve) => {
              releaseVerification = resolve;
            })
          : true
      ),
    );
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders,
          completeProductGrant,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('COINS_100', 'active-checkout');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    const grant = callbacks?.options.processProductGrant({ orderId: 'order-active' });
    await vi.waitFor(() => expect(releaseVerification).toBeDefined());

    await expect(recoverError(iap)).resolves.toMatchObject({
      code: 'AIT_IAP_CHECKOUT_IN_PROGRESS',
      retryable: true,
    });
    expect(getPendingOrders).toHaveBeenCalledOnce();

    releaseVerification?.(false);
    await expect(grant).resolves.toBe(false);
    await callbacks?.onError({ code: 'PRODUCT_NOT_GRANTED_BY_PARTNER' });
    await expect(purchase).resolves.toMatchObject({
      status: 'completed',
      transactionId: 'order-active',
    });
    await expect(recover(iap)).resolves.toEqual({
      restoredEntitlements: [],
    });
    expect(completeProductGrant).toHaveBeenCalledOnce();
  });

  it('persists the direct-recovery marker before acknowledging the order', async () => {
    for (const markerWritable of [false, true]) {
      const values = new Map<string, string>();
      const memoryStorage = createMemoryStorage(values);
      const attemptKey = 'mpgd:ait:iap-purchase-attempt:v1:COINS_100:direct-ack';
      let callbacks: IapPurchaseCallbacks | undefined;
      const markerAtCompletion: unknown[] = [];
      const completeProductGrant = vi.fn(async () => {
        markerAtCompletion.push(JSON.parse(values.get(attemptKey) ?? '{}'));
        return true;
      });
      const iap = createAitIapController({
        iapProducts: [coinsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async (input) => input.source === 'pending-order-restore',
        dependencies: createDependencies({
          storage: {
            ...memoryStorage,
            setItem: async (key: string, value: string) => {
              if (
                !markerWritable
                && key === attemptKey
                && (JSON.parse(value) as { readonly status?: string }).status === 'completed'
              ) {
                throw new Error('completed marker unavailable');
              }
              await memoryStorage.setItem(key, value);
            },
          },
          iap: createSupportedIap({
            products: coinsCatalog,
            completeProductGrant,
            onPurchase: (input) => {
              callbacks = input;
            },
          }),
        }),
      });

      const purchase = iap.purchase('COINS_100', 'direct-ack');
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      await callbacks?.options.processProductGrant({ orderId: 'order-direct-ack' });
      await callbacks?.onError({ code: 'PRODUCT_NOT_GRANTED_BY_PARTNER' });

      if (markerWritable) {
        await expect(purchase).resolves.toMatchObject({ status: 'completed' });
        expect(markerAtCompletion).toEqual([expect.objectContaining({
          status: 'completed',
          orderId: 'order-direct-ack',
        })]);
      } else {
        await expect(purchase).resolves.toEqual({
          status: 'pending',
          transactionId: 'order-direct-ack',
          entitlementIds: [],
          diagnostic: { code: 'AIT_IAP_ATTEMPT_STORAGE_UNAVAILABLE', retryable: true },
        });
        expect(completeProductGrant).not.toHaveBeenCalled();
      }
    }
  });

  it('leaves an order unacknowledged when its link or attempt marker cannot be read', async () => {
    const linkKey = 'mpgd:ait:iap-order-attempt:v1:order-unreadable';
    const attemptKey = 'mpgd:ait:iap-purchase-attempt:v1:COINS_100:unreadable-attempt';
    for (const failingKey of [linkKey, attemptKey]) {
      const values = new Map<string, string>([
        [linkKey, JSON.stringify({ productId: 'COINS_100', idempotencyKey: 'unreadable-attempt' })],
        [attemptKey, JSON.stringify({
          status: 'pending',
          productId: 'COINS_100',
          idempotencyKey: 'unreadable-attempt',
          orderId: 'order-unreadable',
          pendingSince: '2026-09-01T10:00:00.000Z',
        })],
      ]);
      const memoryStorage = createMemoryStorage(values);
      let readable = false;
      const completeProductGrant = vi.fn(async () => true);
      const startPurchase = vi.fn();
      const iap = createAitIapController({
        iapProducts: [coinsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        dependencies: createDependencies({
          storage: {
            ...memoryStorage,
            getItem: async (key: string) => {
              if (!readable && key === failingKey) {
                throw new Error('storage read unavailable');
              }
              return await memoryStorage.getItem(key);
            },
          },
          iap: createSupportedIap({
            products: coinsCatalog,
            pendingOrders: { orders: [pendingOrder('order-unreadable')] },
            completeProductGrant,
            onPurchase: startPurchase,
          }),
        }),
      });

      await expect(recover(iap)).resolves.toEqual({
        restoredEntitlements: [],
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
      });
      await expect(iap.purchase('COINS_100', 'another-attempt')).resolves.toMatchObject({
        status: 'failed',
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED' },
      });
      expect(completeProductGrant).not.toHaveBeenCalled();
      expect(startPurchase).not.toHaveBeenCalled();

      readable = true;
      await expect(recover(iap)).resolves.toMatchObject({
        settledPurchases: [{ transactionId: 'order-unreadable', idempotencyKey: 'unreadable-attempt' }],
      });
      expect(completeProductGrant).toHaveBeenCalledOnce();
      expect(JSON.parse(values.get(attemptKey) ?? '{}')).toMatchObject({ status: 'completed' });
    }
  });

  it('keeps a stale attempt marker when the pending-order list has a malformed entry', async () => {
    const values = new Map<string, string>();
    const attemptKey = 'mpgd:ait:iap-purchase-attempt:v1:COINS_100:stale-malformed';
    values.set(attemptKey, JSON.stringify({
      status: 'pending',
      productId: 'COINS_100',
      idempotencyKey: 'stale-malformed',
      pendingSince: new Date(Date.now() - (30 * 60_000) - 1).toISOString(),
    }));
    const startPurchase = vi.fn();
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => ({
            orders: [{ sku: coinsSku, orderId: '' }],
          }) as unknown as IapPendingOrdersResult,
          onPurchase: startPurchase,
        }),
      }),
    });

    await expect(iap.purchase('COINS_100', 'stale-malformed')).resolves.toEqual({
      status: 'pending',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_ATTEMPT_PENDING', retryable: true },
    });
    expect(values.has(attemptKey)).toBe(true);
    expect(startPurchase).not.toHaveBeenCalled();
  });

  it('settles a stalled order-link write before releasing the purchase', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    const linkKey = 'mpgd:ait:iap-order-attempt:v1:order-slow-link';
    let releaseLinkWrite: (() => void) | undefined;
    let callbacks: IapPurchaseCallbacks | undefined;
    let pendingOrders: IapPendingOrdersResult = { orders: [] };
    let serverAvailable = false;
    const verifyIapProductGrant = vi.fn(
      async (_input: AitIapProductGrantVerificationInput) => serverAvailable,
    );
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: {
          ...memoryStorage,
          setItem: async (key: string, value: string) => {
            if (key === linkKey) {
              await new Promise<void>((resolve) => {
                releaseLinkWrite = resolve;
              });
            }
            await memoryStorage.setItem(key, value);
          },
        },
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => pendingOrders,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('COINS_100', 'slow-link');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await expect(callbacks?.options.processProductGrant({ orderId: 'order-slow-link' }))
      .resolves.toBe(false);
    await callbacks?.onEvent({ type: 'success', data: createIapSuccessEvent('order-slow-link') });
    // The lock is still held: restore cannot read the link as absent yet.
    await expect(recoverError(iap)).resolves.toMatchObject({
      code: 'AIT_IAP_CHECKOUT_IN_PROGRESS',
    });
    releaseLinkWrite?.();
    await expect(purchase).resolves.toMatchObject({ status: 'pending' });

    serverAvailable = true;
    pendingOrders = { orders: [pendingOrder('order-slow-link')] };
    await expect(recover(iap)).resolves.toMatchObject({
      settledPurchases: [{ transactionId: 'order-slow-link', idempotencyKey: 'slow-link' }],
    });
  });

  it('keeps an order unacknowledged when its linked attempt marker is corrupted', async () => {
    const linkKey = 'mpgd:ait:iap-order-attempt:v1:order-corrupt-marker';
    const attemptKey = 'mpgd:ait:iap-purchase-attempt:v1:COINS_100:corrupt-marker';
    for (const corrupted of ['{not json', JSON.stringify({ status: 'pending', productId: 'GEMS_10' })]) {
      const values = new Map<string, string>([
        [linkKey, JSON.stringify({ productId: 'COINS_100', idempotencyKey: 'corrupt-marker' })],
        [attemptKey, corrupted],
      ]);
      const completeProductGrant = vi.fn(async () => true);
      const iap = createAitIapController({
        iapProducts: [coinsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        dependencies: createDependencies({
          storage: createMemoryStorage(values),
          iap: createSupportedIap({
            pendingOrders: { orders: [pendingOrder('order-corrupt-marker')] },
            completeProductGrant,
          }),
        }),
      });
      await expect(recover(iap)).resolves.toEqual({
        restoredEntitlements: [],
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
      });
      expect(completeProductGrant).not.toHaveBeenCalled();
      expect(values.get(attemptKey)).toBe(corrupted);
    }

    // A linked attempt with no marker gets a completed marker before the ack.
    const values = new Map<string, string>([
      [linkKey, JSON.stringify({ productId: 'COINS_100', idempotencyKey: 'corrupt-marker' })],
    ]);
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: coinsCatalog,
          pendingOrders: { orders: [pendingOrder('order-corrupt-marker')] },
        }),
      }),
    });
    await expect(recover(iap)).resolves.toMatchObject({
      settledPurchases: [{ transactionId: 'order-corrupt-marker' }],
    });
    expect(JSON.parse(values.get(attemptKey) ?? '{}')).toMatchObject({
      status: 'completed',
      orderId: 'order-corrupt-marker',
    });
  });

  it('keeps the checkout barrier after an acknowledgement that times out', async () => {
    const values = new Map<string, string>();
    let releaseAcknowledgement: ((acknowledged: boolean) => void) | undefined;
    let acknowledged = false;
    const startPurchase = vi.fn();
    const completeProductGrant = vi.fn(async () => await new Promise<boolean>((resolve) => {
      releaseAcknowledgement = (value) => {
        acknowledged = value;
        resolve(value);
      };
    }));
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      iapProductGrantTimeoutMs: 150,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => ({
            orders: acknowledged ? [] : [pendingOrder('order-slow-ack')],
          }),
          completeProductGrant,
          onPurchase: startPurchase,
        }),
      }),
    });
    const blocked = (code: string) => ({
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code, retryable: true },
    });

    await expect(iap.purchase('COINS_100', 'ack-timeout-1')).resolves.toEqual(blocked('AIT_IAP_PENDING_ORDER_UNRESOLVED'));
    expect(JSON.parse(values.get('mpgd:ait:iap-ack-in-flight:v1') ?? '[]')).toEqual([
      { orderId: 'order-slow-ack', sku: coinsSku, phase: 'started' },
    ]);

    // The timed-out native call succeeds later and the order leaves the list.
    releaseAcknowledgement?.(true);
    await expect(iap.purchase('COINS_100', 'ack-timeout-1')).resolves.toEqual(blocked('AIT_IAP_PENDING_ORDER_RECOVERED'));
    expect(JSON.parse(values.get('mpgd:ait:iap-ack-in-flight:v1') ?? '[]')).toEqual([]);
    expect(startPurchase).not.toHaveBeenCalled();

    // Only after the recovered order was reported can a new checkout open.
    const purchase = iap.purchase('COINS_100', 'ack-timeout-2');
    await vi.waitFor(() => expect(startPurchase).toHaveBeenCalledOnce());
    await startPurchase.mock.calls[0]?.[0].onError({ name: 'AbortError' });
    await expect(purchase).resolves.toMatchObject({ status: 'cancelled' });
    expect(completeProductGrant).toHaveBeenCalledOnce();
  });

  it('ignores native callbacks that arrive after the purchase result is decided', async () => {
    const values = new Map<string, string>();
    const attemptKey = 'mpgd:ait:iap-purchase-attempt:v1:COINS_100:late-callbacks';
    let callbacks: IapPurchaseCallbacks | undefined;
    const verifyIapProductGrant = vi.fn(async () => false);
    const completeProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          products: coinsCatalog,
          completeProductGrant,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('COINS_100', 'late-callbacks');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await callbacks?.options.processProductGrant({ orderId: 'order-late' });
    await callbacks?.onEvent({ type: 'success', data: createIapSuccessEvent('order-late') });
    await expect(purchase).resolves.toMatchObject({ status: 'pending' });
    const marker = values.get(attemptKey);

    await callbacks?.onError({ code: 'PRODUCT_NOT_GRANTED_BY_PARTNER' });
    await callbacks?.onEvent({ type: 'success', data: createIapSuccessEvent('order-late') });
    await expect(callbacks?.options.processProductGrant({ orderId: 'order-late' }))
      .resolves.toBe(false);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(verifyIapProductGrant).toHaveBeenCalledOnce();
    expect(completeProductGrant).not.toHaveBeenCalled();
    expect(values.get(attemptKey)).toBe(marker);
  });

  it('serializes acknowledgement-barrier writes behind a late-landing write', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    const ackKey = 'mpgd:ait:iap-ack-in-flight:v1';
    let ackWrites = 0;
    let releaseStalledWrite: (() => void) | undefined;
    let pendingOrders: IapPendingOrdersResult = { orders: [pendingOrder('order-a')] };
    const completeProductGrant = vi.fn(async ({ params }: { readonly params: { readonly orderId: string } }) => (
      params.orderId === 'order-a' ? true : await new Promise<boolean>(() => {})
    ));
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      iapProductGrantTimeoutMs: 150,
      dependencies: createDependencies({
        storage: {
          ...memoryStorage,
          setItem: async (key: string, value: string) => {
            if (key === ackKey) {
              ackWrites += 1;
              // Writes: A recorded, A started, then A's clear, which stalls
              // past its deadline and lands late.
              if (ackWrites === 3) {
                await new Promise<void>((resolve) => {
                  releaseStalledWrite = resolve;
                });
              }
            }
            await memoryStorage.setItem(key, value);
          },
        },
        iap: createSupportedIap({
          getPendingOrders: async () => pendingOrders,
          completeProductGrant,
        }),
      }),
    });

    await expect(recover(iap)).resolves.toMatchObject({
      settledPurchases: [{ transactionId: 'order-a' }],
    });
    expect(releaseStalledWrite).toBeDefined();

    // While A's clear is still in flight, no barrier read-modify-write may run.
    pendingOrders = { orders: [pendingOrder('order-b')] };
    await expect(recoverError(iap)).resolves.toMatchObject({
      code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED',
    });
    expect(completeProductGrant).toHaveBeenCalledOnce();

    releaseStalledWrite?.();
    await vi.waitFor(() => expect(values.get(ackKey)).toBe('[]'));
    // B's acknowledgement times out, so its barrier must survive.
    await expect(recover(iap)).resolves.toMatchObject({
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED' },
    });
    expect(JSON.parse(values.get(ackKey) ?? '[]')).toEqual([
      { orderId: 'order-b', sku: coinsSku, phase: 'started' },
    ]);
  });

  it('keeps a restore from reading an order link while its native write still runs', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    const linkKey = 'mpgd:ait:iap-order-attempt:v1:order-native-link';
    let releaseLinkWrite: (() => void) | undefined;
    let callbacks: IapPurchaseCallbacks | undefined;
    let pendingOrders: IapPendingOrdersResult = { orders: [] };
    let serverAvailable = false;
    const completeProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => serverAvailable,
      iapProductGrantTimeoutMs: 150,
      dependencies: createDependencies({
        storage: {
          ...memoryStorage,
          setItem: async (key: string, value: string) => {
            if (key === linkKey) {
              // The native write outlives every deadline before it lands.
              await new Promise<void>((resolve) => {
                releaseLinkWrite = resolve;
              });
            }
            await memoryStorage.setItem(key, value);
          },
        },
        iap: createSupportedIap({
          products: coinsCatalog,
          getPendingOrders: async () => pendingOrders,
          completeProductGrant,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('COINS_100', 'native-link');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await callbacks?.options.processProductGrant({ orderId: 'order-native-link' });
    await callbacks?.onEvent({ type: 'success', data: createIapSuccessEvent('order-native-link') });
    // The purchase gives up waiting after its bounded deadline.
    await expect(purchase).resolves.toMatchObject({ status: 'pending' });
    expect(values.has(linkKey)).toBe(false);

    serverAvailable = true;
    pendingOrders = { orders: [pendingOrder('order-native-link')] };
    await expect(recover(iap)).resolves.toEqual({
      restoredEntitlements: [],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
    });
    expect(completeProductGrant).not.toHaveBeenCalled();

    releaseLinkWrite?.();
    await vi.waitFor(() => expect(values.has(linkKey)).toBe(true));
    await expect(recover(iap)).resolves.toMatchObject({
      settledPurchases: [{ transactionId: 'order-native-link', idempotencyKey: 'native-link' }],
    });
    expect(completeProductGrant).toHaveBeenCalledOnce();
  });

  it('settles an absent order barrier of any phase only on a confirmed server grant', async () => {
    const ackKey = 'mpgd:ait:iap-ack-in-flight:v1';
    // `started` may be a phase write that landed late without any dispatch.
    for (const phase of ['recorded', 'started'] as const) {
      const values = new Map<string, string>([[ackKey, JSON.stringify([
        { orderId: 'order-phase', sku: coinsSku, phase },
      ])]]);
      let serverConfirms = false;
      const verifyIapProductGrant = vi.fn(async () => serverConfirms);
      const startPurchase = vi.fn();
      const completeProductGrant = vi.fn(async () => true);
      const iap = createAitIapController({
        iapProducts: [coinsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant,
        dependencies: createDependencies({
          storage: createMemoryStorage(values),
          iap: createSupportedIap({
            products: coinsCatalog,
            completeProductGrant,
            onPurchase: startPurchase,
          }),
        }),
      });
      const purchase = () => iap.purchase('COINS_100', `phase-${phase}`);

      // The order is temporarily absent: absence alone settles nothing.
      await expect(purchase()).resolves.toMatchObject({
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED' },
      });
      expect(JSON.parse(values.get(ackKey) ?? '[]')).toHaveLength(1);
      expect(verifyIapProductGrant).toHaveBeenCalledWith(expect.objectContaining({
        orderId: 'order-phase',
        source: 'pending-order-restore',
      }));
      // Only a confirmed server grant settles it.
      serverConfirms = true;
      await expect(purchase()).resolves.toMatchObject({
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_RECOVERED' },
      });
      expect(values.get(ackKey)).toBe('[]');
      expect(startPurchase).not.toHaveBeenCalled();
      expect(completeProductGrant).not.toHaveBeenCalled();
    }
  });

  it('keeps retired-SKU barriers out of the active acknowledgement capacity', async () => {
    const ackKey = 'mpgd:ait:iap-ack-in-flight:v1';
    const retired = Array.from({ length: 33 }, (_, index) => ({
      orderId: `order-retired-${index}`,
      sku: `ait.retired.${index}`,
      phase: 'started',
    }));
    const values = new Map<string, string>([[ackKey, JSON.stringify(retired)]]);
    const completeProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      iapProductGrantTimeoutMs: 150,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          pendingOrders: { orders: [pendingOrder('order-current')] },
          completeProductGrant,
        }),
      }),
    });

    await expect(recover(iap)).resolves.toMatchObject({
      settledPurchases: [{ transactionId: 'order-current' }],
    });
    expect(completeProductGrant).toHaveBeenCalledOnce();
    const stored = JSON.parse(values.get(ackKey) ?? '[]') as Array<{ readonly orderId: string }>;
    // Retired entries stay, capped at 32 with the oldest dropped.
    expect(stored.map(({ orderId }) => orderId)).toEqual(
      retired.slice(1).map(({ orderId }) => orderId),
    );
  });

  it('removes order links once the order is settled and keeps them while ambiguous', async () => {
    const linkKeys = (values: ReadonlyMap<string, string>) => [...values.keys()]
      .filter((key) => key.startsWith('mpgd:ait:iap-order-attempt:v1:'));

    // Grant callback success.
    {
      const values = new Map<string, string>();
      let callbacks: IapPurchaseCallbacks | undefined;
      const iap = createAitIapController({
        iapProducts: [coinsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        dependencies: createDependencies({
          storage: createMemoryStorage(values),
          iap: createSupportedIap({
            products: coinsCatalog,
            onPurchase: (input) => {
              callbacks = input;
            },
          }),
        }),
      });
      const purchase = iap.purchase('COINS_100', 'link-callback');
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      await callbacks?.options.processProductGrant({ orderId: 'order-link-callback' });
      await callbacks?.onEvent({
        type: 'success',
        data: createIapSuccessEvent('order-link-callback'),
      });
      await expect(purchase).resolves.toMatchObject({ status: 'completed' });
      expect(linkKeys(values)).toEqual([]);
    }

    // Restore acknowledgement, then an ambiguous acknowledgement.
    {
      const values = new Map<string, string>([
        ['mpgd:ait:iap-order-attempt:v1:order-restored', JSON.stringify({
          productId: 'COINS_100', idempotencyKey: 'restored-key',
        })],
        ['mpgd:ait:iap-order-attempt:v1:order-ambiguous', JSON.stringify({
          productId: 'COINS_100', idempotencyKey: 'ambiguous-key',
        })],
      ]);
      const iap = createAitIapController({
        iapProducts: [coinsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        iapProductGrantTimeoutMs: 150,
        dependencies: createDependencies({
          storage: createMemoryStorage(values),
          iap: createSupportedIap({
            pendingOrders: {
              orders: [pendingOrder('order-restored'), pendingOrder('order-ambiguous')],
            },
            completeProductGrant: async ({ params }) => (
              params.orderId === 'order-restored' ? true : await new Promise<boolean>(() => {})
            ),
          }),
        }),
      });
      await expect(recover(iap)).resolves.toMatchObject({
        settledPurchases: [{ transactionId: 'order-restored' }],
      });
      expect(linkKeys(values)).toEqual(['mpgd:ait:iap-order-attempt:v1:order-ambiguous']);
    }
  });

  it('joins a running acknowledgement and keeps its started barrier', async () => {
    const values = new Map<string, string>();
    const ackKey = 'mpgd:ait:iap-ack-in-flight:v1';
    let pendingOrders: IapPendingOrdersResult = { orders: [pendingOrder('order-joined')] };
    const results: Array<(value: boolean) => void> = [];
    const completeProductGrant = vi.fn(async () => await new Promise<boolean>((resolve) => {
      results.push(resolve);
    }));
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      iapProductGrantTimeoutMs: 150,
      dependencies: createDependencies({
        storage: createMemoryStorage(values),
        iap: createSupportedIap({
          getPendingOrders: async () => pendingOrders,
          completeProductGrant,
        }),
      }),
    });
    const started = [{ orderId: 'order-joined', sku: coinsSku, phase: 'started' }];
    const unresolved = {
      restoredEntitlements: [],
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED', retryable: true },
    };

    await expect(recover(iap)).resolves.toEqual(unresolved);
    expect(JSON.parse(values.get(ackKey) ?? '[]')).toEqual(started);
    // The first native call is still running: the retry joins it.
    await expect(recover(iap)).resolves.toEqual(unresolved);
    expect(completeProductGrant).toHaveBeenCalledOnce();
    expect(JSON.parse(values.get(ackKey) ?? '[]')).toEqual(started);

    // A rejected dispatch never clears a started barrier.
    results[0]?.(false);
    const retry = recover(iap);
    await vi.waitFor(() => expect(completeProductGrant).toHaveBeenCalledTimes(2));
    results[1]?.(false);
    await expect(retry).resolves.toEqual(unresolved);
    expect(JSON.parse(values.get(ackKey) ?? '[]')).toEqual(started);

    // Only the order leaving the provider list confirms it.
    pendingOrders = { orders: [] };
    await expect(recover(iap)).resolves.toMatchObject({
      settledPurchases: [{ transactionId: 'order-joined' }],
    });
    expect(values.get(ackKey)).toBe('[]');
    expect(completeProductGrant).toHaveBeenCalledTimes(2);
  });

  it('fails fast without queueing behind a hung storage write', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    const ackKey = 'mpgd:ait:iap-ack-in-flight:v1';
    let releaseHungWrite: (() => void) | undefined;
    let hangNextWrite = true;
    const completeProductGrant = vi.fn(async () => true);
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      iapProductGrantTimeoutMs: 150,
      dependencies: createDependencies({
        storage: {
          ...memoryStorage,
          setItem: async (key: string, value: string) => {
            if (key === ackKey && hangNextWrite) {
              hangNextWrite = false;
              await new Promise<void>((resolve) => {
                releaseHungWrite = resolve;
              });
            }
            await memoryStorage.setItem(key, value);
          },
        },
        iap: createSupportedIap({
          pendingOrders: { orders: [pendingOrder('order-hung-storage')] },
          completeProductGrant,
        }),
      }),
    });

    await expect(recover(iap)).resolves.toMatchObject({
      diagnostic: { code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED' },
    });
    expect(releaseHungWrite).toBeDefined();

    // Each later access fails closed at once instead of waiting its full
    // deadline behind the hung call (50 waits would take about 5 seconds).
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await expect(recoverError(iap)).resolves.toMatchObject({
        code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED',
      });
    }
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(completeProductGrant).not.toHaveBeenCalled();

    // Once the hung call settles, the key works again.
    releaseHungWrite?.();
    await vi.waitFor(() => expect(values.has(ackKey)).toBe(true));
    await expect(recover(iap)).resolves.toMatchObject({
      settledPurchases: [{ transactionId: 'order-hung-storage' }],
    });
    expect(completeProductGrant).toHaveBeenCalledOnce();
  });

  it('joins a hung native pending-order read instead of starting another', async () => {
    let releaseRead: ((orders: IapPendingOrdersResult) => void) | undefined;
    const getPendingOrders = vi.fn(async () => (
      releaseRead === undefined
        ? await new Promise<IapPendingOrdersResult>((resolve) => {
            releaseRead = resolve;
          })
        : { orders: [] }
    ));
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      iapProductGrantTimeoutMs: 60,
      dependencies: createDependencies({ iap: createSupportedIap({ getPendingOrders }) }),
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(recoverError(iap)).resolves.toMatchObject({
        code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED',
      });
    }
    expect(getPendingOrders).toHaveBeenCalledOnce();

    releaseRead?.({ orders: [] });
    await expect(recover(iap)).resolves.toEqual({
      restoredEntitlements: [],
    });
    expect(getPendingOrders).toHaveBeenCalledTimes(2);
  });

  it('keeps the lock until an onEvent completion finishes after another terminal callback', async () => {
    const values = new Map<string, string>();
    const memoryStorage = createMemoryStorage(values);
    const attemptKey = 'mpgd:ait:iap-purchase-attempt:v1:COINS_100:event-then-error';
    let releaseCompletedWrite: (() => void) | undefined;
    let callbacks: IapPurchaseCallbacks | undefined;
    const iap = createAitIapController({
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        storage: {
          ...memoryStorage,
          setItem: async (key: string, value: string) => {
            if (
              key === attemptKey
              && (JSON.parse(value) as { readonly status?: string }).status === 'completed'
            ) {
              await new Promise<void>((resolve) => {
                releaseCompletedWrite = resolve;
              });
            }
            await memoryStorage.setItem(key, value);
          },
        },
        iap: createSupportedIap({
          products: coinsCatalog,
          onPurchase: (input) => {
            callbacks = input;
          },
        }),
      }),
    });

    const purchase = iap.purchase('COINS_100', 'event-then-error');
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await callbacks?.options.processProductGrant({ orderId: 'order-event-error' });
    const event = callbacks?.onEvent({
      type: 'success',
      data: createIapSuccessEvent('order-event-error'),
    });
    await vi.waitFor(() => expect(releaseCompletedWrite).toBeDefined());
    // Another terminal path finishes while the completion write is running.
    await callbacks?.onError({ code: 'NETWORK_ERROR' });
    let purchaseSettled = false;
    void purchase.then(() => {
      purchaseSettled = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(purchaseSettled).toBe(false);
    await expect(recoverError(iap)).resolves.toMatchObject({
      code: 'AIT_IAP_CHECKOUT_IN_PROGRESS',
    });

    releaseCompletedWrite?.();
    await event;
    await expect(purchase).resolves.toMatchObject({ transactionId: 'order-event-error' });
    expect(JSON.parse(values.get(attemptKey) ?? '{}')).toMatchObject({ status: 'completed' });
    expect(values.has('mpgd:ait:iap-order-attempt:v1:order-event-error')).toBe(false);
  });

  it('fails closed when the provider lists a barrier order under another SKU', async () => {
    const ackKey = 'mpgd:ait:iap-ack-in-flight:v1';
    const barrier = JSON.stringify([{ orderId: 'order-moved', sku: coinsSku, phase: 'started' }]);
    for (const listedSku of [gemsSku, 'ait.unconfigured']) {
      const values = new Map<string, string>([[ackKey, barrier]]);
      const startPurchase = vi.fn();
      const completeProductGrant = vi.fn(async () => true);
      const options = {
        iapProducts: [coinsProduct, gemsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
        dependencies: createDependencies({
          storage: createMemoryStorage(values),
          iap: createSupportedIap({
            products: coinsCatalog,
            pendingOrders: { orders: [pendingOrder('order-moved', listedSku)] },
            completeProductGrant,
            onPurchase: startPurchase,
          }),
        }),
      };
      await expect(createAitIapController(options).purchase('COINS_100', `moved-${listedSku}`)).resolves.toEqual({
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED', retryable: true },
      });
      await expect(recoverError(createAitIapController(options)))
        .resolves.toMatchObject({ code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED' });
      expect(startPurchase).not.toHaveBeenCalled();
      expect(completeProductGrant).not.toHaveBeenCalled();
      expect(values.get(ackKey)).toBe(barrier);
    }

    // One order id reported under two SKUs also fails closed.
    const conflicting = createAitIapController({
      iapProducts: [coinsProduct, gemsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies: createDependencies({
        iap: createSupportedIap({
          pendingOrders: {
            orders: [pendingOrder('order-twice', coinsSku), pendingOrder('order-twice', gemsSku)],
          },
        }),
      }),
    });
    await expect(recoverError(conflicting)).resolves.toMatchObject({
      code: 'AIT_IAP_PENDING_ORDER_CHECK_FAILED',
    });
  });

  it('shares one IAP lock between controllers built on the same native dependencies', async () => {
    const callbacks: IapPurchaseCallbacks[] = [];
    const dependencies = createDependencies({
      storage: createMemoryStorage(new Map()),
      iap: createSupportedIap({
        products: coinsCatalog,
        onPurchase: (input) => {
          callbacks.push(input);
        },
      }),
    });
    const options = {
      iapProducts: [coinsProduct],
      prepareIap: async () => true,
      verifyIapProductGrant: async () => true,
      dependencies,
    };
    const first = createAitIapController(options);
    const reinstalled = createAitIapController(options);

    const [firstResult, secondResult] = [
      first.purchase('COINS_100', 'bridge-a'),
      reinstalled.purchase('COINS_100', 'bridge-b'),
    ];
    await expect(secondResult).resolves.toEqual({
      status: 'failed',
      entitlementIds: [],
      diagnostic: { code: 'AIT_IAP_CHECKOUT_IN_PROGRESS', retryable: true },
    });
    await expect(recoverError(reinstalled)).resolves.toMatchObject({
      code: 'AIT_IAP_CHECKOUT_IN_PROGRESS',
    });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    await callbacks[0]?.options.processProductGrant({ orderId: 'order-shared-lock' });
    await callbacks[0]?.onEvent({ type: 'success', data: createIapSuccessEvent('order-shared-lock') });
    await expect(firstResult).resolves.toMatchObject({ status: 'completed' });
    expect(callbacks).toHaveLength(1);

    // Released for every controller once the checkout settles.
    await expect(recover(reinstalled)).resolves.toEqual({
      restoredEntitlements: [],
    });
  });

  it('reports stable catalog and purchase diagnostic codes', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const baseOptions = {
        iapProducts: [coinsProduct, gemsProduct],
        prepareIap: async () => true,
        verifyIapProductGrant: async () => true,
      };
      const catalogBridge = (
        getProductItemList: () => Promise<IapProductListResult>,
      ) => createAitIapController({
        ...baseOptions,
        dependencies: createDependencies({ iap: createSupportedIap({ getProductItemList }) }),
      });

      await expect(catalogError(catalogBridge(async () => ({ products: [] })))).resolves.toMatchObject({ code: 'AIT_IAP_CATALOG_EMPTY', retryable: true });
      await expect(catalogError(catalogBridge(async () => undefined as unknown as IapProductListResult))).resolves.toMatchObject({ code: 'AIT_IAP_UNSUPPORTED_APP_VERSION', retryable: false });
      await expect(catalogError(catalogBridge(async () => ({ products: [createIapProduct({ sku: 'ait.other' })] })))).resolves.toMatchObject({ code: 'AIT_IAP_CONFIGURED_SKUS_NOT_VISIBLE', retryable: false });
      await expect(catalogError(catalogBridge(async () => {
          throw { code: 'NETWORK_ERROR', message: 'request for player 42 failed' };
        }))).resolves.toEqual({
        code: 'AIT_IAP_CATALOG_UNAVAILABLE',
        retryable: true,
        providerCode: 'NETWORK_ERROR',
      });
      // A partially visible catalog still lists the visible products.
      await expect(catalog(catalogBridge(async () => ({ products: [createIapProduct({ sku: coinsSku })] })))).resolves.toMatchObject([{ id: 'COINS_100' }]);

      await expect(catalogBridge(async () => ({ products: coinsCatalog })).purchase('UNKNOWN_PRODUCT', 'unknown-product')).resolves.toEqual({
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_PRODUCT_NOT_CONFIGURED', retryable: false },
      });

      const throwingCheckout = createAitIapController({
        ...baseOptions,
        dependencies: createDependencies({
          iap: {
            ...createSupportedIap({ products: coinsCatalog }),
            createOneTimePurchaseOrder: Object.assign(() => {
              throw Object.assign(new Error('checkout unavailable'), { code: 'APP_NOT_READY' });
            }, { isSupported: () => true }),
          },
        }),
      });
      await expect(throwingCheckout.purchase('COINS_100', 'throwing-checkout')).resolves.toEqual({
        status: 'failed',
        entitlementIds: [],
        diagnostic: {
          code: 'AIT_IAP_CHECKOUT_START_FAILED',
          retryable: true,
          providerCode: 'APP_NOT_READY',
        },
      });

      let callbacks: IapPurchaseCallbacks | undefined;
      const nativeError = createAitIapController({
        ...baseOptions,
        dependencies: createDependencies({
          iap: createSupportedIap({
            products: coinsCatalog,
            onPurchase: (input) => {
              callbacks = input;
            },
          }),
        }),
      });
      const purchase = nativeError.purchase('COINS_100', 'native-error');
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      await callbacks?.onError(new Error('payment failed for card 1234-5678'));
      await expect(purchase).resolves.toEqual({
        status: 'pending',
        entitlementIds: [],
        diagnostic: { code: 'AIT_IAP_NATIVE_PURCHASE_FAILED', retryable: true },
      });
    } finally {
      warning.mockRestore();
    }
  });
});

describe('AIT launch intent', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubSearch(search: string): void {
    vi.stubGlobal('location', { search, href: `https://game.web.tossmini.com/${search}` });
  }

  function nestedQueryParams(value: unknown): string {
    return `queryParams=${encodeURIComponent(JSON.stringify(value))}`;
  }

  const notificationTopics = {
    'energy-full': { templateSetCode: 'ttokdoku-energy-full', agreement: 'required' },
  } as const;

  it('reads a Toss inbox launch from the page URL when the host has no initial URL', async () => {
    stubSearch('?entry=daily&referrer=inbox');
    const bridge = createAitHostBridge({ notificationTopics, dependencies: createDependencies() });
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((envelope) => events.push(envelope));

    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({ entry: 'home' });
    expect(events).toEqual([
      expect.objectContaining({
        event: { type: 'opened', channel: 'remote', source: 'cold', referrer: 'inbox', route: '/?entry=daily' },
      }),
    ]);
  });

  it('falls back to the page URL when reading Environment.initialURL throws', async () => {
    stubSearch('?referrer=push');
    const bridge = createAitHostBridge({
      notificationTopics,
      dependencies: createDependencies({
        readInitialUrl: () => {
          throw new Error('no native constant');
        },
      }),
    });
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((envelope) => events.push(envelope));
    expect(events).toHaveLength(1);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({ entry: 'home' });
  });

  it('routes a push launch normally while no notification topic is configured', async () => {
    stubSearch('?entry=daily&puzzleId=p-1&referrer=push');
    const bridge = createAitHostBridge({ dependencies: createDependencies() });
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((envelope) => events.push(envelope));

    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'daily',
      puzzleId: 'p-1',
    });
    expect(events).toEqual([]);
  });

  it('reads the launch when the bridge is created, before the router can rewrite it', async () => {
    stubSearch('?entry=daily&referrer=push');
    const bridge = createAitHostBridge({ notificationTopics, dependencies: createDependencies() });
    stubSearch('?entry=daily');
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((envelope) => events.push(envelope));
    expect(events).toHaveLength(1);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({ entry: 'home' });
  });

  it('keeps routing push launches through the launch intent for a v1-only game', async () => {
    stubSearch('?entry=daily&referrer=push');
    const bridge = createAitHostBridge({
      notificationTemplateCodes: { 'streak-at-risk': 'TTOKDOKU_STREAK_ALERT' },
      dependencies: createDependencies(),
    });
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((envelope) => events.push(envelope));
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({ entry: 'daily' });
    expect(events).toEqual([]);
  });

  it('routes a push launch through the cold open when the runtime subscribes first', async () => {
    stubSearch('?entry=daily&referrer=push');
    const bridge = createAitHostBridge({ notificationTopics, dependencies: createDependencies() });
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((envelope) => events.push(envelope));
    expect(events).toHaveLength(1);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({ entry: 'home' });
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({ entry: 'home' });
  });

  it('routes a push launch from its landing route when the intent comes first and the page URL lacks it', async () => {
    stubSearch('');
    const bridge = createAitHostBridge({
      notificationTopics,
      dependencies: createDependencies({
        readInitialUrl: () => 'intoss://ttokdoku/daily?entry=daily&puzzleId=p-9&referrer=inbox',
      }),
    });
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'daily',
      puzzleId: 'p-9',
    });
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((envelope) => events.push(envelope));
    expect(events).toEqual([]);
  });

  it('routes a push launch through the launch intent when the game asks first, never losing it', async () => {
    stubSearch('?entry=daily&referrer=push');
    const bridge = createAitHostBridge({ notificationTopics, dependencies: createDependencies() });
    // The game asks before its notifications runtime subscribes, or it
    // exposes no notificationsV2 at all: the intent routes the launch.
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({ entry: 'daily' });
    const events: unknown[] = [];
    bridge.notificationsV2?.subscribe((envelope) => events.push(envelope));
    expect(events).toEqual([]);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({ entry: 'daily' });
  });

  it('prefers direct search params over nested queryParams and only fills missing keys', async () => {
    stubSearch(`?puzzleId=direct-puzzle&${nestedQueryParams({
      puzzleId: 'nested-puzzle',
      challengeToken: 'nested-token',
      entry: 'daily',
    })}`);
    const bridge = createAitHostBridge({ dependencies: createDependencies() });

    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'daily',
      puzzleId: 'direct-puzzle',
      referralToken: 'nested-token',
    });
    await expect(request(bridge, 'share.readInboundShare', {})).resolves.toEqual({
      puzzleId: 'direct-puzzle',
      challengeToken: 'nested-token',
    });
  });

  it('ignores malformed or non-object nested queryParams without dropping direct params', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });

    stubSearch('?queryParams=%7Bnot-json&challengeToken=direct-token');
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'friend-challenge',
      referralToken: 'direct-token',
    });

    stubSearch('?queryParams=%7Bnot-json');
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'home',
    });
    await expect(request(bridge, 'share.readInboundShare', {})).resolves.toBeNull();

    for (const nested of [['challengeToken', 'array-token'], 'string', 7, null]) {
      stubSearch(`?${nestedQueryParams(nested)}`);
      await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
        entry: 'home',
      });
    }

    stubSearch(`?${nestedQueryParams({ challengeToken: ['array-token'], puzzleId: 7 })}`);
    await expect(request(bridge, 'share.readInboundShare', {})).resolves.toBeNull();
  });

  it('drops oversized puzzleId and challengeToken values from direct and nested params', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });
    const maximum = 'p'.repeat(256);
    const oversized = 't'.repeat(257);

    stubSearch(`?puzzleId=${maximum}&challengeToken=${oversized}`);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'home',
      puzzleId: maximum,
    });
    await expect(request(bridge, 'share.readInboundShare', {})).resolves.toEqual({
      puzzleId: maximum,
    });

    stubSearch(`?${nestedQueryParams({ puzzleId: oversized, challengeToken: maximum })}`);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'friend-challenge',
      referralToken: maximum,
    });

    stubSearch(`?entry=${'daily'.padEnd(257, 'x')}&puzzleId=padded`);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'home',
      puzzleId: 'padded',
    });
  });

  it('bounds nested queryParams by serialized size and entry count', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });
    const padding = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`pad${index}`, 'x']),
    );

    stubSearch(`?${nestedQueryParams({ ...padding, challengeToken: 'late-token' })}`);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'home',
    });

    stubSearch(`?${nestedQueryParams({ challengeToken: 'early-token', ...padding })}`);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'friend-challenge',
      referralToken: 'early-token',
    });

    stubSearch(`?${nestedQueryParams({ challengeToken: 'huge-token', filler: 'f'.repeat(4_096) })}`);
    await expect(request(bridge, 'presentation.getLaunchIntent', {})).resolves.toEqual({
      entry: 'home',
    });
  });
});

describe('AIT sharing', () => {
  it('converts an HTTPS game path to the app-owned intoss deep link', async () => {
    const paths: string[] = [];
    const messages: string[] = [];
    const result = await shareIntent(
      {
        text: "Try today's challenge.",
        deepLink: 'https://game.example/daily?challengeToken=signed-token#result',
        previewImageUrl: 'https://game.example/daily.png',
      },
      {
        appName: 'ttokdoku',
        getTossShareLink: async (path) => {
          paths.push(path);
          return 'https://toss.im/_ul/daily';
        },
        share: async ({ message }) => {
          messages.push(message);
        },
      },
    );

    expect(result).toEqual({ status: 'shared', completion: 'presented' });
    expect(paths).toEqual([
      'intoss://ttokdoku/daily?challengeToken=signed-token#result',
    ]);
    expect(messages).toEqual(["Try today's challenge.\nhttps://toss.im/_ul/daily"]);
  });

  it('rejects unsafe links and preserves native share cancellation', async () => {
    const dependencies = {
      appName: 'ttokdoku',
      getTossShareLink: async () => 'https://toss.im/_ul/daily',
      share: async () => {},
    };

    await expect(shareIntent({ text: 'Unsafe', deepLink: 'javascript:alert(1)' }, dependencies))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(shareIntent(
      { text: 'Cancelled', deepLink: '/daily' },
      {
        ...dependencies,
        share: async () => {
          throw { name: 'AbortError' };
        },
      },
    )).resolves.toEqual({ status: 'cancelled' });
  });

  it('answers unavailable for share links that could name another host', async () => {
    const getTossShareLink = vi.fn(async () => 'https://toss.im/_ul/daily');
    const dependencies = { appName: 'ttokdoku', getTossShareLink, share: async () => {} };

    for (const deepLink of [
      // Root-relative escapes come from the shared route vectors below.
      // The same rules apply to the path of an absolute link.
      'https://game.example//evil.example/daily',
      'https://game.example/.//evil.example/daily',
      'https://game.example/%2F%2Fevil.example/daily',
      'https://game.example/daily\n',
      // An app link must start with exactly `intoss://<app>`, and its path follows the same rules.
      'intoss://ttokdoku/\\evil.example/daily',
      'intoss://ttokdoku//evil.example/daily',
      'intoss://evil-app\\@ttokdoku/daily',
      'intoss://ttokdoku@evil-app/daily',
      'intoss://ttokdoku:1/daily',
      'intoss://ttokdokuevil/daily',
      ' intoss://ttokdoku/daily',
    ]) {
      await expect(shareIntent({ text: 'Unsafe', deepLink }, dependencies), deepLink)
        .resolves.toEqual({ status: 'unavailable' });
    }

    expect(getTossShareLink).not.toHaveBeenCalled();
  });

  it('follows the shared route vectors for root-relative share links', async () => {
    const paths: string[] = [];
    const dependencies = {
      appName: 'ttokdoku',
      getTossShareLink: async (path: string) => {
        paths.push(path);
        return 'https://toss.im/_ul/daily';
      },
      share: async () => {},
    };

    for (const deepLink of rootRelativeRouteVectors.rejected) {
      await expect(shareIntent({ text: 'Unsafe', deepLink }, dependencies), JSON.stringify(deepLink))
        .resolves.toEqual({ status: 'unavailable' });
    }

    expect(paths).toEqual([]);

    for (const [deepLink] of rootRelativeRouteVectors.normalized) {
      await expect(shareIntent({ text: 'Share', deepLink }, dependencies), deepLink)
        .resolves.toEqual({ status: 'shared', completion: 'presented' });
    }

    expect(paths).toEqual(
      rootRelativeRouteVectors.normalized.map(([, route]) => `intoss://ttokdoku${route}`),
    );
  });

  it('shares app links whose path stays in the mini-app', async () => {
    const paths: string[] = [];
    const dependencies = {
      appName: 'ttokdoku',
      getTossShareLink: async (path: string) => {
        paths.push(path);
        return 'https://toss.im/_ul/daily';
      },
      share: async () => {},
    };

    for (const deepLink of [
      '/daily',
      '/levels//3?from=share#start',
      '/levels/../daily',
      '/a/%2Fb',
      'intoss://ttokdoku/daily?x=1#y',
      'intoss://ttokdoku',
      'https://game.example/levels//3',
    ]) {
      await expect(shareIntent({ text: 'Share', deepLink }, dependencies), deepLink)
        .resolves.toEqual({ status: 'shared', completion: 'presented' });
    }

    expect(paths).toEqual([
      'intoss://ttokdoku/daily',
      'intoss://ttokdoku/levels//3?from=share#start',
      'intoss://ttokdoku/daily',
      'intoss://ttokdoku/a/%2Fb',
      'intoss://ttokdoku/daily?x=1#y',
      'intoss://ttokdoku/',
      'intoss://ttokdoku/levels//3',
    ]);
  });
});

type LoadAdCallbacks = Parameters<AitHostDependencies['loadFullScreenAd']>[0];
type ShowAdCallbacks = Parameters<AitHostDependencies['showFullScreenAd']>[0];
type NotificationAgreementCallbacks = Parameters<
  AitHostDependencies['requestNotificationAgreement']
>[0];
type IapPurchaseCallbacks = Parameters<
  AitHostDependencies['iap']['createOneTimePurchaseOrder']
>[0];
type IapProductListResult = Awaited<
  ReturnType<AitHostDependencies['iap']['getProductItemList']>
>;
type IapPendingOrdersResult = Awaited<
  ReturnType<AitHostDependencies['iap']['getPendingOrders']>
>;

type AitSdkDependencyKey =
  | 'grantPromotionReward'
  | 'openGameCenterLeaderboard'
  | 'requestNotificationAgreement'
  | 'submitGameCenterLeaderBoardScore';

type CallableOnly<TFunction extends (...args: never[]) => unknown> = (
  ...args: Parameters<TFunction>
) => ReturnType<TFunction>;

type AitSdkTestHandler<TKey extends AitSdkDependencyKey> =
  CallableOnly<AitHostDependencies[TKey]>
  & Partial<Pick<AitHostDependencies[TKey], 'isSupported'>>;

type AitHostDependencyOverrides = Omit<Partial<AitHostDependencies>, AitSdkDependencyKey>
  & {
    grantPromotionReward?: AitSdkTestHandler<'grantPromotionReward'>;
    openGameCenterLeaderboard?: AitSdkTestHandler<'openGameCenterLeaderboard'>;
    requestNotificationAgreement?: AitSdkTestHandler<'requestNotificationAgreement'>;
    submitGameCenterLeaderBoardScore?: AitSdkTestHandler<
      'submitGameCenterLeaderBoardScore'
    >;
  };

function createDependencies(
  overrides: AitHostDependencyOverrides = {},
): AitHostDependencies {
  const unsupportedAd = Object.assign(() => () => {}, { isSupported: () => false });
  const unsupportedIap = {
    createOneTimePurchaseOrder: Object.assign(() => () => {}, { isSupported: () => false }),
    getProductItemList: Object.assign(async () => ({ products: [] }), { isSupported: () => false }),
    getPendingOrders: Object.assign(async () => ({ orders: [] }), { isSupported: () => false }),
    completeProductGrant: Object.assign(async () => false, { isSupported: () => false }),
  };
  const unsupportedBanner = {
    initialize: Object.assign((_options: unknown): void => {}, { isSupported: () => false }),
    attachBanner: Object.assign(
      (_adGroupId: string, _target: string | HTMLElement, _options?: unknown) => ({
        destroy(): void {},
      }),
      { isSupported: () => false },
    ),
  };
  const {
    grantPromotionReward = async () => ({ key: 'test-promotion-receipt' }),
    openGameCenterLeaderboard = async () => {},
    requestNotificationAgreement = () => () => {},
    submitGameCenterLeaderBoardScore = async () => ({ statusCode: 'SUCCESS' as const }),
    ...otherOverrides
  } = overrides;

  return {
    identityProvider: async () => ({ type: 'HASH', hash: 'test-player' }),
    storage: {
      getItem: async () => null,
      removeItem: async () => {},
      setItem: async () => {},
    },
    getTossShareLink: async () => 'https://toss.im/test',
    share: async () => {},
    grantPromotionReward: withSupportProbe(grantPromotionReward),
    requestNotificationAgreement: withSupportProbe(requestNotificationAgreement, false),
    readInitialUrl: () => undefined,
    isMinVersionSupported: () => true,
    loadFullScreenAd: unsupportedAd,
    showFullScreenAd: unsupportedAd,
    tossAds: unsupportedBanner,
    openGameCenterLeaderboard: withSupportProbe(openGameCenterLeaderboard),
    submitGameCenterLeaderBoardScore: withSupportProbe(submitGameCenterLeaderBoardScore),
    iap: unsupportedIap,
    ...otherOverrides,
  } as AitHostDependencies;
}

function withSupportProbe<TKey extends AitSdkDependencyKey>(
  handler: AitSdkTestHandler<TKey>,
  supportedByDefault = true,
): CallableOnly<AitHostDependencies[TKey]>
  & Pick<AitHostDependencies[TKey], 'isSupported'> {
  return Object.assign(handler, {
    isSupported: handler.isSupported ?? (() => supportedByDefault),
  });
}

function createMemoryStorage(values: Map<string, string>): AitHostDependencies['storage'] {
  return {
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
}

function createSupportedIap(input: {
  readonly products?: IapProductListResult['products'];
  readonly pendingOrders?: IapPendingOrdersResult;
  readonly getProductItemList?: () => Promise<IapProductListResult>;
  readonly getPendingOrders?: () => Promise<IapPendingOrdersResult>;
  readonly onPurchase?: (callbacks: IapPurchaseCallbacks) => void;
  readonly onCleanup?: () => void;
  readonly completeProductGrant?: (input: { readonly params: { readonly orderId: string } }) => Promise<boolean>;
} = {}): AitHostDependencies['iap'] {
  const iap = {
    createOneTimePurchaseOrder: Object.assign((callbacks: IapPurchaseCallbacks) => {
      input.onPurchase?.(callbacks);
      return () => {
        input.onCleanup?.();
      };
    }, { isSupported: () => true }),
    getProductItemList: Object.assign(input.getProductItemList ?? (async () => ({
      products: input.products ?? [],
    })), {
      isSupported: () => true,
    }),
    getPendingOrders: Object.assign(input.getPendingOrders ?? (async () => (
      input.pendingOrders ?? ({ orders: [] })
    )), {
      isSupported: () => true,
    }),
    completeProductGrant: Object.assign(
      input.completeProductGrant ?? (async () => true),
      { isSupported: () => true },
    ),
  } satisfies AitHostDependencies['iap'];
  return iap;
}

function createIapProduct(input: {
  readonly sku?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly displayAmount?: string;
} = {}): IapProductListResult['products'][number] {
  return {
    sku: input.sku ?? 'ait.ttokdoku.hints.5',
    displayAmount: input.displayAmount ?? '₩1,100',
    displayName: input.displayName ?? 'Hint Pack',
    description: input.description ?? 'Adds five hints.',
    iconUrl: 'https://images.example/hints.png',
    type: 'CONSUMABLE',
  };
}

function createIapSuccessEvent(orderId: string) {
  return {
    orderId,
    displayName: 'Hint Pack',
    displayAmount: '₩1,100',
    amount: 1100,
    currency: 'KRW',
    fraction: 0,
    miniAppIconUrl: null,
  };
}

/**
 * The engine tests below drive the IAP controller the commerce provider runs
 * on (`createAitIapController`) with the same options and dependencies the
 * host bridge gives it; the bridge-level commerce behavior is covered through
 * the six `commerce.v2.*` methods. `recover` is the pending-order recovery
 * pass (what `restorePurchases` runs) reported as the entitlements it
 * restored, the purchases it settled and, while a paid order stays
 * ungranted, the unresolved diagnostic.
 */
async function recover(iap: AitIapController): Promise<PurchaseRestoreResult> {
  const outcome = await iap.recoverPendingOrders();
  if (outcome.status === 'failed') {
    throw new Error(`Pending-order recovery failed: ${outcome.diagnostic.code}`);
  }
  const { reconciliation } = outcome;
  return {
    restoredEntitlements: reconciliation.restoredEntitlements,
    ...(reconciliation.settledPurchases.length === 0
      ? {}
      : { settledPurchases: reconciliation.settledPurchases }),
    ...(reconciliation.unresolvedOrders.length === 0
      ? {}
      : {
          diagnostic: {
            code: 'AIT_IAP_PENDING_ORDER_UNRESOLVED',
            retryable: true,
            ...(reconciliation.diagnostic?.providerCode === undefined
              ? {}
              : { providerCode: reconciliation.diagnostic.providerCode }),
          },
        }),
  };
}

/** The diagnostic of a recovery pass that did not complete. */
async function recoverError(iap: AitIapController): Promise<CommerceDiagnostic> {
  const outcome = await iap.recoverPendingOrders();
  if (outcome.status !== 'failed') {
    throw new Error('Expected pending-order recovery to fail.');
  }
  return outcome.diagnostic;
}

/** The native catalog as the controller lists it; a failed read throws its code. */
async function catalog(iap: AitIapController): Promise<readonly ProductInfo[]> {
  const outcome = await iap.listProducts();
  if (outcome.status === 'failed') {
    throw new Error(`Catalog read failed: ${outcome.diagnostic.code}`);
  }
  return outcome.products;
}

/** The diagnostic of a catalog read that failed. */
async function catalogError(iap: AitIapController): Promise<CommerceDiagnostic> {
  const outcome = await iap.listProducts();
  if (outcome.status !== 'failed') {
    throw new Error('Expected the catalog read to fail.');
  }
  return outcome.diagnostic;
}

async function requestError(
  bridge: ReturnType<typeof createAitHostBridge>,
  method: BridgeRequest['method'],
  payload: unknown,
): Promise<{ readonly code: string; readonly message: string; readonly retryable: boolean }> {
  const response = await bridge.request({
    id: `${method}:test`,
    method,
    payload,
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'test',
      sentAt: '2026-07-19T00:00:00.000Z',
    },
  } satisfies BridgeRequest);
  if (response.ok) {
    throw new Error(`Expected ${method} to fail.`);
  }
  return response.error;
}

async function request(
  bridge: ReturnType<typeof createAitHostBridge>,
  method: BridgeRequest['method'],
  payload: unknown,
): Promise<unknown> {
  const response = await bridge.request({
    id: `${method}:test`,
    method,
    payload,
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'test',
      sentAt: '2026-07-19T00:00:00.000Z',
    },
  } satisfies BridgeRequest);

  if (!response.ok) {
    throw new Error(response.error.message);
  }

  return response.data;
}
