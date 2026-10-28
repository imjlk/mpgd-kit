# Commerce v2 contract (RFC)

Status: **draft proposal (A1)**. This RFC describes a contract that does not
exist yet. It is not confirmed runtime behavior, and it is outside the
enforced [documentation evidence](../../DOCUMENTATION_EVIDENCE.md) scope until
the A2 and A3 pull requests land types and a conformance runner that cite it.
Baseline: `main@40688545`, 2026-10-05. Draft protocol version:
`2.0.0-draft.1`.

It builds on the subscription decision
[D-02](../../SUBSCRIPTION_COMMERCE_DECISION.md), whose constraints on credit
memberships and credit lots are normative here.

## Summary {#summary}

Six commerce paths ship today: Google Play Billing, StoreKit, Microsoft Store,
Apps in Toss, Devvit, and Verse8. Each has its own result vocabulary,
recovery driver, finish rule, and server routing. Commerce v2 replaces that
with one client contract, one purchase state machine, one reconciler, and one
evidence registry on the server. Every store is described by declared
capabilities rather than by branching on the target name.

The design borrows the structure of the OpenIAP Client Protocol
(`fetchProducts`, `requestPurchase` with results delivered by events,
`getAvailablePurchases`, `finishTransaction`). It takes no dependency on
OpenIAP. Store identifiers, currencies, and evidence schemas are open strings
that the consuming project declares. A prepaid-credit wallet is modeled as a
second commerce layer: the kit defines its interface and rules, and the
consuming project implements it.

## Current state {#current-state}

| Store | Client path today | Recovery today | Finish today | Server routing today |
| --- | --- | --- | --- | --- |
| Google Play | `capacitor-play-billing` provider, evidence `google-play.product-purchase.v2` with `{ purchaseToken }` | `recoverOwnedPlayPurchases`, key `play-token-sha256:<hex>` | Nothing on the client. `createGooglePlayProductPurchaseBoundary` can acknowledge or consume, but no worker or template binds it | `switch (target)` on `android` |
| App Store | `capacitor-storekit` provider; the Swift plugin returns `signedTransaction`, the TS provider validates its shape and drops it | `recoverStoreKitPurchases` with server lookup by transaction id | `finishGrantedTransaction` after a recorded ledger grant | `switch (target)` on `ios`, Server API lookup |
| Microsoft Store | `adapters/browser` Digital Goods path, evidence `mpgd.microsoft-store.digital-goods.v1` | `pending-grant:v3` records in `localStorage`, `restore()` | Server consume finalizer, the only finalizer bound in the worker | `switch (target)` on `microsoft-store` |
| Apps in Toss | `adapters/ait`, evidence `apps-in-toss.iap.callback.v1` | Pending-order cursor, 20 orders per pass | Host: `processProductGrant` returning `true`, or `completeProductGrant` on restore | `switch (target)` on `ait` |
| Devvit | `adapters/devvit` payments client | Entitlements only | None | Not through `verifyPurchase`; fulfillment orders are normalized separately |
| Verse8 | `adapters/verse8`, purchase always `pending` | None | None | Not through `verifyPurchase`; Agent8 `$onItemPurchased` |

The concrete problems this RFC addresses:

- **No shared vocabulary.** `PurchaseResult.status` is
  `completed | cancelled | pending | failed`; the journal summary adds
  `granted | rejected | skipped | unavailable | action-required`; error codes
  are free strings with store prefixes (nearly 40 in the Play and StoreKit
  client layers alone) and no normalized class a game can branch on.
- **Four recovery drivers.** Play, StoreKit, Microsoft Store, and Apps in Toss
  each recover differently, and the shared journal
  (`createRecoverableMonetizationClient`) must be fed by each of them through
  `recoverPurchaseResult`.
- **Events nobody listens to.** The native plugins emit `purchaseUpdated` and
  `transactionUpdated`; no TS code subscribes.
- **Closed server targets.** `GameServicesStoreTarget` is
  `microsoft-store | android | ios | ait`, enforced at runtime, and the worker
  routes verifiers by target. A new store, including a credit wallet, cannot
  reach the ledger without a kit change.
- **Finish ownership is implicit.** Settlement is detected by target name
  (`isAuthoritativeMicrosoftStoreCompletion`), and nothing declares who must
  acknowledge, consume, finish, or complete a purchase.
- **Closed currencies.** `ProductGrant.currency` and `AdReward.currency` are
  `'coin' | 'gem'`.
- **The ledger cannot revoke or expire.** Refunds are only rejections at verify
  time; `GameServicesStore` has no revoke or expiry write.

Known gaps carried into the [PR plan](#pr-plan): the starter worker binds no
Play acknowledge or consume finalizer; the Capacitor templates wire no store
provider and `--providers` records metadata only; StoreKit evidence omits the
JWS; `createGooglePlayTokenTransactionId` is duplicated in the Play plugin and
`@mpgd/game-services`; the server-only `app-store-server.ts` lives in the
client package `@mpgd/adapter-capacitor`; and the Apps in Toss sandbox gateway
self-completes purchases (selected only for the `ait-sandbox` build id
since imjlk/mpgd-kit#261).

## Goals and non-goals {#goals}

Goals:

- One client contract that every commerce provider implements, including
  host platforms and a credit wallet.
- One persisted purchase state machine and one reconciler that handle app
  restarts, events delivered before a listener exists, and finish failures
  after a grant.
- Capability declarations that say who finishes a purchase and what evidence
  authorizes a grant, so behavior follows declarations instead of target names.
- Open, project-declared store ids, currencies, and evidence schemas on both
  client and server.
- Shared conformance vectors that every provider and the reference runtime
  must pass.
- Subscription fields in the contract from the first release, with every
  store provider declaring them unsupported.

Non-goals:

- Implementing store subscriptions (Play Billing, StoreKit). D-02 keeps them
  out of scope until its triggers fire.
- Depending on OpenIAP packages or moving native cores to OpenIAP in this
  repository. See [OpenIAP](#openiap).
- Implementing a credit wallet in the kit. The kit ships the interface,
  rules, and vectors; the consuming project owns the wallet.
- New top-level `providers/` or `conformance/` directories. The SDK boundary
  in `AGENTS.md` stays as it is.

## Principles {#principles}

1. **The ledger grants.** Platform results, events, and adapter settlements
   are evidence. Only a backend ledger entry grants, and only a backend ledger
   entry revokes.
2. **Declarations, not names.** Code branches on `CommerceCapabilities` and
   registry entries, never on a store id or target string.
3. **Open identifiers.** `StoreId`, wallet currencies, and evidence schemas are
   strings declared by the project. The kit ships reference values, not a
   closed list.
4. **Pure contract.** All contract types, the state machine, and the
   conformance runner live in `@mpgd/platform` and stay free of Phaser, DOM,
   network, and SDK imports. Store code stays in `adapters/*`,
   `native-plugins/*`, and `apps/target-*`.
5. **Additive until the major.** v1 `CommerceAdapter` kept working through a
   wrapper until every provider implemented v2; C4 removed v1 in one major
   release (see [Migrating from v1](#migrating-from-v1)).

## Client contract {#client-contract}

The types below are a sketch for A2. Names are proposed; field sets are the
substance of this RFC.

```ts
// packages/platform/src/commerce (pure)

/** Open store identifier. The kit's reference providers use the values below. */
export type StoreId = string;
// Reference ids: 'google-play', 'app-store', 'microsoft-store',
// 'apps-in-toss', 'devvit', 'verse8'. A consuming project adds its own,
// for example a credit wallet id.

export type PurchaseKind = 'consumable' | 'durable' | 'subscription';

export interface StoreProduct {
  readonly logicalId: LogicalProductId;
  readonly store: StoreId;
  readonly storeSku: string;
  readonly kind: PurchaseKind;
  readonly title: string;
  readonly description: string;
  /** ISO 4217 code or a project-declared code such as a wallet currency. */
  readonly price: { readonly formatted: string; readonly currencyCode: string; readonly amountMicros?: number };
  readonly offers?: readonly StoreOffer[];
}

export interface StorePurchase {
  readonly store: StoreId;
  /** Store transaction id; a provider derives one when the store has none. */
  readonly transactionId: string;
  readonly originalTransactionId?: string;
  readonly storeSku: string;
  readonly logicalId?: LogicalProductId;
  readonly quantity: number;
  readonly state: 'pending' | 'purchased' | 'revoked';
  readonly purchasedAt?: string;
  /** Play purchase token, App Store signed transaction (JWS), or host order id. */
  readonly token: string;
  readonly evidence: PlatformEvidenceEnvelope;
  readonly accountBinding?: {
    readonly kind: 'obfuscated-account-id' | 'app-account-token' | 'host-identity';
    readonly value?: string;
  };
  /** Present only for `authority.evidence: 'adapter-settled'`. */
  readonly settlement?: { readonly ledgerEntryId: string };
}

export interface RequestPurchaseInput {
  readonly logicalId: LogicalProductId;
  readonly idempotencyKey: string;
  readonly source: 'shop' | 'stage_fail' | 'result' | 'event';
  readonly offerId?: string;
  readonly quantity?: number;
}

export type RequestPurchaseResult =
  | { readonly outcome: 'launched' }
  | { readonly outcome: 'purchased'; readonly purchase: StorePurchase }
  | { readonly outcome: 'cancelled' | 'failed'; readonly error: CommerceErrorInfo };

export type CommerceEvent =
  | { readonly type: 'purchaseUpdated'; readonly purchase: StorePurchase }
  | { readonly type: 'purchaseError'; readonly logicalId?: LogicalProductId; readonly error: CommerceErrorInfo }
  | { readonly type: 'subscriptionUpdated'; readonly subscription: ActiveSubscription };

export interface CommerceProvider {
  readonly store: StoreId;
  getCapabilities(): Promise<CommerceCapabilities>;
  fetchProducts(input: {
    readonly logicalIds?: readonly LogicalProductId[];
    readonly type?: 'in-app' | 'subscription' | 'all';
  }): Promise<readonly StoreProduct[]>;
  requestPurchase(input: RequestPurchaseInput): Promise<RequestPurchaseResult>;
  /**
   * Purchases the store still reports as unfinished. `restore` is the
   * player's Restore Purchases read: owned non-consumables the recovery list
   * hides are listed too (see "Restore sharing").
   */
  getAvailablePurchases(input?: {
    readonly includePending?: boolean;
    readonly restore?: boolean;
  }): Promise<readonly StorePurchase[]>;
  /** Required when `lifecycle.finish` is 'client' or 'host'. */
  finishTransaction?(input: {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
    readonly isConsumable: boolean;
    /** An earlier finish of this purchase was asked for (a `client` retry). */
    readonly retry?: boolean;
  }): Promise<{ readonly finished: boolean }>;
  /** Accepts `retry`; a caller sends it only to a provider declaring this. */
  readonly acceptsFinishRetry?: boolean;
  /** Asks the store to resynchronize, for example `AppStore.sync`. */
  restorePurchases?(): Promise<void>;
  /** Designed, not implemented by any reference store provider. */
  getActiveSubscriptions?(): Promise<readonly ActiveSubscription[]>;
  subscribe(listener: (event: CommerceEvent) => void): () => void;
}
```

Rules every provider follows:

- **Results arrive as events.** `requestPurchase` returns `launched` when the
  store UI opened and the result will come later. It returns `purchased` only
  when the store answered synchronously. A `purchaseUpdated` event or a later
  `getAvailablePurchases` read is the source of truth either way.
- **Buffer before the first listener.** A provider keeps events emitted before
  its first `subscribe` call and delivers them to that first subscriber. It
  may drop a buffered `purchaseUpdated` only if the same purchase is still
  returned by `getAvailablePurchases`.
- **Available means unfinished.** `getAvailablePurchases` returns purchases
  that have not been finished: unconsumed or unacknowledged Play purchases,
  unfinished StoreKit transactions, Microsoft Store purchases not yet
  consumed, Apps in Toss pending orders, and wallet entitlements not yet
  redeemed. A finished durable purchase is not available; entitlements come
  from the ledger, not from this list. StoreKit is the exception: a
  non-consumable that StoreKit has already finished stays in `currentEntitlements`
  with `unfinished: false`, and the StoreKit SDK still lists it so a finish
  that raced the ledger grant can still be verified. The server ledger
  dedupes that verify. A finished consumable is not listed.

<!-- @link ../../../native-plugins/capacitor-storekit/src/store-sdk.ts#createCapacitorStoreKitStoreSdk Lists unfinished:false non-consumables and finishes only when the session app account token matches the transaction, or a durable of another token (Restore sharing); on a retried finish, a consumable no longer listed answers finished without a native call (a lost acknowledgement). -->
- **No grants on the client.** A provider never credits a wallet or unlocks an
  entitlement. `settlement` on an adapter-settled purchase is a pointer for
  the reconciler, not a grant.
- **Token and evidence both stay.** `token` is the store's canonical proof,
  kept so a server can verify offline. `evidence` remains the envelope the
  server registry routes on.
- **Presentation facts are optional.** A provider whose host can prove when its
  payment surface opens or closes (ONE play) offers
  `presentation.subscribe(listener)`; the game runtime's presentation gate
  uses it, and without it a purchase result alone says nothing about the
  surface. A provider that restarts its event sequence on each call echoes the
  coordinator's attempt generation so a delayed event from the previous call
  cannot close the next sheet. A trusted not-started fact does not grant, and
  it does not reopen a journal already written `failed`: that state has no
  outgoing transition, and a retryable failure without presentation proof stays
  terminal.
  C4 added the field to the contract; it takes no part in granting.

<!-- @link ../../../packages/platform/src/index.ts#commercePresentationAttempt Restarting providers echo this request generation on presentation events. -->
<!-- @link ../../../packages/platform/src/commerce.ts#commercePurchaseTransitions failed has no outgoing transition. -->

## Capabilities {#capabilities}

```ts
export interface CommerceCapabilities {
  readonly purchase: {
    readonly consumable: boolean;
    readonly durable: boolean;
    readonly subscription: boolean;
    readonly quantity: boolean;
  };
  readonly catalog: { readonly products: boolean; readonly offers: boolean; readonly localizedPrice: boolean };
  readonly lifecycle: {
    readonly availablePurchases: boolean;
    readonly pending: boolean;
    readonly restore: boolean;
    readonly events: boolean;
    /** Who finishes a granted purchase. */
    readonly finish: 'client' | 'server' | 'host' | 'none';
  };
  readonly authority: {
    /** What the backend verifies to grant. */
    readonly evidence: 'client-token' | 'host-callback' | 'adapter-settled' | 'server-push';
    readonly accountBinding: 'required' | 'optional' | 'host';
  };
  readonly availability: PlatformProviderAvailability;
}
```

During the transition, `PlatformCapabilities.nativeIap` was derived as
`availability === 'available' && (purchase.consumable || purchase.durable)`,
and `subscriptionIap` as `purchase.subscription`. C4 removed both booleans and
`deriveLegacyCommerceCapabilities`: `PlatformCapabilities.commerce` is
required and is the only source. A gateway that sells nothing reports
`createUnsupportedCommerceCapabilities()` rather than omitting the block, so a
consumer never has to guess a default. The capability conformance rules in
[platform-capability-snapshots.md](../platform-capability-snapshots.md) apply
to the block: it is required, a fresh object on every read, and has no
unknown keys.

Profiles for the reference stores, fixed from the current code:

| Store id | consumable | durable | subscription | available source | pending | finish | evidence | account binding |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `google-play` | yes | yes | no | `getPurchases`, unfinished only | yes | `server` (acknowledge or consume finalizer) | `client-token` (purchase token) | `required` (obfuscated account id) |
| `app-store` | yes | yes | no | `getTransactions`, unfinished only | yes | `client`, after the ledger grant | `client-token` (signed transaction JWS) | `required` (`appAccountToken`) |
| `microsoft-store` | yes | no | no | `listPurchases` | no | `server` (consume finalizer) | `adapter-settled` | `required` |
| `apps-in-toss` | yes | yes | no | `getPendingOrders` | yes | `host` (`completeProductGrant`) | `host-callback` | `host` |
| `devvit` | yes | yes | no | paid, undelivered orders | yes | `none` | `server-push` (fulfillment order) | `host` |
| `verse8` | yes | yes | no | none | yes | `none` | `server-push` (Agent8 event) | `host` |
| `oneplay` | yes | yes | no | none | yes | `server` (consume or acknowledge finalizer) | `client-token` (purchase token) | `host` (server-issued checkout intent) |
| wallet (project-owned) | yes | yes | only where [billing authority](#billing-authority) is `host` | unredeemed entitlements | no | `server` (redeem) | `adapter-settled` | `host` |

`subscription` is `false` for every reference store provider in the first
release, as D-02 requires.

## Errors {#errors}

`CommerceError` extends `PlatformOperationError` with a normalized code and
keeps the store's own code verbatim.

```ts
export type CommerceErrorCode =
  | 'USER_CANCELLED'           // not retryable
  | 'OUTCOME_UNKNOWN'          // reconcile; never retry the purchase UI blindly
  | 'ALREADY_OWNED'            // reconcile; an unfinished purchase likely exists
  | 'IN_PROGRESS'              // another attempt for the same product is open
  | 'ITEM_UNAVAILABLE'
  | 'NOT_PREPARED'             // provider not initialized or not ready
  | 'NETWORK'                  // retryable
  | 'STORE_UNAVAILABLE'        // retryable
  | 'CONFIGURATION_REQUIRED'
  | 'ACTION_REQUIRED'          // the player must act, for example sign in
  | 'ACCOUNT_BINDING_REQUIRED'
  | 'INSUFFICIENT_BALANCE'     // wallet providers
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

export interface CommerceErrorInfo {
  readonly code: CommerceErrorCode;
  readonly retryable: boolean;
  /** The store's original code, for example PLAY_BILLING_SERVICE_UNAVAILABLE. */
  readonly storeCode?: string;
  readonly message?: string;
}
```

Examples of the mapping from today's codes:

| Current code | v2 code |
| --- | --- |
| `PLAY_BILLING_TIMEOUT`, `PLAY_BILLING_INTERRUPTED`, `PLAY_BILLING_EMPTY_PURCHASE`, `STOREKIT_PURCHASE_UNCERTAIN` | `OUTCOME_UNKNOWN` |
| `PLAY_BILLING_ALREADY_OWNED` | `ALREADY_OWNED` |
| `PLAY_BILLING_DISCONNECTED`, `PLAY_BILLING_SERVICE_UNAVAILABLE`, `STOREKIT_UNAVAILABLE`, `NATIVE_PROVIDER_TEMPORARILY_UNAVAILABLE` | `STORE_UNAVAILABLE` |
| `PLAY_BILLING_NETWORK_ERROR`, `NATIVE_PURCHASE_NETWORK_ERROR` | `NETWORK` |
| `PLAY_BILLING_PRODUCT_UNKNOWN`, `PLAY_BILLING_PRODUCT_UNAVAILABLE`, `STOREKIT_PRODUCT_UNKNOWN`, `NATIVE_PROVIDER_PRODUCT_UNKNOWN` | `ITEM_UNAVAILABLE` |
| `PLAY_BILLING_ACCOUNT_REQUIRED`, `PLAY_BILLING_ACCOUNT_LOOKUP_FAILED` | `ACCOUNT_BINDING_REQUIRED` |
| `PLAY_BILLING_CONFIGURATION_ERROR`, `STOREKIT_CONFIGURATION_ERROR`, `NATIVE_PROVIDER_CONFIGURATION_REQUIRED` | `CONFIGURATION_REQUIRED` |
| `PLAY_BILLING_EVIDENCE_INVALID`, `STOREKIT_EVIDENCE_INVALID`, `NATIVE_PROVIDER_INVALID_RESPONSE` | `INVALID_RESPONSE` |

Backend error codes such as `IDEMPOTENCY_KEY_CONFLICT` or
`EVIDENCE_VERIFIER_UNAVAILABLE` are not client commerce errors. They surface
as journal states, as described in [lifecycle](#lifecycle).

`OUTCOME_UNKNOWN` and `ALREADY_OWNED` are not terminal for a purchase
attempt. A provider whose store call throws or returns one of them answers
`requestPurchase` with `launched` rather than `failed`, and it does not emit
a `purchaseError` for them: an unfinished purchase may exist, so the attempt
stays open and the [reconciler](#reconciler) resolves it from
`getAvailablePurchases` without reopening the store UI (B1 implements this
rule in `createStoreCommerceProvider`).

A purchase that the game's sales switch or its account binding refuses
before the store UI opens is the opposite case: nothing was launched, so
`createStoreCommerceProvider` answers `failed`, never `launched`, and
answers it as a result rather than a throw so `storeCode` crosses the
bridge.
`createStoreCommerceProvider`'s optional `purchaseGate` refuses with
`ITEM_UNAVAILABLE` and `storeCode` `PURCHASES_PAUSED` (or the game's own
code; `PURCHASE_GATE_FAILED` when the gate itself fails) and is never
consulted by recovery, restore, finishing, or `getAvailablePurchases`.

## Purchase lifecycle {#lifecycle}

Every purchase, whether started by the game or discovered by the reconciler,
is one journal record moving through these states:

```text
requested ──▶ launched ──▶ purchased ──▶ verifying ──▶ granted ──▶ finishing ──▶ finished
    │            │  │          ▲            │   │          │                        │
    │            │  └▶ pending ┘            │   └▶ pending │  (finish: none) ───────┤
    │            │   (store)                │     (server) │                        ▼
    ├▶ cancelled ├▶ cancelled               └▶ rejected    └──────────────────▶ revoked
    └▶ failed    └▶ failed
```

| From | To | When |
| --- | --- | --- |
| `requested` | `launched` | The provider returned `launched`, or returned `purchased` (both states are written, in order). |
| `requested` | `cancelled`, `failed` | The provider returned that outcome synchronously; the store UI never produced a purchase. |
| `launched` | `pending` | The store reported a purchase in state `pending` (for example deferred payment). |
| `launched`, `pending` | `purchased` | The store reported state `purchased`. |
| `launched`, `pending` | `cancelled`, `failed` | A `purchaseError` event for this attempt. |
| `purchased` | `verifying` | The verify request was saved and sent. |
| `verifying` | `granted` | The backend returned a ledger entry (new or already processed). |
| `verifying` | `pending` | The backend returned `pending`, for example a server-push store whose fulfillment has not arrived. |
| `pending` | `verifying` | The next reconcile resends the same saved request; a restore pending at the [holder limit](#restore-sharing) waits for the player's next Restore Purchases. |
| `verifying` | `rejected` | The backend returned a definitive non-grant. |
| `granted` | `finishing` | The finish owner is `client`, `host`, or `server`. For `server` this means waiting for the backend to report `finalization: 'completed'`. |
| `granted` | `finished` | The finish owner is `none`. |
| `finishing` | `finished` | The finish call succeeded, or the backend reported finalization completed. |
| `finished`, `granted`, `finishing` | `revoked` | The backend ledger holds a revocation entry for the grant. |

Rules:

- Each transition is its own journal revision, written with the existing
  compare-and-replace (`MonetizationOperationStore.replace`), so a crash
  between two writes resumes from the last recorded state.
- A transport failure while `verifying` or `finishing` keeps the state and
  is retried by the next reconcile. It is never a terminal state.
- Terminal states are `finished`, `cancelled`, `failed`, `rejected`, and
  `revoked`. Terminal records stay addressable by key for duplicate
  protection and are excluded from `listRecoverable`.
- Only `granted`, `finishing`, and `finished` may unlock content, and only
  because the ledger says so.
- The journal never reopens purchase UI. A record left in `launched` with no
  matching store purchase stays visible for support reconciliation, as it does
  today.

The existing summary statuses map onto these states: `granted` covers
`granted`, `finishing`, and `finished`; `pending` covers `launched`, `pending`,
`purchased`, and `verifying`; the other statuses keep their names.

## Reconciler {#reconciler}

One reconciler in the `@mpgd/game-services` client replaces
`recoverOwnedPlayPurchases`, `recoverStoreKitPurchases`, the Microsoft Store
recovery records, and the Apps in Toss pending-order pass.

Triggers: runtime start, app resume, every `purchaseUpdated` event, a
manual `restorePurchases`, and the end of every `requestPurchase` call.

One pass:

1. On start, subscribe to the provider, then read `getAvailablePurchases`
   when `lifecycle.availablePurchases` is declared. Always read after
   subscribing, so an event that arrived before the listener is found either
   way. A provider without `lifecycle.events` is polled instead: every pass
   reads `getAvailablePurchases`.
2. Match every reported purchase to a journal record, in this order: a record
   with the same `store` and `transactionId`; otherwise the single open
   (`launched` or `pending`) record for the same player, store, and logical
   product; otherwise create a new record under a
   [derived key](#idempotency-keys), starting at the purchase's state.
3. For records in `purchased` or `verifying`, and `pending` records that
   already hold a saved verify request (server-side pending), send the saved
   request with the record's key. Build and save the request first if a
   `purchased` record has none. A `pending` record without a saved request is
   waiting on the store and is never sent.
4. For `granted` and `finishing` records, act on `lifecycle.finish`: call
   `finishTransaction` for `client` and `host`; resend the verify request to
   read finalization for `server`; mark `finished` for `none`. A `client`
   finish of a record that was already `finishing` before the call (an
   earlier attempt or session) carries `retry: true` when the provider
   declares `acceptsFinishRetry`; the first never does.
   A `finished`
   consumable a `client` store reports again (a store lists a consumable only
   while it is unfinished) is finished again with the record's ledger entry,
   once per session; it is never verified again and the record is not
   rewritten.
5. For records whose grant is still within the journal retention window, ask
   the backend for ledger status and move reversed grants to `revoked`.

The runtime serializes purchases per player, store, and logical product: a
second `requestPurchase` while a record for the same product is `launched` or
`pending` fails with `IN_PROGRESS`. That keeps the match in step 2
unambiguous.

### Idempotency keys {#idempotency-keys}

A game-initiated purchase keeps the game's key, unchanged from the current
rule: one key per player, target, and logical product attempt, never
regenerated on retry.

A purchase discovered without a journal record gets a key derived from the
purchase alone, so every runtime derives the same key:

- Reference rule for new stores: `store:<storeId>:<transactionId>`, with each
  component percent-encoded (`encodeURIComponent`) so the key is injective:
  store `a:b` with transaction `c` and store `a` with transaction `b:c` derive
  different keys.
- Existing stores keep their current forms so ledgers written by v1 still
  deduplicate: `play-token-sha256:<hex>` for `google-play` (one shared helper
  replaces the two copies), and `apps-in-toss:purchase:<orderId>` for
  `apps-in-toss`, with the order id percent-encoded as the v1
  `createAppsInTossPurchaseIdempotencyKey` helper does.

When a game key and a derived key ever reach the backend for the same
purchase, the existing platform-evidence unique index
(`EVIDENCE_ALREADY_PROCESSED`) remains the backstop. One exception reports
instead of refusing: the same player's consumable of a `client`-finish store
(the App Store), asked again under another key once the client's journal has
dropped the finished record while the store still lists the transaction, is
answered with the recorded grant (`verified`, `alreadyProcessed: true`, the
same ledger entry) so the client can finish it; nothing new is granted.

The journal stores a record under `[target, kind, idempotencyKey]`
(`createCommercePurchaseOperationKey`), one key for every player of the
install, while the backend keys a grant by player and idempotency key. A
derived key is therefore the same for two players who see the same store
purchase on one install, the case of a logout followed by the next guest's
Restore Purchases. The rules:

- A key another player's record holds is refused, as before, for a game key,
  for a discovered consumable, subscription, or product of unknown kind, and
  on every start, resume, and event pass (unless that record is another
  account's purchase, below): one player's purchase is never
  matched to, sent for, or replayed as another's, and a purchase a normal
  read lists for the earlier player (Google Play lists an unacknowledged one
  whoever is signed in) is never shared without the player asking.
- On the player's Restore Purchases pass, a discovered **durable** whose
  derived key another player's record holds is this player's own restore. It
  is journaled under the player-scoped key
  `[target, kind, idempotencyKey, playerId]` and sent with this player's id
  and the same derived idempotency key; the backend's
  [restore sharing](#restore-sharing) decides it. Lookups read the shared
  key first and the player-scoped key only where such a record can be: for a
  discovered durable whose shared key is free or (on Restore Purchases)
  another player's, and in `reconciler.read()` when another player's record
  holds the shared key. Game keys and consumables never touch it (except
  under a key left by another account's purchase, below), and
  `reconciler.read()` refuses any other key another player's record holds.
- A key another player's record holds as [another account's
  purchase](#another-account) (parked, or a terminal `rejected` with a binding
  mismatch reason written before that answer) is not that player's: any
  other player of the install, for any kind and on any pass, journals the
  purchase under its own player-scoped key and sends it with its own id. The
  backend decides whose it is; the parked record is never rewritten.
- Nothing is migrated. A journal written before the player-scoped key keeps
  every record under the shared key, where each player still finds its own;
  only a new restore that meets another player's record takes the
  player-scoped key, and the transaction index (`findByTransaction`, by
  player) finds it there on later passes.

## Server: commerce service protocol {#server}

The verify, ledger, finalizer, and fulfillment endpoints stay. v2 changes how
they are routed and what they can record.

### Open store ids {#server-store-ids}

`VerifyPurchaseRequest` gains `store: StoreId`. `target` stays as the
deployment target. `GameServicesStoreTarget` becomes an alias of `StoreId`,
and `assertStoreTarget` checks the store against the registry instead of a
fixed list. For v1 requests without `store`, the server maps `android` to
`google-play`, `ios` to `app-store`, `microsoft-store` to `microsoft-store`,
`ait` to `apps-in-toss`, and `reddit` to `devvit`; every other target
(`verse8`, `oneplay`, a project store that reuses its target name) is its own
store id.

### Evidence registry {#evidence-registry}

The game composes a registry; the kit ships reference entries.

```ts
export interface CommerceEvidenceRegistryEntry {
  readonly schema: string;              // for example 'google-play.product-purchase.v2'
  readonly store: StoreId;
  readonly verifier: GameServicesEvidenceVerifier;
  readonly finalizer?: GameServicesPurchaseGrantFinalizer;
  readonly finish: 'client' | 'server' | 'host' | 'none';
  /** Spend scope of credit lots bought through this store. Default 'title'. */
  readonly creditScope?: 'title' | 'cross-title';
}
```

A request is routed by `evidence.schema`. An unknown schema is rejected with
`EVIDENCE_SCHEMA_UNSUPPORTED`; a schema registered for another store with
`EVIDENCE_SCHEMA_STORE_MISMATCH`. An entry with `finish: 'server'` must
supply a finalizer; registry construction fails otherwise. This replaces
the worker's `switch (target)` and makes the missing Play finalizer a
startup error instead of a silent gap.

Reference entries: `google-play.product-purchase.v2`,
`app-store.signed-transaction.v1` (new: the JWS verified offline, with the
Server API lookup as fallback), `mpgd.microsoft-store.digital-goods.v1`,
`apps-in-toss.iap.callback.v1`, `devvit.payment-order.v1` (the fulfillment
handler's own record), and the client envelopes of the server-push stores
that B6 added, `devvit.order.v1` and `verse8.agent8-event.v1`, which a lookup
verifier routes on.

Server-push stores register a lookup verifier: it answers `granted` when a
ledger entry for the same store and transaction id exists, written by the
host's fulfillment path, and `pending` otherwise. The client therefore sees
server-push purchases through the same verify call as every other store.

### Provider capabilities endpoint {#provider-capabilities}

The backend publishes what it accepts:

```ts
interface CommerceServiceCapabilities {
  readonly commerceProtocolVersion: string;
  readonly stores: readonly {
    readonly store: StoreId;
    readonly schemas: readonly string[];
    readonly finish: 'client' | 'server' | 'host' | 'none';
    readonly purchase: { readonly consumable: boolean; readonly durable: boolean; readonly subscription: boolean };
  }[];
}
```

The client runtime compares this with its provider's capabilities at start.
A store the backend does not accept, or a finish owner that disagrees, sets
the provider's availability to `configuration-required` before any purchase
UI opens.

### Revocation and expiry entries {#ledger-entries}

The ledger stays append-only and gains entry types that reference an earlier
grant: `revoke` (refund, chargeback, voided purchase) and, for
subscriptions, `period` entries carrying `expiresAt`. Store notification
handlers write them: Play voided purchases, App Store Server Notifications V2
refunds, Apps in Toss refunded orders, and Devvit refund orders (already
normalized by `normalizeDevvitRefundOrder` but not consumed today). A new
read, `getPurchaseLedgerStatus({ ledgerEntryIds })`, returns whether each
grant is active or reversed and by which entry. Entitlement reads subtract
reversed grants.

### Restore sharing {#restore-sharing}

A purchase is bound to the player that bought it (Google Play
`obfuscatedAccountId`, StoreKit `appAccountToken`). A guest player lives in
the device's secure store, so a reinstall, a new device, or a second device
on the same store account is another player while the store keeps returning
the non-consumable with the buyer's binding. Under the backend's
`restoreSharing: { mode: 'share', maxHolders }` policy the store's
verification of the restored purchase is the proof of ownership, and the
restoring player gets its own grant of it:

- **Request.** `VerifyPurchaseRequest.intent: 'restore'`. The reconciler sends
  it for a purchase it discovered (no journal record of this install started
  it); a game-started purchase sends none. The intent selects the policy and
  proves nothing.
- **Restore read.** A store's recovery list hides what a reinstall needs:
  Google Play's non-consumables are acknowledged at the first grant, and
  StoreKit's entitlements carry the earlier guest's `appAccountToken`. The
  reconciler's `restorePurchases` trigger, and only it, reads
  `getAvailablePurchases({ restore: true })`: the Play SDK adds every owned
  configured durable from `getPurchases`, acknowledged or not, and the
  StoreKit SDK keeps durables bound to another or no token. Consumables,
  unmapped SKUs, and kind mismatches stay filtered; startup and resume
  passes keep the recovery list, so an acknowledged durable is not resent on
  every launch, and a restore read the store or a bridge host rejects falls
  back to the recovery read. A restore of a purchase this install's journal
  matches (the same transaction or token) sends nothing; one it cannot match
  is sent under its derived key, and the backend answers it idempotently; after
  a logout, a durable the earlier player journaled under that key is
  journaled under the next player's [player-scoped key](#idempotency-keys). On
  StoreKit the shared grant's finish ends on the entitlement StoreKit already
  finished (`unfinished: false`, `{ finished: true }` without a native call).
  A durable still unfinished under another token (the earlier guest crashed
  between its grant and its finish, then the app was reinstalled; or a native
  build omits `unfinished`) is finished with its own token once this
  player's grant is journaled: the reconciler finishes only a `granted` or
  `finishing` record, which the backend's `verified` answer (a new grant,
  `restoredAcrossPlayers`, or `alreadyProcessed`) wrote. Finishing a durable
  takes nothing from any player, because StoreKit keeps it in
  `Transaction.currentEntitlements`, where the earlier guest's own read still
  finds it. The native plugin keeps its token match unchanged and is handed
  the transaction's own token, read from the native list. A consumable or
  subscription of another token, and a transaction bound to no token, are
  never finished.
- **Verifier.** A decision, `{ status: 'restorable', reason, ...verified
  fields }`: every check passed except the account binding, which names
  another player or none; `reason` is the binding mismatch. Reference
  verifiers answer it only for a restore of a non-consumable (the App Store one
  only with the client's verified JWS); for everything else they answer
  [another account's purchase](#another-account), or reject a purchase bound
  to no account. Ad reward claims treat it as a verifier error.
- **Ledger.** The purchase's holders are the grant its verification id names
  and the shared grants at slots 1, 2, ... (evidence id
  `<verification id>#mpgd-holder:<slot>`, under the request's key, listed
  with one indexed prefix read). A share takes the slot after the highest
  one, so concurrent shares collide and the limit holds;
  a player that already holds the purchase gets its grant back; nothing is
  revoked to make room. A purchase whose every holder is revoked is never
  shared again. A store refund, chargeback, or voided purchase of any holder's
  grant revokes every holder.
- **Limit.** At most `maxHolders` (default 5) players hold a purchase at the
  same time; reversed grants and a deleted player's retained record do not
  count.
- **Answers.** `verified` with `restoredAcrossPlayers: true` (retries
  included); [another account's purchase](#another-account) when the policy
  refuses, the request is not a restore, or the product is not a
  non-consumable; `rejected` `LEDGER_GRANT_REVERSED` for
  a purchase a store refund, chargeback, or voided purchase ended (a share
  written while that refund fans out is revoked right after its write; an
  `admin` entry ends one holder only); `pending` `PURCHASE_HOLDER_LIMIT_REACHED` at the
  limit; `pending` `PURCHASE_HOLDER_CONFLICT` after repeated lost races. The
  reconciler resends a restore pending at the limit only on the player's next
  Restore Purchases (a holder may have been freed since); start, resume, and
  event passes leave it, since nothing they observe frees a holder. Every other
  backend-pending answer is resent by the next reconcile as before.
- **Never shared.** Consumables and subscriptions.

### Another account's purchase {#another-account}

A verify can reach the backend with one player's session for a purchase the
store binds to another player: the client could not read its binding, a game
wraps the verifiers, a client predates the reconciler's foreign-binding skip,
or a race. The purchase is valid; it is just not this player's, and its own
account can still recover it. Ending it for good on this install would make
the store transaction unrecoverable there: the record's derived key is the
same for every player of the install, so a terminal record would refuse the
owner's own recovery.

- **Verifier.** `{ status: 'rejected', reason, anotherAccount: true }` once
  every other check passed and the binding names another account (Google
  Play `GOOGLE_PLAY_ACCOUNT_MISMATCH` or `GOOGLE_PLAY_PROFILE_MISMATCH`, App
  Store `APP_STORE_ACCOUNT_TOKEN_MISMATCH`; the App Store verifier runs the
  other checks again without the token, so a revoked transaction is still
  refused). A purchase bound to no account (a promo code, a build that set no
  binding) is no account's and stays `rejected`:
  `GOOGLE_PLAY_ACCOUNT_ID_MISSING`, `GOOGLE_PLAY_PROFILE_ID_MISSING`,
  `APP_STORE_ACCOUNT_TOKEN_MISSING`, and on a backend that binds nobody
  `GOOGLE_PLAY_ACCOUNT_BINDING_UNEXPECTED`. A restore of a non-consumable stays
  `restorable` as above, bound to no account included; when no share covers
  it, it gets this answer too.
- **Backend.** Nothing is granted or recorded, and the answer is a retryable
  error, never a receipt: HTTP 409 `{ error:
  'PURCHASE_BOUND_TO_ANOTHER_ACCOUNT', reason }`, the oRPC error code
  `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT` (status 409, `data.reason`), and in
  process `GameServicesPurchaseBoundToAnotherAccountError` (its message starts
  with the code). Analytics tracks it as `purchase_pending`.
- **Why an error.** Released clients end every non-pending receipt as
  `rejected`, and journal a `pending` one as an open record that refuses new
  purchases of the product with `IN_PROGRESS` for as long as it waits; both
  would read an unknown `disposition` as `rejected`. Every client already keeps
  a record in `verifying` on a transport error and resends it on the next
  reconcile, which is the right answer for the purchase's account. They keep
  resending it on those passes, which costs one store read per pass on the
  backend; nothing else bounds it for them.
- **Reconciler.** The answer, or a `rejected` receipt whose reason is one of
  the three binding mismatches (a backend or game server from before it),
  parks the record: it stays `verifying` with `anotherAccount: { reason,
  reportedAt }`, is never sent again by start, resume, or event passes, is not
  among the player's recoverable records (so neither recovery summaries nor
  Restore Purchases report it), and `reconciler.read()` and the purchase
  result summarize it as `rejected` for that player. Only the player's Restore
  Purchases, when the store reports the purchase again, sends it once more,
  with the evidence the store reports then (a policy or binding may have
  changed; a saved signed transaction may have expired). The journal keeps
  it as an open record; a journal's retention does not drop it.
  Its shared key no longer refuses another player of the install (below).

| Server answer | Client 0.27-0.31 | This client |
| --- | --- | --- |
| HTTP 409 / oRPC `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT` (this backend) | transport failure: `verifying`, resent on every start, resume, and event pass after the retry interval; purchases of the product stay open | parked |
| `rejected` with a binding mismatch reason (an older backend, a game server mapping every refusal to `rejected`) | `rejected`, terminal; the shared key refuses the owner on the install | parked |
| `rejected` with any other reason | `rejected` | `rejected` |

## Credit wallet {#credit-wallet}

D-02 frames the first recurring product as a credit-funded membership and
puts credit packs first on native targets. Commerce v2 therefore has two
layers.

**Store layer.** Play Billing, StoreKit, and host stores sell credit packs as
consumables. A pack's catalog grant is
`{ type: 'currency', currency: '<wallet currency>', amount }`. When the ledger
grants it, the wallet owner credits a lot whose `lotId` is the
`ledgerEntryId`, so a replayed grant cannot create a second lot.

**Wallet layer.** Spending credits is itself a commerce provider. The kit
defines the client interface and a provider factory; the consuming project
implements the client against its wallet service.

```ts
export interface CreditWalletClient {
  readonly store: StoreId;              // chosen by the project
  listOffers(input: { readonly titleId: string }): Promise<readonly CreditOffer[]>;
  spend(input: CreditSpendInput): Promise<CreditSpendResult>;
  listUnredeemed(input: { readonly titleId: string }): Promise<readonly CreditEntitlement[]>;
  redeem(input: { readonly entitlementId: string; readonly ledgerEntryId: string }): Promise<{ readonly redeemed: boolean }>;
  getBalance(input: { readonly titleId: string }): Promise<CreditBalance>;
  getActiveSubscriptions?(input: { readonly titleId: string }): Promise<readonly ActiveSubscription[]>;
  subscribe?(listener: (event: CommerceEvent) => void, input?: { readonly titleId?: string }): () => void;
}

export function createCreditCommerceProvider(
  client: CreditWalletClient,
  options: { readonly titleId: string; readonly billingAuthority: CommerceBillingAuthority },
): CommerceProvider;
```

The provider maps `fetchProducts` to `listOffers`, `requestPurchase` to
`spend` (outcome `purchased`, evidence `adapter-settled`),
`getAvailablePurchases` to `listUnredeemed`, and finishing to a server-side
`redeem`.

B7 ships the contract as `@mpgd/platform/commerce-wallet`
([Credit wallet commerce](../../CREDIT_WALLET_COMMERCE.md)): the provider
answers a spend with evidence `credit-wallet.spend.v1` carrying the debits and
the wallet's entitlement id and no `settlement` pointer (the backend ledger
entry exists only once that evidence is verified), `finishTransaction`
refuses to redeem without the ledger entry id of the grant, `restorePurchases`
re-reads unredeemed entitlements as `purchaseUpdated` events, a `spend` of a
membership offer starts the membership with the spend key as its subscription
id, the wallet prices the spend (a `purchased` answer requires debits that add
up to the offer price), and the client's `getActiveSubscriptions` serves the
provider's. The lot and membership rules below are exported as pure
functions, and `createInMemoryCreditWallet` is the reference wallet the
conformance runner's wallet now wraps. The wallet service itself stays in the
consuming project.

### Credit lots {#credit-lots}

The wallet contract records where every lot came from:

```ts
export interface CreditLot {
  readonly lotId: string;               // = ledgerEntryId of the granting purchase
  readonly currency: string;
  readonly amount: number;
  readonly remaining: number;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly origin: {
    readonly channel: 'store' | 'off-store' | 'promotion';
    readonly store: StoreId;
    readonly titleId: string;
  };
  readonly spendScope: { readonly kind: 'title'; readonly titleId: string } | { readonly kind: 'cross-title' };
}
```

- `spendScope` is derived, never supplied by the caller. A lot bought through a
  store is `title`-scoped to its purchasing title. Only `off-store` lots are
  `cross-title`. The registry's `creditScope` decides which stores count as
  off-store; it defaults to `title`, and the kit's reference stores keep that
  default. Google Play and App Store entries cannot be set to `cross-title`.
  A project may mark another store `cross-title` only after its own policy
  review.
- Promotion lots declare their scope explicitly when issued.
- A spend in a title may use that title's lots and `cross-title` lots. It
  consumes eligible lots in this order: earliest `expiresAt` first (lots
  without expiry last), then `title`-scoped before `cross-title`, then oldest
  `createdAt`, then `lotId`. A spend that eligible lots cannot cover fails
  with `INSUFFICIENT_BALANCE` and debits nothing.
- Spends are idempotent by key: a repeated key returns the original debits
  with `alreadyProcessed: true`. The reference wallet rejects a key reused
  for a different spend and reserves the `membership:` prefix for scheduled
  debits.

### Billing authority and memberships {#billing-authority}

```ts
export type CommerceBillingAuthority = 'store' | 'host';
```

Each target resolves a billing authority from its release profile.
`google-play` and `app-store` are always `store`. `web` and `web-preview`
default to `host`. Every other profile defaults to `store`; a project may set
`host` for one of them after its own policy review. The target-config
validator rejects `host` for `google-play` and `app-store`
(`resolveCommerceBillingAuthority(profile, override?)` in
`@mpgd/platform/commerce-wallet`; the override is
`TargetReleaseConfig.billingAuthority`, B7).

A credit-funded membership is a `subscription`-kind product priced in a
wallet currency with a period. It is offered only where the billing
authority is `host`:

- Where the authority is `store`, the wallet provider declares
  `purchase.subscription: false`, `fetchProducts` omits memberships, and
  `requestPurchase` for one fails with `ITEM_UNAVAILABLE`. Credit packs stay
  available.
- A membership's renewal is a scheduled debit with the key
  `membership:<subscriptionId>:<periodIndex>`, so a repeated scheduler tick
  cannot charge twice.
- A `platform`-scoped membership debits only `cross-title` lots; a
  `title`-scoped membership debits that title's lots and `cross-title` lots,
  in the spend order above.
- When eligible balance cannot cover a renewal, the membership lapses at the
  end of the paid period with reason `INSUFFICIENT_BALANCE`. A renewal judges
  lot eligibility at the boundary of the period it pays for, not at the time
  the scheduler runs, and period `n` ends at `startedAt + (n + 1) × period`
  with calendar months clamped to the month length.
- Membership authority is `server-push`: the wallet service decides
  renewal, expiry, and lapse alone, and the client learns them through
  `subscriptionUpdated` events and `getActiveSubscriptions`.

## Subscriptions {#subscriptions}

The contract carries subscription fields from the first release so a later
store provider is additive:

```ts
export interface ActiveSubscription {
  readonly store: StoreId;
  readonly logicalId: LogicalProductId;
  readonly subscriptionId: string;
  readonly periodIndex: number;
  readonly state: 'active' | 'lapsed' | 'revoked';
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly autoRenew: boolean;
}
```

Lifecycle events are `subscriptionStarted`, `subscriptionRenewed`,
`subscriptionLapsed`, and `subscriptionRevoked`, each with the stable event id
`<subscriptionId>:<periodIndex>:<type>` so redelivery is idempotent. On the
ledger, each paid period is a `period` entry with `expiresAt`. No reference
store provider sets `purchase.subscription`, and the Play, App Store, and
Apps in Toss verifiers keep rejecting subscription products until D-02 is
reopened.

## Catalog currencies {#catalog-currencies}

`ProductGrant.currency` and `AdReward.currency` become strings validated
against a currency list the catalog declares:

```json
{ "version": "2026-10-05", "currencies": ["coin", "gem", "credits"], "products": [] }
```

When `currencies` is absent the list defaults to `["coin", "gem"]`, so
existing catalogs stay valid. `validate:catalog` rejects a grant whose
currency is not declared, and a wallet provider rejects a currency that is
not in the catalog. The kit adds no wallet currency literal.

## Bridge and versioning {#bridge}

- `@mpgd/platform` exports `commerceProtocolVersion = '2.0.0-draft.1'` until
  the contract is released as `2.0.0`.
- A4 landed the bridge side in `@mpgd/bridge`: `BridgeMethod` includes
  `commerce.v2.getCapabilities`, `commerce.v2.fetchProducts`,
  `commerce.v2.requestPurchase`, `commerce.v2.getAvailablePurchases`,
  `commerce.v2.finishTransaction`, and `commerce.v2.restorePurchases`
  (`bridgeCommerceV2Methods`, kept equal to `commerceBridgeMethods` from
  `@mpgd/platform/commerce` by a type check and a test), and the event side
  exports `BridgeEvent` (the `CommerceEventEnvelope`
  `{ protocol: 'mpgd.commerce.v2', sequence, event }` with a per-session
  sequence number), `assertBridgeEvent`, and the `BridgeEventSource`
  interface (`subscribe(listener): () => void`) that transports may
  implement; `@mpgd/adapter-capacitor` declares the matching optional
  `NativeBridge.subscribe`. No transport implements v2 yet: a v2 method that
  reaches the Cloudflare Pages stub, the Devvit server bridge, or the Devvit
  and Apps in Toss sandbox bridges answers the non-retryable bridge error
  `COMMERCE_V2_UNAVAILABLE` (`createCommerceV2UnavailableBridgeError`), and
  the Capacitor provider registry rejects a v1 provider that declares a v2
  method. The B-phase PRs wire providers behind these methods.
- B1 landed the first transport in `@mpgd/adapter-capacitor` (status: draft,
  no store plugin adapted yet): `StoreSdk` is the in-process surface a store
  plugin exposes, `createStoreCommerceProvider` turns it into a
  `CommerceProvider`, and `createCommerceServiceProvider` registers that
  provider so the registry serves the six `commerce.v2.*` methods through
  `createCommerceProviderBridge` (payloads and results validated with the A2
  asserts, events in the envelope with a per-bridge sequence) and the four v1
  `commerce.*` methods through `toCommerceAdapter`. The gateway exposes the
  provider as the transitional `PlatformGateway.commerceV2` and derives
  `nativeIap` and `subscriptionIap` from its `commerce` capability block,
  read once per snapshot with the registry's three-second bound (a stalled or
  invalid provider yields a degraded block, never a rejected read). A
  `launched` purchase keeps the gateway's external activity open until the
  product's purchase event, a two-minute safety timeout, or dispose. A thrown
  failure crosses the bridge as `{ code, message, retryable }`; a `cancelled`
  or `failed` purchase result keeps its `storeCode`. The contract types that
  `PlatformGateway` references live in the typia-free
  `@mpgd/platform` module `commerce-contract` (re-exported by
  `@mpgd/platform/commerce`), so headless consumers can type-check the main
  entry without typia's declarations.
- Payloads are validated with typia on both sides. A2 generates JSON Schemas
  for the bridge payloads and the vector format into
  `docs/specs/commerce/schemas/`, and `validate:commerce-alignment` checks that
  the protocol constant, the vectors, the schemas, and each provider's
  declared version agree.
- The committed schemas live in
  [`docs/specs/commerce/schemas/`](https://github.com/imjlk/mpgd-kit/tree/main/docs/specs/commerce/schemas)
  (`pnpm generate:commerce-schemas` rewrites them from
  `@mpgd/platform/commerce`), and `pnpm validate:commerce-alignment` runs in
  the root `check` chain; the module's helpers are tested against every vector
  file in `packages/platform/src/commerce-vectors.test.ts`.
- C4 removed the four v1 bridge methods (`commerce.getProducts`,
  `commerce.purchase`, `commerce.restore`, `commerce.getEntitlements`) and
  renamed the transitional `PlatformGateway.commerceV2` to
  `PlatformGateway.commerce`. The wire names (`commerce.v2.*`), the protocol
  constant, and `COMMERCE_V2_UNAVAILABLE` keep the protocol's `v2`: they name
  the protocol version, not a gateway field. `validate:commerce-alignment` is a
  hard gate (it throws, never warns) on any drift between the contract types,
  the generated schemas and vectors, the bridge method lists, and the provider
  capability blocks; see [Alignment gate](#alignment-gate).

### Alignment gate {#alignment-gate}

`pnpm validate:commerce-alignment` runs in the root `check` chain and fails the
build when any of these drift apart:

- **Protocol, vectors, schemas.** `commerceProtocolVersion` equals every
  vector's `protocol` and every schema's version, each vector's name equals its
  file name, and the committed schemas equal what `generate:commerce-schemas`
  renders from the contract types, byte for byte (a missing, changed, or stale
  schema file fails).
- **Bridge method lists.** `commerceBridgeMethods` (platform, with a compile
  time check that it names every `CommerceBridgeMethods` key),
  `bridgeCommerceV2Methods` and the `BridgeMethod` union (bridge), the RFC
  bridge section, and the published `CommerceBridge*Payload`/`Result` schemas
  name the same six methods. A non-test source under `packages/`, `adapters/`,
  `native-plugins/`, `apps/`, or `examples/` that names two or more
  `commerce.v2.*` methods must name all six, and no source may name a removed
  v1 `commerce.*` method.
- **Provider capability blocks.** Every reference provider (Google Play, App
  Store, Microsoft Store, Apps in Toss, Devvit, Verse8, ONE play, and the
  wallet) exposes a pure factory for its declared block. For each readiness
  state the block passes `assertCommerceCapabilities`, only `availability`
  changes with the state, and the block equals its row of the profile table
  under [Capabilities](#capabilities) (`purchase.consumable`, `durable`,
  `subscription`, `lifecycle.availablePurchases` against the "available
  source" column being other than `none`, `pending`, `finish`,
  `authority.evidence`, `accountBinding`). A profile row without a checked provider, or one that does
  not parse, fails.

## Conformance vectors {#vectors}

Vectors live in
[`docs/specs/commerce/vectors/`](https://github.com/imjlk/mpgd-kit/tree/main/docs/specs/commerce/vectors).
A3 adds the runner to `@mpgd/platform` with an in-memory reference provider,
fake store, fake backend, and in-memory journal. Every provider in B runs the
same files against its own fake SDK.

The runner ships as `@mpgd/platform/commerce-conformance`:
`runCommerceConformanceVector(vector, options?)` returns
`{ vector, status, passed, failures: [{ path, expected, actual }], reason?,
adaptive? }` (`status` is `passed`, `failed`, or `skipped`; a skipped vector
did not run, has `passed: false`, no failures, and a `reason`) and
`runCommerceConformanceVectors(vectors, options?)` runs a list. The package
test suite (`pnpm --filter @mpgd/platform test`, source tests in
`packages/platform/src/commerce-conformance.test.ts` and the dist smoke in
`packages/platform/test/commerce-conformance-dist-import.mjs`) loads every
file in the vectors directory and requires all fourteen to pass with the
reference pieces: `createCommerceConformanceClock`,
`createCommerceConformanceStore` (fake store plus its `CommerceProvider`),
`createCommerceConformanceBackend` (scripted verify decisions and the ledger),
`createCommerceConformanceJournal` (compare-and-replace journal that keeps
every revision), `createCommerceConformanceRuntime` (the reference
reconciler), and `createCommerceConformanceWallet` with
`createCommerceConformanceWalletProvider` for the `fixture.credit-wallet`
profiles. A B-phase provider runs the same vectors by passing
`options.createProvider(context)`, which receives the vector, profile,
catalog, clock, backend, and journal and returns a harness
`{ provider, store?, wallet? }` whose `store` actor translates the `store`
steps (`complete`, `update`, `error`, `queueRequest`, `queueFinish`) into its
own fake SDK and reports `purchaseUiOpened` and `finishCalls`; the shared
runtime, backend, journal, and matcher stay the same. The fakes are exported
individually so such tests can compose them.

### Adaptive vectors {#adaptive-vectors}

A vector's `profile` fixes one finish owner and one evidence authority, and
its `expect` block is written for that profile; a real provider declares its
own. The lifecycle vectors whose scenario does not depend on the owner set
`profile.adaptive: true` (`purchase-client-finish`, `purchase-server-finish`,
`purchase-host-finish`, `purchase-pending-then-purchased`,
`restart-before-verify`, `event-before-listener`, `finish-failure-retry`,
`revoked-after-grant`, `cancelled-and-failed`; `server-push-settlement`,
`adapter-settled`, and the three wallet vectors stay profile-specific). A
provider gets adaptive behaviour only by running
`runCommerceConformanceVectors` (or `runCommerceConformanceVector`) with
`options.createProvider`; the reference harness ignores the flag, so the
committed fixture profiles keep passing unchanged. For such a run the runner
reads the harness provider's `getCapabilities()` and `store`, replays the
vector's steps against the reference fake store configured with exactly
those capabilities and that store id, and matches the provider under test
against the observable state of that reference run instead of the fixture's
`expect`. The result carries the derivation as `adaptive: { store, finish,
evidence, expect }`. Only `journal`, `finishCalls`, `verifyRequests`, and
`available` are derived, and only when the fixture asserts them; `ledger`,
`entitlements`, `purchaseUiOpened`, and step `returns` are owner-independent
and keep the fixture's values. What the reference run yields per declared
`lifecycle.finish`:

| Owner | `journal` tail after `granted` | `finishCalls` | `verifyRequests` | `available` after a completed finish |
| --- | --- | --- | --- | --- |
| `client` | `finishing`, `finished` | one per grant, `by: 'client'` | one per grant | `[]` |
| `host` | `finishing`, `finished` | one per grant, `by: 'host'` | one per grant | `[]` |
| `server` | `finishing`, `finished` | `[]` | one per grant, plus one finalization re-read unless the grant already reported `finalization: 'completed'` | `[]` |
| `none` | `finished` | `[]` | one per grant | what the store still lists |

The `server` row encodes what the reference reconciler does: a `finishing`
record whose grant did not report `finalization: 'completed'` resends the
saved verify request to read finalization. When the vector was written for a
non-server fixture, the fake backend answers that re-read itself
(`finalizeOnReread`): a verify request that replays a key the backend already
granted is answered `{ status: 'granted', ledgerEntryId, finalization:
'completed', alreadyProcessed: true }` from the backend's own grant state and
invokes the harness `finalize` hook, consuming no queued decision, so a
decision scripted for another record is never taken by the re-read; a vector
written for a server fixture scripts its own finalization decisions and the
backend consumes them as written. Derived journal keys and verify requests
carry the provider's store id in place of the fixture's (`store:app-store:tx-1`
for a derived key; only the encoded `store:<store>:` prefix is replaced, so a
transaction id or game key that happens to contain the fixture store id is
left alone), so a provider need not rewrite the files. A store whose `token`
is not the fixture's, for example a host-order store that reports the
transaction id, declares `tokenOf(purchase)` on its store actor; the runner
replays the scripted purchases with that token into the reference store
(`withStoreTokens`), so the derived `verifyRequests` carry the token the
provider reports. `available` is what
the reference store still lists (pending included) once the run is idle: empty
after a completed finish for `client`, `host`, and `server` owners, since the
client, the host, or the backend finalizer removed the purchase, and still
listed for a fixture that leaves a finish failed without retry. A provider
whose declared owner disagrees with its behaviour fails on these paths:
declaring `server` while the SDK finishes on its own fails
`finishCalls.length`, declaring `client` while never finishing fails
`journal.<key>.length`, `finishCalls.length`, and `available.length`, and
declaring `server` without consuming on finalization fails
`available.length`. A `createProvider` that throws is a `failed` result at
path `harness`, and a `getCapabilities()` that rejects one at path
`capabilities`; the runner never rejects.

Skip and duplicate rules (`commerceConformanceAdaptiveSkipReason(vector,
capabilities, vectors?)`): an adaptive vector is reported `skipped` with a
`reason` instead of failing when a `game.requestPurchase` names a product
whose catalog `kind` the provider does not sell (`purchase.<kind>` false) or
a `quantity` above one without `purchase.quantity`, when a store-side
`pending` purchase needs `lifecycle.pending` the provider does not declare,
when a store `error` event needs `lifecycle.events` it does not declare, when
a store `complete` or `update` cannot be polled (see below), or when a
`queueFinish` script needs a `client` or `host` owner and the provider
declares `server` or `none` (so `finish-failure-retry` runs only for client
and host owners). A provider without `lifecycle.events` is polled: the
reference reconciler reads `getAvailablePurchases` on every pass, and the
reference fake store emits nothing for such a profile, so a store completion
reaches the journal at the next `runtime.reconcile` or `runtime.start`. A
completion is therefore applicable only when such a step follows it with
nothing in between but `backend.queueVerify` and `clock.set`; a `runtime.stop`
first, no runtime step at all, or an intervening step that would have
observed the event-driven grant or finish (another `store` script, a ledger
`push` or `revoke`) makes the scenario timing-bound and skips it with the
intervening step named. Within one `runCommerceConformanceVectors` call only
one member of the `purchase-<owner>-finish` family runs: the member named
after the provider's owner when the set holds it, otherwise the first by name
(`purchase-client-finish` for `none`); the others are reported `skipped:
duplicate of <vector> for finish=<owner>`. The family is fixed once per call;
a single `runCommerceConformanceVector` call never deduplicates. The
derivation is also refused as a skip when the reference run under the
provider's capabilities does not end every journal key in the fixture's
terminal state, since the scenario then depends on a capability the provider
lacks. Vectors without the flag run against a caller-supplied provider
exactly as before, with their fixture expectations.

A vector is one JSON file:

| Field | Meaning |
| --- | --- |
| `vector` | Name; equals the file name without `.json`. |
| `protocol` | Commerce protocol version the vector targets. |
| `profile` | Store id plus the `purchase`, `lifecycle`, and `authority` capability blocks under test. Omitted blocks default to all supported and `available`. `adaptive: true` marks an owner-independent scenario (see [Adaptive vectors](#adaptive-vectors)). |
| `catalog` | Logical products with `kind` and `storeSku`, plus `membership` terms for memberships. |
| `wallet` | Wallet vectors only: declared currencies and the target's billing authority. |
| `steps` | Ordered actions. |
| `expect` | The final observable state. |

Actors and actions:

| Actor | Action | Effect |
| --- | --- | --- |
| `runtime` | `start` | Create the runtime: subscribe, read available purchases, reconcile. |
| `runtime` | `stop` | Drop all in-memory state; keep the journal, the store, and the ledger. |
| `runtime` | `reconcile` | Run one reconcile pass. |
| `game` | `requestPurchase`, `fetchProducts` | Call the runtime; `returns` is the expected result. |
| `store` | `complete`, `update` | Report a purchase or change its state; emitted as an event if a listener exists, buffered otherwise, and listed as available until finished. |
| `store` | `error` | Emit `purchaseError` for an attempt. |
| `store` | `queueRequest`, `queueFinish` | Script the next `requestPurchase` or `finishTransaction` answer. |
| `backend` | `queueVerify` | Script the next verify decision: `status`, `ledgerEntryId`, `finalization`, `alreadyProcessed`. |
| `backend` | `push`, `revoke` | Write a server-push grant or a revocation entry to the ledger. |
| `wallet` | `creditFromGrant`, `spend`, `renewDue` | Credit a lot from a ledger grant, spend, or run the renewal scheduler. |
| `clock` | `set` | Set the current time. |

After each step the runner lets the runtime run until it is idle.
The fake store defaults to `launched` for an unqueued `requestPurchase` and
`{ finished: true }` for an unqueued `finishTransaction`; available-purchase
and ledger-status reads derive from the fake store and ledger state. A
`queueRequest` or `queueFinish` entry overrides the next such answer. Verify
responses must be queued with `queueVerify`; no grant is inferred from a
store callback. Wallet actions execute the declared in-memory wallet rules.
Other unscripted operations fail the vector.

Step inputs are fixture shorthand, not complete wire payloads. The runner
fills the profile's `store`, quantity `1`, request source `shop`, and fake
evidence/account binding from the fixture context before calling the typed
provider. `returns` and `expect` match the listed fields; omitted fields are
not assertions. Store `queueRequest` errors and `error` actions carry explicit
normalized `code` and `retryable`; the runner never guesses an error class
from a fixture `storeCode`. `expect` may assert `journal` (the
full state sequence per key), `verifyRequests`, `ledger`, `finishCalls`,
`available`, `entitlements`, `lots`, `balances`, `debits`, `events`,
`activeSubscriptions`, and `purchaseUiOpened`.

| Vector | Covers |
| --- | --- |
| `purchase-client-finish` | Normal client-token purchase finished by the client |
| `purchase-server-finish` | Finalization owned by the backend; the client never calls finish |
| `purchase-host-finish` | Host-callback evidence and host completion |
| `purchase-pending-then-purchased` | Store-side pending is never verified until purchased |
| `restart-before-verify` | App stops between store completion and grant; no UI reopened |
| `event-before-listener` | Purchase delivered before any listener; derived key; verified once |
| `finish-failure-retry` | Finish fails after the grant; retried without a second grant |
| `revoked-after-grant` | Ledger revocation reaches the journal; no client-side revoke |
| `cancelled-and-failed` | Synchronous cancel, cancel event, store failure; `storeCode` kept |
| `server-push-settlement` | Pending until the host's fulfillment writes the ledger |
| `adapter-settled` | Adapter settlement still confirmed through the ledger |
| `credit-lot-title-scope` | Lot origin, title scope, spend order, idempotent spend and lot credit |
| `credit-membership-renewal` | Idempotent renewal debits, lapse, platform scope skips store lots |
| `membership-store-billing-target` | No membership where billing authority is `store` |

## Migration and PR plan {#pr-plan}

v1 `CommerceAdapter` stayed through B and C1-C3. A2 added
`toCommerceAdapter(provider)` so a v2 provider served v1 callers, and the
game-services client moved to v2 internally. Templates and games called
game-services and did not change until C3. C4 removed v1 in one major release
(see [Migrating from v1](#migrating-from-v1)). Every PR that changes a
publishable package carries a Sampo changeset. The rows below describe each
PR as it landed; where they mention a v1 wrapper, driver, boolean capability,
or `commerceV2`, C4 removed it.

| PR | Scope | Closes |
| --- | --- | --- |
| A1 | This RFC and the vectors | |
| A2 | `@mpgd/platform` `commerce/` module: types, `CommerceError`, capabilities, state machine, typia validators, JSON Schemas, `validate:commerce-alignment`; catalog currency list | Closed currencies |
| A3 | Conformance runner and in-memory reference provider passing every vector | |
| A4 | Bridge v2 methods, event envelope, and `COMMERCE_V2_UNAVAILABLE` fail-closed answers; `app-store-server` moved into `@mpgd/game-services` (deprecated re-export kept); `createGooglePlayTokenTransactionId` aliases `createGooglePlayTokenPurchaseKey` | Duplicated helper, server code in client package |
| B1 (landed, draft) | `@mpgd/adapter-capacitor`: `StoreSdk` interface, `createStoreCommerceProvider`, registry wiring, v1 wrapper; every store vector passes directly and through the gateway bridge path | |
| B2 (landed, draft) | `@mpgd/capacitor-play-billing`: `createCapacitorPlayBillingStoreSdk` over the plugin (unfinished purchases from `getPurchases` with the `isAcknowledged` flag, `purchaseUpdated` subscription with retained native events, token key or order id as `transactionId`), `createCapacitorPlayBillingCommerceProvider` and the registry entry with the v1 evidence payload; the server-finish vector passes directly and through the gateway, client- and host-finish vectors are listed as not applicable | Unused native events |
| B3 (landed, draft) | `@mpgd/capacitor-storekit`: `createCapacitorStoreKitStoreSdk` and `createCapacitorStoreKitCommerceProvider` over B1's `createStoreCommerceProvider` with the App Store profile, the StoreKit-verified JWS as `token` and as `app-store.signed-transaction.v1` evidence, and the v1 recovery helpers deprecated; the SDK answers only for the configured catalog and the active `appAccountToken` and checks the declared kind before the sheet opens; `@mpgd/game-services/app-store-verifier` verifies that evidence offline through its `signedTransactionVerifier` (authenticity, `APP_STORE_SIGNED_TRANSACTION_ID_MISMATCH` on a foreign id) and then decides the grant on the current status from the Server API by default (`signedTransactionEvidence: { mode: 'offline-only', maxSignedAgeMs }` is the documented opt-in for deployments without Server API access); requests without the evidence keep the Server API lookup | JWS dropped |
| B4 (landed, draft) | `@mpgd/adapter-browser/microsoft-store`: `createMicrosoftStoreCommerceProvider` over the Digital Goods engine shared with the v1 adapter (`transactionId` and `token` are the `purchaseToken`, `settlement` is the authority's ledger entry, `launched` while the authority answer is open, `finish: 'server'`), `withMicrosoftStoreCommerceProvider` wiring `commerceV2`, the v1 wrapper, and the capability block; the `adapter-settled` vector passes directly and through the gateway, every other store vector is listed as not applicable to the profile; `@mpgd/game-services` grants on `findAdapterSettledGrant` (capability block `authority.evidence: 'adapter-settled'` plus `authoritativeGrant`) when `commerceV2` exists and keeps `isAuthoritativeMicrosoftStoreCompletion` (deprecated) for v1-only gateways | Target-name settlement check |
| B5 (landed, draft) | `@mpgd/adapter-ait`: `createAitCommerceProvider` over the host bridge's IAP machinery (one controller shared with the v1 `commerce.*` methods), pending orders as available purchases, `finishTransaction` as the host finish (`completeProductGrant` after the ledger grant, never without a ledger entry id), `restorePurchases` as the pending-order recovery pass, the six `commerce.v2.*` bridge methods and the `commerceV2` event channel on the host bridge, `gateway.commerceV2` and the `commerce` capability block; the host-finish vectors pass directly and through the gateway with the store actor's `tokenOf` (the token is the order id) | |
| B6 (landed, draft) | `@mpgd/adapter-devvit`: `createDevvitCommerceProvider` over the v1 payments client with the `devvit` profile (`finish: 'none'`, `server-push`, `host` binding), a `completed` checkout answered as `purchased` with the order id as `transactionId` and `token` and `devvit.order.v1` evidence, `getAvailablePurchases` as the paid, undelivered orders read through the server bridge, `restorePurchases` as the re-read, and events on an order signal; `createDevvitCommerceV2BridgeHandler` (`@mpgd/adapter-devvit/server`) serves the six `commerce.v2.*` methods over the Devvit `payments` plugin (`PAID` orders, products in Reddit Gold, checkout refused as client-only, finish unsupported) and the Devvit server bridge takes it as its optional `commerce` dependency while failing closed without it, as the sandbox bridge always does; `createDevvitPlatformGateway({ commerce })` exposes `commerceV2` and the capability block. `@mpgd/adapter-verse8`: `createVerse8CommerceProvider` over VXShop with the `verse8` profile (no available list, `finish: 'none'`, `server-push`, `host` binding), `requestPurchase` as `buyItem` answered `launched`, the Agent8 service's new `listPurchases` as the purchase source reported through `restorePurchases` and the dialog-closed signal with `verse8.agent8-event.v1` evidence, and `createVerse8PlatformGateway({ vxShop: { purchases } })` exposing `commerceV2` and the capability block. `server-push-settlement` passes for both directly and through their gateway paths; the adaptive vectors run with finish-none expectations derived for each id. Not yet usable in production before C2: the backend lookup verifiers for `devvit.order.v1` and `verse8.agent8-event.v1` do not exist yet, so a verify request is refused today instead of answering `pending` | Devvit and Verse8 outside `verifyPurchase` (client side; the server lookup is C2) |
| B7 (landed, draft) | `@mpgd/platform/commerce-wallet`: `createCreditCommerceProvider` over a project-owned `CreditWalletClient` (offers as products with memberships omitted under `store` authority, a spend as a `purchased` outcome with `credit-wallet.spend.v1` adapter-settled evidence carrying the debits and the wallet entitlement id and no `settlement` pointer, unredeemed entitlements as available purchases, `finishTransaction` as the redeem that refuses to run without the ledger entry id, `restorePurchases` as the unredeemed re-read, client events through the pre-listener buffer, the RFC capability row with `purchase.subscription` only under `host`); the lot and membership rules as pure functions (`deriveCreditLotSpendScope` with a `creditScope` registry that keeps Google Play and the App Store `title`, `selectEligibleCreditLots`, `compareCreditLotSpendOrder`, `planCreditDebits`, `createMembershipRenewalKey`, `createCreditSubscriptionEventId`); `resolveCommerceBillingAuthority` with `TargetReleaseConfig.billingAuthority` and the target-config validator rejecting `host` on `google-play` and `app-store`; `createInMemoryCreditWallet` as the reference wallet the conformance wallet wraps, so the three wallet vectors pass through the public provider (a lapsed membership cannot be restarted by replaying its period-0 key); `CreditWalletClient.getActiveSubscriptions?` | |
| C1 (landed, draft) | `@mpgd/game-services/commerce-reconciler`: `createCommerceReconciler({ provider, backend, store, playerId, target, deploymentTarget?, products?, now?, onEvent? })` over any `CommerceProvider`, journaling every purchase as one `commerce-purchase` record of the shared `MonetizationOperationStore` through the lifecycle above, one compare-and-replace revision per transition, with the five-step pass as listed (match by store and transaction id, then the single open record for player, store, and product, else a derived key with the `play-token-sha256:` and `apps-in-toss:purchase:` forms kept; saved verify requests resent unchanged; `finishTransaction` for `client` and `host`, a finalization re-read for `server`, `finished` for `none`; reversed grants to `revoked` when the backend offers `getPurchaseLedgerStatus`, which the reference server gains in C2), purchases serialized per product with `IN_PROGRESS`, `OUTCOME_UNKNOWN` and `ALREADY_OWNED` left open, transport failures kept and retried, nothing granted from a provider result (adapter-settled and wallet purchases are verified like the rest). `assertCommerceFinishAllowed` is the finish gate: the v2 StoreKit SDK keeps no allow-list, and the journal revision the backend grant wrote pairs the transaction with its ledger entry id. `createGameServicesClient` purchases through it whenever `gateway.commerceV2` exists (`commerceReconciler`, `operationStore?`; the v1 path stays for gateways without a v2 provider), `createRecoverableMonetizationClient` runs it from `reconcile()`, adds `restorePurchases()`, and keeps `recoverPurchaseResult` as a deprecated wrapper, and `createGameServicesRuntime` wires it. The fourteen vectors pass through the real reconciler via the runner's `createRuntime` hook, and the Play and StoreKit plugins carry smoke tests showing the deprecated v1 drivers and the reconciler reach the same outcomes over their fake SDKs; the drivers themselves are removed in C4 | Four recovery drivers |
| C2 (landed, draft) | `@mpgd/game-services`: `VerifyPurchaseRequest.store?: StoreId` next to the ledger `target`, `GameServicesStoreTarget` as `StoreId` with the request validator accepting any bounded kebab-case id (the closed list stays as the deprecated `GameServicesLegacyStoreTarget` until C4) and `resolveLegacyCommerceStoreId` as the v1 mapping (`android` to `google-play`, `ios` to `app-store`, `ait` to `apps-in-toss`, `reddit` to `devvit`, others themselves); `createCommerceEvidenceRegistry(entries, { unregistered? })` routing by `evidence.schema` with `EVIDENCE_SCHEMA_UNSUPPORTED` and `EVIDENCE_SCHEMA_STORE_MISMATCH` answered before any verifier runs, construction refusing a `finish: 'server'` entry without a finalizer, a schema claimed twice, a store with two finish owners, or two missing-envelope entries per store, finalization routed to the owning entry (the schema the grant recorded, then the request schema, then the store's single finalizing entry), and an optional `unregistered` fallback for a deployment's aggregate v1 verifier; the reference entries for `google-play.product-purchase.v2`, `app-store.signed-transaction.v1` (accepts a missing envelope for the Server API lookup), `mpgd.microsoft-store.digital-goods.v1`, `apps-in-toss.iap.callback.v1`, `devvit.payment-order.v1` (bound through a `DevvitPaymentOrderAuthority` port), and the server-push lookups `devvit.order.v1` and `verse8.agent8-event.v1` over `createCommerceLedgerLookupVerifier`, which answers the new `settled` decision with the grant the host's fulfillment path wrote for the same store and transaction id (checked against the requesting player, product, and target; never written from the client envelope), `pending` before that write, and `rejected` on a mismatch; `createServerPushLedgerGrant`, `createPlatformOrderLedgerGrant`, and `createPlatformOrderVerifyRequest` build the grant those lookups read, and the Verse8 Agent8 service writes it when given a ledger; `createGameServicesBackend({ commerceEvidenceRegistry })` uses the registry for purchases and keeps the v1 single verifier and finalizer without one; `getCommerceCapabilities` (`CommerceServiceCapabilities` in `@mpgd/platform/commerce`, JSON Schema published) derived from the registry over HTTP (`/game-services/purchases/capabilities`) and oRPC (`commerce.getCapabilities`), and `compareCommerceServiceCapabilities` applied by the reconciler at start so a store the backend does not accept or a finish owner that disagrees sets `configuration-required` and refuses `requestPurchase` with `CONFIGURATION_REQUIRED`; append-only `revoke` entries (`EntitlementLedgerRevocation`, `GameServicesStore.recordEntitlementRevocation?` / `findEntitlementRevocations?`, one reversal per grant, replay-safe by notification key) with `revokeEntitlementGrant`, `revokePlatformOrder` for `normalizeDevvitRefundOrder` results, `readPurchaseLedgerStatuses` behind `getPurchaseLedgerStatus` (`/game-services/purchases/ledger-status`, `commerce.getPurchaseLedgerStatus`, so the C1 revocation pass is live), `listActiveEntitlementTransactions` subtracting reversed grants, and the subscription `period` shape as a validator only; the Worker composes its registry from bindings (migration `0006_entitlement_revocations.sql` and the D1 revocation methods, the in-Worker Play boundary over `GAME_SERVICES_GOOGLE_PLAY_PACKAGE_NAME` and `GAME_SERVICES_GOOGLE_PLAY_PUBLISHER_AUTH` or a `GAME_SERVICES_ANDROID_PURCHASE_FINALIZER` service, `GAME_SERVICES_ANDROID_VERIFIER_FINALIZES` for a binding that acknowledges itself, an Android verifier with none of these closing the purchase routes while ads and leaderboards keep serving, `MPGD_COMMERCE_LOOKUP_STORES` for the server-push lookups) and keeps the aggregate verifier as the unregistered fallback with its stores declared and the undeclared ones still served, binds `devvit.payment-order.v1` through `GAME_SERVICES_DEVVIT_PAYMENT_ORDER_AUTHORITY`, and builds its store, registry, and handlers once per `env`; entries declare `targets` (a foreign target is a 400) and `acceptsUnclaimedSchemas`, every entry of a store declares the same purchase profile, ledger status reads are chunked and name their player, and a revoke key reused for another grant is a conflict. App Store Server Notifications and Play voided-purchase intake stay game-owned handlers over `revokeEntitlementGrant` | Closed targets, missing Play finalizer, no revocation |
| C3 (landed, draft) | CLI and templates: the generated game and the private starter wire every store from the catalog's `platformProductIds` (`commerceProducts.ts`): `capacitorAndroid.ts` registers `createCapacitorPlayBillingServiceProvider` and `capacitorIos.ts` registers `createCapacitorStoreKitServiceProvider` for the one-time products with an `android` or `ios` SKU, bound through the reference `commerceAccountBinding.ts` (the hex SHA-256 of `mpgd-commerce-account:<playerId>` as Play's obfuscated account id, the same digest as a version 5 UUID `appAccountToken`; a guest binds nothing), and a shell without the native plugin still runs because both SDKs report Capacitor's `UNIMPLEMENTED` as `configuration-required`; `ait.ts` keeps `commerceV2` from the host bridge's channel while the Apps in Toss wrapper installs `iapProducts` from `extractAitIapProductConfig` (`@mpgd/adapter-ait/iap-config`, `AitIapProductConfig` per `ait` SKU) and still sells nothing without its server hooks, and `aitSandbox.ts` keeps the `ait-sandbox` build-id gate; `reddit.ts` passes `commerce` (`createDevvitCommerceProducts`, `createDevvitWebPaymentsClient` over `purchase()` with `toDevvitCheckoutResult`) and the Devvit server serves `createDevvitCommerceV2BridgeHandler` over `createDevvitCommerceBridgeProducts` (`{ productId, sku }` per `reddit` SKU) only when `devvit.json` sets `permissions.payments` and the catalog names a SKU, so the shipped default keeps failing closed; `verse8.ts` passes `vxShop.purchases` from the game's Agent8 client `listPurchases` (`verse8Agent8Client.ts`, absent by default); `microsoftStore.ts` uses `withMicrosoftStoreCommerceProvider` with the `microsoft-store` consumables; `gameServices.ts` runs the C1 reconciler over `createStorageMonetizationOperationStore` (the reference durable journal over `gateway.storage`: serialized compare-and-swap `replace`, `listRecoverable`, `listGranted`, `findByTransaction`, terminal records bounded by age and count, an unreadable document never replaced) unless the game passes its own `operationStore`, with `commerceProducts` (`createGameServicesRuntime({ commerceProducts })`) from the catalog. `mpgd target init capacitor --providers play-billing,storekit` pins one exact plugin version in the shell and the game (the installed copy, else the CLI's), lets `cap add` or `cap sync` register it, records it in `mpgd.native-shell.json`, replaces only an unwired template gateway with the wired one (a game-owned gateway gets a warning), refuses a store id without its native target, a declared but uninstalled plugin, a shell pinned to another version, and an installed plugin whose kit peers the game does not satisfy, and lists every file in the dry run; `--providers` is refused for every other target. `validate:catalog` derives both host lists, `validate:effective-config` rejects an IAP-enabled `ait` or `reddit` target whose sold products differ from its host list, `validate:starter-workflow` pins the new modules and each target's wiring, and `validate:capacitor-fail-closed` and `validate:capacitor-alignment` cover the store plugins | Template wiring |
| C4 (landed, draft) | Major: `PlatformGateway.commerce` is the one `CommerceProvider` surface (the transitional `commerceV2` is renamed to it; optional, absent where a target sells nothing) and the v1 `CommerceAdapter`, `toCommerceAdapter`, the four v1 `commerce.*` bridge methods and every adapter's v1 wrapper are removed: the Capacitor registry's v1 methods and `app-store-server` re-export, the Apps in Toss host and sandbox v1 `commerce.*` handlers and entitlement reader, `createDevvitCommerceAdapter`/`withDevvitCommerceAdapter` and the Devvit server bridge's v1 cases, `createMicrosoftStoreCommerceAdapter`/`withMicrosoftStoreCommerceAdapter`, the Verse8 v1 wrapper, the browser base and WeChat stubs, and `createOnePlayCommerceAdapter` (replaced by `createOnePlayCommerceProvider`, the seventh reference store: `oneplay`, `client-token` evidence, server-owned finish, with the trusted `presentation` facts as the new optional `CommerceProvider.presentation`). The Play and StoreKit v1 drivers (`createCapacitorPlayBillingProvider`, `recoverOwnedPlayPurchases`, `createCapacitorStoreKitProvider`, `recoverStoreKitPurchases`, `finishGrantedTransaction`), the `createGooglePlayTokenTransactionId` aliases, and the deprecated `PlayPurchase` fields `productIds`, `purchaseTimeMillis`, and `state` (with their Android emission) are gone; so are `isAuthoritativeMicrosoftStoreCompletion` and `findAdapterSettledGrant` (settlement is the `adapter-settled` capability the reconciler verifies), `recoverPurchaseResult`, `GameServicesLegacyStoreTarget`, and the v1 purchase path of `createGameServicesClient`/`createRecoverableMonetizationClient`: the reconciler is the only purchase path, a gateway without a provider answers `rejected` (`commerce_unavailable`) and opens no store UI, a leftover v1 `purchase` journal record is read but never starts, reopens, or grants anything (a record that was mid-verification has its saved verify request sent to the backend once more and closed by the backend's answer; the reconciler finds whatever the store still lists), and rewarded ads keep their path. `PlatformCapabilities.nativeIap`, `subscriptionIap`, `deriveLegacyCommerceCapabilities`, and the `nativeIap`/`subscriptionIap` provider features are removed: `PlatformCapabilities.commerce` is required and the only source, a gateway that sells nothing reports `createUnsupportedCommerceCapabilities()`, and `withTargetAvailability`, feature availability, the runtime snapshot, and the capability conformance runner read the block alone (`withTargetAvailability` now masks the provider: catalog, new purchases, and resync obey the target configuration while `getAvailablePurchases`, `finishTransaction`, and `subscribe` always pass through, and a refused purchase answers `failed` before it reaches the store: `ITEM_UNAVAILABLE` when the target or catalog does not sell it, the provider's own `CONFIGURATION_REQUIRED`, `ACTION_REQUIRED`, or retryable `STORE_UNAVAILABLE` when only its readiness blocks it). `createCoordinatedPlatformGateway` holds the purchase lease on `requestPurchase` when a trusted release source exists. `validate:commerce-alignment` additionally checks bridge method lists and every provider capability block against the profile table, and fails the build on drift; entitlement reads move to the backend ledger | v1 adapter, deprecated drivers, boolean capabilities, unenforced alignment |
| D1 | Optional, outside this repository: a Capacitor IAP plugin over the OpenIAP native cores | |

The credit wallet implementation itself (B7's counterpart) lives in the
consuming project, against the B7 interface.

### Migrating from v1 {#migrating-from-v1}

The first release that contains C4 is a major release of every changed
package (the 0.x packages bump their minor version and mark it breaking).
Replace each removed API as follows; TypeScript reports every remaining use
as an unknown member or a missing `commerce` capability block.

| Removed | Replacement |
| --- | --- |
| `PlatformGateway.commerce` as a v1 `CommerceAdapter` (`getProducts`, `purchase`, `restore`, `getEntitlements`) and the `CommerceAdapter` type | `PlatformGateway.commerce?: CommerceProvider` (`fetchProducts`, `requestPurchase`, `getAvailablePurchases`, `finishTransaction`, `restorePurchases`, `subscribe`). Games do not call it: they purchase and recover through `createGameServicesClient`, `createRecoverableMonetizationClient`, or `createGameServicesRuntime`, whose reconciler drives it |
| `PlatformGateway.commerceV2` | `PlatformGateway.commerce` (same provider). Adapter option and bridge-channel names that carried `commerceV2` as a protocol event channel (for example Apps in Toss `GamePlatformBridge.commerceV2`) are unchanged |
| `toCommerceAdapter`, `ToCommerceAdapterOptions` | None. A v2 provider no longer serves v1 callers |
| `findAuthoritativePurchaseSettlement` | The journal record or `GameServicesPurchaseResult` the reconciler returns |
| `PlatformCapabilities.nativeIap` | `capabilities.commerce.availability === 'available' && (commerce.purchase.consumable \|\| commerce.purchase.durable)` |
| `PlatformCapabilities.subscriptionIap` | `capabilities.commerce.availability === 'available' && capabilities.commerce.purchase.subscription` |
| `providerAvailability.nativeIap`/`subscriptionIap`, and `'nativeIap'`/`'subscriptionIap'` in `PlatformProviderFeature` | `capabilities.commerce.availability` |
| Optional `PlatformCapabilities.commerce`; `deriveLegacyCommerceCapabilities`, `LegacyCommerceCapabilities` | `commerce` is required; a gateway that sells nothing reports `createUnsupportedCommerceCapabilities()` (from `@mpgd/platform` or `@mpgd/platform/commerce`) |
| Bridge methods `commerce.getProducts`, `commerce.purchase`, `commerce.restore`, `commerce.getEntitlements` | The six `commerce.v2.*` methods. A host that still receives a v1 method answers `UNSUPPORTED_METHOD`; a host that sells nothing answers `COMMERCE_V2_UNAVAILABLE` to the v2 methods |
| Entitlement reads through `gateway.commerce.getEntitlements()` and the adapter hooks behind it (`AitIapEntitlementReader`/`readIapEntitlements`, `MicrosoftStorePurchaseAuthority.getEntitlements`, `OnePlayCommerceServerPort.getEntitlements`, `DevvitPaymentsClient.getEntitlements`, `Verse8CommerceOptions.loadEntitlements`) | The backend ledger through game-services: `listActiveEntitlementTransactions` (reversed grants subtracted) and `getPurchaseLedgerStatus` on the server. There is no client entitlement list on the gateway; a game gates content on ledger-backed state |
| `recoverPurchaseResult` | `reconcile()` and `restorePurchases()` of the recoverable client, or `reconciler.reconcile()` |
| The v1 purchase path of `createGameServicesClient`/`createRecoverableMonetizationClient`; v1 `purchase` journal records | The reconciler (`gateway.commerce`). Without a provider `purchase()` answers `rejected` and opens no store UI. A leftover v1 `purchase` record is read; only a record that was mid-verification is finished, by sending its saved verify request to the backend once more |
| `findAdapterSettledGrant`, `isAuthoritativeMicrosoftStoreCompletion` | The `authority.evidence: 'adapter-settled'` capability and the reconciler's backend verification |
| `GameServicesLegacyStoreTarget` | `GameServicesStoreTarget` (an open `StoreId`) |
| `createGooglePlayTokenTransactionId` (`@mpgd/game-services/google-play-purchase`, `@mpgd/capacitor-play-billing`) | `createGooglePlayTokenPurchaseKey` from `@mpgd/platform/commerce` |
| `@mpgd/adapter-capacitor/app-store-server` | `@mpgd/game-services/app-store-server` |
| Capacitor provider `features: ['nativeIap']`, `createCommerceServiceProvider({ features })`, `CapacitorCommerceFeature`, `deriveCommerceFeatureStates`, v1 provider methods | `createCommerceServiceProvider({ id, commerce })`; readiness is the provider's capability block |
| `createCapacitorPlayBillingProvider`, `recoverOwnedPlayPurchases`, `PlayPurchase.productIds`/`purchaseTimeMillis`/`state` | `createCapacitorPlayBillingServiceProvider`; `PlayPurchase.products`/`purchaseTime`/`purchaseState` (run `cap sync` so the shell carries the matching native module) |
| `createCapacitorStoreKitProvider`, `recoverStoreKitPurchases`, `finishGrantedTransaction` | `createCapacitorStoreKitServiceProvider`; the reconciler lists unfinished transactions and finishes after the ledger grant |
| `createMicrosoftStoreCommerceAdapter`, `withMicrosoftStoreCommerceAdapter` | `createMicrosoftStoreCommerceProvider`, `withMicrosoftStoreCommerceProvider` |
| `createDevvitCommerceAdapter`, `withDevvitCommerceAdapter` | `createDevvitPlatformGateway({ commerce })` or `createDevvitCommerceProvider` |
| The Verse8 v1 commerce wrapper | `createVerse8PlatformGateway({ vxShop: { purchases } })` (`purchases` is required) |
| `createOnePlayCommerceAdapter` | `createOnePlayCommerceProvider` |
| The Apps in Toss host's v1 `commerce.*` handlers and the sandbox bridge's v1 `commerce.*` answers | The `commerce.v2.*` handlers; the sandbox build serves the evidence-only v2 stub |

Kept on purpose:

- The result vocabulary `PurchaseResult`, `PurchaseRestoreResult`,
  `PurchaseSettlement`, `ProductInfo`, `ProductType`, `Entitlement`,
  `CommerceDiagnostic`, and `PlatformPurchasePresentationEvent`. They are no
  gateway surface any more, but `GameServicesPurchaseResult.purchase`, the
  Apps in Toss and Microsoft Store engines (which the v2 providers share), and
  the ONE play presentation facts still use them.
- `resolveLegacyCommerceStoreId` and the `target` field of
  `VerifyPurchaseRequest`: a server still accepts requests from clients that
  predate `store`.
- `@mpgd/game-services/app-store-recovery`: a server-side helper, not marked
  deprecated; no kit client calls it any more, so a game that wired a restore
  route to it keeps working, and a later release can retire it.
- `@deprecated` on the AdMob compatibility helper in
  `@mpgd/game-services/admob-client-reward`: it concerns rewarded ads, whose
  path stays.

## OpenIAP {#openiap}

OpenIAP is a structural reference. As read on 2026-10-04: the Client
Protocol's store enum is closed (`Unknown | Apple | Google | Horizon |
Amazon`); its Commerce Protocol has an open store id but covers
auto-renewing subscriptions only, with one-time purchases out of scope; and
no Capacitor SDK, issue, or roadmap exists. Its native cores, `openiap` 3.6.1
(StoreKit 2, iOS 15+) and `openiap-google` 3.6.2 (Play Billing 9.1.0), wrap
the same store libraries as this kit's plugins, so switching cores gives no
one-time-purchase feature today.

Borrowed: the client method shape, results delivered by events with
available purchases as the source of truth, a normalized error enum with the
store code kept, provider capability descriptors, spec-first types with
conformance vectors, and a lockstep protocol version.

Deliberately different: open store ids on the client, ledger-first one-time
purchases, host-push fulfillment, and a credit wallet layer. These are also
the first candidates to propose upstream.

D1 starts only when a D-02 trigger fires (a native renewal requirement or
alternative billing), because that is where the OpenIAP cores add surface
(offers, renewal information, user-choice billing events) that the kit's
plugins lack. It begins with an OpenIAP discussion, lives in its own
repository under a neutral name, and replaces the kit's two plugins only
after it passes these vectors.

## Open questions {#open-questions}

1. How long the journal keeps finished records for revocation reporting, and
   whether revocations older than that window should reach the client
   through entitlement reads only.
2. Resolved in A2: the lot spend order is fixed, not configurable. Every
   wallet consumes eligible lots in the order under [credit lots](#credit-lots)
   (earliest `expiresAt`, then `title` before `cross-title`, then oldest
   `createdAt`, then `lotId`), so every wallet passes the same vectors and the
   spend expectations in `credit-lot-title-scope` are normative.
3. Whether memberships need a grace period before lapse, and how a lapsed
   membership resumes.
4. Resolved in A2: `quantity` is a provider capability. `RequestPurchaseInput.
   quantity` stays optional (integer >= 1); a request above 1 is rejected with
   `ITEM_UNAVAILABLE` by `assertRequestPurchaseSupported` when the provider
   does not declare `purchase.quantity`, before any store UI opens. Verifiers
   may still require 1 (the App Store verifier does today), which surfaces as a
   journal rejection, not as a client error.
5. Resolved in A2: the pre-listener buffer holds 64 events
   (`commerceEventBufferLimit`). Over the limit, `createCommerceEventBuffer`
   drops the oldest recoverable `purchaseUpdated` first: a pending or purchased
   purchase is still returned by `getAvailablePurchases`. A revoked purchase is
   not, so revoked `purchaseUpdated`, `purchaseError`, and `subscriptionUpdated`
   events are dropped oldest-first only when no recoverable `purchaseUpdated`
   remains.
6. Default billing authority and credit scope for Microsoft Store, Apps in
   Toss, Devvit, and Verse8 builds, pending each platform's policy review.

## References {#references}

- [Subscription commerce decision (D-02)](../../SUBSCRIPTION_COMMERCE_DECISION.md)
- [Recovering purchases and rewarded ads](../../MONETIZATION_RECOVERY.md)
- [Game services backend](../../GAME_SERVICES_BACKEND.md)
- [Platform capability snapshot conformance](../platform-capability-snapshots.md)
- OpenIAP: https://github.com/hyodotdev/openiap
