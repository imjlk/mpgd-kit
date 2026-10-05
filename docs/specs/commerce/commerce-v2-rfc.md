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
5. **Additive until the major.** v1 `CommerceAdapter` keeps working through a
   wrapper until every provider implements v2; one major release removes v1.

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
  /** Purchases the store still reports as unfinished. */
  getAvailablePurchases(input?: { readonly includePending?: boolean }): Promise<readonly StorePurchase[]>;
  /** Required when `lifecycle.finish` is 'client' or 'host'. */
  finishTransaction?(input: {
    readonly transactionId: string;
    readonly ledgerEntryId: string;
    readonly isConsumable: boolean;
  }): Promise<{ readonly finished: boolean }>;
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
  from the ledger, not from this list.
- **No grants on the client.** A provider never credits a wallet or unlocks an
  entitlement. `settlement` on an adapter-settled purchase is a pointer for
  the reconciler, not a grant.
- **Token and evidence both stay.** `token` is the store's canonical proof,
  kept so a server can verify offline. `evidence` remains the envelope the
  server registry routes on.

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

During the transition, `PlatformCapabilities.nativeIap` is derived as
`availability === 'available' && (purchase.consumable || purchase.durable)`,
and `subscriptionIap` as `purchase.subscription`. The capability conformance
rules in [platform-capability-snapshots.md](../platform-capability-snapshots.md)
apply to the new block as well: fresh objects on every read and no unknown
keys.

Profiles for the reference stores, fixed from the current code:

| Store id | consumable | durable | subscription | available source | pending | finish | evidence | account binding |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `google-play` | yes | yes | no | `getPurchases`, unfinished only | yes | `server` (acknowledge or consume finalizer) | `client-token` (purchase token) | `required` (obfuscated account id) |
| `app-store` | yes | yes | no | `getTransactions`, unfinished only | yes | `client`, after the ledger grant | `client-token` (signed transaction JWS) | `required` (`appAccountToken`) |
| `microsoft-store` | yes | no | no | `listPurchases` | no | `server` (consume finalizer) | `adapter-settled` | `required` |
| `apps-in-toss` | yes | yes | no | `getPendingOrders` | yes | `host` (`completeProductGrant`) | `host-callback` | `host` |
| `devvit` | yes | to be verified | no | none | yes | `none` | `server-push` (fulfillment order) | `host` |
| `verse8` | yes | to be verified | no | none | yes | `none` | `server-push` (Agent8 event) | `host` |
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
| `pending` | `verifying` | The next reconcile resends the same saved request. |
| `verifying` | `rejected` | The backend returned a definitive non-grant. |
| `granted` | `finishing` | The finish owner is `client`, `host`, or `server`. For `server` this means waiting for the backend to report `finalization: 'completed'`. |
| `granted` | `finished` | The finish owner is `none`. |
| `finishing` | `finished` | The finish call succeeded, or the backend reported finalization completed. |
| `finished`, `granted` | `revoked` | The backend ledger holds a revocation entry for the grant. |

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
   way.
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
   read finalization for `server`; mark `finished` for `none`.
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

- Reference rule for new stores: `store:<storeId>:<transactionId>`.
- Existing stores keep their current forms so ledgers written by v1 still
  deduplicate: `play-token-sha256:<hex>` for `google-play` (one shared helper
  replaces the two copies), and `apps-in-toss:purchase:<orderId>` for
  `apps-in-toss`.

When a game key and a derived key ever reach the backend for the same
purchase, the existing platform-evidence unique index
(`EVIDENCE_ALREADY_PROCESSED`) remains the backstop.

## Server: commerce service protocol {#server}

The verify, ledger, finalizer, and fulfillment endpoints stay. v2 changes how
they are routed and what they can record.

### Open store ids {#server-store-ids}

`VerifyPurchaseRequest` gains `store: StoreId`. `target` stays as the
deployment target. `GameServicesStoreTarget` becomes an alias of `StoreId`,
and `assertStoreTarget` checks the store against the registry instead of a
fixed list. For v1 requests without `store`, the server maps `android` to
`google-play`, `ios` to `app-store`, `microsoft-store` to `microsoft-store`,
and `ait` to `apps-in-toss`.

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
`apps-in-toss.iap.callback.v1`, and `devvit.payment-order.v1`.

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
  subscribe?(listener: (event: CommerceEvent) => void): () => void;
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
  with `alreadyProcessed: true`.

### Billing authority and memberships {#billing-authority}

```ts
export type CommerceBillingAuthority = 'store' | 'host';
```

Each target resolves a billing authority from its release profile.
`google-play` and `app-store` are always `store`. `web` and `web-preview`
default to `host`. Every other profile defaults to `store`; a project may set
`host` for one of them after its own policy review. The target-config
validator rejects `host` for `google-play` and `app-store`.

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
  end of the paid period with reason `INSUFFICIENT_BALANCE`.
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
- The bridge adds `commerce.v2.getCapabilities`, `commerce.v2.fetchProducts`,
  `commerce.v2.requestPurchase`, `commerce.v2.getAvailablePurchases`,
  `commerce.v2.finishTransaction`, and `commerce.v2.restorePurchases`, and an
  optional `NativeBridge.subscribe` for events. Events use the envelope
  `{ protocol: 'mpgd.commerce.v2', sequence, event }` with a per-session
  sequence number.
- Payloads are validated with typia on both sides. A2 generates JSON Schemas
  for the bridge payloads and the vector format into
  `docs/specs/commerce/schemas/`, and `validate:commerce-alignment` checks that
  the protocol constant, the vectors, the schemas, and each provider's
  declared version agree.

## Conformance vectors {#vectors}

Vectors live in
[`docs/specs/commerce/vectors/`](https://github.com/imjlk/mpgd-kit/tree/main/docs/specs/commerce/vectors).
A3 adds the runner to `@mpgd/platform` with an in-memory reference provider,
fake store, fake backend, and in-memory journal. Every provider in B runs the
same files against its own fake SDK.

A vector is one JSON file:

| Field | Meaning |
| --- | --- |
| `vector` | Name; equals the file name without `.json`. |
| `protocol` | Commerce protocol version the vector targets. |
| `profile` | Store id plus the `purchase`, `lifecycle`, and `authority` capability blocks under test. Omitted blocks default to all supported and `available`. |
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

After each step the runner lets the runtime run until it is idle. Unscripted
store and backend calls fail the vector. `expect` may assert `journal` (the
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

v1 `CommerceAdapter` stays. A2 adds `toCommerceAdapter(provider)` so a v2
provider serves v1 callers, and the game-services client moves to v2
internally. Templates and games call game-services and do not change until
C3. C4 removes v1 in one major release. Every PR that changes a publishable
package carries a Sampo changeset.

| PR | Scope | Closes |
| --- | --- | --- |
| A1 | This RFC and the vectors | |
| A2 | `@mpgd/platform` `commerce/` module: types, `CommerceError`, capabilities, state machine, typia validators, JSON Schemas, `validate:commerce-alignment`; catalog currency list | Closed currencies |
| A3 | Conformance runner and in-memory reference provider passing every vector | |
| A4 | Bridge v2 methods and event envelope; move `app-store-server` into `@mpgd/game-services`; one `createGooglePlayTokenTransactionId` | Duplicated helper, server code in client package |
| B1 | `@mpgd/adapter-capacitor`: `StoreSdk` interface, `createStoreCommerceProvider`, registry wiring, v1 wrapper | |
| B2 | Play Billing provider: available purchases, `purchaseUpdated` subscription, acknowledged flag from the plugin | Unused native events |
| B3 | StoreKit provider: JWS as `token` and evidence; server verifies offline with Server API fallback | JWS dropped |
| B4 | Microsoft Store provider | Target-name settlement check |
| B5 | Apps in Toss provider: pending orders as available, host finish | |
| B6 | Devvit and Verse8 providers on server-push lookup | |
| B7 | Credit wallet contract: `CreditWalletClient`, `createCreditCommerceProvider`, lot and membership rules, reference in-memory wallet | |
| C1 | Single reconciler in the game-services client replacing the four drivers | Four recovery drivers |
| C2 | Server: open `StoreId`, evidence registry, capabilities endpoint, revocation entries, worker Play finalizer and App Store recovery bindings | Closed targets, missing Play finalizer, no revocation |
| C3 | CLI and templates: wire store providers in `capacitorAndroid.ts` and `capacitorIos.ts`, make `--providers` install them, connect Apps in Toss and Devvit products | Template wiring |
| C4 | Major: remove v1 adapter, deprecated drivers, and the boolean capabilities; enforce the alignment validator | |
| D1 | Optional, outside this repository: a Capacitor IAP plugin over the OpenIAP native cores | |

The credit wallet implementation itself (B7's counterpart) lives in the
consuming project, against the B7 interface.

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
2. Whether the lot spend order should be configurable per wallet, or fixed so
   every wallet passes the same vectors.
3. Whether memberships need a grace period before lapse, and how a lapsed
   membership resumes.
4. Whether `quantity` above 1 is allowed for credit packs; the App Store
   verifier currently requires 1.
5. A bound for the pre-listener event buffer.
6. Default billing authority and credit scope for Microsoft Store, Apps in
   Toss, Devvit, and Verse8 builds, pending each platform's policy review.

## References {#references}

- [Subscription commerce decision (D-02)](../../SUBSCRIPTION_COMMERCE_DECISION.md)
- [Recovering purchases and rewarded ads](../../MONETIZATION_RECOVERY.md)
- [Game services backend](../../GAME_SERVICES_BACKEND.md)
- [Platform capability snapshot conformance](../platform-capability-snapshots.md)
- OpenIAP: https://github.com/hyodotdev/openiap
