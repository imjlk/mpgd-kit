import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  assertProductCatalog,
  assertStoreListingCatalog,
  type ProductCatalog,
  type StoreListingCatalog,
} from '@mpgd/catalog';

import {
  readJsonFile,
  readStorePlanFile,
  StorePlanStaleError,
  writeStorePlanFile,
} from './store-sync.js';

export {
  canonicalLanguageTag,
  mapWithConcurrency,
  stableJson,
  stableSha256,
} from './store-sync.js';

/**
 * Shared pieces of `mpgd store products plan|apply`: the game files the sync
 * reads, the saved plan file, and the stable digests apply uses to refuse a
 * plan the store or the files have moved past.
 */

export type StoreProductAction = 'create' | 'update' | 'unchanged';

export const defaultStoreListingFileName = 'mpgd.store-listings.json';
export const defaultProductCatalogFileName = 'mpgd.catalog.json';

export interface StoreProductSources {
  readonly catalogFile: string;
  readonly listingsFile: string;
  readonly catalog: ProductCatalog;
  readonly listings: StoreListingCatalog;
}

/**
 * Read and cross-check the game's product catalog and store listing file.
 * Given paths resolve against the current directory, like every other mpgd
 * file flag (`deploy --plan`, `--release-notes`); the defaults are the
 * game's own files.
 */
export function readStoreProductSources(input: {
  readonly gameRoot: string;
  readonly catalogFile?: string;
  readonly listingsFile?: string;
}): StoreProductSources {
  const catalogFile = input.catalogFile === undefined
    ? path.join(path.resolve(input.gameRoot), defaultProductCatalogFileName)
    : path.resolve(input.catalogFile);
  const listingsFile = input.listingsFile === undefined
    ? path.join(path.resolve(input.gameRoot), defaultStoreListingFileName)
    : path.resolve(input.listingsFile);
  for (const file of [catalogFile, listingsFile]) {
    if (!existsSync(file)) {
      throw new Error(`Store product sync needs ${file}.`);
    }
  }
  const catalog = assertProductCatalog(readJsonFile(catalogFile));
  const listings = assertStoreListingCatalog(readJsonFile(listingsFile), catalog);
  return { catalogFile, listingsFile, catalog, listings };
}

/** A new plan file, never overwriting one (the same rule as `deploy plan --out`). */
export function writeStoreProductPlan(file: string, plan: unknown): string {
  return writeStorePlanFile(file, plan);
}

export function readStoreProductPlanFile(file: string): Record<string, unknown> {
  return readStorePlanFile(file, 'store product plan');
}

export class StoreProductPlanStaleError extends StorePlanStaleError {
  constructor(detail: string) {
    super(detail, 'mpgd store products plan');
    this.name = 'StoreProductPlanStaleError';
  }
}

/** Decimal string (`"0.99"`) as whole units and nanos, without floating point. */
export function decimalToUnitsAndNanos(amount: string): { units: string; nanos: number } {
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,9}))?$/u.exec(amount);
  if (match === null) {
    throw new Error(`Price ${amount} is not a plain decimal amount.`);
  }
  return {
    units: match[1] ?? '0',
    nanos: Number((match[2] ?? '').padEnd(9, '0')),
  };
}

/** Decimal strings compared by value: `0.99` equals `0.990`. */
export function sameDecimal(left: string, right: string): boolean {
  const normal = (value: string): string => {
    const [whole = '0', fraction = ''] = value.trim().split('.');
    const trimmedFraction = fraction.replace(/0+$/u, '');
    const trimmedWhole = whole.replace(/^0+(?=\d)/u, '');
    return trimmedFraction === '' ? trimmedWhole : `${trimmedWhole}.${trimmedFraction}`;
  };
  return normal(left) === normal(right);
}
