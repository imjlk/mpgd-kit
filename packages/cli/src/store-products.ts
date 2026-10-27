import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  assertProductCatalog,
  assertStoreListingCatalog,
  type ProductCatalog,
  type StoreListingCatalog,
} from '@mpgd/catalog';

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
  const catalog = assertProductCatalog(readJson(catalogFile));
  const listings = assertStoreListingCatalog(readJson(listingsFile), catalog);
  return { catalogFile, listingsFile, catalog, listings };
}

/** JSON with object keys sorted, so equal values always hash the same. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function stableSha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** A new plan file, never overwriting one (the same rule as `deploy plan --out`). */
export function writeStoreProductPlan(file: string, plan: unknown): string {
  const resolved = path.resolve(file);
  writeFileSync(resolved, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return resolved;
}

export function readStoreProductPlanFile(file: string): Record<string, unknown> {
  const raw = readJson(path.resolve(file));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Saved store product plan is malformed.');
  }
  return raw as Record<string, unknown>;
}

export class StoreProductPlanStaleError extends Error {
  constructor(detail: string) {
    super(`${detail} Run "mpgd store products plan" again and review the new plan.`);
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

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
