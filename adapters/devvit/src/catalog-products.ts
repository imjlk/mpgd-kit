import type { ProductInfo, ProductType } from '@mpgd/platform';

import { normalizeDevvitCommerceProducts, type DevvitCommerceProduct } from './payments.js';

/** The catalog target whose `platformProductIds` entry is the Devvit SKU. */
export const defaultDevvitCatalogTarget = 'reddit';

/**
 * The product catalog fields this module reads (`ProductCatalog` from
 * `@mpgd/catalog` fits). Structural so the adapter adds no catalog dependency.
 */
export interface DevvitCatalogProductLike {
  readonly id: string;
  readonly type: ProductType;
  readonly platformProductIds: Readonly<Partial<Record<string, string>>>;
}

export interface DevvitCatalogLike {
  readonly products: readonly DevvitCatalogProductLike[];
}

/** A logical product paired with its Devvit SKU, as the server bridge handler takes it. */
export interface DevvitCatalogBridgeProduct {
  readonly productId: string;
  readonly sku: string;
}

export interface CreateDevvitCommerceProductsOptions {
  /** Defaults to `reddit`. */
  readonly target?: string;
  /**
   * Static product info for the webview provider's `fetchProducts`. Devvit
   * prices live products in Reddit Gold on the server (`payments.getProducts`),
   * so the default lists the logical id as title with a Reddit Gold price
   * placeholder; a game that wants localized copy supplies its own.
   */
  readonly describe?: (product: DevvitCatalogProductLike, sku: string) => Pick<
    ProductInfo,
    'title' | 'description' | 'price'
  >;
}

/**
 * The `{ productId, sku }` pairs `createDevvitCommerceV2BridgeHandler` takes,
 * read from the catalog's `platformProductIds[target]` entries. The catalog is
 * the single source of the Devvit SKUs and its rules apply, as
 * `resolveProductPlatformId` reads them: the SKU is trimmed, and a product
 * without an entry, or with a blank one, is not sold on Reddit. A subscription
 * is skipped because Devvit sells one-time goods only. Duplicate product ids
 * and SKUs are rejected.
 */
export function createDevvitCommerceBridgeProducts(
  catalog: DevvitCatalogLike,
  target: string = defaultDevvitCatalogTarget,
): readonly DevvitCatalogBridgeProduct[] {
  const skus = new Set<string>();
  const productIds = new Set<string>();
  const products: DevvitCatalogBridgeProduct[] = [];
  for (const product of catalog.products) {
    const sku = readSku(product, target);
    if (sku === undefined || product.type === 'subscription') {
      continue;
    }
    if (productIds.has(product.id)) {
      throw new TypeError(`Duplicate Devvit logical product ID: ${product.id}`);
    }
    if (skus.has(sku)) {
      throw new TypeError(`Duplicate Devvit product SKU: ${sku}`);
    }
    productIds.add(product.id);
    skus.add(sku);
    products.push(Object.freeze({ productId: product.id, sku }));
  }
  return Object.freeze(products);
}

/**
 * The webview products for `createDevvitPlatformGateway({ commerce: { products } })`
 * and `createDevvitCommerceAdapter`, derived from the same catalog entries as
 * `createDevvitCommerceBridgeProducts`, so the webview and the server agree on
 * every SKU.
 */
export function createDevvitCommerceProducts(
  catalog: DevvitCatalogLike,
  options: CreateDevvitCommerceProductsOptions = {},
): readonly DevvitCommerceProduct[] {
  const target = options.target ?? defaultDevvitCatalogTarget;
  const describe = options.describe ?? describeDevvitProduct;
  const bridgeProducts = createDevvitCommerceBridgeProducts(catalog, target);
  const byId = new Map(catalog.products.map((product) => [product.id, product]));
  return normalizeDevvitCommerceProducts(
    bridgeProducts.map((bridgeProduct) => {
      const product = byId.get(bridgeProduct.productId);
      if (product === undefined) {
        throw new TypeError(
          `Devvit product ${bridgeProduct.productId} is missing from the catalog.`,
        );
      }
      return {
        info: {
          id: product.id,
          type: product.type,
          ...describe(product, bridgeProduct.sku),
        },
        sku: bridgeProduct.sku,
      };
    }),
  );
}

function describeDevvitProduct(
  product: DevvitCatalogProductLike,
): Pick<ProductInfo, 'title' | 'description' | 'price'> {
  return {
    title: product.id,
    description: '',
    price: { formatted: 'Reddit Gold', currencyCode: 'GOLD' },
  };
}

/** The catalog's reading of a platform id: own key only, trimmed, blank as unsold. */
function readSku(product: DevvitCatalogProductLike, target: string): string | undefined {
  const identifiers = product.platformProductIds;
  if (!Object.prototype.hasOwnProperty.call(identifiers, target)) {
    return undefined;
  }
  const value = identifiers[target];
  if (typeof value !== 'string') {
    return undefined;
  }
  const sku = value.trim();
  return sku.length === 0 ? undefined : sku;
}
