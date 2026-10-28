---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/bridge: minor (Added)
---

Purchase presentation facts get their own bridge event protocol, `mpgd.commerce.presentation.v1`. `@mpgd/platform/commerce` adds `commercePresentationProtocol`, `CommercePresentationEvent`, `CommercePresentationEventEnvelope`, their typia asserts, and their JSON Schemas; `@mpgd/bridge` adds `BridgeCommercePresentationEvent` to `BridgeEvent`, `bridgeCommercePresentationEventProtocol`, and a `createBridgeEventSource` overload. It is not a `CommerceEvent` type, so a consumer built before it skips the envelopes as another protocol's.

`PlatformPurchasePresentationEvent` gains an optional `reason` (`timeout`, `interrupted`, `disposed`) for a `closed` fact no native observation proved, and the `CommerceProvider.presentation` contract now states that a provider answers every `requestPurchase` with facts: `not-started` before the answer when no surface opened, otherwise `open` and exactly one `closed`.

`@mpgd/platform` also exports the pure helpers a provider or a wrapper uses for these facts: `createPurchasePresentationChannel` (publishes numbered facts, isolating a failing listener), `createPurchasePresentationRelay` (relays a source's facts, drops a superseded one, numbers them again, and reports `not-started` for a purchase the wrapper answered before its source ran), and `createPurchasePresentationSequenceGuard` (bounded memory: ended keys are kept in a list of the most recent 1024).
