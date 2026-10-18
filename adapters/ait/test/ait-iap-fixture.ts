import type { AitHostDependencies } from '../src/host.js';
import type { AitIapDependencies, AitIapHostDependencies } from '../src/iap.js';

/**
 * Fake Apps in Toss IAP host for commerce tests: the four native IAP methods
 * over an in-memory pending-order list, in-memory native storage, scripted
 * checkout and `completeProductGrant()` answers, and the pending-order change
 * signal the commerce v2 provider subscribes to. It behaves the way the SDK
 * does: a checkout that grants calls `processProductGrant` and then reports
 * `success` (the SDK completes such an order itself), a checkout whose grant
 * callback refused reports `PRODUCT_NOT_GRANTED_BY_PARTNER` and leaves the
 * paid order in the pending list, and `completeProductGrant()` removes a
 * listed order.
 */

export interface FakeAitIapOrder {
  readonly orderId: string;
  readonly sku: string;
  readonly paymentCompletedDate: string;
}

export interface FakeAitIapProduct {
  readonly sku: string;
  readonly type: 'CONSUMABLE' | 'NON_CONSUMABLE' | 'SUBSCRIPTION';
  readonly displayName?: string;
  readonly displayAmount?: string;
  readonly description?: string;
}

export type FakeAitCheckoutOutcome =
  /** The SDK asks the host to grant `orderId`; `success` follows a confirmed grant. */
  | { readonly kind: 'grant'; readonly orderId: string }
  /** The SDK reports an error before any order is observed. */
  | { readonly kind: 'error'; readonly error: unknown }
  /** The player cancels. */
  | { readonly kind: 'cancel' }
  /** The outcome is not known yet: the SDK reports a non-cancel error without an order. */
  | { readonly kind: 'deferred' }
  /** The SDK never reports a terminal callback. */
  | { readonly kind: 'hang' };

export type FakeAitCompleteOutcome =
  | { readonly returns: boolean }
  | { readonly throws: unknown };

export interface FakeAitCompleteCall {
  readonly orderId: string;
  readonly result: 'true' | 'false' | `threw:${string}`;
}

export interface FakeAitIapHost {
  readonly dependencies: AitIapHostDependencies;
  readonly iap: AitIapDependencies;
  readonly storage: AitIapHostDependencies['storage'];
  readonly values: Map<string, string>;
  readonly pendingOrders: FakeAitIapOrder[];
  readonly checkoutCalls: { readonly sku: string }[];
  readonly completeCalls: FakeAitCompleteCall[];
  /** The checkout outcome for the next `createOneTimePurchaseOrder()`; the default repeats. */
  queueCheckout(outcome: FakeAitCheckoutOutcome): void;
  queueComplete(outcome: FakeAitCompleteOutcome): void;
  /** Lists a paid order the way the provider does and signals the change with that order. */
  addPendingOrder(order: FakeAitIapOrder): void;
  /** The pending-order change signal, in the shape `createAitCommerceProvider` subscribes with. */
  onPendingOrdersChanged(listener: (change?: { readonly orders?: readonly FakeAitIapOrder[] }) => void): () => void;
  signalPendingOrdersChanged(change?: { readonly orders?: readonly FakeAitIapOrder[] }): void;
  /** Whether the four native methods report support. */
  supported: boolean;
  /** Scripted `getProductItemList()` failure. */
  catalogError: unknown;
  /** Scripted `getPendingOrders()` failure. */
  pendingOrdersError: unknown;
}

export interface CreateFakeAitIapHostInput {
  readonly products: readonly FakeAitIapProduct[];
  readonly defaultCheckout?: FakeAitCheckoutOutcome;
}

export function createFakeAitIapHost(input: CreateFakeAitIapHostInput): FakeAitIapHost {
  const values = new Map<string, string>();
  const pendingOrders: FakeAitIapOrder[] = [];
  const checkoutCalls: { readonly sku: string }[] = [];
  const completeCalls: FakeAitCompleteCall[] = [];
  const checkoutQueue: FakeAitCheckoutOutcome[] = [];
  const completeQueue: FakeAitCompleteOutcome[] = [];
  const listeners = new Set<(change?: { readonly orders?: readonly FakeAitIapOrder[] }) => void>();
  const defaultCheckout = input.defaultCheckout ?? { kind: 'deferred' };

  const probe = { isSupported: () => host.supported };
  const storage: AitIapHostDependencies['storage'] = {
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };

  const iap: AitIapDependencies = {
    createOneTimePurchaseOrder: Object.assign((params: Parameters<AitIapDependencies['createOneTimePurchaseOrder']>[0]) => {
      checkoutCalls.push({ sku: params.options.sku ?? params.options.productId ?? '' });
      const outcome = checkoutQueue.shift() ?? defaultCheckout;
      let cancelled = false;
      queueMicrotask(() => {
        void (async () => {
          if (cancelled) {
            return;
          }
          switch (outcome.kind) {
            case 'grant': {
              const granted = await params.options.processProductGrant({ orderId: outcome.orderId });
              if (cancelled) {
                return;
              }
              if (granted === true) {
                await params.onEvent({
                  type: 'success',
                  data: {
                    orderId: outcome.orderId,
                    displayName: 'Fixture product',
                    displayAmount: 'KRW 1,100',
                    amount: 1_100,
                    currency: 'KRW',
                    fraction: 0,
                    miniAppIconUrl: null,
                  },
                });
              } else {
                // Paid, not granted: the order waits in the pending list.
                if (!pendingOrders.some((order) => order.orderId === outcome.orderId)) {
                  pendingOrders.push({
                    orderId: outcome.orderId,
                    sku: params.options.sku ?? params.options.productId ?? '',
                    paymentCompletedDate: '2026-10-01T00:00:00Z',
                  });
                }
                await params.onError({
                  code: 'PRODUCT_NOT_GRANTED_BY_PARTNER',
                  message: 'Product not granted by partner.',
                });
              }
              return;
            }
            case 'error':
              await params.onError(outcome.error);
              return;
            case 'cancel':
              await params.onError({ code: 'USER_CANCELLED', message: 'The player cancelled.' });
              return;
            case 'deferred':
              await params.onError({
                code: 'FAKE_CHECKOUT_DEFERRED',
                message: 'The checkout outcome is not known yet.',
              });
              return;
            case 'hang':
              return;
          }
        })();
      });
      return () => {
        cancelled = true;
      };
    }, probe),
    getProductItemList: Object.assign(async () => {
      if (host.catalogError !== undefined) {
        throw host.catalogError;
      }
      return {
        products: input.products.map((product) => ({
          sku: product.sku,
          type: product.type,
          displayName: product.displayName ?? `Product ${product.sku}`,
          displayAmount: product.displayAmount ?? 'KRW 1,100',
          description: product.description ?? `Fixture product ${product.sku}`,
          iconUrl: 'https://example.invalid/icon.png',
        })),
      } as Awaited<ReturnType<AitIapDependencies['getProductItemList']>>;
    }, probe),
    getPendingOrders: Object.assign(async () => {
      if (host.pendingOrdersError !== undefined) {
        throw host.pendingOrdersError;
      }
      return { orders: pendingOrders.map((order) => ({ ...order })) };
    }, probe),
    completeProductGrant: Object.assign(async ({ params }: { readonly params: { readonly orderId: string } }) => {
      const queued = completeQueue.shift();
      if (queued !== undefined && 'throws' in queued) {
        const code = readCode(queued.throws);
        completeCalls.push({ orderId: params.orderId, result: `threw:${code}` });
        throw queued.throws;
      }
      const index = pendingOrders.findIndex((order) => order.orderId === params.orderId);
      const returns = queued === undefined ? index !== -1 : queued.returns;
      if (returns && index !== -1) {
        pendingOrders.splice(index, 1);
      }
      completeCalls.push({ orderId: params.orderId, result: returns ? 'true' : 'false' });
      return returns;
    }, probe),
  };

  const host: FakeAitIapHost = {
    dependencies: { iap, storage },
    iap,
    storage,
    values,
    pendingOrders,
    checkoutCalls,
    completeCalls,
    supported: true,
    catalogError: undefined,
    pendingOrdersError: undefined,
    queueCheckout(outcome) {
      checkoutQueue.push(outcome);
    },
    queueComplete(outcome) {
      completeQueue.push(outcome);
    },
    addPendingOrder(order) {
      if (!pendingOrders.some((candidate) => candidate.orderId === order.orderId)) {
        pendingOrders.push({ ...order });
      }
      host.signalPendingOrdersChanged({ orders: [order] });
    },
    onPendingOrdersChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signalPendingOrdersChanged(change) {
      for (const listener of [...listeners]) {
        listener(change);
      }
    },
  };
  return host;
}

function readCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNKNOWN';
}

/** Every non-IAP host dependency stubbed as unsupported, so a host bridge can be built on the fake IAP host. */
export function createFakeAitHostDependencies(
  host: FakeAitIapHost,
  overrides: Partial<AitHostDependencies> = {},
): AitHostDependencies {
  const unsupported = { isSupported: () => false };
  const unsupportedAd = Object.assign(() => () => {}, unsupported);
  return {
    identityProvider: async () => ({ type: 'HASH', hash: 'test-player' }),
    storage: host.storage,
    getTossShareLink: async () => 'https://toss.im/test',
    share: async () => {},
    grantPromotionReward: Object.assign(
      async () => ({ key: 'test-promotion-receipt' }),
      unsupported,
    ),
    requestNotificationAgreement: Object.assign(() => () => {}, unsupported),
    readInitialUrl: () => undefined,
    isMinVersionSupported: () => true,
    loadFullScreenAd: unsupportedAd,
    showFullScreenAd: unsupportedAd,
    tossAds: {
      initialize: Object.assign((_options: unknown): void => {}, unsupported),
      attachBanner: Object.assign(
        (_adGroupId: string, _target: string | HTMLElement, _options?: unknown) => ({
          destroy(): void {},
        }),
        unsupported,
      ),
    },
    openGameCenterLeaderboard: Object.assign(async () => {}, unsupported),
    submitGameCenterLeaderBoardScore: Object.assign(
      async () => ({ statusCode: 'SUCCESS' as const }),
      unsupported,
    ),
    iap: host.iap,
    ...overrides,
  } as AitHostDependencies;
}

/** Lets queued microtasks and the fake's immediate native answers settle. */
export async function flushAitIap(): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
