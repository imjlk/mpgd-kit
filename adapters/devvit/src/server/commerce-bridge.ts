import {
  createBridgeError,
  type BridgeCommerceV2Method,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';
import {
  assertCommerceBridgeFetchProductsPayload,
  assertCommerceBridgeFetchProductsResult,
  assertCommerceBridgeFinishTransactionPayload,
  assertCommerceBridgeGetAvailablePurchasesPayload,
  assertCommerceBridgeGetAvailablePurchasesResult,
  assertCommerceBridgeGetCapabilitiesPayload,
  assertCommerceBridgeGetCapabilitiesResult,
  assertCommerceBridgeRequestPurchasePayload,
  assertCommerceBridgeRestorePurchasesPayload,
  assertCommerceBridgeRestorePurchasesResult,
  assertStoreProduct,
  CommerceError,
  commerceErrorInfoOf,
  commerceProtocolVersion,
  type CommerceBridgeMethods,
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
  readDevvitOrderTime,
  type DevvitOrderEnvironment,
  type DevvitPaidOrder,
} from '../commerce-contract.js';

/**
 * Host side of commerce v2 for Devvit: the server bridge serves the six
 * `commerce.v2.*` methods from the Devvit `payments` plugin
 * (`@devvit/payments/server`, re-exported by `@devvit/web/server`). The
 * plugin runs in the request context of the authenticated Reddit user:
 * Reddit documents server-side `payments.getOrders()` as the current user's
 * orders, newest first (Devvit docs, "Manage Payments", "Check orders"),
 * which the fulfillment handler's own user binding backs. The checkout is a webview
 * effect, so `requestPurchase` is answered by the client provider, never
 * here. This module imports no Devvit SDK; the plugin surface it needs is
 * the structural `DevvitServerPaymentsLike`.
 */

/** Bridge error for a commerce v2 payload the typia assert rejected. */
export const devvitCommerceV2InvalidPayloadBridgeErrorCode = 'COMMERCE_V2_INVALID_PAYLOAD' as const;
/** Bridge error for `finishTransaction`: the Devvit profile has nothing to finish. */
export const devvitCommerceV2MethodUnsupportedBridgeErrorCode =
  'COMMERCE_V2_METHOD_UNSUPPORTED' as const;
/** Bridge error for `requestPurchase` reaching the server: the checkout opens in the webview. */
export const devvitCommerceCheckoutClientOnlyBridgeErrorCode =
  'DEVVIT_COMMERCE_CHECKOUT_CLIENT_ONLY' as const;
/** Bridge error when the payments plugin fails; retryable. */
export const devvitPaymentsUnavailableBridgeErrorCode = 'DEVVIT_PAYMENTS_UNAVAILABLE' as const;

/** `Order.status` as `@devvit/protos` encodes it (`OrderStatus` enum) or as the handler types spell it. */
export type DevvitPaymentsOrderStatusLike = number | string;

/** The fields of a `@devvit/payments` `Order` the handler reads. */
export interface DevvitPaymentsOrderLike {
  readonly id: string;
  readonly status: DevvitPaymentsOrderStatusLike;
  readonly createdAt?: string | null | undefined;
  readonly updatedAt?: string | null | undefined;
  readonly products: readonly { readonly sku: string }[];
  readonly environment?: number | string | undefined;
}

/** The fields of a `@devvit/payments` `Product` the handler reads. */
export interface DevvitPaymentsProductLike {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly price?: { readonly amount: number; readonly currency: number | string } | undefined;
  readonly accountingType: number | string;
}

/** The subset of the Devvit `payments` plugin the handler calls (`PaymentsClient` fits). */
export interface DevvitServerPaymentsLike {
  getOrders(filters: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly orders: readonly DevvitPaymentsOrderLike[];
    readonly pageInfo?: { readonly hasNextPage: boolean; readonly endCursor: string } | undefined;
  }>;
  getProducts(filters?: {
    readonly skus?: readonly string[];
  }): Promise<{ readonly products: readonly DevvitPaymentsProductLike[] }>;
}

export interface DevvitCommerceBridgeProduct {
  readonly productId: string;
  readonly sku: string;
}

export interface CreateDevvitCommerceV2BridgeHandlerInput {
  readonly payments: DevvitServerPaymentsLike;
  /** The game's logical products and their Devvit SKUs; orders for other SKUs are not listed. */
  readonly products: readonly DevvitCommerceBridgeProduct[];
  /** Defaults to `devvit`. */
  readonly store?: StoreId;
  readonly warn?: ((message: string) => void) | undefined;
}

export interface DevvitCommerceV2BridgeHandler {
  /** Answers one of the six `commerce.v2.*` methods; other methods are rejected. */
  request(input: BridgeRequest): Promise<BridgeResponse>;
}

/** `OrderStatus.ORDER_STATUS_PAID` of `@devvit/protos`, and its handler-type spelling. */
const paidOrderStatuses: ReadonlySet<DevvitPaymentsOrderStatusLike> = new Set([
  3,
  'PAID',
  'ORDER_STATUS_PAID',
]);
/** `Environment` of `@devvit/protos`, and its string spellings. */
const sandboxEnvironments: ReadonlySet<number | string> = new Set([
  1,
  'SANDBOX',
  'ENVIRONMENT_SANDBOX',
]);
const productionEnvironments: ReadonlySet<number | string> = new Set([
  2,
  'PRODUCTION',
  'ENVIRONMENT_PRODUCTION',
]);
/** `AccountingType` of `@devvit/protos`: instant and consumable goods are consumables, durable goods are durable. */
const consumableAccountingTypes: ReadonlySet<number | string> = new Set([
  1,
  3,
  'INSTANT',
  'CONSUMABLE',
  'ACCOUNTING_TYPE_INSTANT',
  'ACCOUNTING_TYPE_CONSUMABLE',
]);
const durableAccountingTypes: ReadonlySet<number | string> = new Set([
  2,
  'DURABLE',
  'ACCOUNTING_TYPE_DURABLE',
]);
const orderPageSize = maximumDevvitAvailableOrders;
/**
 * Pages scanned per listing. The plugin's `status` filter does nothing in
 * `@devvit/payments` 0.14, so delivered orders are scanned too; a paid order
 * beyond this window is not listed until the window moves.
 */
const maximumOrderPages = 8;

/**
 * Serves `commerce.v2.*` from the payments plugin:
 *
 * - `getCapabilities` answers the Devvit profile (`createDevvitCommerceCapabilities`).
 * - `fetchProducts` lists the configured SKUs from `payments.getProducts`
 *   (instant and consumable goods as `consumable`, durable goods as
 *   `durable`; time-limited goods are not listed) priced in Reddit Gold.
 * - `getAvailablePurchases` lists the authenticated user's `PAID` orders for
 *   configured SKUs from `payments.getOrders` as `purchased` (the order id as
 *   `transactionId` and `token`, `devvit.order.v1` evidence), bounded by
 *   `maximumDevvitAvailableOrders`. A delivered order is no longer listed:
 *   Reddit marks it `DELIVERED` once the fulfillment handler acknowledged it.
 * - `requestPurchase` is refused with `DEVVIT_COMMERCE_CHECKOUT_CLIENT_ONLY`,
 *   `finishTransaction` with `COMMERCE_V2_METHOD_UNSUPPORTED`, and
 *   `restorePurchases` answers `{ restored: false }`: the webview provider
 *   re-reads the list itself.
 *
 * Payloads and results are validated with the `@mpgd/platform/commerce`
 * asserts; a plugin failure crosses the bridge as the retryable
 * `DEVVIT_PAYMENTS_UNAVAILABLE`.
 */
export function createDevvitCommerceV2BridgeHandler(
  input: CreateDevvitCommerceV2BridgeHandlerInput,
): DevvitCommerceV2BridgeHandler {
  const store: StoreId = input.store ?? devvitCommerceStoreId;
  if (store.length === 0) {
    throw new TypeError('A Devvit commerce bridge handler requires a non-empty store id.');
  }
  const products = normalizeBridgeProducts(input.products);
  const productsBySku = new Map(products.map((product) => [product.sku, product]));
  const warn = input.warn ?? ((message: string) => {
    console.warn(message);
  });

  const listPaidOrders = async (): Promise<readonly DevvitPaidOrder[]> => {
    const orders: DevvitPaidOrder[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maximumOrderPages; page += 1) {
      const response = await input.payments.getOrders({
        limit: orderPageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const next = response.pageInfo;
      const hasNextPage = next !== undefined && next.hasNextPage && next.endCursor.length > 0;
      for (const [index, order] of response.orders.entries()) {
        const paid = readPaidOrder(order, productsBySku);
        if (paid !== undefined) {
          orders.push(paid);
        }
        if (orders.length >= maximumDevvitAvailableOrders) {
          if (index + 1 < response.orders.length || hasNextPage) {
            warn('Devvit paid-order list reached the available-purchase bound; older orders wait.');
          }
          return orders;
        }
      }
      if (!hasNextPage || next === undefined) {
        break;
      }
      cursor = next.endCursor;
    }
    return orders;
  };

  const serve = async (request: BridgeRequest): Promise<unknown> => {
    const { payload } = request;
    switch (request.method) {
      case 'commerce.v2.getCapabilities': {
        assertCommerceBridgeGetCapabilitiesPayload(payload);
        return assertResult('commerce.v2.getCapabilities', {
          protocolVersion: commerceProtocolVersion,
          store,
          capabilities: createDevvitCommerceCapabilities(
            products.length === 0 ? 'configuration-required' : 'available',
          ),
        });
      }
      case 'commerce.v2.fetchProducts': {
        const filter = assertCommerceBridgeFetchProductsPayload(payload);
        if ((filter.type ?? 'all') === 'subscription' || products.length === 0) {
          return assertResult('commerce.v2.fetchProducts', { products: [] });
        }
        const skus = products
          .filter((product) =>
            filter.logicalIds === undefined || filter.logicalIds.includes(product.productId))
          .map((product) => product.sku);
        if (skus.length === 0) {
          return assertResult('commerce.v2.fetchProducts', { products: [] });
        }
        const response = await paymentsCall(() => input.payments.getProducts({ skus }));
        const listed: StoreProduct[] = [];
        for (const product of response.products) {
          const storeProduct = toStoreProduct(store, product, productsBySku);
          if (storeProduct !== undefined && skus.includes(storeProduct.storeSku)) {
            listed.push(storeProduct);
          }
        }
        return assertResult('commerce.v2.fetchProducts', { products: listed });
      }
      case 'commerce.v2.requestPurchase':
        assertCommerceBridgeRequestPurchasePayload(payload);
        throw new PlatformOperationError({
          code: devvitCommerceCheckoutClientOnlyBridgeErrorCode,
          message: 'Devvit checkout opens in the webview; requestPurchase is served by the '
            + 'client commerce provider, not by the server bridge.',
        });
      case 'commerce.v2.getAvailablePurchases': {
        // The payload is asserted as sent; `includePending` adds nothing here.
        assertCommerceBridgeGetAvailablePurchasesPayload(payload);
        const orders = await paymentsCall(listPaidOrders);
        const purchases: StorePurchase[] = [];
        for (const order of orders) {
          const product = productsBySku.get(order.sku);
          if (product === undefined) {
            continue;
          }
          try {
            purchases.push(
              createDevvitStorePurchase({
                store,
                orderId: order.orderId,
                sku: order.sku,
                logicalId: product.productId,
                source: 'order-list',
                paidAt: order.paidAt,
                environment: order.environment,
              }),
            );
          } catch (error) {
            // One invalid order must not hide the others.
            warn(`Devvit paid order was not listed: ${errorMessage(error)}`);
          }
        }
        return assertResult('commerce.v2.getAvailablePurchases', { purchases });
      }
      case 'commerce.v2.finishTransaction':
        assertCommerceBridgeFinishTransactionPayload(payload);
        throw new PlatformOperationError({
          code: devvitCommerceV2MethodUnsupportedBridgeErrorCode,
          message: `Store ${store} finishes nothing: the fulfillment handler settles on the server.`,
        });
      case 'commerce.v2.restorePurchases':
        assertCommerceBridgeRestorePurchasesPayload(payload);
        return assertResult('commerce.v2.restorePurchases', { restored: false });
      default:
        throw new PlatformOperationError({
          code: 'UNSUPPORTED_METHOD',
          message: `${request.method} is not a commerce v2 method.`,
        });
    }
  };

  return {
    async request(request) {
      try {
        return { id: request.id, ok: true, data: await serve(request) };
      } catch (error) {
        return toBridgeError(request, error);
      }
    },
  };
}

/** A `PAID` order for a configured SKU with exactly one product, or nothing. */
function readPaidOrder(
  order: DevvitPaymentsOrderLike,
  productsBySku: ReadonlyMap<string, DevvitCommerceBridgeProduct>,
): DevvitPaidOrder | undefined {
  if (!paidOrderStatuses.has(order.status)) {
    return undefined;
  }
  const orderId = readDevvitIdentifier(order.id);
  // A Devvit order holds one product (the payment handler normalizer requires it too).
  const sku = order.products.length === 1
    ? readDevvitIdentifier(order.products[0]?.sku)
    : undefined;
  if (orderId === undefined || sku === undefined || !productsBySku.has(sku)) {
    return undefined;
  }
  const paidAt = readDevvitOrderTime(order.updatedAt ?? order.createdAt ?? undefined);
  const environment = readEnvironment(order.environment);
  return {
    orderId,
    sku,
    ...(paidAt === undefined ? {} : { paidAt }),
    ...(environment === undefined ? {} : { environment }),
  };
}

function readEnvironment(value: number | string | undefined): DevvitOrderEnvironment | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (sandboxEnvironments.has(value)) {
    return 'sandbox';
  }
  if (productionEnvironments.has(value)) {
    return 'production';
  }
  return undefined;
}

function toStoreProduct(
  store: StoreId,
  product: DevvitPaymentsProductLike,
  productsBySku: ReadonlyMap<string, DevvitCommerceBridgeProduct>,
): StoreProduct | undefined {
  const sku = readDevvitIdentifier(product.sku);
  const configured = sku === undefined ? undefined : productsBySku.get(sku);
  if (sku === undefined || configured === undefined) {
    return undefined;
  }
  const kind = consumableAccountingTypes.has(product.accountingType)
    ? 'consumable'
    : durableAccountingTypes.has(product.accountingType)
      ? 'durable'
      : undefined;
  if (kind === undefined) {
    // Time-limited goods (`VALID_FOR_*`) have no v2 kind yet.
    return undefined;
  }
  const amount = product.price?.amount;
  const formatted = typeof amount === 'number' && Number.isFinite(amount)
    ? `${String(amount)} Gold`
    : 'Reddit Gold';
  try {
    return assertStoreProduct({
      logicalId: configured.productId,
      store,
      storeSku: sku,
      kind,
      title: product.name,
      description: product.description,
      price: { formatted, currencyCode: 'GOLD' },
    });
  } catch (error) {
    throw new CommerceError('INVALID_RESPONSE', {
      message: `Devvit reported an invalid product for ${sku}.`,
      cause: error,
    });
  }
}

function normalizeBridgeProducts(
  input: readonly DevvitCommerceBridgeProduct[],
): readonly DevvitCommerceBridgeProduct[] {
  const productIds = new Set<string>();
  const skus = new Set<string>();
  return input.map((product) => {
    if (readDevvitIdentifier(product.productId) === undefined) {
      throw new TypeError('Devvit commerce bridge product ids must be non-empty identifiers.');
    }
    if (readDevvitIdentifier(product.sku) === undefined) {
      throw new TypeError('Devvit commerce bridge SKUs must be non-empty identifiers.');
    }
    if (productIds.has(product.productId)) {
      throw new TypeError(`Duplicate Devvit logical product ID: ${product.productId}`);
    }
    if (skus.has(product.sku)) {
      throw new TypeError(`Duplicate Devvit product SKU: ${product.sku}`);
    }
    productIds.add(product.productId);
    skus.add(product.sku);
    return { productId: product.productId, sku: product.sku };
  });
}

async function paymentsCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PlatformOperationError) {
      throw error;
    }
    throw new PlatformOperationError({
      code: devvitPaymentsUnavailableBridgeErrorCode,
      message: `Devvit payments plugin request failed: ${errorMessage(error)}`,
      retryable: true,
    });
  }
}

// Each entry is the typia assert of that method's result type; the lookup is
// typed by `assertDevvitCommerceBridgeResult`.
const resultAsserts: Readonly<Partial<Record<BridgeCommerceV2Method, (input: unknown) => unknown>>> = {
  'commerce.v2.getCapabilities': assertCommerceBridgeGetCapabilitiesResult,
  'commerce.v2.fetchProducts': assertCommerceBridgeFetchProductsResult,
  'commerce.v2.getAvailablePurchases': assertCommerceBridgeGetAvailablePurchasesResult,
  'commerce.v2.restorePurchases': assertCommerceBridgeRestorePurchasesResult,
};

function assertResult<TMethod extends BridgeCommerceV2Method>(
  method: TMethod,
  data: unknown,
): CommerceBridgeMethods[TMethod]['result'] {
  const assert = resultAsserts[method];
  if (assert === undefined) {
    throw new PlatformOperationError({
      code: devvitCommerceV2MethodUnsupportedBridgeErrorCode,
      message: `${method} is not served by the Devvit server bridge.`,
    });
  }
  try {
    return assert(data) as CommerceBridgeMethods[TMethod]['result'];
  } catch (error) {
    throw new PlatformOperationError({
      code: 'NATIVE_PROVIDER_INVALID_RESPONSE',
      message: `Devvit commerce bridge produced invalid data for ${method}: ${errorMessage(error)}`,
    });
  }
}

function toBridgeError(request: BridgeRequest, error: unknown): BridgeResponse {
  if (isTypiaGuardError(error)) {
    return createBridgeError(
      request.id,
      devvitCommerceV2InvalidPayloadBridgeErrorCode,
      `${request.method} payload is invalid: ${error.message}`,
    );
  }
  if (error instanceof PlatformOperationError) {
    return createBridgeError(request.id, error.code, error.message, error.retryable);
  }
  const info = commerceErrorInfoOf(error);
  return createBridgeError(
    request.id,
    info.code,
    info.message ?? `${request.method} failed.`,
    info.retryable,
  );
}

function isTypiaGuardError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'TypeGuardError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
