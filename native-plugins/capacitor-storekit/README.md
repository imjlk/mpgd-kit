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
account to the game-owned `backend.recoverPurchase` contract. That backend
must reuse the original idempotency key from the durable purchase journal, or
return the existing ledger grant for the same Apple evidence, product and
player. It must not invent a new key for an already-granted transaction: the
generic game-services verifier rejects such evidence replay. For new evidence,
the backend uses the existing App Store Server API/JWS verifier to validate
bundle, product, environment and account binding before the ledger grant.
The recovery helper calls native `finishTransaction` only after a
verified response with a ledger entry ID. If finish fails, it reports
`finishPending: true`; repeat recovery with the original purchase identity.
An unknown backend result stays pending and never triggers a
new purchase sheet automatically.

On the game server, `@mpgd/game-services/app-store-recovery` provides
`createAppStoreRecoveryBackend(...)` for this contract. Construct it only after
authenticating the game player, and bind `playerId` to that authenticated
identity. Pass the same durable `GameServicesStore` instance and
`createGameServicesBackend(...).purchases` used for checkout. Its optional
`resolveOriginalIdempotencyKey` callback must query the game's durable
checkout journal for the **original** key associated with this player and
transaction. The adapter first checks existing App Store ledger evidence and
rejects cross-player, cross-product, cross-deployment and key collisions. If
neither a matching grant nor an original journal key exists, it returns
`pending` without attempting a new grant. Do not use the in-memory store for
production recovery. The game's HTTP/RPC endpoint must authenticate the
request; this helper does not expose one or authenticate clients.
For restored non-consumables whose new transaction ID differs from the
original, configure `restoredNonConsumables` with the same catalog and official
App Store evidence verifier, bundle ID and environment used by the game backend.
When no prior grant exists, also bind `deploymentTarget` on the server-side
recovery backend. The client-supplied target is not trusted to select a product;
without a bound target this restore stays pending until the game backend is
configured for its deployment. An existing grant can supply its recorded target.
The bundle/environment identify an existing grant for its deployment target
before product lookup; they must match the verifier configuration. The helper re-verifies
the **current** Apple transaction and looks up the prior grant by its canonical
original-transaction verification ID before reusing the original key. Without
that verifier, this restore remains pending rather than trusting a client-
reported original ID. A verifier that exceeds its timeout also remains pending.
The native provider forwards both IDs and product type.
For production-scale ledgers, implement the store's indexed
`findEntitlementTransactionByPlatformEvidence` and
`findEntitlementTransactionByIdempotency` methods, plus
`findEntitlementTransactionByEvidenceVerificationId` for restored
non-consumables. Without them, the helper
uses the same full-ledger scan fallback as the generic game-services server.

An existing grant is returned by the normal backend idempotent-retry path;
that path relies on the prior verified ledger record rather than fetching
fresh Apple status. Continue to process App Store revocations separately.
Permanently rejected and account-mismatched transactions are reported as
`rejected` and are **not** finished: the helper cannot prove content delivery
for them. Persist that terminal result in the game-owned operation journal and
do not run an automatic retry loop for it. A support flow may recheck a
corrected account or backend decision later. One malformed transaction is
reported separately and cannot block valid sibling transactions.

The iOS native plugin also emits `transactionUpdated` for delayed StoreKit
transactions. Call recovery after this event and on app launch because events
can be missed while the game is closed. `commerce.restore` intentionally
invokes user-initiated `AppStore.sync()` before returning no local entitlements;
call recovery afterward. Subscriptions are not supported by this package;
they require a separate subscription status and renewal flow.

The Kit tests use mocked StoreKit responses and a syntax-only local Swift
parse. The macOS CI job compiles the optional Swift package against an iOS
Simulator SDK. Neither check proves a signed App Store purchase, sandbox
checkout, TestFlight installation, or device grant. Validate those with a
game-owned account, keys, and device before a production rollout.
