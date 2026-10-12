import typia from 'typia';

import { extractAitIapProductConfig } from '@mpgd/adapter-ait/iap-config';
import { createDevvitCommerceBridgeProducts } from '@mpgd/adapter-devvit/server';
import { resolveCatalogCurrencies, resolveProductPlatformId, type ProductCatalog } from '@mpgd/catalog';

import { productCatalogFilePath } from './catalog-paths';
import { isCliEntrypoint, readJsonFile } from './io';

const assertProductCatalog = typia.createAssert<ProductCatalog>();

/**
 * The host-side product lists derived from one catalog: the Apps in Toss
 * `iapProducts` the wrapper installs and the `{ productId, sku }` pairs the
 * Devvit server bridge serves. Both are read from `platformProductIds`, so
 * the catalog stays the single source of every store SKU.
 */
export interface ProductCatalogHostProducts {
  readonly ait: ReturnType<typeof extractAitIapProductConfig>;
  readonly reddit: ReturnType<typeof createDevvitCommerceBridgeProducts>;
}

export function resolveProductCatalogHostProducts(
  catalog: ProductCatalog,
  sourceLabel = 'product catalog',
): ProductCatalogHostProducts {
  return {
    ait: extractAitIapProductConfig(catalog, { sourceLabel }),
    reddit: createDevvitCommerceBridgeProducts(catalog),
  };
}

export function validateProductCatalogFile(path = productCatalogFilePath()) {
  const catalog = assertProductCatalog(readJsonFile(path));
  const currencies = resolveCatalogCurrencies(catalog);
  const ids = new Set<string>();

  for (const product of catalog.products) {
    const trimmedId = product.id.trim();

    if (trimmedId.length === 0) {
      throw new Error('Product id must be non-empty.');
    }

    if (trimmedId !== product.id) {
      throw new Error(`Product id has leading or trailing whitespace: ${product.id}`);
    }

    if (ids.has(product.id)) {
      throw new Error(`Duplicate product id: ${product.id}`);
    }

    ids.add(product.id);

    if (product.grant.type === 'currency' && !currencies.has(product.grant.currency)) {
      throw new Error(
        `Product ${product.id} grants undeclared currency ${product.grant.currency}; `
          + `declared currencies: ${[...currencies].join(', ')}.`,
      );
    }

    if (Object.keys(product.platformProductIds).length === 0) {
      throw new Error(`Product ${product.id} has no platformProductIds.`);
    }

    for (const [target, platformProductId] of Object.entries(product.platformProductIds)) {
      if (typeof platformProductId !== 'string' || platformProductId.trim().length === 0) {
        throw new Error(`Product ${product.id} has blank platformProductId for ${target}.`);
      }
    }
  }

  // The Apps in Toss and Devvit host lists must derive cleanly and agree
  // with the catalog's own reading of each SKU (`resolveProductPlatformId`):
  // a subscription SKU on either target, or a duplicate SKU, fails here
  // before the wrapper or the Devvit server reads the same catalog.
  const hostProducts = resolveProductCatalogHostProducts(catalog, path);
  for (const [target, products] of [
    ['ait', hostProducts.ait.map((product) => [product.productId, product.sku] as const)],
    ['reddit', hostProducts.reddit.map((product) => [product.productId, product.sku] as const)],
  ] as const) {
    const derived = new Map<string, string>(products);
    for (const product of catalog.products) {
      const sku = resolveProductPlatformId(product, target);
      if (sku !== undefined && product.type === 'subscription') {
        throw new Error(
          `Product ${product.id} is a subscription but names a ${target} SKU; `
            + `${target === 'ait' ? 'Apps in Toss' : 'Devvit'} sells one-time products only.`,
        );
      }
      if (derived.get(product.id) !== sku) {
        throw new Error(`Product ${product.id} ${target} SKU did not derive into the host list.`);
      }
    }
  }

  return catalog;
}

if (isCliEntrypoint(import.meta.url)) {
  const catalog = validateProductCatalogFile();
  const currencies = [...resolveCatalogCurrencies(catalog)].join(', ');
  const hostProducts = resolveProductCatalogHostProducts(catalog);
  console.info(
    `Product catalog ${catalog.version}: ${catalog.products.length} products; `
      + `currencies: ${currencies}; `
      + `ait SKUs: ${hostProducts.ait.length}; reddit SKUs: ${hostProducts.reddit.length}`,
  );
}
