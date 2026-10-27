# Store product sync (`mpgd store products`)

A purchase works only after its product exists in the store, with a title,
a description and a price. `mpgd store products plan|apply` creates and
updates the store's one-time products (consumables and non-consumables) from
the game's files, so the products do not have to be typed into Play Console
and App Store Connect by hand. Subscriptions stay outside the sync
([subscription decision](./SUBSCRIPTION_COMMERCE_DECISION.md)).

Supported stores: Google Play (`--store google-play`) and App Store Connect
(`--store app-store`, iPhone and iPad share the in-app purchases).

## The store listing file

The product catalog (`mpgd.catalog.json`) keeps the product IDs, kinds and
grants. Store text and prices go in a second file next to it,
`mpgd.store-listings.json`, keyed by the catalog's logical product ID. It is
a separate file because game clients bundle the catalog: review notes and
pricing never ship to players, and the game runtime never reads this file.

```json
{
  "version": "2026-10-27",
  "products": {
    "COINS_100": {
      "localizations": {
        "en-US": { "title": "100 coins", "description": "A small pile of coins." },
        "ko-KR": { "title": "코인 100개", "description": "코인 한 줌." }
      },
      "googlePlay": {
        "price": {
          "base": { "currency": "USD", "amount": "0.99" },
          "regions": { "KR": { "currency": "KRW", "amount": "1500" } }
        }
      },
      "appStore": {
        "localizations": {
          "en-US": { "title": "100 coins", "description": "A small pile of coins." },
          "ko": { "title": "코인 100개", "description": "코인 한 줌." }
        },
        "price": { "baseTerritory": "USA", "customerPrice": "0.99" },
        "reviewNote": "Open the shop from the title screen.",
        "reviewScreenshot": "store/review/coins_100.png"
      }
    }
  }
}
```

- `localizations`: title and description per BCP-47 language. A store's own
  `localizations` replaces the shared map for that store (Play writes
  `ko-KR`, App Store Connect `ko`).
- Amounts are decimal strings, never JSON numbers.
- `googlePlay.price.base` is the **tax-exclusive** price that Play converts
  into every region (`monetization.convertRegionPrices`). `regions` replaces
  the converted price of single regions (ISO 3166-1 alpha-2), each in that
  region's currency. Play needs a base price to create a product; without
  one the sync only updates the text of an existing product.
- `googlePlay.purchaseOptionId`: the purchase option the sync manages.
  Defaults to the product's only buy option, or `buy` for a new product.
- `googlePlay.productTaxCategoryCode`: optional; when absent the product
  keeps its Play category (Play's default for a new product), and the price
  conversion uses that category.
- Multi-quantity checkout stays off: the kit backend grants one unit per
  purchase and rejects larger quantities, so the sync turns it off on a
  managed option where it was turned on in Play Console.
- `appStore.price`: `baseTerritory` (ISO 3166-1 alpha-3) and the customer
  price there, which must be one of Apple's price points; Apple equalizes
  the other territories from it. `territories` sets manual customer prices
  that replace the equalized price of single territories.
- `appStore.referenceName` (defaults to the logical ID, 64 characters),
  `reviewNote` (4,000), `reviewScreenshot` (PNG or JPEG, relative to the
  listing file), `familySharable` (non-consumables only; cannot be turned
  off again), `availability` (`territories`, `availableInNewTerritories`;
  default every territory and new ones).
- App Store display names are 2-30 characters and descriptions up to 45;
  Play titles up to 55 and descriptions up to 200. The plan refuses longer
  text before any write.

`assertStoreListingCatalog` in `@mpgd/catalog` validates the file against
the catalog: every key must be a catalog product, and subscriptions are
rejected.

## Workflow

The app and the store credential come from the deployment profile
(`mpgd.deploy.json` and `mpgd.targets.json`), the same ones
`mpgd deploy submit` uses:

- Google Play: the package ID, and the service account file named by the
  Android profile's `submissionCredential.env` (default
  `MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT`). That account also needs a Play
  Console permission that covers in-app products (see the first-live-run
  checks).
- App Store Connect: the bundle ID, `MPGD_ASC_APP_ID`, `MPGD_ASC_KEY_ID`,
  `MPGD_ASC_ISSUER_ID`, the iOS profile's `submissionCredential.env` (the
  base64 `.p8`) and `MPGD_ASC_BINARY`, the pinned `asc` 5.5.0 the TestFlight
  submission uses ([tooling decision](./NATIVE_DEPLOY_TOOLING_DECISION.md)).
  The key needs the App Manager role.

```sh
# Read the store, print the changes, save the plan; nothing is written.
pnpm exec mpgd store products plan --game . --store google-play --out play-products.json
pnpm exec mpgd store products plan --game . --store app-store --out app-store-products.json

# Write exactly what was reviewed.
pnpm exec mpgd store products apply --plan play-products.json --approve
pnpm exec mpgd store products apply --plan app-store-products.json --approve
```

`plan` lists each catalog product sold on the target:

- `create`: not in the store yet.
- `update`: with the fields that change.
- `unchanged`.
- `skipped`: no listing entry, a subscription, or (Play) no price to create with.
- `remote`: in the store but named by no catalog product. Never deleted.
- `manual` (App Store): what the reviewer does in App Store Connect.

`apply` is the same for both stores:

- needs `--approve`;
- reads the store again and refuses when a product's store state or its
  planned write differs from the saved plan (someone edited it in the
  console, or the files changed): run `plan` again and review;
- skips products an earlier apply already wrote, so re-running it is safe;
- refuses a price change on a product players can buy (Play `ACTIVE`
  purchase option, App Store `APPROVED` in-app purchase) unless
  `--confirm-price-change` is given; `plan --keep-live-prices` leaves live
  prices as they are instead;
- on a failed write, names the products already written. Run `plan` again:
  it reads the store and shows what is left.

## Google Play

Changes: `listings`, `prices`, `purchase-option`, `multi-quantity`,
`tax-category`, `activate`.

Listing languages and purchase options that the file does not name are kept
as they are on Play. Prices follow the file: every region Play's conversion
covers gets the converted price (or the file's regional price), so a price
typed into Play Console for one region is replaced unless the file names
that region too. A region's availability (for example `NO_LONGER_AVAILABLE`)
and an existing option's choice about regions Play launches later stay as
Play has them; regions the conversion does not list are kept. Each price
change is printed with its old and new value, and the plan file lists all of
them.

`apply` activates new and `DRAFT` purchase options that have prices, so
the product can be bought; an `INACTIVE` option is reported and never
reactivated. Play's converted prices follow its exchange rates, so a later
plan can show a price change for a live product even when the file did not
change; read it before confirming.

What stays manual on Play:

- Creating the app and the payments profile (Play needs a merchant account
  before it sells anything).
- Deleting products or purchase options, discounted, pre-order and rental
  offers, and per-region availability other than "available".
- Reactivating an `INACTIVE` purchase option.
- License testers.

### Google Play API references

- [`monetization.onetimeproducts`](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts)
  (resource, purchase option states, field limits)
- [`onetimeproducts.patch`](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts/patch)
  (`allowMissing`, `updateMask`, `regionsVersion`)
- [`purchaseOptions.batchUpdateStates`](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts.purchaseOptions/batchUpdateStates)
- [`monetization.convertRegionPrices`](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization/convertRegionPrices)
- [Multiple purchase options and offers](https://developer.android.com/google/play/billing/one-time-product-multi-purchase-options-offers)
  (backward-compatible buy option)

## App Store Connect

Changes: `create`, `reference-name`, `family-sharing`, `version`,
`localizations`, `prices`, `availability`, `review-screenshot`.

- **Localizations** belong to the in-app purchase version (App Store
  Connect API 4.4.1). The sync edits the one version that still accepts
  edits (`PREPARE_FOR_SUBMISSION`, `READY_FOR_REVIEW`, `REJECTED`,
  `DEVELOPER_REJECTED`). When the latest version is approved, `apply`
  creates a new draft version (App Store Connect copies the current
  metadata into it) and changes only the differing locales; that version
  needs App Review. While a version waits for or is in review, text changes
  wait. Two editable versions stop the plan. Locales the file does not name
  are kept.
- **Prices**: a new price schedule effective now, with the base territory's
  price point and the manual territory prices. The new schedule replaces
  the old one: a manual price for a territory the file does not name goes
  back to Apple's equalized price (the plan shows it as `-> equalized`).
  When App Store Connect holds a price change scheduled for a later date,
  or a temporary price that ends later, the sync leaves the prices alone
  and says so, because a new schedule would drop it. Apply resolves each price point by territory and customer
  price; a price that is not an App Store price point fails before the
  schedule is written. "On sale", for `--confirm-price-change`, means the
  in-app purchase or any of its versions was approved.
- **Availability** is set when there is none (a new in-app purchase). After
  that it changes only when the file names `appStore.availability` and it
  differs; the plan prints the territory count. A file availability must
  include every priced territory.
- **Review screenshot**: uploaded when missing; when its MD5 differs from
  the file, or App Store Connect reports its delivery `FAILED` or still
  awaiting upload, the old one is deleted and the new one uploaded (App
  Store Connect keeps one). The screenshot must stay inside the listing
  file's directory, symbolic links included.
- **Never automatic**: submission. The first consumable and the first
  non-consumable must each go to App Review with a new app version; later
  ones can be submitted on their own
  ([Submit an In-App Purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase)).
  The plan prints this as a manual step.
- **Review note**: `asc` 5.5.0 has no flag for it, so a differing review
  note is printed as a manual step with the text to paste.

What stays manual on the App Store:

- Paid Apps agreement, tax and banking.
- Submitting the in-app purchases (with the app version the first time).
- The review note.
- Turning Family Sharing off (Apple does not allow it), changing an in-app
  purchase's type, deleting in-app purchases, offer codes, promotional
  images, and availability changes after the first submission.
- Sandbox testers.

### App Store Connect API references

- [In-App Purchases (v2)](https://developer.apple.com/documentation/appstoreconnectapi/in-app-purchases)
- [In-App Purchase versions](https://developer.apple.com/documentation/appstoreconnectapi/in-app-purchase-versions)
  and [API 4.4.1 release notes](https://developer.apple.com/documentation/appstoreconnectapi/app-store-connect-api-4-4-1-release-notes)
  (version-scoped localizations; v1 localizations deprecated)
- [Price schedules](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-inapppurchasepriceschedules)
  ("A base territory is now required")
- [Availability](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-inapppurchaseavailabilities)
- [Review screenshot](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-inapppurchaseappstorereviewscreenshots)
- [In-App Purchase information](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-information)
  (field limits)
- `asc` 5.5.0 commands: `commands/iap.mdx` and `internal/cli/iap/*` at the
  [5.5.0 tag](https://github.com/rorkai/App-Store-Connect-CLI/tree/5.5.0)

## Verify on the first live run

Mock-tested only. Check on the first run against a real Play account:

- [ ] A product created by `patch` with `allowMissing` starts with its
      purchase option in `DRAFT`, and `batchUpdateStates` activation makes it
      purchasable from a license-tester build.
- [ ] The converted regional prices (tax inclusive, per the
      `convertRegionPrices` reference) are what Play Console then shows, and
      a second `plan` reports the product `unchanged`.
- [ ] A product created earlier in Play Console (or through the older
      `inappproducts` API) is listed with one buy purchase option, and the
      sync picks it as the managed option.
- [ ] The service account permission needed for `onetimeproducts` writes.

And against a real App Store Connect app:

- [ ] `asc iap create` provisions the first in-app purchase version, or the
      sync's `versions create` does; localizations land on it.
- [ ] `asc iap pricing schedules view` on an in-app purchase without a price
      exits with code 4 (not found) or prints no resource, which the sync
      reads as "no schedule"; `asc iap pricing availability view` without
      availability exits naming "has no availability configured".
- [ ] `asc iap review-screenshots view` without a screenshot exits with code
      4 or returns no resource.
- [ ] A new in-app purchase with localization, price, availability and
      screenshot reaches `READY_TO_SUBMIT`, and a second `plan` reports it
      `unchanged`.
- [ ] Editing the text of an approved in-app purchase creates version 2 with
      the copied locales, and only the changed locale is updated.

## Tests

```sh
pnpm smoke:cli-store-products
```

Runs the planner and apply against an in-memory Play
(`packages/cli/src/store-products-play.test.ts`) and the SDK adapter against
a local mock of the REST paths (`adapters/play-publisher/src/play-products.test.ts`),
then the App Store Connect planner and apply against an in-memory App Store
Connect and the `asc` command lines and output parsing against recorded
`asc` 5.5.0 output shapes (`packages/cli/src/store-products-app-store.test.ts`).
No Google or Apple endpoint is called, and no `asc` binary runs.
