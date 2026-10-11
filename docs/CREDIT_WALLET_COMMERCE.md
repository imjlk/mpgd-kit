# Credit wallet commerce

Status: commerce v2 draft (RFC B7). The wallet contract is implemented in
`@mpgd/platform/commerce-wallet`; the wallet service itself is not part of
the kit. This note is outside the enforced
[documentation evidence](DOCUMENTATION_EVIDENCE.md) scope until the commerce
v2 protocol is released.

## Credit wallet

A prepaid-credit wallet is the second commerce layer of the
[commerce v2 RFC](specs/commerce/commerce-v2-rfc.md#credit-wallet): credit
packs are sold by the store providers and settle in the game-services ledger,
and spending credits is itself a `CommerceProvider`. The kit defines the
client interface and the rules; **the consuming project implements the
client** against its own wallet service, under its own open `StoreId`:

- `CreditWalletClient` (`@mpgd/platform/commerce`, re-exported by
  `@mpgd/platform/commerce-wallet`): `listOffers`, `spend`, `listUnredeemed`,
  `redeem`, `getBalance`, and optionally `getActiveSubscriptions({ titleId })`
  and `subscribe(listener, { titleId })`. Every method talks to the wallet
  service; the client holds no balance and grants nothing. A `spend` is
  idempotent by key and answers a repeated key with the original debits,
  `createdAt`, and `alreadyProcessed: true`, whatever happened to the
  purchase since (a lapsed membership still replays its start). The wallet
  service, not the caller, prices a spend: `amount` must be a whole number
  of the offer's price. A `spend` of a membership offer starts the
  membership with the key as its subscription id.
- `createCreditCommerceProvider(client, { titleId, billingAuthority })` turns
  the client into a `CommerceProvider` (plus `dispose()`, which releases the
  client subscription): `fetchProducts` lists the offers (memberships omitted
  where the billing authority is `store` or the client cannot report active
  subscriptions), `requestPurchase` spends the offer price times the quantity
  and answers `purchased` only when the wallet's debits add up to that price,
  with `adapter-settled` evidence (`credit-wallet.spend.v1`, carrying the
  debits and the wallet's settlement id, which is also
  `settlement.ledgerEntryId`) and the wallet's `createdAt` as `purchasedAt`,
  so a replay and a later `getAvailablePurchases` read show the same
  purchase; `getAvailablePurchases` lists the title's unredeemed entitlements
  (one the wallet lists for another title is dropped), `finishTransaction`
  redeems one and refuses to run without the ledger entry id of its grant,
  `restorePurchases` re-reads the unredeemed entitlements as `purchaseUpdated`
  events (buffered once per transaction before the first listener), and the
  client's events for the title pass through the standard pre-listener buffer.
  The capability block is the RFC profile row (`finish: 'server'`,
  `authority.evidence: 'adapter-settled'`, `accountBinding: 'host'`,
  `lifecycle.events: true`, `purchase.subscription` only under `host`
  authority with a client that has `getActiveSubscriptions`);
  `options.capabilities` overrides it, `options.currencies` names the catalog
  currencies an offer may be priced in, and `options.now` is the fallback
  clock. A malformed client answer, including a `subscription`-kind offer
  without membership terms or debits that do not add up, is
  `INVALID_RESPONSE`; an undeclared offer currency is
  `CONFIGURATION_REQUIRED`; a wallet `INSUFFICIENT_BALANCE` is returned as a
  `failed` outcome with that code.
- The wallet service implements the rules with the same pure functions the
  reference wallet uses: `deriveCreditLotSpendScope` (store lots are
  title-scoped, off-store lots cross-title, promotion lots as issued, a
  `creditScope` registry per store with Google Play and the App Store fixed to
  `title`), `selectEligibleCreditLots` and `compareCreditLotSpendOrder`
  (earliest `expiresAt` first with no expiry last, then `title` before
  `cross-title`, then oldest `createdAt`, then `lotId`), `planCreditDebits`
  (debits nothing on `INSUFFICIENT_BALANCE`), `createMembershipRenewalKey`
  (`membership:<subscriptionId>:<periodIndex>`), and
  `createCreditSubscriptionEventId` (`<subscriptionId>:<periodIndex>:<type>`),
  `parseIsoDuration` / `addIsoDuration(at, period, times)` (positive periods
  only; months are anchored on the start date with the day clamped, so period
  `n` ends at `startedAt + (n + 1) × period`). A `platform`-scoped membership
  debits `cross-title` lots only; a renewal judges lot eligibility at the
  period boundary it pays for, not at the time the scheduler runs; a
  membership the eligible balance cannot renew lapses at the end of the paid
  period with reason `INSUFFICIENT_BALANCE`; a lapsed id cannot be restarted
  by replaying its period-0 key, and a subscription id started with other
  terms, title, or product is refused.
- `createInMemoryCreditWallet({ store, currencies, now, offers, creditScope, maxRenewalsPerTick })`
  is the reference wallet: the client surface plus the owner-side operations
  a wallet service runs (`creditFromGrant` keyed by `ledgerEntryId`, so a
  replayed grant cannot create a second lot and a conflicting replay throws;
  `addOffers`; `startMembership`; `renewDue(now)`, which charges at most
  `maxRenewalsPerTick` periods per membership per call, 12 by default, and
  continues on the next tick). It has no billing authority of its own: the
  provider is what refuses memberships on a `store` target, and its `redeem`
  checks the entitlement and the ledger entry id it was first redeemed under,
  not that the ledger entry exists; a production wallet service verifies the
  pair against the ledger. The conformance runner's
  `createCommerceConformanceWallet` wraps it (registering the vector catalog
  as offers when the wallet has none), so the three wallet vectors
  (`credit-lot-title-scope`, `credit-membership-renewal`,
  `membership-store-billing-target`) run through `createCreditCommerceProvider`;
  a consumer runs the same vectors against its own client with
  `runCommerceConformanceVectors(vectors, { createProvider })`.
- `resolveCommerceBillingAuthority(profile, override?)` resolves a target's
  billing authority: `google-play` and `app-store` are always `store` and reject
  a `host` override, `web` and `web-preview` default to `host`, every other
  profile defaults to `store`. `TargetReleaseConfig.billingAuthority` in
  `@mpgd/target-config` is the per-target override and `validate:target-config`
  rejects `host` on the two store-billed profiles.

The provider never credits a lot or unlocks an entitlement: lots are credited
by the wallet owner from ledger grants, the `settlement` pointer is verified by
the reconciler through the backend like any other adapter-settled purchase,
and memberships renew, lapse, and expire on the wallet service alone
(`subscriptionUpdated` events and `getActiveSubscriptions` are how a client
learns about them). Policy constraints come from
[D-02](SUBSCRIPTION_COMMERCE_DECISION.md).

Note for C1 (the single reconciler): `@mpgd/game-services` grants a v1
`completed` result carrying `authoritativeGrant` from a provider that declares
`authority.evidence: 'adapter-settled'` without a second verification
(`findAdapterSettledGrant`, B4). That shortcut assumes the adapter already
wrote the ledger grant, as the Microsoft Store authority does. A wallet
purchase's `settlement.ledgerEntryId` is the wallet's own entitlement id, not
a game-services ledger entry, and the reference wallet derives it from the
client-chosen idempotency key. No bridge maps wallet settlements to
`authoritativeGrant` today; one that did would mark wallet purchases granted
without a ledger entry. C1 must either verify wallet settlements through the
backend (`credit-wallet.spend.v1` evidence) or key the shortcut on the store,
never on the evidence declaration alone.
