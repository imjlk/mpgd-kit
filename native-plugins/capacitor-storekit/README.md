# @mpgd/capacitor-storekit

Private, opt-in StoreKit 2 one-time purchase collector for Capacitor 8 on iOS.
It does not enable native IAP in the base Capacitor shell. Install it only in a
game-owned iOS project and register `createCapacitorStoreKitProvider(...)` in
that game's provider list.

Map each logical game product to its App Store Connect product ID and provide
an authenticated, stable UUID `getAppAccountToken()` value. The game backend
must resolve the same UUID for the player. Product lookup, purchase results,
`Transaction.updates`, unfinished transactions, and current non-consumable
entitlements provide **provisional evidence**, never a wallet or entitlement
grant. A completed native purchase returns no `authoritativeGrant`.

On startup, account restoration, and after a pending or uncertain checkout,
call `recoverStoreKitPurchases({ provider, backend, playerId })`. It sends only
transactions whose `appAccountToken` matches the current authenticated game
account to the existing game-services App Store verifier. That verifier fetches
the transaction from Apple's Server API, verifies its signed JWS, validates
bundle/product/environment/account binding, and commits the backend ledger
grant. The recovery helper calls native `finishTransaction` only after a
verified response with a ledger entry ID. If finish fails, it reports
`finishPending: true`; repeat recovery using the same transaction ID and
idempotency key. An unknown backend result stays pending and never triggers a
new purchase sheet automatically.

The iOS native plugin also emits `transactionUpdated` for delayed StoreKit
transactions. Call recovery after this event and on app launch because events
can be missed while the game is closed. `commerce.restore` intentionally
returns no local entitlements. Subscriptions are not supported by this package;
they require a separate subscription status and renewal flow.

The Kit tests use mocked StoreKit responses and a syntax-only local Swift
parse. The macOS CI job compiles the optional Swift package against an iOS
Simulator SDK. Neither check proves a signed App Store purchase, sandbox
checkout, TestFlight installation, or device grant. Validate those with a
game-owned account, keys, and device before a production rollout.
