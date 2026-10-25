# Monetization observability

`createMonetizationAttempt` from `@mpgd/analytics` gives game and host composition roots a
portable diagnostic contract. It has no platform SDK, DOM, transport, storage or identity dependency.
It can wrap AIT, Microsoft Store, Play Billing or StoreKit work without changing their authority.

Generate a fresh random diagnostic operation ID for each attempt. Do not reuse a player ID,
order ID, receipt, purchase token or grant idempotency key. Map logical products and stable error
codes explicitly; never spread SDK payloads or exception messages into analytics.

Use identity/catalog/checkout/verification/fulfillment/confirmation stages for IAP; eligibility,
claim/finalization/recovery for retention. `finish` is idempotent and ignores subsequent stages.
A new retry uses a new diagnostic ID. The business idempotency key remains separate and unchanged.

The observer is optional and best effort. Synchronous exceptions, rejected promises and broken clocks
are isolated; returned observer promises are never awaited. Keep the callback lightweight: synchronous
work still runs on the caller's thread. An invalid, throwing or backwards-before-start clock yields
`elapsedMs: null`, not a zero-latency performance claim. Prefer a monotonic clock. When mapping to
`AnalyticsReporter` properties, omit an unknown duration rather than passing null or substituting zero.
The caller owns transport buffering, privacy policy, launch-channel classification and build context.
Test/live/unknown describes known execution configuration: a public-build QR test is not necessarily
distinguishable from a public launch. Do not infer it from undocumented hostnames.

A client success is never an entitlement or revenue. Keep authoritative grants in game-services,
collect server verification/fulfillment observations separately, and reconcile money against the
store/order ledger. Do not grant a purchase, reward or attendance credit inside an observer.

Keep duplicates, sampled data, legacy missing IDs and requests without an observed result visible.
Missing results can be pending, delayed or outside the reporting window; do not classify them as
failed purchases. These diagnostics are not an accounting ledger or guaranteed audit log.

## Adoption boundary

This API is opt-in. It does not automatically instrument a provider adapter, send an event to a sink,
modify an existing `AnalyticsEvent`, or add a backend dataset. A composition root supplies its own
observer and clock, assigns a fresh ID, and records stages at boundaries it actually observes.
Do not report verification/fulfillment from a checkout-success callback alone.

Each emitted observation includes the operation ID, operation, stage, status, known mode, elapsed
milliseconds and a zero-based sequence. Optional logical product IDs and stable uppercase error
codes are bounded. Invalid operation/product metadata disables observations; this lexical check is
not a secret detector, so integrations must still use an explicit allowlist. Metadata is snapshotted
at creation. Finishing closes the attempt before notifying observers, including reentrant callbacks.

Catalog, purchase and restore are distinct operations; attendance and promotion have their own
eligibility/claim/finalization stages. A retry starts a new diagnostic attempt while the authority's
existing idempotency key remains unchanged. Use `stage(..., 'pending')` if this same attempt will
continue later, or `finish(..., 'pending')` when its observation window ends; pending is not failure.

## Local validation

Build the published JS before the package tests, as CI does:

```sh
mise exec -- pnpm build:packages @mpgd/analytics
mise exec -- pnpm --dir packages/analytics check
mise exec -- pnpm --dir packages/analytics test
```

The final test deliberately uses plain Node without a TypeScript loader to verify the public
package entry and preserve existing reporter exports. Source-only tests cannot catch missing ESM
extensions in published re-exports.
