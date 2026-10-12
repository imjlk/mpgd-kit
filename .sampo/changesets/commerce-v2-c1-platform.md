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
