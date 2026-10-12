import type { AitIapProductConfig } from './iap.js';

/** The catalog target whose `platformProductIds` entry is the Apps in Toss SKU. */
export const defaultAitCatalogTarget = 'ait';

export interface ExtractAitIapProductConfigOptions {
  /** Defaults to `ait`. */
  readonly target?: string;
  /** Label for error messages, for example the catalog file path. */
  readonly sourceLabel?: string;
}

/**
 * Reads the `iapProducts` of `installAitHostBridge` from a product catalog
 * (`@mpgd/catalog` `catalog.json` as parsed JSON): one `AitIapProductConfig`
 * per one-time product whose `platformProductIds[target]` names the console
 * SKU. The catalog is the single source of the Apps in Toss SKUs and its
 * rules apply, as `resolveProductPlatformId` reads them: the SKU is trimmed,
 * and a product without an entry, or with a blank one, is not sold there. A
 * subscription is skipped because Apps in Toss sells one-time products only.
 * Duplicate product ids and SKUs are rejected. Like
 * `extractAitAdBridgeConfig`, this runs in the wrapper's build config, so it
 * imports no SDK.
 */
export function extractAitIapProductConfig(
  input: unknown,
  options: ExtractAitIapProductConfigOptions = {},
): readonly AitIapProductConfig[] {
  const target = options.target ?? defaultAitCatalogTarget;
  const sourceLabel = options.sourceLabel ?? 'product catalog';
  if (!isRecord(input) || !Array.isArray(input.products)) {
    throw new Error(`AIT product catalog is invalid: ${sourceLabel}`);
  }
  const products: readonly unknown[] = input.products;
  const productIds = new Set<string>();
  const skus = new Set<string>();
  const iapProducts: AitIapProductConfig[] = [];

  for (const [index, product] of products.entries()) {
    if (!isRecord(product) || typeof product.id !== 'string' || product.id.trim().length === 0) {
      throw new Error(`AIT product catalog entry at index ${index} is invalid: ${sourceLabel}`);
    }
    if (productIds.has(product.id)) {
      throw new Error(`Duplicate AIT product ID "${product.id}" at index ${index}: ${sourceLabel}`);
    }
    productIds.add(product.id);
    if (product.type === 'subscription') {
      continue;
    }
    const identifiers = product.platformProductIds;
    if (!isRecord(identifiers) || !Object.prototype.hasOwnProperty.call(identifiers, target)) {
      continue;
    }
    const value = identifiers[target];
    if (typeof value !== 'string') {
      continue;
    }
    const sku = value.trim();
    if (sku.length === 0) {
      continue;
    }
    if (skus.has(sku)) {
      throw new Error(`Duplicate AIT SKU "${sku}" for ${target}: ${sourceLabel}`);
    }
    skus.add(sku);
    iapProducts.push({ productId: product.id, sku });
  }

  return iapProducts;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
