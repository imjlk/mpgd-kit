# Review requests across hosts

Games call an optional `PlatformGateway.reviews`. They never import review SDKs in scenes.
Compose the provider at the target boundary, then pass it through `withTargetAvailability`.
Set `integrations.reviews` to `available` explicitly; old matrices default to `disabled`.
All other states hide both the provider and its capability block.

## Two distinct operations

- `requestNative()` asks the host to consider its own review UI. `requested` means only that the API resolved. It does not prove display, rating, dismissal or submission.
- `openPage()` navigates to the registered game's store page from an explicit user click. `opened` means the navigation request was accepted, not that a review was written.

`nativePrompt` and `reviewPage` are separate capabilities. An absent provider means unsupported. A future provider can use a new `providerId` without adding a platform enum or changing game scenes. SDK exceptions become `failed`; unavailable methods return `unavailable`. Never unlock rewards or gameplay based on either outcome.

## Platform adapters

| Distribution | Adapter import | Capability |
| --- | --- | --- |
| Apps in Toss | `@mpgd/adapter-ait/reviews` | `createAitReviewProvider` uses SDK 3.6 `Review.request` and `isSupported` |
| Google Play | `@mpgd/adapter-capacitor/reviews` | `createCapacitorReviewProvider({store:'google-play'})`: native request and listing |
| Apple App Store | same | `store:'apple-app-store'`; registered numeric `appId` enables listing; native request needs no listing ID |
| Microsoft Store | `@mpgd/adapter-browser/reviews` | `createMicrosoftReviewProvider`: explicit `ms-windows-store://review/?ProductId=…`; host availability and navigation are injected |
| ONE store H5 / oneplay | same | `createOneStoreReviewProvider`: unsupported until a registered game listing and host-approved opener are supplied |
| Verse8 | same | `createVerse8ReviewProvider`: same explicit listing path; never review the host app on the game's behalf |
| Generic web, Devvit, other hosts | no provider | No native prompt, no fabricated store URL |

ONE store H5 and Verse8 do not have a review prompt API in the SDK materials checked on 2026-10-26. This is an unverified capability, not a permanent platform prohibition. Only add a native implementation when documented. Listing helpers accept HTTPS URLs on explicitly allowed origins; the consuming game must confirm that host navigation and listing are permitted.

For Capacitor install `@capawesome/capacitor-app-review@8.1.0`, run native sync and rebuild. It is an optional peer of the adapter and imported only from `/reviews`. Android OS detection alone is insufficient: an APK distributed through another store must not call Google Play reviews. No custom native bridge is needed. Native display and store navigation still require device acceptance on the actual distribution build.

## Courtesy policy and game wiring

`@mpgd/platform/reviews-runtime` contains `createReviewController`. Supply `StorageAdapter`, a game/target scope, and product-owned positive integer policy values. A starting policy can use two visits, three completed plays and thirty days between requests; these are game choices, not host quotas.

Create one controller per runtime. Call `completedPlay(attemptId)` once for every completed run, regardless of win, rating or satisfaction. Duplicate result rendering must reuse the same attempt ID. At a safe menu transition call `consider(() => stillSafe())` without awaiting it in navigation. The callback must exclude active play, payments, ads, dialogs, hidden documents and stale routes. Safety is checked again after persistence. Dispose the controller with the game runtime.

The controller persists the request time before invoking the host, allows at most one request per runtime, suppresses automatic requests on storage failure or corrupt state, and keeps its persistence queue usable even if the host request promise never resolves. Unsupported hosts do not read or write review state. A provider unavailable at construction needs a new controller once it becomes ready; it cannot overwrite a previously unread saved cooldown.

Storage is device-local courtesy, not a cross-tab transaction or cross-account quota. Host fatigue rules remain authoritative. Do not clear this state on an ordinary restart. Do not use an app-local storage substitute on AIT when the gateway offers durable host storage.

Do not automatically open store links, ask whether someone likes the game before choosing whom to request reviews from, or tie requests to rewards. A manually selected review action should open a supported store page; it should not promise a quota-limited native dialog.

## Verification and telemetry

Provider and controller tests: `pnpm --filter @mpgd/platform exec vitest run src/reviews.test.ts` (build platform first for adapter tests). Each adapter has `src/reviews.test.ts`. Target gating regression: `node tools/run-ttsx.mjs packages/target-config/test/reviews-gating-smoke.ts`. Graph: `pnpm graph:inspect --preset reviews`, also included by graph preflight.

Observe only `request`, `requested`, `failed` and `storage-unavailable`. Never label these counts as reviews, conversions or ratings. Current game deployments are not automatically changed by this module.

Sources checked: [AIT reviews](https://developers-apps-in-toss.toss.im/documentation/common/growth/review.md), [Capawesome App Review](https://capawesome.io/docs/sdks/capacitor/app-review/), [Google review guidance](https://developer.android.com/guide/playcore/in-app-review), [Apple review guidance](https://developer.apple.com/documentation/storekit/requesting-app-store-reviews), [Microsoft Store navigation](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-store-app), [ONE store Web SDK](https://onestore-dev.gitbook.io/dev/tools/web-sdk).
