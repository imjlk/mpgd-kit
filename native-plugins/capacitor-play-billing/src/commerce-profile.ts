// The Play Billing commerce profile (RFC "Capabilities", row `google-play`).
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

/** The store id of the Play Billing `StoreSdk` (RFC "Capabilities", `google-play`). */
export const googlePlayStoreId = 'google-play' as const;

/** The evidence schema the Google Play verifier in `@mpgd/game-services` routes on. */
export const googlePlayProductPurchaseEvidenceSchema = 'google-play.product-purchase.v2' as const;

/**
 * What the Play Billing plugin supports (RFC "Capabilities" profile row for
 * `google-play`): one-time consumables and durables, no subscriptions, no
 * multi-quantity, pending purchases, no restore call, one-time offers, and a
 * server-owned finish (the backend acknowledges or consumes after the grant).
 */
export const playBillingStoreSdkCapabilities: StoreSdkCapabilities = Object.freeze({
  purchase: Object.freeze({
    consumable: true,
    durable: true,
    subscription: false,
    quantity: false,
  }),
  offers: true,
  pending: true,
  restore: false,
  finish: 'server',
});

/** RFC "Capabilities" profile row for `google-play`: the purchase token is the proof, bound to an obfuscated account id. */
export const playBillingCommerceAuthority: CommerceAuthorityCapabilities = Object.freeze({
  evidence: 'client-token',
  accountBinding: 'required',
});

/**
 * The `CommerceCapabilities` block `createCapacitorPlayBillingCommerceProvider`
 * declares while the store reports `availability`: composed from
 * `playBillingStoreSdkCapabilities` and `playBillingCommerceAuthority` exactly
 * as `createStoreCommerceProvider` composes it (the provider has no capability
 * overrides, and the Play SDK has no `restorePurchases`). Returns a fresh object
 * on every call and has no side effects.
 */
export function createPlayBillingCommerceCapabilities(
  availability: PlatformProviderAvailability,
): CommerceCapabilities {
  const sdk = playBillingStoreSdkCapabilities;
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
    authority: { ...playBillingCommerceAuthority },
    availability,
  };
}
