import typia from 'typia';

import type { LogicalProductId, ProductType } from '@mpgd/monetization-contract';

export type CatalogTarget = 'android' | 'ios' | 'ait';

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

export const assertProductCatalog = typia.createAssert<ProductCatalog>();
