---
npm/@mpgd/capacitor-game-services: minor
---

BREAKING: Commerce v2, PR C4: the base native plugin drops the v1 commerce stubs.

- The Android and iOS `runtime.getCapabilities` answers no longer carry
  `nativeIap`; the commerce capability block is set by
  `@mpgd/adapter-capacitor` from the registered commerce provider (or the
  unsupported block).
- The retired `commerce.getProducts`, `commerce.purchase`, `commerce.restore`,
  and `commerce.getEntitlements` routes (which answered `NATIVE_IAP_UNAVAILABLE`)
  are removed and now answer `UNSUPPORTED_METHOD`. The six `commerce.v2.*`
  methods fail closed with the non-retryable `COMMERCE_V2_UNAVAILABLE`.
