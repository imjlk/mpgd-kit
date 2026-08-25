import typia, { type tags } from 'typia';

import type { LogicalAdPlacementId, LogicalProductId, ProductType } from '@mpgd/platform';

/** Built-in and game-owned deployment target names. */
export type CatalogTarget = string;

/** Built-in and game-owned ad placement target names. */
export type AdPlacementTarget = string;

export type ProductGrant =
  | {
      readonly type: 'currency';
      readonly currency: 'coin' | 'gem';
      readonly amount: number;
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
      readonly amount: number;
    }
  | {
      readonly type: 'currency';
      readonly amount: number;
      readonly currency: 'coin' | 'gem';
    };

export interface AdPlacementEntry {
  readonly id: LogicalAdPlacementId;
  readonly type: 'rewarded' | 'interstitial' | 'banner';
  readonly reward?: AdReward;
  readonly frequencyCap: FrequencyCap;
  readonly platformPlacementIds: Partial<Record<AdPlacementTarget, string>>;
}

export interface AdPlacements {
  readonly version: string;
  readonly placements: readonly AdPlacementEntry[];
}

const assertProductCatalogShape = typia.createAssert<ProductCatalog>();
const assertAdPlacementsShape = typia.createAssert<AdPlacements>();
export const assertProductGrant = typia.createAssert<ProductGrant>();

export function assertProductCatalog(input: unknown): ProductCatalog {
  const catalog = assertProductCatalogShape(input);
  assertUniqueNormalizedPlatformIdentifiers(
    catalog.products.map((product) => ({
      logicalId: product.id,
      identifiers: product.platformProductIds,
    })),
    'product',
  );
  return catalog;
}

export function assertAdPlacements(input: unknown): AdPlacements {
  const placements = assertAdPlacementsShape(input);
  assertUniqueNormalizedPlatformIdentifiers(
    placements.placements.map((placement) => ({
      logicalId: placement.id,
      identifiers: placement.platformPlacementIds,
    })),
    'ad placement',
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

function assertUniqueNormalizedPlatformIdentifiers(
  entries: readonly {
    readonly logicalId: string;
    readonly identifiers: Partial<Record<string, string>>;
  }[],
  kind: string,
): void {
  const identifiersByTarget = new Map<string, Map<string, string>>();

  for (const entry of entries) {
    for (const [target, identifier] of Object.entries(entry.identifiers)) {
      const normalized = normalizePlatformIdentifier(identifier);
      if (normalized === undefined) {
        continue;
      }

      const targetIdentifiers = identifiersByTarget.get(target) ?? new Map<string, string>();
      const existingLogicalId = targetIdentifiers.get(normalized);
      if (existingLogicalId !== undefined) {
        throw new Error(
          `Duplicate normalized ${kind} platform identifier ${normalized} for target ${target}: `
            + `${existingLogicalId} and ${entry.logicalId}.`,
        );
      }

      targetIdentifiers.set(normalized, entry.logicalId);
      identifiersByTarget.set(target, targetIdentifiers);
    }
  }
}
