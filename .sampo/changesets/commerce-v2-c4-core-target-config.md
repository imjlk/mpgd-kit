---
npm/@mpgd/target-config: minor
---

BREAKING: commerce v2, PR C4 masks the commerce provider, not the removed v1
adapter, and reads commerce capabilities from the `commerce` block only.

- `withTargetAvailability` masks `gateway.commerce` as a `CommerceProvider`: the
  catalog (`fetchProducts`, filtered by kind), new purchases
  (`requestPurchase`), the store resync (`restorePurchases`), and
  `getActiveSubscriptions` obey the target configuration, and
  `getCapabilities` answers the masked block. A purchase the target or the
  effective catalog does not allow answers `{ outcome: 'failed', error: { code:
  'ITEM_UNAVAILABLE', retryable: false } }` (the v1 mask answered a `cancelled`
  result) and never reaches the provider. A purchase the target allows but the
  provider cannot take yet answers the provider's own class of error instead
  (`CONFIGURATION_REQUIRED`, `ACTION_REQUIRED`, or the retryable
  `STORE_UNAVAILABLE` for a `temporarily-unavailable` block), so a temporary
  outage is not journaled as a terminal failure. `getAvailablePurchases`, `finishTransaction`, and
  `subscribe` always pass through, so a purchase already paid for stays
  recoverable and finishable even when the target stops selling. A gateway
  without a provider stays without one.
- `applyTargetConfigToCapabilities` no longer reads or writes `nativeIap` or
  `subscriptionIap`. The new `applyTargetConfigToCommerceCapabilities(commerce,
  config)` returns a fresh masked block: one-time kinds follow `features.iap`,
  `subscription` follows `features.iap` and `features.subscriptions`, and a
  target that allows neither reports `availability: 'unsupported'`; lifecycle
  and authority facts are not masked.
- `getFeatureAvailability` and `createTargetRuntimeSnapshot` derive the `iap`
  and `subscriptions` reasons from `capabilities.commerce` alone
  (`configuration-required`, `action-required`, and `temporarily-unavailable`
  come from `commerce.availability`; a block that sells no matching kind is
  `capability-unsupported`). `providerAvailability.nativeIap` and
  `.subscriptionIap` are no longer read; they no longer exist. A snapshot
  without the required `commerce` block fails with a `TypeError` that says so.
