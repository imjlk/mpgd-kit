---
npm/@mpgd/capacitor-play-billing: minor
---

BREAKING: Commerce v2, PR C4: the v1 provider and recovery driver are removed.

- Removed `createCapacitorPlayBillingProvider` and its types
  (`PlayBillingProviderOptions`, `PlayBillingProductMapping`,
  `CapacitorPlayBillingProvider`, `PlayBillingAvailability`), and
  `recoverOwnedPlayPurchases` with `OwnedPlayPurchase`, `RecoveredPlayPurchase`,
  `PlayPurchaseVerification`, and `PlayPurchaseRecoveryBackend`. Register
  `createCapacitorPlayBillingServiceProvider` (or use
  `createCapacitorPlayBillingCommerceProvider`) and let the
  `@mpgd/game-services` reconciler recover purchases.
- Removed the `createGooglePlayTokenTransactionId` alias; use
  `createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce`.
- `createCapacitorPlayBillingServiceProvider` declares no `features` (it was
  `['nativeIap']`); readiness is the gateway's `commerce` capability block, and
  the gateway exposes the provider as `gateway.commerce`.
- Removed the deprecated `PlayPurchase` fields `productIds`, `state`, and
  `purchaseTimeMillis` from the TypeScript type, the TypeScript readers, and the
  Android plugin's payload; use `products`, `purchaseState`, and `purchaseTime`.
  A shell must carry the matching native module (`cap sync` after upgrading),
  or purchases fail closed as invalid evidence.
- Added `createPlayBillingCommerceCapabilities(availability)`, a pure
  SDK-free function (`src/commerce-profile.ts` imports types only) that returns
  the `CommerceCapabilities` block the provider declares for an availability.
  The profile constants `googlePlayStoreId`, `playBillingStoreSdkCapabilities`,
  `playBillingCommerceAuthority`, and `googlePlayProductPurchaseEvidenceSchema`
  moved into it and stay exported from the package.
