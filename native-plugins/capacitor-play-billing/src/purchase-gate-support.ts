import * as adapterCapacitor from '@mpgd/adapter-capacitor';
import {
  CommerceError,
  type CommerceLogicalProductId,
  type CommerceProvider,
  type PurchaseKind,
  type PurchaseSource,
  type RequestPurchaseResult,
  type StoreId,
} from '@mpgd/platform/commerce';

// The gate types mirror `StorePurchaseGate*` of `@mpgd/adapter-capacitor`
// field for field instead of importing them, so this plugin's published
// declarations still type-check against an adapter from before the gate
// (which the runtime probe below refuses to sell through). They are
// structurally identical, so a gate typed with either fits both.

/** What a purchase gate is asked about: one new purchase, before any store UI opens. */
export interface StorePurchaseGateRequest {
  readonly store: StoreId;
  readonly logicalId: CommerceLogicalProductId;
  readonly storeSku: string;
  readonly kind: PurchaseKind;
  readonly source: PurchaseSource;
}

/** A purchase gate's answer; see `StorePurchaseGateDecision` in `@mpgd/adapter-capacitor`. */
export type StorePurchaseGateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly storeCode?: string;
      readonly message?: string;
      readonly retryable?: boolean;
    };

/** The game's sales switch for new purchases; see `StorePurchaseGate` in `@mpgd/adapter-capacitor`. */
export type StorePurchaseGate = (
  request: StorePurchaseGateRequest,
) => StorePurchaseGateDecision | Promise<StorePurchaseGateDecision>;

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
   * Set when a gate was given but the adapter cannot run it: the plugin then
   * answers every new purchase itself (`refuseNewPurchasesUnlessGated`).
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

/**
 * Refuses every new purchase at the plugin boundary when the adapter cannot
 * run the configured gate, before the adapter's `requestPurchase` (which
 * would open the store) is reached. The refusal is a `failed` result, not a
 * throw, so `PURCHASE_GATE_UNSUPPORTED` survives the bridge whatever the
 * adapter version. Recovery, finishing, restore, and events are untouched.
 */
export function refuseNewPurchasesUnlessGated<TProvider extends CommerceProvider>(
  provider: TProvider,
  support: PurchaseGateSupport,
): TProvider {
  if (!support.refuseNewPurchases) {
    return provider;
  }
  return Object.assign(provider, {
    async requestPurchase(): Promise<RequestPurchaseResult> {
      return {
        outcome: 'failed',
        error: createPurchaseGateUnsupportedError().toCommerceErrorInfo(),
      };
    },
  });
}
