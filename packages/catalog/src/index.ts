import typia, { type tags } from 'typia';

import type { LogicalAdPlacementId, LogicalProductId, ProductType } from '@mpgd/platform';

/** Built-in and game-owned deployment target names. */
export type CatalogTarget = string;

/** Built-in and game-owned ad placement target names. */
export type AdPlacementTarget = string;

/** Currencies a catalog accepts when it declares none. The kit adds no wallet currency literal. */
export const defaultCatalogCurrencies = Object.freeze(['coin', 'gem'] as const);

/**
 * A ledger quantity: finite, greater than zero, and a safe integer.
 * Scaling `amount * quantity` of two safe integers stays finite, and JSON
 * round-trips the same integer.
 */
type PositiveLedgerAmount = number
  & tags.Minimum<1>
  & tags.Maximum<9007199254740991>
  & tags.MultipleOf<1>;

export type ProductGrant =
  | {
      readonly type: 'currency';
      /** Must be declared by the catalog's `currencies` list (default `coin`, `gem`). */
      readonly currency: string & tags.MinLength<1>;
      /** Positive safe integer credited to `currency`. */
      readonly amount: PositiveLedgerAmount;
    }
  | {
      readonly type: 'entitlement';
      readonly entitlement: string;
    }
  | {
      readonly type: 'resource';
      readonly resource: string & tags.MinLength<1>;
      readonly amount: number
        & tags.ExclusiveMinimum<0>
        & tags.Maximum<1.7976931348623157e308>;
    };

export interface ProductCatalogEntry {
  readonly id: LogicalProductId;
  readonly type: ProductType;
  readonly grant: ProductGrant;
  readonly platformProductIds: Partial<Record<CatalogTarget, string>>;
}

export interface ProductCatalog {
  readonly version: string;
  /**
   * Currencies a `currency` grant may name. Non-empty, unique, trimmed; when
   * absent the catalog accepts `coin` and `gem` only.
   */
  readonly currencies?: readonly (string & tags.MinLength<1>)[] & tags.MinItems<1>;
  readonly products: readonly ProductCatalogEntry[];
}

export interface FrequencyCap {
  readonly cooldownSeconds: number;
  readonly maxPerSession?: number;
  readonly minStageInterval?: number;
}

export type AdReward =
  | {
      readonly type: 'continue';
      /** Positive safe integer count of continues. Not a fraction or a duration. */
      readonly amount: PositiveLedgerAmount;
    }
  | {
      readonly type: 'currency';
      /** Positive safe integer credited to `currency`. */
      readonly amount: PositiveLedgerAmount;
      /** Validated against the product catalog's declared currencies by `validate:ads`. */
      readonly currency: string & tags.MinLength<1>;
    };

interface AdPlacementEntryBase {
  readonly id: LogicalAdPlacementId;
  readonly frequencyCap: FrequencyCap;
  readonly platformPlacementIds: Partial<Record<AdPlacementTarget, string>>;
}

export type AdPlacementEntry =
  | AdPlacementEntryBase & {
      readonly type: 'rewarded';
      readonly reward?: AdReward;
    }
  | AdPlacementEntryBase & {
      readonly type: 'interstitial' | 'banner';
      /** Non-rewarding placements must never describe a game grant. */
      readonly reward?: never;
    };

export interface AdPlacements {
  readonly version: string;
  readonly placements: readonly AdPlacementEntry[];
  /** Explicitly share a physical placement among logical placements of the same format. */
  readonly sharedPlatformPlacementTargets?: readonly string[];
}

const assertProductCatalogShape = typia.createAssert<ProductCatalog>();
const assertAdPlacementsShape = typia.createAssert<AdPlacements>();
export const assertProductGrant = typia.createAssert<ProductGrant>();

export function assertProductCatalog(input: unknown): ProductCatalog {
  const catalog = assertProductCatalogShape(input);
  const currencies = resolveCatalogCurrencies(catalog);
  for (const product of catalog.products) {
    if (product.grant.type === 'currency' && !currencies.has(product.grant.currency)) {
      throw new Error(
        `Product ${product.id} grants undeclared currency ${product.grant.currency}; `
          + `declared currencies: ${[...currencies].join(', ')}.`,
      );
    }
  }
  assertUniqueLogicalIds(
    catalog.products.map((product) => product.id),
    'product',
  );
  assertUniqueNormalizedPlatformIdentifiers(
    catalog.products.map((product) => ({
      logicalId: product.id,
      identifiers: product.platformProductIds,
    })),
    'product',
  );
  return catalog;
}

/**
 * The currencies a catalog accepts, in declaration order. Rejects blank,
 * untrimmed, or duplicate entries; an absent list means `coin` and `gem`.
 */
export function resolveCatalogCurrencies(
  catalog: Pick<ProductCatalog, 'currencies'>,
): ReadonlySet<string> {
  const declared = catalog.currencies ?? defaultCatalogCurrencies;
  const currencies = new Set<string>();
  for (const currency of declared) {
    if (currency.trim() !== currency || currency.length === 0) {
      throw new Error(
        `Catalog currency ${JSON.stringify(currency)} must be a trimmed non-empty code.`,
      );
    }
    if (currencies.has(currency)) {
      throw new Error(`Catalog currency ${currency} is declared more than once.`);
    }
    currencies.add(currency);
  }
  return currencies;
}

export function assertAdPlacements(input: unknown): AdPlacements {
  const placements = assertAdPlacementsShape(input);
  const sharingTargets = new Set(placements.sharedPlatformPlacementTargets ?? []);
  if (sharingTargets.size !== (placements.sharedPlatformPlacementTargets?.length ?? 0)
    || [...sharingTargets].some((target) => target.trim() !== target || target.length === 0)) {
    throw new Error('Shared placement targets must be unique non-empty identifiers.');
  }
  assertUniqueLogicalIds(
    placements.placements.map((placement) => placement.id),
    'ad placement',
  );
  assertUniqueNormalizedPlatformIdentifiers(
    placements.placements.map((placement) => ({
      logicalId: placement.id,
      identifiers: placement.platformPlacementIds,
      format: placement.type,
    })),
    'ad placement',
    sharingTargets,
  );
  return placements;
}

export function resolveProductPlatformId(
  product: ProductCatalogEntry,
  target: CatalogTarget,
): string | undefined {
  const identifier = readOwnPlatformIdentifier(product.platformProductIds, target);
  return normalizePlatformIdentifier(identifier);
}

export function resolveAdPlacementPlatformId(
  placement: AdPlacementEntry,
  target: AdPlacementTarget,
): string | undefined {
  return normalizePlatformIdentifier(
    readOwnPlatformIdentifier(placement.platformPlacementIds, target),
  );
}

function readOwnPlatformIdentifier(
  identifiers: Partial<Record<string, string>>,
  target: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(identifiers, target)
    ? identifiers[target]
    : undefined;
}

function normalizePlatformIdentifier(identifier: string | undefined): string | undefined {
  const normalized = identifier?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function assertUniqueLogicalIds(
  ids: readonly string[],
  kind: 'product' | 'ad placement',
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${kind} id: ${id}.`);
    }
    seen.add(id);
  }
}

function assertUniqueNormalizedPlatformIdentifiers(
  entries: readonly {
    readonly logicalId: string;
    readonly identifiers: Partial<Record<string, string>>;
    readonly format?: string;
  }[],
  kind: string,
  sharingTargets: ReadonlySet<string> = new Set(),
): void {
  const identifiersByTarget = new Map<string, Map<string, { readonly logicalId: string; readonly format?: string }>>();

  for (const entry of entries) {
    for (const [target, identifier] of Object.entries(entry.identifiers)) {
      const normalized = normalizePlatformIdentifier(identifier);
      if (normalized === undefined) {
        continue;
      }

      const targetIdentifiers = identifiersByTarget.get(target) ?? new Map<string, { readonly logicalId: string; readonly format?: string }>();
      const existing = targetIdentifiers.get(normalized);
      if (existing !== undefined && (!sharingTargets.has(target) || existing.format !== entry.format)) {
        throw new Error(
          `Duplicate normalized ${kind} platform identifier ${normalized} for target ${target}: `
            + `${existing.logicalId} and ${entry.logicalId}.`,
        );
      }

      targetIdentifiers.set(normalized, {
        logicalId: entry.logicalId,
        ...(entry.format === undefined ? {} : { format: entry.format }),
      });
      identifiersByTarget.set(target, targetIdentifiers);
    }
  }
}

export {
  assertNotificationTopicCatalog,
  isRootRelativeNotificationRoute,
  resolveNotificationTopicsForTarget,
  validateNotificationTopicCatalog,
  type NotificationTopicCatalog,
  type NotificationTopicCatalogEntry,
  type NotificationTopicCatalogIssue,
  type NotificationTopicCatalogNotices,
  type NotificationTopicCatalogValidation,
  type NotificationTopicCatalogValidationOptions,
} from './notification-topics.js';

export {
  assertStoreListingCatalog,
  resolveStoreListingLocalizations,
  type AppStoreListing,
  type AppStoreListingAvailability,
  type AppStoreListingPrice,
  type GooglePlayListing,
  type GooglePlayListingPrice,
  type StoreListingCatalog,
  type StoreListingEntry,
  type StoreListingLocale,
  type StoreListingLocalization,
  type StoreListingMoney,
} from './store-listings.js';
