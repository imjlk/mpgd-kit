// The StoreKit commerce profile (RFC "Capabilities", row `app-store`).
//
// This module is pure and SDK-free: it imports TYPES only (no `@capacitor/core`,
// no `plugin.ts`), so a tools project, a validator, or a server can read the
// capability block the plugin's provider declares without loading Capacitor.
import type { StoreSdkCapabilities } from '@mpgd/adapter-capacitor';
import type {
  CommerceAuthorityCapabilities,
  CommerceCapabilities,
  PlatformProviderAvailability,
} from '@mpgd/platform';

/** The store id of the StoreKit `StoreSdk` and its commerce provider (RFC "Capabilities", `app-store`). */
export const appStoreStoreId = 'app-store' as const;

/**
 * Evidence schema of a commerce v2 App Store purchase. The payload carries
 * the StoreKit-verified JWS so `@mpgd/game-services/app-store-verifier`
 * verifies it offline and falls back to the Server API only without it.
 */
export const appStoreSignedTransactionEvidenceSchema = 'app-store.signed-transaction.v1';

/** The App Store profile from the RFC "Capabilities" table. */
export const storeKitStoreSdkCapabilities: StoreSdkCapabilities = Object.freeze({
  purchase: Object.freeze({
    consumable: true,
    durable: true,
    subscription: false,
    quantity: false,
  }),
  offers: false,
  pending: true,
  restore: true,
  finish: 'client',
});

/** RFC "Capabilities" profile row for `app-store`: the signed transaction is the proof, bound to an app account token. */
export const storeKitCommerceAuthority: CommerceAuthorityCapabilities = Object.freeze({
  evidence: 'client-token',
  accountBinding: 'required',
});

/**
 * The `CommerceCapabilities` block `createCapacitorStoreKitCommerceProvider`
 * declares while the store reports `availability`: composed from
 * `storeKitStoreSdkCapabilities` and `storeKitCommerceAuthority` exactly as
 * `createStoreCommerceProvider` composes it (the provider has no capability
 * overrides, and the StoreKit SDK implements `restorePurchases` through
 * `AppStore.sync()`). Returns a fresh object on every call and has no side
 * effects.
 */
export function createStoreKitCommerceCapabilities(
  availability: PlatformProviderAvailability,
): CommerceCapabilities {
  const sdk = storeKitStoreSdkCapabilities;
  return {
    purchase: { ...sdk.purchase },
    catalog: { products: true, offers: sdk.offers ?? false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: sdk.pending,
      restore: sdk.restore,
      events: true,
      finish: sdk.finish,
    },
    authority: { ...storeKitCommerceAuthority },
    availability,
  };
}
