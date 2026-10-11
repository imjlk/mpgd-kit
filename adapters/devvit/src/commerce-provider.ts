import type { PlatformProviderAvailability } from '@mpgd/platform';
import {
  assertRequestPurchaseSupported,
  assertStoreProduct,
  CommerceError,
  createCommerceEventBuffer,
  isCommerceErrorCode,
  type CommerceCapabilities,
  type CommerceErrorInfo,
  type CommerceEvent,
  type CommerceProvider,
  type FetchProductsInput,
  type GetAvailablePurchasesInput,
  type PurchaseKind,
  type RequestPurchaseInput,
  type RequestPurchaseResult,
  type StoreId,
  type StoreProduct,
  type StorePurchase,
} from '@mpgd/platform/commerce';

import {
  createDevvitCommerceCapabilities,
  createDevvitStorePurchase,
  devvitCommerceStoreId,
  maximumDevvitAvailableOrders,
  readDevvitIdentifier,
  type DevvitPaidOrder,
} from './commerce-contract.js';
import {
  normalizeDevvitCommerceProducts,
  type DevvitCheckoutFailure,
  type DevvitCheckoutResult,
  type DevvitCommerceProduct,
  type DevvitPaymentsClient,
} from './payments.js';

/**
 * Refreshes an order reported ahead of the list (by a checkout result or a
 * signal) survives without a listing showing it; it is forgotten on the next
 * one, so a re-listed order is reported again.
 */
export const unlistedOrderGraceRefreshes = 7;

/** Store codes the provider attaches to failures of its own. */
export const devvitCommerceStoreCodes = Object.freeze({
  productNotConfigured: 'DEVVIT_PRODUCT_NOT_CONFIGURED',
  checkoutFailed: 'DEVVIT_CHECKOUT_FAILED',
  checkoutCancelled: 'DEVVIT_CHECKOUT_CANCELLED',
  ordersUnavailable: 'DEVVIT_ORDERS_UNAVAILABLE',
} as const);

/**
 * The server-push lookup of the Devvit provider: the user's recent paid
 * orders, each marked `delivered` once Reddit acknowledged its delivery
 * (which happens as soon as the fulfillment handler answered). The order
 * list is server-only in Devvit (`payments.getOrders`), so the webview reads
 * it through the server bridge (`commerce.v2.getAvailablePurchases`); the
 * conformance harness reads it from its fake payments plugin.
 */
export interface DevvitOrderSource {
  listPaidOrders(): Promise<readonly DevvitPaidOrder[]>;
  /** Whether the server side serves commerce v2; defaults to `available`. */
  getAvailability?(): Promise<PlatformProviderAvailability>;
}

export interface DevvitOrdersChange {
  /**
   * Paid orders the signaller already knows, for example the order a
   * realtime message named. The provider reports them at once and still
   * re-reads the order source; an order for an unconfigured SKU is ignored.
   */
  readonly orders?: readonly DevvitPaidOrder[];
}

export type DevvitOrdersChangeListener = (change?: DevvitOrdersChange) => void;

export interface CreateDevvitCommerceProviderInput {
  readonly products: readonly DevvitCommerceProduct[];
  /** Opens the Reddit checkout (`purchase()` from `@devvit/payments/client`). */
  readonly client: Pick<DevvitPaymentsClient, 'purchase'>;
  readonly orders: DevvitOrderSource;
  /** Defaults to `devvit`; conformance vectors name their fixture store. */
  readonly store?: StoreId;
  /**
   * Signals that the paid-order list may have changed, for example because the
   * webview became visible again. The provider reports the orders the signal
   * carries at once, then re-reads the list and emits `purchaseUpdated` for
   * paid orders it has not reported yet. Observed only while a listener
   * exists. Absent, orders are read on demand only.
   */
  readonly onOrdersChanged?: (listener: DevvitOrdersChangeListener) => () => void;
  readonly onCheckoutError?: (error: unknown) => void;
}

export interface DevvitCommerceProvider extends CommerceProvider {
  restorePurchases(): Promise<void>;
  /** Stops observing the order signal; the provider answers no further events. */
  dispose(): void;
}

/**
 * Commerce v2 provider for Devvit (RFC profile `devvit`, see
 * `createDevvitCommerceCapabilities`). Reddit's fulfillment handler settles a
 * purchase on the server: it writes the backend ledger, and the client learns
 * of the grant through the backend's server-push lookup verifier, which
 * answers `pending` until that entry exists. The provider therefore never
 * grants and has nothing to finish.
 *
 * - `requestPurchase` opens the Reddit checkout. A checkout that already
 *   carries the created order id answers `purchased` with the order id as
 *   `transactionId` and `token` and `devvit.order.v1` evidence; the backend
 *   verify is what grants it. A checkout without an order id, or one that
 *   ended `pending`, is `launched`: an order may exist, and the reconciler
 *   resolves it from `getAvailablePurchases`. A dismissed checkout is
 *   `cancelled`; a failed one is `failed` with the platform code as
 *   `storeCode` (`OUTCOME_UNKNOWN` and `ALREADY_OWNED` classes stay open as
 *   `launched`, as the RFC requires, and so does a `purchase()` call that
 *   rejects, since a missing response does not prove a missing order).
 * - `getAvailablePurchases` lists the paid orders whose delivery the server
 *   has not acknowledged (the order source without its delivered entries),
 *   bounded by `maximumDevvitAvailableOrders`; `includePending` adds nothing
 *   because Devvit has no store-side pending order.
 * - `restorePurchases` re-reads the order source and emits `purchaseUpdated`
 *   once per order not reported before, delivered orders included: Reddit
 *   marks an order delivered as soon as the fulfillment handler answered, so
 *   a session that lost its checkout result finds the order this way and the
 *   backend lookup answers `granted` for it. The first listener triggers the
 *   same read. Events before the first `subscribe` are buffered.
 * - The provider emits no `purchaseError`: every checkout outcome is a
 *   synchronous result of the purchase call.
 */
export function createDevvitCommerceProvider(
  input: CreateDevvitCommerceProviderInput,
): DevvitCommerceProvider {
  const store: StoreId = input.store ?? devvitCommerceStoreId;
  if (store.length === 0) {
    throw new TypeError('A Devvit commerce provider requires a non-empty store id.');
  }
  const products = normalizeDevvitCommerceProducts(input.products);
  const oneTimeProductCount = products.filter(
    (product) => product.info.type !== 'subscription',
  ).length;
  const productsById = new Map(products.map((product) => [product.info.id, product]));
  const productsBySku = new Map(products.map((product) => [product.sku, product]));
  const buffer = createCommerceEventBuffer();
  const listeners = new Set<(event: CommerceEvent) => void>();
  /** Orders already reported, through a checkout result or a `purchaseUpdated` event. */
  const reportedOrders = new Set<string>();
  /**
   * Orders reported ahead of the list (a checkout result or a signal) that no
   * listing has confirmed yet, with the unlisted refreshes left before one is
   * forgotten: the server may list a just-created order a moment later, and
   * it must not be reported twice.
   */
  const unlistedOrders = new Map<string, number>();

  /** Bounds the reported set (oldest first) and drops grace entries of evicted orders. */
  const boundReported = (): void => {
    for (const oldest of reportedOrders) {
      if (reportedOrders.size <= maximumDevvitAvailableOrders) {
        break;
      }
      reportedOrders.delete(oldest);
    }
    for (const tracked of [...unlistedOrders.keys()]) {
      if (!reportedOrders.has(tracked)) {
        unlistedOrders.delete(tracked);
      }
    }
  };

  const emit = (event: CommerceEvent): void => {
    if (listeners.size === 0) {
      buffer.push(event);
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One listener must not stop the others from receiving the event.
        console.warn('Devvit commerce listener failed.', errorMessage(error));
      }
    }
  };

  const toPurchase = (
    order: DevvitPaidOrder,
    source: 'checkout' | 'order-list',
  ): StorePurchase | undefined => {
    const product = productsBySku.get(order.sku);
    if (product === undefined) {
      // An order for a SKU this build does not sell is not this game's purchase.
      return undefined;
    }
    return createDevvitStorePurchase({
      store,
      orderId: order.orderId,
      sku: order.sku,
      logicalId: product.info.id,
      source,
      paidAt: order.paidAt,
      environment: order.environment,
      delivered: order.delivered,
    });
  };

  const readPaidOrders = async (): Promise<readonly DevvitPaidOrder[]> => {
    let orders: readonly DevvitPaidOrder[];
    try {
      orders = await input.orders.listPaidOrders();
    } catch (error) {
      throw toCommerceError(error);
    }
    if (orders.length > maximumDevvitAvailableOrders) {
      console.warn('Devvit paid-order list exceeds the available-purchase bound.', {
        limit: maximumDevvitAvailableOrders,
        ignoredOrderCount: orders.length - maximumDevvitAvailableOrders,
      });
    }
    return orders.slice(0, maximumDevvitAvailableOrders).filter((order) =>
      readDevvitIdentifier(order.orderId) !== undefined
      && readDevvitIdentifier(order.sku) !== undefined);
  };

  /**
   * Reports a paid order once. The purchase is built before any bookkeeping,
   * so an order the contract rejects is neither marked reported nor emitted.
   */
  const reportOrder = (order: DevvitPaidOrder, aheadOfList = false): void => {
    if (reportedOrders.has(order.orderId)) {
      return;
    }
    let purchase: StorePurchase | undefined;
    try {
      purchase = toPurchase(order, 'order-list');
    } catch (error) {
      // One invalid order must not hide the others.
      console.warn('Devvit paid order was not reported.', errorMessage(error));
      return;
    }
    if (purchase === undefined) {
      return;
    }
    reportedOrders.add(order.orderId);
    if (aheadOfList) {
      unlistedOrders.set(order.orderId, unlistedOrderGraceRefreshes);
    }
    boundReported();
    emit({ type: 'purchaseUpdated', purchase });
  };

  /** Re-reads the paid orders and reports the ones not reported yet. */
  const refreshOrders = async (): Promise<void> => {
    const orders = await readPaidOrders();
    const listed = new Set(orders.map((order) => order.orderId));
    for (const order of orders) {
      reportOrder(order);
    }
    for (const orderId of [...reportedOrders]) {
      if (listed.has(orderId)) {
        // A listing confirmed the order; it is a listed order now.
        unlistedOrders.delete(orderId);
        continue;
      }
      const remaining = unlistedOrders.get(orderId);
      if (remaining !== undefined && remaining > 0) {
        // Not listed yet: the server may still be catching up.
        unlistedOrders.set(orderId, remaining - 1);
        continue;
      }
      // An order the server stopped listing (or never listed within the grace)
      // was delivered; it is forgotten so a re-listed order is reported again.
      unlistedOrders.delete(orderId);
      reportedOrders.delete(orderId);
    }
  };
  const refreshInBackground = (): void => {
    void refreshOrders().catch((error: unknown) => {
      console.warn('Devvit paid-order refresh failed.', errorMessage(error));
    });
  };

  /** Reports the orders a signal carries; the read that follows confirms the rest. */
  const reportSignalledOrders = (orders: readonly DevvitPaidOrder[]): void => {
    for (const order of orders.slice(0, maximumDevvitAvailableOrders)) {
      if (
        readDevvitIdentifier(order.orderId) === undefined
        || readDevvitIdentifier(order.sku) === undefined
      ) {
        continue;
      }
      reportOrder(order, true);
    }
  };

  let detachOrderSignal: (() => void) | undefined;
  const attachOrderSignal = (): void => {
    if (detachOrderSignal !== undefined || input.onOrdersChanged === undefined) {
      return;
    }
    detachOrderSignal = input.onOrdersChanged((change) => {
      if (change?.orders !== undefined && Array.isArray(change.orders)) {
        reportSignalledOrders(change.orders);
      }
      refreshInBackground();
    });
  };
  const detachOrderSignalIfIdle = (): void => {
    if (listeners.size > 0 || detachOrderSignal === undefined) {
      return;
    }
    const detach = detachOrderSignal;
    detachOrderSignal = undefined;
    detach();
  };

  const toRequestPurchaseResult = (
    product: DevvitCommerceProduct,
    result: DevvitCheckoutResult,
  ): RequestPurchaseResult => {
    switch (result.status) {
      case 'completed': {
        const orderId = readDevvitIdentifier(result.orderId);
        if (orderId === undefined) {
          // Reddit answered without an order id: an order may still exist.
          return { outcome: 'launched' };
        }
        const purchase = createDevvitStorePurchase({
          store,
          orderId,
          sku: product.sku,
          logicalId: product.info.id,
          source: 'checkout',
        });
        reportedOrders.add(orderId);
        unlistedOrders.set(orderId, unlistedOrderGraceRefreshes);
        boundReported();
        return { outcome: 'purchased', purchase };
      }
      case 'pending':
        return { outcome: 'launched' };
      case 'cancelled':
        return { outcome: 'cancelled', error: toCancelledErrorInfo(result.error) };
      case 'failed': {
        const error = toCheckoutErrorInfo(result.error);
        if (error.code === 'OUTCOME_UNKNOWN' || error.code === 'ALREADY_OWNED') {
          // RFC "Errors": an unfinished order may exist, so the attempt stays
          // open for the reconciler instead of becoming terminal.
          return { outcome: 'launched' };
        }
        if (error.code === 'USER_CANCELLED') {
          return { outcome: 'cancelled', error };
        }
        return { outcome: 'failed', error };
      }
      default:
        return {
          outcome: 'failed',
          error: new CommerceError('INVALID_RESPONSE', {
            message: `Devvit checkout answered an unknown status: ${String(
              (result as { readonly status?: unknown }).status,
            )}.`,
          }).toCommerceErrorInfo(),
        };
    }
  };

  const provider: DevvitCommerceProvider = {
    store,
    async getCapabilities(): Promise<CommerceCapabilities> {
      let availability: PlatformProviderAvailability = 'available';
      if (oneTimeProductCount === 0) {
        // A catalog without a consumable or durable product sells nothing here.
        availability = 'configuration-required';
      } else if (input.orders.getAvailability !== undefined) {
        try {
          availability = await input.orders.getAvailability();
        } catch (error) {
          console.warn('Devvit commerce availability read failed.', errorMessage(error));
          availability = 'temporarily-unavailable';
        }
      }
      return createDevvitCommerceCapabilities(availability);
    },
    async fetchProducts(request: FetchProductsInput = {}): Promise<readonly StoreProduct[]> {
      if ((request.type ?? 'all') === 'subscription') {
        return [];
      }
      const listed: StoreProduct[] = [];
      for (const product of products) {
        if (request.logicalIds !== undefined && !request.logicalIds.includes(product.info.id)) {
          continue;
        }
        const storeProduct = toStoreProduct(store, product);
        if (storeProduct !== undefined) {
          listed.push(storeProduct);
        }
      }
      return listed;
    },
    async requestPurchase(request: RequestPurchaseInput): Promise<RequestPurchaseResult> {
      const product = productsById.get(request.logicalId);
      if (product === undefined) {
        return {
          outcome: 'failed',
          error: new CommerceError('ITEM_UNAVAILABLE', {
            message: `Devvit product ${request.logicalId} is not configured.`,
            storeCode: devvitCommerceStoreCodes.productNotConfigured,
          }).toCommerceErrorInfo(),
        };
      }
      // Both one-time kinds are sold; a subscription-typed product and a
      // quantity above one are rejected before the checkout opens.
      assertRequestPurchaseSupported(
        createDevvitCommerceCapabilities('available'),
        request,
        purchaseKindOf(product.info.type),
      );
      let result: DevvitCheckoutResult;
      try {
        // Reddit's order id is authoritative; no client metadata is attached.
        result = await input.client.purchase(product.sku);
      } catch (error) {
        // `purchase()` rejects when the checkout effect produced no usable
        // response, which does not prove that no order was created: the
        // outcome is unknown, so the attempt stays open (RFC "Errors") and
        // the reconciler resolves it from the paid-order list.
        input.onCheckoutError?.(error);
        refreshInBackground();
        return { outcome: 'launched' };
      }
      const outcome = toRequestPurchaseResult(product, result);
      if (outcome.outcome === 'launched') {
        // The order, if any, is in the server's list; report it without
        // waiting for a signal.
        refreshInBackground();
      }
      return outcome;
    },
    async getAvailablePurchases(
      _request: GetAvailablePurchasesInput = {},
    ): Promise<readonly StorePurchase[]> {
      const purchases: StorePurchase[] = [];
      for (const order of await readPaidOrders()) {
        if (order.delivered === true) {
          // Delivered: the fulfillment handler settled it; it reaches the
          // reconciler as an event, not as an unfinished purchase.
          continue;
        }
        try {
          const purchase = toPurchase(order, 'order-list');
          if (purchase !== undefined) {
            purchases.push(purchase);
          }
        } catch (error) {
          // One invalid order must not hide the others, as on a refresh.
          console.warn('Devvit paid order was not listed.', errorMessage(error));
        }
      }
      return purchases;
    },
    async restorePurchases(): Promise<void> {
      await refreshOrders();
    },
    subscribe(listener) {
      listeners.add(listener);
      attachOrderSignal();
      if (listeners.size === 1) {
        buffer.drain((event) => {
          try {
            listener(event);
          } catch (error) {
            console.warn('Devvit commerce listener failed.', errorMessage(error));
          }
        });
        // A fresh listener (a new session, or a restart) learns of the recent
        // orders, delivered ones included, so a checkout result lost to a
        // restart still reaches the reconciler; it matches them to its
        // records by store and transaction id.
        refreshInBackground();
      }
      return () => {
        listeners.delete(listener);
        detachOrderSignalIfIdle();
      };
    },
    dispose() {
      listeners.clear();
      detachOrderSignalIfIdle();
    },
  };
  return provider;
}

function toStoreProduct(store: StoreId, product: DevvitCommerceProduct): StoreProduct | undefined {
  const { info } = product;
  const kind = info.type === 'consumable'
    ? 'consumable'
    : info.type === 'non_consumable'
      ? 'durable'
      : undefined;
  if (kind === undefined) {
    return undefined;
  }
  try {
    return assertStoreProduct({
      logicalId: info.id,
      store,
      storeSku: product.sku,
      kind,
      title: info.title,
      description: info.description,
      price: { formatted: info.price.formatted, currencyCode: info.price.currencyCode },
    });
  } catch (error) {
    throw new CommerceError('INVALID_RESPONSE', {
      message: `Devvit product ${product.sku} is configured with invalid product info.`,
      cause: error,
    });
  }
}

function purchaseKindOf(type: DevvitCommerceProduct['info']['type']): PurchaseKind {
  switch (type) {
    case 'consumable':
      return 'consumable';
    case 'non_consumable':
      return 'durable';
    case 'subscription':
      return 'subscription';
  }
}

/** A cancelled checkout: `USER_CANCELLED`, with the platform's own code kept as `storeCode`. */
function toCancelledErrorInfo(failure: DevvitCheckoutFailure | undefined): CommerceErrorInfo {
  const storeCode = failure?.storeCode
    ?? (failure !== undefined && !isCommerceErrorCode(failure.code) ? failure.code : undefined)
    ?? devvitCommerceStoreCodes.checkoutCancelled;
  return new CommerceError('USER_CANCELLED', {
    message: failure?.message ?? 'Devvit checkout was cancelled.',
    storeCode,
    retryable: false,
  }).toCommerceErrorInfo();
}

/**
 * The normalized error of a failed checkout: a v2 code the client classified
 * is kept with its own `storeCode`; any other code is `UNKNOWN` and travels
 * as `storeCode`. `retryable` defaults from the normalized code.
 */
function toCheckoutErrorInfo(failure: DevvitCheckoutFailure | undefined): CommerceErrorInfo {
  if (failure === undefined) {
    return new CommerceError('UNKNOWN', {
      message: 'Devvit checkout failed.',
      storeCode: devvitCommerceStoreCodes.checkoutFailed,
      retryable: false,
    }).toCommerceErrorInfo();
  }
  const normalized = isCommerceErrorCode(failure.code) ? failure.code : 'UNKNOWN';
  const storeCode = failure.storeCode ?? (normalized === 'UNKNOWN' ? failure.code : undefined);
  return new CommerceError(normalized, {
    message: failure.message ?? `Devvit checkout failed: ${storeCode ?? normalized}.`,
    ...(storeCode === undefined ? {} : { storeCode }),
    ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
  }).toCommerceErrorInfo();
}

/** A thrown order-source failure as a retryable `STORE_UNAVAILABLE`, unless it already is a commerce error. */
function toCommerceError(error: unknown): CommerceError {
  if (error instanceof CommerceError) {
    return error;
  }
  return new CommerceError('STORE_UNAVAILABLE', {
    message: `Devvit paid orders are unavailable: ${errorMessage(error)}`,
    storeCode: devvitCommerceStoreCodes.ordersUnavailable,
    retryable: true,
    cause: error,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
