# Store product sync (`mpgd store products`)

A purchase works only after its product exists in the store, with a title,
a description and a price. `mpgd store products plan|apply` creates and
updates the store's one-time products (consumables and non-consumables) from
the game's files, so the products do not have to be typed into Play Console
by hand. Subscriptions stay outside the sync
([subscription decision](./SUBSCRIPTION_COMMERCE_DECISION.md)).

Supported stores: Google Play (`--store google-play`). App Store Connect
in-app purchases are declared in the same file; their sync is a follow-up.

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
        },
        "multiQuantity": true
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
- `googlePlay.productTaxCategoryCode`, `multiQuantity`: optional; Play's
  defaults apply when absent.
- `appStore.*`: base territory (ISO 3166-1 alpha-3) and customer price,
  manual `territories` prices, review note, review screenshot (relative to
  the listing file) and `familySharable` (non-consumables only).

`assertStoreListingCatalog` in `@mpgd/catalog` validates the file against
the catalog: every key must be a catalog product, and subscriptions are
rejected.

## Workflow

The app ID and the store credential come from the deployment profile
(`mpgd.deploy.json` and `mpgd.targets.json`), the same ones
`mpgd deploy submit` uses: for Google Play the service account file named by
the profile's `submissionCredential.env` (default
`MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT`). That account also needs a Play Console
permission that covers in-app products (see the first-live-run checks).

```sh
# Read Play, print the changes, save the plan; nothing is written.
pnpm exec mpgd store products plan --game . --store google-play --out products-plan.json

# Write exactly what was reviewed.
pnpm exec mpgd store products apply --plan products-plan.json --approve
```

`plan` lists each catalog product sold on the target:

- `create`: not on Play yet.
- `update`: with the fields that change (`listings`, `prices`,
  `purchase-option`, `multi-quantity`, `tax-category`, `activate`).
- `unchanged`.
- `skipped`: no listing entry, a subscription, or no price to create with.
- `remote`: on Play but named by no catalog product. Never deleted.

Listing languages, purchase options and regions that the file does not name
are kept as they are on Play.

`apply`:

- needs `--approve`;
- reads Play again and refuses when a product's Play state or its planned
  write differs from the saved plan (someone edited it in Play Console, or
  the files changed): run `plan` again and review;
- skips products an earlier apply already wrote, so re-running it is safe;
- activates new and `DRAFT` purchase options, so the product can be bought;
  an `INACTIVE` option is reported and never reactivated;
- refuses a price change on a product whose purchase option is `ACTIVE`
  unless `--confirm-price-change` is given. `plan --keep-live-prices` leaves
  live prices as they are instead. Play's converted prices follow its
  exchange rates, so a later plan can show a price change for a live product
  even when the file did not change; read it before confirming.

If a write fails, the error names the products already written. Run `plan`
again: it reads Play and shows what is left.

## What stays manual

- Creating the app and the payments profile (Play needs a merchant account
  before it sells anything).
- Deleting products or purchase options, discounted, pre-order and rental
  offers, and per-region availability other than "available".
- Reactivating an `INACTIVE` purchase option.
- License testers.

## API references

- [`monetization.onetimeproducts`](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts)
  (resource, purchase option states, field limits)
- [`onetimeproducts.patch`](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts/patch)
  (`allowMissing`, `updateMask`, `regionsVersion`)
- [`purchaseOptions.batchUpdateStates`](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts.purchaseOptions/batchUpdateStates)
- [`monetization.convertRegionPrices`](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization/convertRegionPrices)
- [Multiple purchase options and offers](https://developer.android.com/google/play/billing/one-time-product-multi-purchase-options-offers)
  (backward-compatible buy option)

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

## Tests

```sh
pnpm smoke:cli-store-products
```

Runs the planner and apply against an in-memory Play
(`packages/cli/src/store-products-play.test.ts`) and the SDK adapter against
a local mock of the REST paths (`adapters/play-publisher/src/play-products.test.ts`).
No Google endpoint is called.
