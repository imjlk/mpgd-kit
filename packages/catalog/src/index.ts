import typia from 'typia';

import type { LogicalAdPlacementId, LogicalProductId, ProductType } from '@mpgd/platform';

export type CatalogTarget = 'android' | 'ios' | 'ait';

export type AdPlacementTarget = CatalogTarget;

export type ProductGrant =
  | {
      readonly type: 'currency';
      readonly currency: 'coin' | 'gem';
      readonly amount: number;
    }
  | {
      readonly type: 'entitlement';
      readonly entitlement: string;
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
  readonly type: 'rewarded' | 'interstitial';
  readonly reward?: AdReward;
  readonly frequencyCap: FrequencyCap;
  readonly platformPlacementIds: Partial<Record<AdPlacementTarget, string>>;
}

export interface AdPlacements {
  readonly version: string;
  readonly placements: readonly AdPlacementEntry[];
}

export const assertProductCatalog = typia.createAssert<ProductCatalog>();
export const assertAdPlacements = typia.createAssert<AdPlacements>();
export const assertProductGrant = typia.createAssert<ProductGrant>();
