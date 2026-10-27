---
npm/@mpgd/catalog: minor (Added)
---

New store listing file for one-time products (`StoreListingCatalog`, validated by `assertStoreListingCatalog(input, catalog)`): per logical product, the localized title and description, a Google Play tax-exclusive base price with optional per-region prices, purchase option ID and tax category, and for the App Store the base-territory customer price, manual territory prices, reference name, review note, review screenshot and Family Sharing. It is a separate file from `catalog.json` (game clients bundle the catalog; review notes and prices must not ship), every key must name a catalog product, and subscriptions are rejected. `resolveStoreListingLocalizations(entry, store)` returns a store's own localizations or the shared ones. Existing catalogs are unchanged.
