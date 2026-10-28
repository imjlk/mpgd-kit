---
npm/@mpgd/capacitor-storekit: minor (Added)
---

The StoreKit provider reports the purchase sheet (`CommerceProvider.presentation`): the native plugin reports `open` right before `Product.purchase()` and `closed` when it returns or throws (an Ask to Buy is closed when the call returns), `not-started` for a call refused before it. Facts arrive as `purchasePresentation` events and in the `purchase` answer's `presentation`; `getPresentationSupport` declares them. Apple does not document that `Product.purchase()` returns only once the sheet is dismissed, so this is unverified until device testing.

On by default (`purchasePresentation: false` keeps the result-based pause). A web bundle on a native build from before the facts reports the store `configuration-required` and refuses new purchases with `CONFIGURATION_REQUIRED` / `STOREKIT_PRESENTATION_UNSUPPORTED`; recovery is unaffected. An adapter from before the facts sends no presentation id, and purchases run as before. Rebuild the app (`cap sync`) with this version's native code.
