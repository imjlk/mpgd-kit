import * as adapterCapacitor from '@mpgd/adapter-capacitor';
import type { StorePurchaseGate } from '@mpgd/adapter-capacitor';
import { CommerceError } from '@mpgd/platform/commerce';

/** `storeCode` of every new purchase refused because the adapter cannot run the gate. */
export const purchaseGateUnsupportedStoreCode = 'PURCHASE_GATE_UNSUPPORTED' as const;

/**
 * Whether the installed `@mpgd/adapter-capacitor` runs `purchaseGate`. An
 * adapter from before the gate ignores the option and would keep selling, so
 * the probe reads an export the gate release added (`purchasesPausedStoreCode`)
 * through the module namespace, where a missing export is `undefined` rather
 * than a link error.
 */
export function adapterSupportsPurchaseGate(
  adapterExports: object = adapterCapacitor,
): boolean {
  return typeof (adapterExports as Readonly<Record<string, unknown>>).purchasesPausedStoreCode
    === 'string';
}

export interface PurchaseGateSupport {
  /** The gate to hand the adapter, when it runs one. */
  readonly purchaseGate?: StorePurchaseGate;
  /**
   * Set when a gate was given but the adapter cannot run it: the account
   * binding, which every adapter asks before a new purchase opens the store
   * and never during recovery, then refuses every new purchase.
   */
  readonly refuseNewPurchases: boolean;
}

/** Fails closed: a gate the adapter would ignore refuses every new purchase instead. */
export function resolvePurchaseGateSupport(
  purchaseGate: StorePurchaseGate | undefined,
  supported: boolean = adapterSupportsPurchaseGate(),
): PurchaseGateSupport {
  if (purchaseGate === undefined) {
    return { refuseNewPurchases: false };
  }
  return supported ? { purchaseGate, refuseNewPurchases: false } : { refuseNewPurchases: true };
}

export function createPurchaseGateUnsupportedError(): CommerceError {
  return new CommerceError('ITEM_UNAVAILABLE', {
    message: 'A purchase gate is configured but @mpgd/adapter-capacitor is too old to run it; '
      + 'new purchases are refused until the adapter is upgraded.',
    storeCode: purchaseGateUnsupportedStoreCode,
    retryable: false,
  });
}
