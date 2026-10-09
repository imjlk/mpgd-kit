# ONE play

ONE play runs a hosted HTML5 game inside the ONE store app's WebView and hosting iframe. Build with `pnpm build:oneplay`, then run `pnpm smoke:target oneplay`. A generated game uses `pnpm exec mpgd target build oneplay --kit-path <kit> --targets-file ./mpgd.targets.json` and the corresponding `target smoke` command.

## Adapter boundary

Use `createOnePlayPlatformGateway` from `@mpgd/adapter-browser/oneplay`. The adapter loads the official v1.1.0 ESM SDK, registers lifecycle listeners before initialization and initializes before inspecting feature support. SDK imports and bridge actions stay outside scenes. The SDK is created before game construction; `BootScene` reports resource progress and awaits `gameRuntime.completeLoading()` before opening play. A rejected start keeps simulation, gameplay input and audio blocked and can be retried.

`playerId` is a game-specific pseudonym: the gateway reports `platform-anonymous` / `platform-asserted`, never a verified login. Authenticate game-services requests with a game-owned server session. SDK identity alone cannot authorize access to another player's saves or ledger.

The adapter supplies locale, ringer mute policy and initial safe-area insets. Host mute uses a separate execution block, so changing an in-game setting cannot override it. Pause/resume events are retained across initialization. Exit listeners are synchronous checkpoints: save through `storage.saveSync` in less than 500 ms. The starter checkpoints its local run state; server saves must happen at earlier checkpoints. Storage is partitioned by platform player ID and is local, not cloud storage. Back handlers must return exactly `true` synchronously; async handlers cannot consume the ONE play back event. Dispose the gateway lifecycle when the owning document is torn down.

## Ads

The default target disables monetization until game-owned configuration is ready. Request a ONEconsole placement ID for each format, add the ID to the game's ad catalog under `platformPlacementIds.oneplay`, then enable the corresponding target feature and monetization policy. The SDK supports rewarded and interstitial formats; banners are unsupported.

Interstitials map logical placements to issued IDs. Invocation replay cannot reopen SDK UI, and native fullscreen ownership is shared across gateway instances. `no_fill` never grants a reward. A timeout, transport failure or unknown result keeps the presentation uncertain and prevents another native request for the lifetime of that SDK instance. Do not clear ownership because of `resume`: v1.1.0 synthesizes that event in a `finally` block even on timeout, while the public guide allows late native display. Reload the document to recover an unresolved native UI; do not retry automatically.

Rewarded grants and purchases require independent server verification. `authoritativeGameServices: true` is a policy opt-in, not proof or authentication. Missing server integrations must remain unavailable. The next integrations use server-issued reward request IDs / checkout payloads and the backend ledger; a client callback never credits durable state.

## Hosting and real-app tests

The artifact is non-installable. Register an HTTPS execution URL with HTTP 200 and TLS 1.2 or newer in ONEconsole. `_headers` includes a `Content-Security-Policy: frame-ancestors https://*.onestore.co.kr https://*.onestore.net` rule for compatible static hosting providers. Other servers must configure the equivalent HTTP response header themselves. An HTML meta tag cannot apply this policy. Verify the final CDN/WAF response and every ancestor; artifact smoke does not prove live hosting is configured.

Register the test URL and test account, then open ONE store → My → Usage information → Web game test → My test games. Browser fixtures check gateway contracts and gameplay, but actual SDK ads, payments, app lifecycle and hosting validation need the real app. No public test placement IDs are provided; ONEconsole placement provisioning is required.

## Official references

- [SDK overview](https://onestore-dev.gitbook.io/dev/tools/web-sdk/ov)
- [Prerequisites and iframe requirements](https://onestore-dev.gitbook.io/dev/tools/web-sdk/pre)
- [Lifecycle, exit and back](https://onestore-dev.gitbook.io/dev/tools/web-sdk/lifecycle)
- [Advertising](https://onestore-dev.gitbook.io/dev/tools/web-sdk/iaa)
- [Advertising placement setup and signed SSV](https://onestore-dev.gitbook.io/dev/docs/apps/product/monetization/iaa)
- [IAP](https://onestore-dev.gitbook.io/dev/tools/web-sdk/iap)
- [Purchase server API](https://onestore-dev.gitbook.io/dev/tools/billing/v21/serverapi)
- [PNS](https://onestore-dev.gitbook.io/dev/tools/billing/v21/pns)
- [Real-app testing](https://onestore-dev.gitbook.io/dev/tools/web-sdk/test)
- [Release notes](https://onestore-dev.gitbook.io/dev/tools/web-sdk/releasenote)
