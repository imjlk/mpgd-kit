---
npm/@mpgd/platform: minor
---

Commerce v2, PR C1: the conformance runner accepts the runtime under test.

`runCommerceConformanceVector` and `runCommerceConformanceVectors` gain
`options.createRuntime(input, context)`, which builds the runtime a vector
drives (`CommerceConformanceRuntime`) over the harness provider, the fake
backend, and the reference journal in place of the reference reconciler
(`createCommerceConformanceRuntime`). `@mpgd/game-services` uses it to run
the fourteen vectors through its `createCommerceReconciler`. The reference
run an adaptive vector's expectations are derived from keeps using the
reference reconciler, so a derived expectation never depends on the runtime
under test.

`createDerivedPurchaseIdempotencyKey` percent-encodes the Apps in Toss order
id (`apps-in-toss:purchase:<encodeURIComponent(orderId)>`), which is the
byte-for-byte form of the v1 `createAppsInTossPurchaseIdempotencyKey` helper
in `@mpgd/game-services`; ids without reserved characters are unchanged.
`CommerceProvider.finishTransaction` documents that it is called again after
a crash between a successful finish and its journal write, so it must be
idempotent per transaction.
