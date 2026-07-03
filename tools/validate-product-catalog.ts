import typia from 'typia';

import type { ProductCatalog } from '@mpgd/product-catalog';

import { isCliEntrypoint, readJsonFile } from './io';

const assertProductCatalog = typia.createAssert<ProductCatalog>();

export function validateProductCatalogFile(path = 'packages/product-catalog/catalog.json') {
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
  }

  return catalog;
}

if (isCliEntrypoint(import.meta.url)) {
  const catalog = validateProductCatalogFile();
  console.log(`Product catalog ${catalog.version}: ${catalog.products.length} products`);
}
