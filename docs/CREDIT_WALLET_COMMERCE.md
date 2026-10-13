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
  debits and the wallet's entitlement id) and no `settlement` pointer (see the
  paragraph on settlement below), and the wallet's `createdAt` as `purchasedAt`,
  so a replay and a later `getAvailablePurchases` read show the same
  purchase; `getAvailablePurchases` lists the title's unredeemed entitlements
  (one the wallet lists for another title is dropped), `finishTransaction`
  redeems one and refuses to run without the ledger entry id of its grant,
  `restorePurchases` re-reads the unredeemed entitlements as `purchaseUpdated`
  events (buffered once per transaction before the first listener), and the
  client's events for the title pass through the standard pre-listener buffer;
  a listener that throws is logged and never stops the others. Recovery reads
  (`getAvailablePurchases`, `restorePurchases`) never fail because of the
  offer list: an offers outage or a malformed offer only means a purchase is
  listed under its logical id, and a malformed entitlement is skipped with a
  warning. A purchase's `quantity` is the one the wallet recorded at spend
  time (`CreditEntitlement.quantity`), falling back to the spent amount over
  the current price; it is advisory, because the backend prices a wallet
  purchase from the evidence's `amount` and `debits`.
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
  period boundary it pays for, not at the time the scheduler runs, and
  ignores lots granted after that boundary (`CreditLotEligibility.createdBy`);
  a
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
  `@mpgd/target-config` is the per-target override, the starter and template
  runtime loaders accept only `store` or `host` for it, and
  `validate:target-config` rejects `host` on the two store-billed profiles.

The provider never credits a lot or unlocks an entitlement: lots are credited
by the wallet owner from ledger grants, a wallet purchase is verified by the
reconciler through the backend from its `credit-wallet.spend.v1` evidence like
any other purchase, and memberships renew, lapse, and expire on the wallet
service alone (`subscriptionUpdated` events and `getActiveSubscriptions` are
how a client learns about them). Policy constraints come from
[D-02](SUBSCRIPTION_COMMERCE_DECISION.md).

A wallet purchase carries no `settlement` pointer. The contract defines
`settlement.ledgerEntryId` as the authority's ledger entry, which for a wallet
spend exists only after the backend verifies the evidence, and the wallet's own
id (the entitlement id, derived by the reference wallet from the client-chosen
idempotency key) is not one. The commerce reconciler is the only purchase path
(the v1 adapter wrapper, `toCommerceAdapter`, and the adapter-settled shortcut
`findAdapterSettledGrant` were removed in commerce v2 PR C4), and it sends
every provider result, adapter-settled included, through one verify request
whose answer carries the ledger entry. A wallet purchase is therefore granted
from the backend's verification of the evidence, never from a settlement
pointer the wallet could supply.
