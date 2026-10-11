import type {
  CommerceAdapter,
  Entitlement,
  PlatformEvidenceEnvelope,
  PlatformGateway,
  ProductInfo,
  PurchaseResult,
} from '@mpgd/platform';

/**
 * Why a Devvit checkout ended without an order (`OrderResultEvent` with
 * `STATUS_ERROR` or `STATUS_CANCELLED`). `code` is a commerce v2 error code
 * when the client could classify the failure, otherwise the platform's own
 * code (`String(errorCode)`), which the v2 provider keeps as `storeCode`.
 */
export interface DevvitCheckoutFailure {
  readonly code: string;
  readonly storeCode?: string;
  readonly message?: string;
  readonly retryable?: boolean;
}

export interface DevvitCheckoutResult {
  readonly status: PurchaseResult['status'];
  /** `OrderResultEvent.orderId`: present once Reddit created the order. */
  readonly orderId?: string;
  readonly evidence?: PlatformEvidenceEnvelope;
  /** Read by the commerce v2 provider for a `cancelled` or `failed` checkout. */
  readonly error?: DevvitCheckoutFailure;
}

export interface DevvitPaymentsClient {
  purchase(sku: string): Promise<DevvitCheckoutResult>;
  getEntitlements(): Promise<readonly Entitlement[]>;
}

export interface DevvitCommerceProduct {
  readonly info: ProductInfo;
  readonly sku: string;
}

export interface CreateDevvitCommerceAdapterInput {
  readonly products: readonly DevvitCommerceProduct[];
  readonly client: DevvitPaymentsClient;
  readonly onCheckoutError?: (error: unknown) => void;
}

export function createDevvitCommerceAdapter(
  input: CreateDevvitCommerceAdapterInput,
): CommerceAdapter {
  const products = normalizeDevvitCommerceProducts(input.products);
  const productsById = new Map(products.map((product) => [product.info.id, product]));

  return {
    async getProducts() {
      return products.map((product) => product.info);
    },
    async purchase(request) {
      const product = productsById.get(request.productId);
      if (product === undefined) {
        return failedPurchase();
      }

      try {
        // Reddit's platform order ID is authoritative. Do not attach client operation
        // metadata whose identifiers can exceed Devvit's metadata constraints.
        const result = await input.client.purchase(product.sku);

        return {
          status: result.status,
          ...(result.orderId === undefined ? {} : { transactionId: result.orderId }),
          // Devvit server fulfillment and a subsequent entitlement read are authoritative.
          entitlementIds: [],
          ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
        };
      } catch (error) {
        input.onCheckoutError?.(error);
        return failedPurchase();
      }
    },
    async restore() {
      return { restoredEntitlements: await input.client.getEntitlements() };
    },
    async getEntitlements() {
      return input.client.getEntitlements();
    },
  };
}

export function withDevvitCommerceAdapter(
  gateway: PlatformGateway,
  commerce: CommerceAdapter,
): PlatformGateway {
  if (gateway.target !== 'reddit') {
    throw new TypeError('Devvit commerce can only be installed on a reddit gateway.');
  }
  if ('getTargetRuntime' in gateway && typeof gateway.getTargetRuntime === 'function') {
    throw new TypeError('Devvit commerce must be installed before target availability is applied.');
  }

  return {
    ...gateway,
    async getCapabilities() {
      return {
        ...await gateway.getCapabilities(),
        nativeIap: true,
      };
    },
    commerce,
  };
}

/** Frozen copies of the configured products; duplicate ids or SKUs and blank SKUs are rejected. */
export function normalizeDevvitCommerceProducts(
  input: readonly DevvitCommerceProduct[],
): readonly DevvitCommerceProduct[] {
  const productIds = new Set<string>();
  const skus = new Set<string>();

  return Object.freeze(
    input.map((product) => {
      if (productIds.has(product.info.id)) {
        throw new TypeError(`Duplicate Devvit logical product ID: ${product.info.id}`);
      }
      if (skus.has(product.sku)) {
        throw new TypeError(`Duplicate Devvit product SKU: ${product.sku}`);
      }
      if (product.sku.length === 0 || product.sku.trim() !== product.sku) {
        throw new TypeError('Devvit product SKU must be a non-empty identifier.');
      }

      productIds.add(product.info.id);
      skus.add(product.sku);

      return Object.freeze({
        info: Object.freeze({ ...product.info }),
        sku: product.sku,
      });
    }),
  );
}

function failedPurchase(): PurchaseResult {
  return Object.freeze({
    status: 'failed',
    entitlementIds: [],
  });
}
