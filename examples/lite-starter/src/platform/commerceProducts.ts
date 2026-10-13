import {
  resolveProductPlatformId,
  type ProductCatalog,
  type ProductCatalogEntry,
} from '@mpgd/catalog';
import type { CommerceReconcilerProduct } from '@mpgd/game-services';
import type { PurchaseKind } from '@mpgd/platform/commerce';

/**
 * One catalog product mapped to the store SKU of a target, in the shape the
 * Capacitor store providers take (`StoreCommerceProductMapping`): the catalog
 * `platformProductIds[target]` entry is the single source of every SKU.
 */
export interface StarterStoreProductMapping {
  readonly logicalId: ProductCatalogEntry['id'];
  readonly storeSku: string;
  readonly kind: PurchaseKind;
}

/** Commerce v2 purchase kind of a catalog product type. */
export function purchaseKindOf(type: ProductCatalogEntry['type']): PurchaseKind {
  switch (type) {
    case 'consumable':
      return 'consumable';
    case 'non_consumable':
      return 'durable';
    case 'subscription':
      return 'subscription';
    default:
      throw new TypeError(`Unknown catalog product type: ${String(type)}`);
  }
}

/**
 * The products sold on `target`: every catalog entry that names a platform
 * product id for it. A product without one is not sold on that target, so a
 * store provider never offers it.
 */
export function resolveStarterStoreProducts(
  catalog: ProductCatalog,
  target: string,
): readonly StarterStoreProductMapping[] {
  return catalog.products.flatMap((product) => {
    const storeSku = resolveProductPlatformId(product, target);
    return storeSku === undefined
      ? []
      : [{ logicalId: product.id, storeSku, kind: purchaseKindOf(product.type) }];
  });
}

/**
 * The catalog kinds and SKUs the commerce v2 reconciler resolves without a
 * store read (`createGameServicesRuntime({ commerceProducts })`). Every
 * product is listed so a purchase for an unsold product fails on the store
 * answer, not on a missing kind.
 */
export function resolveStarterCommerceProducts(
  catalog: ProductCatalog,
  target: string,
): readonly CommerceReconcilerProduct[] {
  return catalog.products.map((product) => {
    const storeSku = resolveProductPlatformId(product, target);
    return {
      logicalId: product.id,
      kind: purchaseKindOf(product.type),
      ...(storeSku === undefined ? {} : { storeSku }),
    };
  });
}
