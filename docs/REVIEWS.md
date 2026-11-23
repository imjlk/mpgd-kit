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

`@mpgd/platform/reviews-runtime` decides when to ask. `createReviewController` keeps the courtesy policy; `createReviewSession` and `createReviewMoments` connect it to a game's finished plays and settled screens. Generated games do not wire reviews yet: add the provider at each target bootstrap and the moments at runtime start.

```ts
import { createReviewMoments, createReviewSession } from '@mpgd/platform/reviews-runtime';

// Once per game runtime, with the gateway after withReviewProvider and withTargetAvailability.
const reviews = createReviewMoments(createReviewSession({
  gateway,
  gameId: 'my-game',
  onEvent: (name) => reportGameEvent(name), // the game's own analytics
}));
reviews.record(`play-${result.runId}`); // every finished play, whatever its outcome
void reviews.settled(() => lobbyIsSettled()); // the menu after a result, a closed sheet, foreground
reviews.dispose(); // with the game runtime
```

`createReviewSession({ gateway, gameId, policy, now, onEvent })` returns `undefined` where the gateway has no native prompt: no provider, `integrations.reviews` other than `available`, a provider not ready at construction, or one whose capability read throws. It checks `gameId` (lowercase letters, digits, `.`, `_` and `-`, at most 64) and the policy on every target, so a mistake fails on the first web run too. The session is a controller scoped to `<gameId>:<target>`, so its state is stored under `mpgd:reviews:v1:<gameId>:<target>:<providerId>`; a game that already kept state under that scope keeps its visits, plays and cooldown.

`defaultReviewPolicy` asks after one visit and two completed plays, at most once every fourteen days. Spread it to change one value, as in `{ ...defaultReviewPolicy, minimumVisits: 2 }`. These are game choices, not host quotas: Apps in Toss applies its own fatigue rule and skips players who already rated.

`createReviewMoments(session)` turns game moments into requests:

- `record(momentId)` for a finished play, whatever its outcome, or a reward the backend already granted. Each ID counts once, so a result rendered twice reuses its ID. Empty, repeated and longer than 128-character IDs are ignored, as are moments past the 10,000th in one runtime. `reviewMomentId('goal')` makes an ID for a moment without its own.
- `settled(isSafe)` when the player reaches a settled screen. A new moment opens one opportunity; a settled screen without one does nothing. `isSafe` must exclude active play, payments, ads, dialogs, hidden documents and stale routes, and is checked again after every wait. An opportunity whose screen was covered, including one the controller found covered when it checked again, stays open for the next settled screen; nothing polls. A covered screen after the controller saved the request time still skips that request and starts the cooldown. The promise never rejects but can stay pending while the host shows its own UI, so never await it in navigation.
- `dispose()` with the game runtime. It disposes the session, and later calls do nothing. Without a session every call does nothing.

The controller underneath can also be used directly. Create one per runtime. Call `completedPlay(attemptId)` once for every completed run, regardless of win, rating or satisfaction; duplicate result rendering must reuse the same attempt ID. At a safe menu transition call `consider(() => stillSafe())` without awaiting it in navigation. Safety is checked again after persistence. Dispose the controller with the game runtime.

The controller persists the request time before invoking the host, allows at most one request per runtime, suppresses automatic requests on storage failure or corrupt state, and keeps its persistence queue usable even if the host request promise never resolves. Unsupported hosts do not read or write review state. A provider unavailable at construction needs a new controller once it becomes ready; it cannot overwrite a previously unread saved cooldown.

Storage is device-local courtesy, not a cross-tab transaction or cross-account quota. Host fatigue rules remain authoritative. Do not clear this state on an ordinary restart. Do not use an app-local storage substitute on AIT when the gateway offers durable host storage.

Anti-patterns:

- Counting only some plays. Count every finished play alike; never ask only after wins, high scores or good ratings, and never ask whether someone likes the game before choosing whom to ask.
- Tying anything to a review. Never grant or withhold coins, hints, continues, promotions or rank rewards over a review request or its outcome, and never wait for one before moving on. A reward counts as a moment only after the backend granted it.
- Asking over the game. Never request during play, a result, a purchase, an ad or a dialog, or while the document is hidden.
- Falling back to a store page. A native request that seemingly did nothing is normal (host fatigue rules, already rated). Never open a store page automatically. A manually selected review action should open a supported store page with `openPage()`; it should not promise a quota-limited native dialog.

## Verification and telemetry

Provider, controller and moments tests: `pnpm --filter @mpgd/platform exec vitest run src/reviews.test.ts src/review-moments.test.ts` (build platform first for adapter tests). They run against fake providers and storage: they show what the kit decides, not that a host displayed a prompt. Each adapter has `src/reviews.test.ts`. Target gating regression: `node tools/run-ttsx.mjs packages/target-config/test/reviews-gating-smoke.ts`. Graph: `pnpm graph:inspect --preset reviews`, also included by graph preflight.

Observe only `request`, `requested`, `failed` and `storage-unavailable`. `createReviewSession` reports them through `onEvent` by the names in `reviewAnalyticsEvents`: `review_request`, `review_request_resolved`, `review_request_failed` and `review_storage_unavailable`. Add those names to the game's own analytics allowlist; they are not `@mpgd/analytics` event names. Never label these counts as reviews, conversions or ratings. Current game deployments are not automatically changed by this module.

Sources checked: [AIT reviews](https://developers-apps-in-toss.toss.im/documentation/common/growth/review.md), [Capawesome App Review](https://capawesome.io/docs/sdks/capacitor/app-review/), [Google review guidance](https://developer.android.com/guide/playcore/in-app-review), [Apple review guidance](https://developer.apple.com/documentation/storekit/requesting-app-store-reviews), [Microsoft Store navigation](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-store-app), [ONE store Web SDK](https://onestore-dev.gitbook.io/dev/tools/web-sdk).
