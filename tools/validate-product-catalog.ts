import typia from 'typia';

import { resolveCatalogCurrencies, type ProductCatalog } from '@mpgd/catalog';

import { productCatalogFilePath } from './catalog-paths';
import { isCliEntrypoint, readJsonFile } from './io';

const assertProductCatalog = typia.createAssert<ProductCatalog>();

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

  return catalog;
}

if (isCliEntrypoint(import.meta.url)) {
  const catalog = validateProductCatalogFile();
  const currencies = [...resolveCatalogCurrencies(catalog)].join(', ');
  console.info(
    `Product catalog ${catalog.version}: ${catalog.products.length} products; `
      + `currencies: ${currencies}`,
  );
}
