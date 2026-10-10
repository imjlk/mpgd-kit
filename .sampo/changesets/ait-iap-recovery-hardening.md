---
npm/@mpgd/adapter-ait: minor
npm/@mpgd/platform: minor
---

Harden the built-in Apps in Toss purchase flow with recovery rules proven by a
production game. Purchase verifiers now receive the game's own purchase key as
`clientIdempotencyKey` on every path that can link an order to it, including
restore after a reload. A new checkout is no longer opened while a paid order
for the same product is still ungranted, only one checkout runs at a time
(restore waits its turn with a retryable code), and a `PRODUCT_NOT_GRANTED_BY_PARTNER`
error triggers one direct re-check of that order. Restore returns
`settledPurchases` and reports failures as coded errors instead of an empty
success. Catalog and purchase outcomes carry stable diagnostic codes
(`aitIapDiagnosticCodes`). Add `aitBrowserOrigins()` and `isAitBrowserOrigin()`
(`@mpgd/adapter-ait/origins`) for exact CORS allowlists. `@mpgd/platform` adds
the optional `CommerceDiagnostic` type, `diagnostic` fields on purchase and
restore results, and `idempotencyKey` on `PurchaseSettlement`.
