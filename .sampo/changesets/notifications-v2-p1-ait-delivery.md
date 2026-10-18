---
npm/@mpgd/game-services: minor
---

Add `@mpgd/game-services/notifications/ait-functional-delivery`: `createAitFunctionalMessageDeliveryProvider` sends one Apps in Toss functional message per recipient over an injected mTLS fetcher (a Workers mTLS binding) and answers the notifications v2 provider answers: 4095 is `rate-limited` with `retryAfterSeconds`; 5004, 4034, and 4010 are `rejected` for configuration; `HTTP_TIMEOUT`, `NETWORK_ERROR`, `EXECUTION_FAIL`, `INTERRUPTED`, `INTERNAL_ERROR`, HTTP 5xx, and transport failures are `ambiguous`; a `SUCCESS` answer is `accepted` when any channel sent the message and otherwise rejected per its channel failures. Deployments name the recipient-level and missing-agreement codes they observe, which the partner API does not document.
