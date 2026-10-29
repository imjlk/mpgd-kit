---
npm/@mpgd/game-runtime: minor (Changed)
---

`createGamePlatformRuntime` coordinates purchases on a gateway without an ad provider. When `gateway.ads.provider` is absent but the commerce provider offers `presentation` facts (or the runtime gets a `purchasePresentation` source), `runtime.gateway.commerce` is a `createCoordinatedCommerceProvider` over the runtime's full-screen scope: a purchase owns `runtime.presentation` and blocks simulation, gameplay input and audio from the request until the sheet's `closed` or `not-started` fact, a second purchase is refused `busy` while the sheet is up, and a settled key does not reopen it. Before, only a gateway with an ad provider got this, and a game without ads relied on the gateway's own lifecycle pause. `runtime.actions` keeps its own block on such a gateway. A commerce provider without facts keeps the plain gateway and the earlier behavior.
