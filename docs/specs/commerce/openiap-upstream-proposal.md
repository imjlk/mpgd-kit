# Draft: a Capacitor binding for OpenIAP

Status: draft for the mpgd maintainer. Nothing here has been posted to
`hyodotdev/openiap`. OpenIAP's contribution guide asks for a Discussion
before a new API or package, so this is written as that Discussion's first
post, followed by the smaller core requests found while moving mpgd's two
Capacitor plugins onto the OpenIAP cores
([migration record](openiap-migration.md)).

## Proposal

**Purpose.** A Capacitor plugin that exposes the existing OpenIAP Apple and
Google cores to Capacitor apps, the way `expo-iap`, `react-native-iap`,
`flutter_inapp_purchase`, and `godot-iap` do for their frameworks. It would
reuse `OpenIapModule` and `OpenIapStore` and add no store logic of its own.

**Where it comes from.** mpgd-kit ships two Capacitor plugins for a Phaser
game that sells consumables and non-consumables, verifies every receipt on
its own backend, and grants only through a server ledger. Since mpgd-kit's
OpenIAP migration both plugins call the OpenIAP 4.0.5 (Apple) and 4.0.6
(Google) cores. What has been verified is listed in the migration record:
native unit tests of the mapping, compiled and packed consumer builds, and
the game's checkout and recovery suites. No sandbox purchase has run yet; the
proposal should wait for the game's store acceptance.

**What would move upstream and what stays in mpgd.**

| Generic Capacitor binding (upstream) | mpgd policy (stays in mpgd) |
| --- | --- |
| calls to the public `OpenIapModule` / `OpenIapStore` facades | `StoreSdk` and `CommerceProvider` mapping |
| Capacitor methods and events | logical products and SKU mapping |
| listener and connection lifetime | game account binding and its derivation |
| full canonical `Purchase` serialization, `storeId` included, through the generated types | the server-grant-then-finish policy |
| SwiftPM, Gradle, and Capacitor packaging | journals, the ledger, currency grants |
| examples and native tests for purchase, restore, finish | Apps in Toss, Devvit, and per-game servers |

The binding would round-trip OpenIAP's canonical `Purchase` without picking
fields; mpgd's compact 0.3 payloads would be built outside it.

**Requirements found in practice** (each is detailed below): delivering
revocations, a product type on Apple purchases, a verified-only read that
skips unverifiable entries, a finish that reports whether it found the
purchase, an opt-out of already-owned recovery, an in-app-only ownership
query on `OpenIapStore`, Compose outside the core artifact, and a lighter
SwiftPM checkout.

**Form.** Two options to discuss: an official `capacitor-iap` package in the
monorepo with the parity, example, and conformance obligations of the other
framework libraries, or a community package that depends on the published
cores and follows the Client Protocol. mpgd would maintain the community
option; an official package would need the OpenIAP maintainers' agreement on
ownership of releases, compatibility tests, and issues.

**Protocol range.** Start with the one-time purchase subset of Client
Protocol 1.3 (`initConnection`, `fetchProducts`, `requestPurchase`,
`getAvailablePurchases`, `getPendingTransactionsIOS`, `finishTransaction`,
`restorePurchases`/`syncIOS`, the purchase listeners), generated TypeScript
types from the protocol schema, and native handlers that pass the conformance
suite; subscriptions and alternative billing would follow the parity
checklist later rather than being declared before they work.

## Core requests

1. **Deliver revoked transactions (Apple).** `startTransactionListener`
   skips any transaction with a `revocationDate`. Apps that refund through
   their own server still want the signal so they can re-verify. An opt-in
   listener option (for example `includeRevokedIOS`) or a separate
   revocation event would let mpgd remove its `Transaction.updates` shim.
2. **Product type on `PurchaseIOS`.** The transaction's `productType` is not
   in `PurchaseIOS`, so a consumer cannot tell a consumable from a
   non-consumable (or a non-renewing subscription) without decoding the JWS
   or fetching products. A `productTypeIOS` field would fix that offline.
3. **Verified-only reads.** `getPendingTransactionsIOS` and
   `getAvailablePurchases` throw on the first unverified entry, so one
   unverifiable transaction hides every verified one on that device. An
   option to skip (and report) unverified entries would let apps recover the
   verified ones while still never trusting the rest. mpgd reads
   `Transaction.unfinished`, `currentEntitlements`, and `all` itself for now
   (a read-only shim); this option would let it remove that shim.
4. **Finish result.** `finishTransaction` treats a purchase it cannot find
   as already finished and returns nothing. Returning whether a transaction
   was found and finished would let an id-based API answer precisely.
5. **Already-owned recovery opt-out (Google).** `requestPurchase` answers
   `ITEM_ALREADY_OWNED` with the owned purchase as if it had just been
   bought. A flag to receive the error instead, while still delivering the
   owned purchase to listeners, would keep "purchased now" distinct from
   "owned before".
6. **In-app-only ownership query on `OpenIapStore`.** The facade's
   `getAvailablePurchases` also queries subscriptions; one-time-only apps
   need the provider's `getAvailableItems(InApp)`. Exposing it (or a type
   filter) on the facade would keep consumers on the facade.
7. **Compose outside the core artifact.** `openiap-google` brings Compose
   runtime and UI for `IapContext`. A separate artifact for the Compose
   helper would keep non-Compose apps lighter.
8. **SwiftPM checkout size.** SwiftPM clones the whole monorepo (about
   240 MB) for the Apple core. A thin mirror repository or a smaller tag
   layout for SwiftPM consumers would help CI caches.
9. **Configurable flow hold (Google).** The 15-minute purchase-flow hold is
   fixed; an app with its own shorter timeout cannot release the slot.

## Before posting

- Run the game's store acceptance (sandbox purchases, restore, refund on
  devices) with the OpenIAP engine, and add those results here.
- Decide which core requests to file as separate issues and which to raise
  in the Discussion.
- Name the maintainer for the community-package option.
