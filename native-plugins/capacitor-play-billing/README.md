# @mpgd/capacitor-play-billing

Android-only, opt-in Google Play one-time purchase collection for Capacitor 8.
The native module uses Google Play Billing Library 9.1.0. It queries product
details, launches a purchase, listens for purchase updates, and requeries
currently owned, unconsumed purchases. It intentionally does **not** call
BillingClient acknowledge or consume. The game-owned backend must verify the
purchase via Google Play Publisher, commit the mpgd ledger grant, and perform
acknowledge/consume after the grant. A device callback alone never grants a
purchase.

This package is published for opt-in integration, but Kit's mock and compile
checks do not establish live Play purchase behavior. Validate it in a
game-owned Play Console project before relying on it in a published game.

The provider maps game logical product IDs to Play product IDs and requires a
stable obfuscated account ID that agrees with the backend account resolver.
When Play returns multiple eligible one-time offers, map an explicit
`offerToken`; otherwise product lookup reports `PLAY_BILLING_OFFER_REQUIRED`
instead of displaying a price for the wrong offer.
`getOwnedPurchases()` returns provisional evidence for recovery after a missed
callback or process restart. `recoverOwnedPlayPurchases({ provider, backend:
backend.purchases, playerId })` submits completed owned purchases to the same
authenticated backend using stable token-derived idempotency keys. Backend
uncertainty stays pending for retry; `commerce.restore` deliberately returns
no local entitlements. Pending Play purchases remain pending until Google
reports purchased. The caller must not grant based on a native callback,
`getOwnedPurchases()` result, or `commerce.restore` alone.
If a launched purchase times out, is interrupted, or reports an already-owned
item without a matching callback, the provider returns `pending`. Requery and
recover owned purchases before offering another billing flow.

The Kit reference app includes an opt-in Gradle compile target, without
bundling Billing into the base app:

```sh
cd apps/mobile-capacitor/android
./gradlew -PmpgdPlayBillingPluginTest=true \
  :mpgd-capacitor-play-billing:compileDebugJavaWithJavac
```

This compile and the TypeScript fixture do not prove a live Play purchase,
license-test configuration, or device behavior. Validate those in a game-owned
Play Console project before enabling commerce for players.
