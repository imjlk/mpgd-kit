---
npm/@mpgd/platform: minor
---

Commerce v2, PR A3b: profile-adaptive conformance vectors in
`@mpgd/platform/commerce-conformance` and `@mpgd/platform/commerce-vectors`.

A vector may set `profile.adaptive: true` (nine lifecycle vectors do:
`purchase-client-finish`, `purchase-server-finish`, `purchase-host-finish`,
`purchase-pending-then-purchased`, `restart-before-verify`,
`event-before-listener`, `finish-failure-retry`, `revoked-after-grant`, and
`cancelled-and-failed`). When `runCommerceConformanceVector(s)` runs such a
vector with `options.createProvider`, it reads the provider's
`getCapabilities()` and derives `journal`, `finishCalls`, `verifyRequests`,
and `available` from a reference run under the provider's declared store id
and capabilities instead of the vector's fixture profile: the journal tail
after `granted` is `finishing, finished` for `client`, `host`, and `server`
owners and `finished` for `none`; `finishCalls` carry `by` the owner for
`client` and `host` and are empty for `server` and `none`; a `server` owner
adds one verify request per grant whose first response did not already
report `finalization: 'completed'` (the reconciler's finalization re-read,
answered by an auto-queued completed decision); `available` is empty after
finish for every owner. Owner-independent fields keep the fixture
expectation, and the reference harness ignores the flag, so the fourteen
committed vectors pass unchanged.

`CommerceConformanceVectorResult` gains `status: 'passed' | 'failed' |
'skipped'`, `reason` for skipped vectors, and `adaptive` (the derived
expectation, store id, finish owner, and evidence authority) for adaptive
runs. A skipped vector has `passed: false` and no failures. The runner skips
a vector when a store-side `pending` purchase needs `lifecycle.pending`, a
store `error` event needs `lifecycle.events`, or a `queueFinish` script needs
a `client` or `host` finish owner, and it runs only one member of the
`purchase-<owner>-finish` family per run (the one named after the provider's
owner, else the first by name), reporting the others as duplicates. New
exports: `isAdaptiveCommerceConformanceVector`,
`commerceConformanceAdaptiveSkipReason`,
`deriveAdaptiveCommerceConformanceExpectation`,
`CommerceConformanceVectorStatus`, `CommerceConformanceAdaptation`, and
`CommerceConformanceResolvedExpectation`. The `CommerceConformanceVector`
JSON Schema includes the new optional `profile.adaptive` field.
