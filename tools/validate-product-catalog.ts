import typia from 'typia';

import type { ProductCatalog } from '@mpgd/catalog';

import { productCatalogFilePath } from './catalog-paths';
import { isCliEntrypoint, readJsonFile } from './io';

const assertProductCatalog = typia.createAssert<ProductCatalog>();

export function validateProductCatalogFile(path = productCatalogFilePath()) {
  const catalog = assertProductCatalog(readJsonFile(path));
  const ids = new Set<string>();

  for (const product of catalog.products) {
    if (ids.has(product.id)) {
      throw new Error(`Duplicate product id: ${product.id}`);
    }

    ids.add(product.id);

    if (Object.keys(product.platformProductIds).length === 0) {
      throw new Error(`Product ${product.id} has no platformProductIds.`);
    }

    for (const [target, platformProductId] of Object.entries(product.platformProductIds)) {
      if (platformProductId.trim().length === 0) {
        throw new Error(`Product ${product.id} has blank platformProductId for ${target}.`);
      }
    }
  }

  return catalog;
}

if (isCliEntrypoint(import.meta.url)) {
  const catalog = validateProductCatalogFile();
  console.log(`Product catalog ${catalog.version}: ${catalog.products.length} products`);
}
