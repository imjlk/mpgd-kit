---
npm/@mpgd/game-services: minor
---

Add the notifications v2 server as `@mpgd/game-services/notifications`: a provider registry whose entries are the policy gate's only capability input, with per-target topic mappings when two targets share a provider (FCM on `android` and `ios`); an endpoint registry bound to the game-services session, with dead and stale endpoints; append-only consent records dated by the backend; the notices API; and sends through the idempotency ledger, `evaluateNotificationDelivery`, device fan-out (inline or through a dispatch queue that runs the gate at the provider call), the five provider answers with rate-limit backoff, due-row replays, and retention purges. `createInMemoryNotificationStore` is the reference store. The service passes every server conformance vector except those that need the S2 scheduler. The v1 `notification-delivery` module is unchanged.
