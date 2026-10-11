# @mpgd/capacitor-play-billing

## 0.1.8 — 2026-10-11

### Patch changes

- [b0b6e5a8](https://github.com/imjlk/mpgd-kit/commit/b0b6e5a8573cd251646600a646fa8ca2ec81292e) Commerce v2, PR A4: bridge methods and event envelope, `app-store-server`
  moved to `@mpgd/game-services`, one Google Play token key helper.
  
  `@mpgd/bridge` adds the six commerce v2 methods to `BridgeMethod`
  (`commerce.v2.getCapabilities`, `commerce.v2.fetchProducts`,
  `commerce.v2.requestPurchase`, `commerce.v2.getAvailablePurchases`,
  `commerce.v2.finishTransaction`, `commerce.v2.restorePurchases`), exported as
  `bridgeCommerceV2Methods` and kept equal to `commerceBridgeMethods` from
  `@mpgd/platform/commerce`, which is now a dependency. The event side exports
  `BridgeEvent` (the `{ protocol: 'mpgd.commerce.v2', sequence, event }`
  envelope), `assertBridgeEvent`, `BridgeEventListener`, `BridgeEventSource`
  (`subscribe(listener): () => void`), and `bridgeEventProtocol`. The
  `COMMERCE_V2_UNAVAILABLE` bridge error (`commerceV2UnavailableBridgeErrorCode`,
  `createCommerceV2UnavailableBridgeError`, `isBridgeCommerceV2Method`) is the
  non-retryable answer of a transport without a v2 provider; the Cloudflare
  Pages host stub returns it for every v2 method. The v1 `commerce.*` methods
  are unchanged.
  
  `@mpgd/game-services` adds the `./app-store-server` subpath with
  `createAppleSignedTransactionVerifier` and
  `CreateAppleSignedTransactionVerifierOptions`, moved from
  `@mpgd/adapter-capacitor`, together with the optional
  `@apple/app-store-server-library` (`^3.1.0`) peer dependency.
  `createGooglePlayTokenTransactionId` in `./google-play-purchase` is now a
  deprecated alias of `createGooglePlayTokenPurchaseKey` from
  `@mpgd/platform/commerce` (same key, same `TypeError` for an invalid token);
  import the platform helper instead. The alias is removed in the next major
  version.
  
  `@mpgd/adapter-capacitor` deprecates the `./app-store-server` subpath: it
  re-exports `createAppleSignedTransactionVerifier` and its options type from
  `@mpgd/game-services/app-store-server` for one release and no longer peers on
  `@apple/app-store-server-library`; install the Apple library next to
  `@mpgd/game-services`. `NativeBridge` gains an optional
  `subscribe(listener: (event: BridgeEvent) => void): () => void` so a B-phase
  store provider can deliver commerce v2 events; the gateway works without it.
  `createCapacitorProviderRegistry` rejects a provider that declares a commerce
  v2 method, since v2 providers are registered through their own surface.
  
  `@mpgd/capacitor-play-billing` computes the token transaction ID with
  `createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce` and keeps
  `createGooglePlayTokenTransactionId` as a deprecated alias of that helper.
  
  `@mpgd/adapter-devvit` and `@mpgd/adapter-ait` sandbox bridges answer
  `COMMERCE_V2_UNAVAILABLE` for commerce v2 methods instead of
  `UNSUPPORTED_METHOD`. `@mpgd/adapter-browser` only gains a test that the
  Microsoft Store native bridge ignores commerce v2 envelopes. — Thanks @imjlk!
- Updated dependencies: bridge@0.12.0, game-services@0.20.0, platform@0.19.0

## 0.1.7 — 2026-10-11

### Patch changes

- Updated dependencies: game-services@0.19.1, platform@0.18.0

## 0.1.6 — 2026-10-09

### Patch changes

- Updated dependencies: game-services@0.19.0, platform@0.17.0

## 0.1.5 — 2026-10-09

### Patch changes

- Updated dependencies: game-services@0.18.1, platform@0.16.0

## 0.1.4 — 2026-10-09

### Patch changes

- Updated dependencies: bridge@0.11.0, game-services@0.18.0, platform@0.15.0

## 0.1.3 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.2

## 0.1.2 — 2026-10-04

### Patch changes

- Updated dependencies: game-services@0.17.1

## 0.1.1 — 2026-09-28

### Patch changes

- [ad66eaf0](https://github.com/imjlk/mpgd-kit/commit/ad66eaf0659b3fce6cacbcec609409479aea0985) Enable automated releases for the separately registered Play Billing and StoreKit Capacitor plugins. — Thanks @imjlk!
- Updated dependencies: game-services@0.17.0, platform@0.14.0

