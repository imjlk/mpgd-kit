---
npm/@mpgd/game-runtime: minor
---

BREAKING: commerce v2, PR C4. `createCoordinatedPlatformGateway` coordinates the
commerce provider's `requestPurchase` instead of the removed v1 `purchase`, and
holds a purchase lease only when a trusted release source exists.

- The wrapper intercepts `gateway.commerce.requestPurchase` and keeps its
  duplicate-key, busy, and key-history guards. Its fingerprint is now the
  `logicalId`, `source`, `offerId`, and `quantity` of the request; the input
  carries `logicalId` where v1 carried `productId`.
- `classifyPurchasePresentation` receives the provider's `RequestPurchaseResult`
  (`launched`, `purchased`, `cancelled`, or `failed`) instead of a platform
  `PurchaseResult`.
- A lease is held only when a trusted source can release it: the provider's own
  `presentation` facts (`CommerceProvider.presentation`), the
  `purchasePresentation` option, or a `classifyPurchasePresentation` function.
  With none of them `gateway.commerce` is forwarded unchanged and acquires no
  lease, because a purchase result alone left presentation `unknown` for the
  rest of the session and blocked every ad. A gateway without a commerce
  provider stays without one (`gateway.commerce` is optional).
