# Subscription commerce decision (D-02)

Status: **deferred**. Subscription purchases are part of the commerce v2
contract design, but no adapter, verifier, or store plugin implements them
yet. This record fixes why, what the kit designs now, and which observations
reopen the decision. It is a decision note, not confirmed runtime behavior,
and it is outside the enforced documentation-evidence scope.
Baseline: `main@646745bc`, 2026-10-04.

## Context

The kit supports one-time purchases on every commerce target (Play Billing,
StoreKit, Microsoft Store, Apps in Toss, Devvit, Verse8). The Google Play and
App Store verifiers reject subscription products explicitly
(`GOOGLE_PLAY_SUBSCRIPTION_VERIFIER_REQUIRED`,
`APP_STORE_SUBSCRIPTION_UNSUPPORTED`); the Apps in Toss verifier does not
check the product type and relies on the adapter hiding subscription products
and on target configuration leaving `subscriptions` disabled. `subscriptionIap`
is declared but never set, and no target configuration enables
`subscriptions`. A common consumer
shape is a game platform that sells prepaid credits through a merchant of
record and lets games spend those credits for entitlements; such a platform
typically starts without a paid recurring plan.

The question is whether subscriptions deserve implementation effort before
the credit-pack and credit-spend flows are proven, and which subscription
shape fits a game platform.

## What the market data says (read 2026-10-04)

Figures below are published benchmarks, each with its own sample bias; they
are inputs to a judgement, not targets for any particular platform.

| Observation | Figure | Source and window |
| --- | --- | --- |
| Gaming download-to-paid conversion for subscription apps | 1.0% median at day 35, the lowest category; all-category median 2.0%; gaming top quartile 2.3% | RevenueCat, State of Subscription Apps 2026, gaming cut, 2025 data |
| Gaming trial funnel | 4.4% of downloads start a trial; 25.0% of trials convert; 73.3% of gaming apps use trials of four days or less | same |
| Gaming revenue per install | USD 0.14 at day 60, 4.7 times lower than Health and Fitness (USD 0.66) | same |
| Plan mix in gaming | 82% of subscriptions sold are weekly; USD 4.99 weekly is the most common price | same |
| Monetization mix in gaming | 40.5% of gaming subscription apps are subscription-only, the lowest share of any category; 27.5% combine subscriptions with consumables | same |
| Paywall effect, all categories | Hard paywall apps convert downloads to paid at 10.7% by day 35 versus 2.1% for freemium apps; one-year retention of yearly subscribers is about 27% to 28% either way | RevenueCat, State of Subscription Apps 2026 |
| Gaming revenue concentration | 59% of gaming in-app purchase revenue comes from paid installs; midcore titles are 90% in-app-purchase-only; non-gaming subscription penetration is 15.6% of monetizing apps | AppsFlyer, App Marketing and Monetization Report, January 2025 to March 2026 |
| Direct-to-consumer share | Off-store revenue is estimated at about USD 17 billion, roughly 15% of a USD 113.3 billion store in-app purchase estimate; the figure is an extrapolation that applies a survey-median off-store share to Newzoo's store total, from 281 respondents of whom 11% had direct mobile-game involvement; 92% of surveyed publishers expect growth in 2026 | Appcharge with GDC survey, January to February 2026, via PocketGamer.biz |
| Direct-to-consumer by genre | Casino titles in the US top 100 take about 30% of revenue through web stores; Monopoly GO about one third; traffic is mostly direct or bookmarked | Sensor Tower, H1 2026, presented at Gamescom 2026 |
| Overall mobile game spend | In-app purchase revenue USD 82 billion in 2025, up 1.4%, with fewer installs and retention-first operation | Sensor Tower, 2025 |

Reading of the data:

- Game players convert to subscriptions at about half the rate of other
  categories, and the games that do sell subscriptions sell short weekly
  plans. A subscription-only game economy is the exception.
- The packaging mix shows that hybrids are common (27.5% of gaming
  subscription apps combine subscriptions with consumables and a further 9.6%
  add lifetime purchases), but the report compares how apps are packaged, not
  how each model performs. The working hypothesis, to be tested rather than
  assumed, is that an ad-free or convenience tier with a recurring currency
  allowance layered over consumables fits game spending better than a
  subscription-only economy. In credit terms that is a recurring credit grant.
- Off-store web commerce is estimated to be growing quickly and is measured
  as material for the genres that lean on it. A prepaid-credit wallet sits on
  that side of the market, so the first recurring product should live there
  too, within the store-policy limits described under the decision.

## Decision

1. **Design now, implement later.** Commerce v2 declares subscription
   capability per provider (`purchase.subscription`), models entitlement
   expiry, renewal, and lapse events on the ledger, and exposes active
   subscriptions through the same reconciliation loop as one-time purchases.
   No provider sets the capability to true in the first release.
2. **First recurring product is a credit-funded membership, not a store
   subscription, and it is scoped to where the host owns commerce.** When a
   recurring offer is wanted, it is an entitlement renewed by a scheduled
   credit debit on the wallet that owns the balance, with
   `lifecycle.finish: 'none'` and `authority.evidence: 'server-push'`. On web
   distribution and on host platforms whose own billing the kit already
   treats as authoritative it needs no store SDK, and expiry and lapse are
   decided by one server. It is **not** offered inside Google Play or App
   Store distributed builds: both stores require their own billing for
   digital entitlements unlocked in the app unless a program or territory
   exception applies, so a membership on those targets is a store
   subscription and waits for decision 3.
3. **Store subscriptions (Play Billing, StoreKit) stay out of scope** until a
   trigger below fires. Implementing them also decides the native-core
   question: at that point the Capacitor providers move to an OpenIAP-based
   plugin built outside this repository, because renewal metadata, offers,
   and alternative-billing events are where the external cores add surface
   the kit's own plugins do not have.
4. **Credit packs come first on native targets, scoped to the purchasing
   title.** Play Billing and StoreKit sell consumable credit packs that
   settle in the game-services ledger and top up a balance scoped to the
   title they were bought in. Google Play limits in-app virtual currency to
   the title it was purchased for, and the App Store applies equivalent
   rules, so store-purchased credits never become a cross-title balance.
   Only credits purchased outside the stores may be spent across titles,
   subject to the consuming platform's own policy review. Credit-pack
   conversion is the baseline against which any membership is judged.

## Triggers that reopen this decision

Review the decision when any one of these is observed, or at the latest in
April 2027.

| Trigger | Threshold to propose | Why |
| --- | --- | --- |
| Membership take-rate | A credit-funded membership reaches 20% of paying accounts, or 10% of credit revenue, for two consecutive months | Shows recurring demand exists before store renewals are built |
| Native renewal requirement | A Google Play or App Store build wants a recurring offer | Store billing is the only compliant shape for digital entitlements on those targets, so the membership cannot be reused there |
| Alternative billing | User-choice or developer-provided billing becomes applicable to a shipped target | The OpenIAP cores already surface these events |
| Conversion evidence | Gaming subscription conversion benchmarks move materially, or the platform's own trial-to-paid data exceeds the 25% gaming median | The assumption behind deferral no longer holds |

The thresholds are proposals to be adjusted by each product owner; the
decision record is updated, not replaced, when they change.

## Consequences for the commerce v2 work

- The contract, conformance vectors, and capability matrix include
  subscription fields from the first release so adding a provider later is
  additive.
- A prepaid-credit wallet provider, implemented by the consuming project
  against the kit's wallet contract with its own open `StoreId`, is the first
  place a recurring entitlement is implemented.
- The wallet contract records the purchasing store and title on every credit
  lot, so store-purchased balances stay title-scoped and only off-store lots
  are eligible for cross-title spending.
- Follow-up outside this record: the Apps in Toss verifier should reject
  subscription product types explicitly instead of relying on adapter and
  configuration gating.
- `@mpgd/capacitor-play-billing` and `@mpgd/capacitor-storekit` keep their
  one-time-purchase scope; no subscription surface is added to them.
- Documentation that describes subscriptions must label them as designed but
  not implemented until a provider ships with the capability enabled.

## References

- RevenueCat, State of Subscription Apps 2026, gaming cut:
  https://www.revenuecat.com/state-of-subscription-apps-2026-gaming
- RevenueCat, State of Subscription Apps 2026:
  https://www.revenuecat.com/state-of-subscription-apps
- AppsFlyer, App Marketing and Monetization Report:
  https://appsflyer.com/resources/reports/app-marketing-monetization-report
- Appcharge and GDC direct-to-consumer survey, via PocketGamer.biz:
  https://www.pocketgamer.biz/report-mobile-game-d2c-revenues-reach-17bn-as-publishers-push-beyond-app-stores/
- Sensor Tower on direct-to-consumer revenue, H1 2026, via PocketGamer.biz:
  https://www.pocketgamer.biz/sensor-tower-reveals-the-hidden-impact-of-d2c-revenue-in-mobile-games/
- Sensor Tower 2025 mobile game revenue, via PocketGamer.biz:
  https://www.pocketgamer.biz/over-95000-mobile-games-were-downloaded-every-minute-in-2025
- Google Play Payments policy (in-app virtual currency scope, section 5):
  https://support.google.com/googleplay/android-developer/answer/9858738
- App Store Review Guidelines, section 3.1.1 In-App Purchase:
  https://developer.apple.com/app-store/review/guidelines/#in-app-purchase
- Related kit notes: [GAME_SERVICES_BACKEND.md](GAME_SERVICES_BACKEND.md),
  [MONETIZATION_RECOVERY.md](MONETIZATION_RECOVERY.md),
  [NATIVE_DEPLOY_TOOLING_DECISION.md](NATIVE_DEPLOY_TOOLING_DECISION.md)
