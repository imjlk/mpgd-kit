---
npm/@mpgd/platform: minor
---

Commerce v2, PR B7: the credit wallet contract.

`@mpgd/platform/commerce-wallet` is a new public subpath (RFC "Credit wallet",
"Credit lots", "Billing authority and memberships", "Subscriptions"):

- `createCreditCommerceProvider(client, { titleId, billingAuthority, currencies?, capabilities?, now? })`
  turns a project-owned `CreditWalletClient` into a `CommerceProvider`:
  `fetchProducts` lists the wallet's offers (memberships omitted where the
  billing authority is `store`), `requestPurchase` spends the offer price
  times the quantity under the game's idempotency key and answers `purchased`
  with `adapter-settled` evidence `credit-wallet.spend.v1` carrying the debits
  and the wallet's entitlement id and no `settlement` pointer (the backend
  ledger entry exists only after that evidence is verified), a membership
  under `store` authority fails with `ITEM_UNAVAILABLE`, a wallet
  `INSUFFICIENT_BALANCE` is a `failed` outcome with that code,
  `getAvailablePurchases` lists unredeemed entitlements, `finishTransaction`
  redeems one and refuses to run without the ledger entry id of its grant,
  `restorePurchases` re-reads the unredeemed entitlements as `purchaseUpdated`
  events (buffered once per transaction before the first listener; recovery
  reads skip a malformed offer or entitlement and treat an offers outage as
  no offers rather than hiding purchases), `getActiveSubscriptions` exists
  when the client has it, a listener that throws is logged and never stops
  the others, the client's events
  for the title pass through the standard pre-listener buffer, and
  `dispose()` releases the client subscription. A `purchased` answer requires
  the wallet's debits to add up to the price; `purchasedAt` is the wallet's
  settlement time, so a replay and a later `getAvailablePurchases` read show
  one purchase with one evidence payload; entitlements the wallet lists for
  another title are dropped. The capability block is the RFC profile row
  (`purchase.subscription` only under `host` and only when the client has
  `getActiveSubscriptions`, `lifecycle.events: true`,
  `lifecycle.finish: 'server'`, `authority.evidence: 'adapter-settled'`,
  `accountBinding: 'host'`; `createCreditCommerceCapabilities` reports
  subscriptions only when told `{ subscriptions: true }`); a wallet that
  reports no settlement time gets one fallback `purchasedAt` per entitlement
  that every replay repeats; malformed client answers, including a
  `subscription`-kind offer without membership terms, are `INVALID_RESPONSE`
  and an offer priced in an undeclared catalog currency is
  `CONFIGURATION_REQUIRED`.
- Pure lot and membership rules shared by consumer wallet services and the
  reference wallet: `deriveCreditLotSpendScope` with a `CreditScopeRegistry`
  (`assertCreditScopeRegistry` rejects `cross-title` for `google-play` and
  `app-store`, and a promotion lot attributed to either cannot be issued
  `cross-title`), `selectEligibleCreditLots`, `isCreditLotEligible`,
  `compareCreditLotSpendOrder`, `planCreditDebits`, `sumCreditLotRemaining`,
  `sumCreditDebits`, `creditPriceMultiple`, `sameCreditAmount`,
  `createMembershipRenewalKey` (`membership:<subscriptionId>:<periodIndex>`),
  `createCreditSubscriptionEventId` (`<subscriptionId>:<periodIndex>:<type>`),
  the `CreditSubscriptionEvent` shape with the four lifecycle types,
  `createCreditWalletSpendEvidence` / `readCreditWalletSpendEvidence`,
  `parseIsoDuration`, `isIsoDuration`, `addIsoDuration(at, period, times)`
  (positive periods only, months anchored on the start date with the day
  clamped), and `normalizeIsoTimestamp`.
- `resolveCommerceBillingAuthority(profile, override?)`: `google-play` and
  `app-store` are always `store` and reject a `host` override, `web` and
  `web-preview` default to `host`, every other profile to `store`.
- `createInMemoryCreditWallet({ store, currencies, now?, offers?, creditScope?, maxRenewalsPerTick? })`
  is the reference wallet implementing `CreditWalletClient` plus the
  owner-side operations (`creditFromGrant` keyed by `ledgerEntryId`,
  `addOffers`, `startMembership`, `renewDue(now)`). It prices every spend by
  its offers (`amount` must be a whole number of the price; an unknown
  `logicalId` is `ITEM_UNAVAILABLE`), records a membership start under the
  client's key as well as `membership:<key>:0` so every replay of that key
  returns the original debits even after the membership lapsed, refuses a
  subscription id reused with other terms, judges renewal lot eligibility at
  the period boundary it pays for and ignores lots granted after it
  (`CreditLotEligibility.createdBy`), charges at most `maxRenewalsPerTick`
  periods per tick (12 by default), rejects a conflicting grant replay
  (different amount, currency, origin, timestamps, or scope), reserves the
  `membership:` key prefix, and rejects a key reused for a different spend.
  `subscribe(listener, { titleId })` delivers a title-scoped membership's
  events only to that title's listeners.
- typia validators `assertCreditLotGrant`, `assertCreditMembershipTerms`,
  `assertCreditRedeemInput`, `assertCreditSubscriptionEvent`,
  `assertCreditMembershipStartInput`, `assertCreditLotSpendScope`, and
  `assertCreditWalletOffer` (membership terms only on `subscription` offers,
  every `subscription` offer with terms, a positive period, and a membership
  priced as its terms say).

`@mpgd/platform/commerce`: `CreditWalletClient` gains the optional
`getActiveSubscriptions({ titleId })` and an optional second `subscribe`
argument `CreditWalletSubscribeInput` (`{ titleId? }`); a `debited`
`CreditSpendResult` may carry `createdAt`, the wallet's settlement time, which
the provider uses as `purchasedAt`; a `CreditEntitlement` may carry
`quantity`, the units bought at spend time, which the provider reports instead
of deriving one from the current price (the derivation stays as a fallback).

`@mpgd/platform/commerce-conformance`: `createCommerceConformanceWallet` and
`createCommerceConformanceWalletProvider` now delegate to the wallet module
(the provider is `createCreditCommerceProvider` with the vector profile as its
capability block, after registering the vector catalog as the wallet's offers
when it lists none), so the three wallet vectors run through the public
provider. Behaviour changes a caller of the conformance wallet sees:

- `addIsoDuration`, `normalizeIsoTimestamp`, `compareCreditLotSpendOrder`, and
  `deriveCreditLotSpendScope` are re-exports of the wallet module;
  `deriveCreditLotSpendScope` takes an options object (`{ explicit, creditScope }`)
  instead of a positional explicit scope (a JS caller still passing a scope
  gets the derived `title` scope), and `addIsoDuration` gains a `times`
  argument, rejects zero-length durations (`P0D`, `PT0S`, `P1DT`), and anchors
  month arithmetic with the day clamped (`2026-01-31` + `P1M` is now
  `2026-02-28`, not `2026-03-03`).
- `CommerceConformanceWallet` has `offers`, `addOffers`,
  `getActiveSubscriptions(input?)`, and `subscribe(listener, input?)`; a
  `spend` with a `logicalId` is priced by the registered offers.
- `redeem` is no longer unconditional: an empty ledger entry id returns
  `{ redeemed: false }`, redeeming again under the same ledger entry id is a
  no-op `true`, and a different ledger entry id cannot claim an entitlement.
  `finalize` is async and redeems through `redeem` with the backend's ledger
  entry id.
- `startMembership` replays answer with the original period-0 debits in any
  state; a subscription id reused with other terms is `INVALID_RESPONSE`.
- The wallet provider surfaces unredeemed entitlements whose offer is gone
  (under their logical id), carries `credit-wallet.spend.v1` evidence instead
  of the fixture schema, no longer sets `settlement` on wallet purchases, and
  omits memberships whenever `purchase.subscription` is false.
- A client key that equals the id of a membership the owner started is
  rejected on `spend` unless it replays that membership's start, and
  `startMembership` refuses a subscription id already used as a spend key.
