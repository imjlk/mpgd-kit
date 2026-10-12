import type { PlatformEvidenceEnvelope, ProductInfo, PurchaseResult } from '@mpgd/platform';

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

/**
 * The checkout half of the Reddit payments client: the commerce v2 provider
 * opens the checkout through it and needs nothing else. Owned entitlements are
 * not read from the client; the backend ledger answers them through
 * `@mpgd/game-services`, and the paid orders come from the server bridge.
 */
export interface DevvitPaymentsClient {
  purchase(sku: string): Promise<DevvitCheckoutResult>;
}

export interface DevvitCommerceProduct {
  readonly info: ProductInfo;
  readonly sku: string;
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
