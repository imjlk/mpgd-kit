---
npm/@mpgd/adapter-capacitor: minor (Added)
npm/@mpgd/target-config: patch (Fixed)
---

The standard Capacitor commerce path carries store sheet facts. A `StoreSdk` that declares `purchasePresentation` reports `open`, `closed`, or `not-started` for a `requestPurchase` with a `presentationId`; only then does `createStoreCommerceProvider` offer `presentation`, answering every call with facts by idempotency key: `not-started` before the answer for a call that opened no sheet (a purchase gate or account binding refusal, an unavailable store, a throw), so the reconciler keeps a retryable refusal's key reusable, otherwise `open` and exactly one `closed` (from the SDK, after `purchasePresentationTimeoutMs`, or on dispose). A result, a pending purchase, or a purchase event never closes a sheet.

`createCommerceProviderBridge` serves the facts through a new `subscribePresentation` (`mpgd.commerce.presentation.v1` envelopes), apart from the commerce channel. `createBridgeCommerceProvider` offers `presentation` only with `subscribePresentation`, renumbers the facts, and reports `not-started` for a request the bridge refused before its host ran. With facts, `gateway.commerce.presentation` turns on the game runtime's purchase coordination, and the gateway keeps a purchase's pause until the sheet's `closed` (`presentedPurchaseActivityTimeoutMs` as a safety net) instead of until a result event or two minutes. An SDK, provider, or bridge without the facts keeps the earlier behavior.

`withTargetAvailability` relays a commerce source's presentation facts and reports `not-started` for a purchase it refuses before the source runs; before, a game runtime gate over such a source waited for a fact that never came.

An SDK fact `unknown` (its native flow still runs and has observed nothing, for example after a call timeout) keeps the call waiting for the native verdict, bounded by the safety timeout, instead of ending it `not-started` or assuming a sheet. `createNativePurchasePresentation` is exported for the store plugins: the shared bookkeeping of their native `purchasePresentation` events and `presentation` answers.
