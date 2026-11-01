# @mpgd/platform

## 0.36.0 — 2026-11-01

### Added

- [f005417e](https://github.com/imjlk/mpgd-kit/commit/f005417e35f9032216aa3b8b8b3debf1eb82a82c) Three conformance vectors join the notifications contract that providers run with `@mpgd/platform/notifications-conformance`: `endpoint-registration-refresh` (a read more than 7 days after the last acknowledged registration sends it again, so a device in use stays reachable past the 60-day stale rule), `endpoint-unbind-until-register` (`unregister()` cancels the pending local reminders and the installation stays unbound across a restart and a read until `register()`), and `duplicate-topics-once` (a topic listed twice in one call is asked and recorded once). A provider that runs every vector now runs 53.
  
  The notifications runtime (`@mpgd/platform/notifications-runtime`) asks the backend for the player's consent records less often: `getPermission` reuses its own read for the local reminder sweep after it, unless the runtime recorded something since, so it lists the records at most twice instead of three times. Writing records still lists them afresh, so another device's record is never hidden from the write. When the host fails a batch `cancelLocal`, the runtime cancels each key alone, so one reminder the host cannot cancel no longer keeps the others pending; if the first single-key call fails too, the host is taken to be failing every call and the rest are not tried. A batch failure whose keys all cancel alone is reported through `onError` and the next `runUntilIdle`, and the sweep succeeds. When the backend's records cannot be read during a local reminder sweep, the reminders whose permission the host reports as not granted are still cancelled, and the read's error is thrown after. — Thanks @imjlk!
- [370cc1b1](https://github.com/imjlk/mpgd-kit/commit/370cc1b18ac7204dc915baff9a6456ecfe67d889) The notifications policy gate takes the copy a server-side resolver chose for a recipient (`resolvedCopy`, a `NotificationResolvedCopy`). Where the content comes from copy (neither a mapping's own title and body nor a host template, as the new `notificationContentSource` reports), `{ copy }` is rendered as catalog copy is, placeholders and the Korean advertising rendering included, and `{}` answers the new `unavailable: copy-missing` reason (gate step 9), so a send is never made with empty text. Without `resolvedCopy` the gate behaves as before. `notificationNoticeTextIssues` checks one notice text by the `notices.copy` rules. The conformance vector schema lists `copy-missing`; a consumer that validates delivery outcomes against a closed reason list should accept it. — Thanks @imjlk!

## 0.35.1 — 2026-11-01

### Fixed

- [aef7e004](https://github.com/imjlk/mpgd-kit/commit/aef7e004aeae912979ae34ba56d47efbf5a26578) `@mpgd/platform/notifications-runtime` fixes three deferred notification issues:
  
  - Reads back off a registration that keeps failing. A read retried a failed registration (a first one, one for another session, or a stale one) on every read, so a game that reads often sent a registration to a backend that kept refusing it on each read. A read now retries no sooner than 30 seconds after the backend failed it, doubling with each failure in a row up to an hour. Only the backend's own failure of the registration call counts, whatever triggered it (a late address's `endpoint-changed` included); a storage, input, or provider failure does not back reads off. Start, a sign-in, `register()`, and a changed address or permission still send at once, a registration the backend acknowledges ends the backoff, and a read for a session other than the one the failed call was made for does not wait for it.
  - A registry entry that cannot be compared no longer throws from `start()`. An entry `loadRegistryEntry` answers whose compared fields (`provider`, `addressing`, `content`, `purposes`, `permission`) are malformed, or cannot be read, is a failed load: it is reported through `onError`, the runtime runs without the comparison, and the next `start()` loads it again. A malformed or unreadable `registryEntry` given at creation is reported at each start and fails closed exactly as a readable entry that disagrees with the provider does: every call throws `NOTIFICATIONS_CONFIGURATION_REQUIRED`, nothing is registered or recorded, and no entry is loaded in its place. Fields the runtime does not compare are not checked, so an entry from a newer backend still compares.
  - `notificationRuntimeStateOf` reads each stored entry on its own: a malformed or unreadable one (a getter or `Proxy` trap that throws) is left out and the others are kept, and it never throws. The kept registration is a plain copy. A stored value whose `then` cannot be read reads as an empty state rather than failing every call.
  
  A storage or input failure whose thrown value cannot be read (a getter, `toString`, or `Proxy` trap that throws) now still surfaces as the runtime's `NotificationError`, with `a failure that cannot be read` in its message, instead of the raw value. The v1 notifications wrapper no longer throws while it reads the code of such a failure. — Thanks @imjlk!

## 0.35.0 — 2026-10-30

### Added

- [cd6b9ceb](https://github.com/imjlk/mpgd-kit/commit/cd6b9ceb313bdd9b9db4a459587f8d073ba35596) `FinishTransactionInput` (and the `commerce.v2.finishTransaction` bridge payload) is now a union: `GrantedFinishTransactionInput`, the finish after a ledger grant (unchanged; `revoked` absent or false), or `RevokedFinishTransactionInput` (`revoked: true`, `isConsumable: true`, `ledgerEntryId` optional): finish a consumable the store revoked (refunded) while it was still unfinished, without any grant. The ledger entry names the reversed grant when there was one and is absent when nothing was granted. `CommerceProvider.acceptsRevokedFinish` gates it the way `acceptsFinishRetry` gates `retry`. A provider that reads `ledgerEntryId` narrows on `revoked` first. `createStoreCommerceProvider` declares the flag, forwards the revoked finish, and keeps the SDK's revoked consumables of the catalog in `getAvailablePurchases` (state `revoked`) only for a `StoreSdk` that declares `acceptsRevokedFinish`; `StoreSdkFinishTransactionInput` is the same union. A revoked finish sent to any other SDK answers `{ finished: false }` without calling it. The conformance vector format gains `profile.revokedFinish` and `finishCalls[].revoked` (with `ledgerEntryId` optional and an `unfinished` result), and the reference reconciler and fixture store implement the revoked finish. A bridge host on an earlier `@mpgd/platform` rejects the new shape, so update the host and the webview together. — Thanks @imjlk!

## 0.34.0 — 2026-10-29

### Added

- [b73b129d](https://github.com/imjlk/mpgd-kit/commit/b73b129d35097331dc6d8de0363191c9cf110dd2) Purchase presentation facts get their own bridge event protocol, `mpgd.commerce.presentation.v1`. `@mpgd/platform/commerce` adds `commercePresentationProtocol`, `CommercePresentationEvent`, `CommercePresentationEventEnvelope`, their typia asserts, and their JSON Schemas; `@mpgd/bridge` adds `BridgeCommercePresentationEvent` to `BridgeEvent`, `bridgeCommercePresentationEventProtocol`, and a `createBridgeEventSource` overload. It is not a `CommerceEvent` type, so a consumer built before it skips the envelopes as another protocol's.
  
  `PlatformPurchasePresentationEvent` gains an optional `reason` (`timeout`, `interrupted`, `disposed`) for a `closed` fact no native observation proved, and the `CommerceProvider.presentation` contract now states that a provider answers every `requestPurchase` with facts: `not-started` before the answer when no surface opened, otherwise `open` and exactly one `closed`.
  
  `@mpgd/platform` also exports the pure helpers a provider or a wrapper uses for these facts: `createPurchasePresentationChannel` (publishes numbered facts, isolating a failing listener), `createPurchasePresentationRelay` (relays a source's facts, drops a superseded one, numbers them again, and reports `not-started` for a purchase the wrapper answered before its source ran), and `createPurchasePresentationSequenceGuard` (bounded memory: ended keys are kept in a list of the most recent 1024). — Thanks @imjlk!
- [b85c2a06](https://github.com/imjlk/mpgd-kit/commit/b85c2a068adb871da772190436eece21b3839fec) Allow hosted web and Microsoft Store PWA production targets to use a clean same-origin `/api` game-services path for an authoritative edge service binding. Keep absolute public HTTPS requirements for native and third-party runtimes, and reject protocol-relative, encoded, traversal, query and fragment paths.
  
  Add the DOM-free `resolveGameServicesBaseUrl` composition helper and wire starter commerce/notification clients to resolve a hosted path against the actual browser origin before the existing absolute-URL authority checks. Invalid or native relative inputs remain fail-closed without a backend fallback.
  
  Add `isHostedGameServicesPath` to `@mpgd/platform/routes`, re-exported from `@mpgd/game-services`: the one rule for a clean same-origin ingress path, shared by the CLI's production readiness check and `resolveGameServicesBaseUrl`. — Thanks @imjlk!
- [fa2c44b4](https://github.com/imjlk/mpgd-kit/commit/fa2c44b4533d74df106a70aa6a75971a376a2ae3) The commerce conformance runner models another account's purchase (RFC "Another account's purchase"). A `queueVerify` decision may be `another-account` with its required binding mismatch `reason` (one of `GOOGLE_PLAY_ACCOUNT_MISMATCH`, `GOOGLE_PLAY_PROFILE_MISMATCH`, `APP_STORE_ACCOUNT_TOKEN_MISMATCH`, `isCommerceConformanceStoreAccountMismatchReason`; the reference reconciler parks nothing else) (`CommerceConformanceVerifyDecision` is now a union of `CommerceConformanceVerifyReceiptDecision` and `CommerceConformanceAnotherAccountDecision`), which the fake backend throws as `CommerceConformanceAnotherAccountError` (`code` `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT`, `reason`, and the `transport` a runtime under test should answer it in: `http` or `orpc`); a receipt decision may carry a `reason`. The reference reconciler parks such a record in `verifying` (and a `rejected` receipt whose reason is a store binding mismatch), never resends it on a pass, resends it only from its new `restorePurchases()` with the evidence reported then, and lets another player journal the purchase under its player-scoped key (`commerceConformanceJournalKey`, listed as `<key>@<player>`).
  
  Vectors gain the `runtime.restore` and `runtime.switchPlayer` steps, a `parked` expectation, and `playerId` and `intent` on verify request expectations; `journal` no longer repeats a state for a revision that keeps it. The reference journal accepts such a revision only to park or unpark a `verifying` record. Six provider-independent vectors ship in `docs/specs/commerce/reconciler-vectors/`; the fourteen provider vectors are unchanged. — Thanks @imjlk!

## 0.33.0 — 2026-10-28

### Added

- [ae7b0f77](https://github.com/imjlk/mpgd-kit/commit/ae7b0f77120c1eb73c92c0249c9048cafa8a9d4f) `FinishTransactionInput` (and the `commerce.v2.finishTransaction` bridge payload) takes an optional `retry`: the caller already asked to finish this purchase, in an earlier attempt or session. A store may then read a consumable missing from its unfinished list as the lost acknowledgement of that earlier finish; a first finish never carries it. `createStoreCommerceProvider` forwards it to `StoreSdk.finishTransaction`. A bridge host on an earlier `@mpgd/platform` rejects the unknown field, so update the host and the webview together. — Thanks @imjlk!

### Changed

- [d684308f](https://github.com/imjlk/mpgd-kit/commit/d684308f4eff54e2ea772bed8dcda4b1ea528630) The runtime `typia` dependency moves from 13.0.2 to 15.2.1, and the shipped validators are rebuilt with typia 15 through ttsc 0.34.2. A game that runs its own typia transform over `@mpgd/platform` types (for example `typia.assert<StorePurchase>()`) now needs typia 15.2 or later. The contract's tag records emit typia 15 runtime helpers (`_stringLengthGte`, `isTypeInt64Bigint`) that typia 13 does not have. The typia-free commerce contract mirrors typia 15's tag records under typia's alias names, so commerce validation errors read `expected (string & MinLength<1>)` like the other validators, instead of `CommerceMinLength<1>`; the exported `Commerce*` tag types are unchanged. `MinLength` counts code points instead of UTF-16 units, and `Type<'int64'>` checks the range of a bigint. The `date-time` and `date` formats now refuse a day the month does not have and a space for `T`. The notifications validators already refused such timestamps, but the error now comes from typia (`invalid type on $input.<field>`) instead of the kit's `<field> must be RFC 3339` or `must be a date that exists`. The committed commerce and notifications JSON Schemas drop their duplicate `NonEmptyString.o1` and `PositiveInteger.o1` components, and name the remaining `ReadonlyRecord…` variants `-oN` instead of `.oN`. — Thanks @imjlk!

## 0.32.0 — 2026-10-27

### Added

- [c46d915b](https://github.com/imjlk/mpgd-kit/commit/c46d915b9e5662840554f51138d569237496b0c8) Crash reporting for the Capacitor shells. `@mpgd/platform/crash-reporting` adds the `CrashReporter` port (`recordError`, which resolves whether the report reached the service, `log`, `setCollectionEnabled`, `getStatus`), redaction and stack-frame helpers, and `installCrashErrorCapture` for WebView `error` and `unhandledrejection` events; `PlatformGateway` gains an optional `crashReporter`. `@mpgd/adapter-capacitor` implements it on Firebase Crashlytics (`@capacitor-firebase/crashlytics` 8.x, a new optional peer reached by its registered plugin name, so games do not depend on the npm package): `createCapacitorPlatformGateway` exposes `crashReporter` and, when the shell has the plugin, reports uncaught errors and unhandled rejections as non-fatal (`crashReporting: false` opts out; `crashReporting: { requireConsent: true }` holds JavaScript reports until `setCollectionEnabled(true)`). The kit adds the target, build id, app version, and adapter as custom keys; reports may also carry the game-supplied context keys, breadcrumbs (`log`), exception messages, and stack frames (function, file path, line), all sanitized and redacted first. The kit never sets a player id or Crashlytics user id. The player's stored collection choice is applied to the native SDK again at every start and retried until the SDK takes it. `mpgd target init capacitor --providers crash-reporting` installs the plugin into the shell and the Crashlytics Gradle plugin 3.0.8 into a newly generated Android project, and refuses an existing Android project without that Gradle plugin, whose app would stop at startup. The native store-policy preflight fails a production build of a shell with the plugin when its platform's Firebase config file is missing or, on Android, the Gradle plugin is not applied. Games and shells that do not request the provider are unchanged. — Thanks @imjlk!

## 0.31.0 — 2026-10-26

### Minor changes

- [1d2d74e0](https://github.com/imjlk/mpgd-kit/commit/1d2d74e058e6fae18e7d5b4d1850b29a94c6165e) Optional review providers distinguish opaque native requests from explicit store-page navigation. Add an opt-in target integration, persisted visit/play/cooldown policy, AIT Review.request, Capawesome AppReview for explicitly selected mobile stores, and Microsoft/registered ONE store or Verse8 listing helpers. Unsupported hosts have no prompt or storage activity; no outcome claims that a review was displayed or submitted. Import review adapters by subpath so unused SDKs stay out of browser and inline bundles. — Thanks @imjlk!

## 0.30.0 — 2026-10-26

### Added

- [718801f9](https://github.com/imjlk/mpgd-kit/commit/718801f9b9544fc9be505dc5994cb81974bdea48) Restore Purchases now reaches restore sharing after a reinstall or on a new device. `GetAvailablePurchasesInput.restore?: boolean` (and `StoreSdkGetAvailablePurchasesInput.restore`, which `createStoreCommerceProvider` passes through) marks the player's explicit Restore Purchases read: a store whose recovery list hides owned non-consumables (Google Play's acknowledged items, StoreKit entitlements bound to another app account token) lists them too. The commerce reconciler's `restorePurchases()` makes that read (an event provider directly, a polled one through the pass it runs), so those purchases reach the backend as discovered purchases with `intent: 'restore'`; `start()`, `reconcile()`, and event passes keep the recovery read, so an acknowledged durable is not resent on every launch. Providers without such a filter ignore the field. The commerce bridge payload schema for `commerce.v2.getAvailablePurchases` accepts `restore`. A bridge host built before it rejects the field; the reconciler then reports the failed restore read (`failure` stage `available`) and still makes the recovery read, so Restore Purchases never finds less than before. — Thanks @imjlk!

## 0.29.0 — 2026-10-26

### Patch changes

- [3d603721](https://github.com/imjlk/mpgd-kit/commit/3d6037213f0494348cdca31e694416cb40de3354) Describe optional host-carried promotion authority acknowledgements and verify AIT passthrough, allowing consumers to omit duplicate finalization only after account-scoped server confirmation. — Thanks @imjlk!

### Added

- [6ce27613](https://github.com/imjlk/mpgd-kit/commit/6ce27613a430cde2cf13ffd7bac4e842f29cb296) Android advertising pushes rendered by the shell (AR1). A device registration's FCM address can say `rendersAdvertising: true`: the app renders advertising pushes itself, with the opt-out action. `NotificationDeployment.shellRendersAdvertising` says the game's shell does so on the targets in `notificationShellRenderedAdvertisingTargets` (`android`, whose FCM notification messages cannot carry actions). The policy gate takes `endpointShowsActions` and fails closed on it: under the Korean rules an advertising send to a resolved device endpoint needs `true`, and `false` or an absent value is `suppressed: purpose-unsupported`, as a registry entry without `actions` is. A backend that calls `evaluateNotificationDelivery` itself passes `true` for an endpoint whose pushes show the opt-out action. The conformance runner's fake backend does so for its fixture device; no vector outcome changed. The JSON Schemas for the endpoint registration and the deployment carry both fields. — Thanks @imjlk!

## 0.28.0 — 2026-10-25

### Added

- [dd51d8e9](https://github.com/imjlk/mpgd-kit/commit/dd51d8e9a6d994b1c2cefcd5adaf90e304953a6d) Notifications backend bridge methods: the notifications runtime's backend calls (`NotificationRuntimeBackend`) for a backend that a host serves over its own bridge, such as the Devvit server. `@mpgd/platform/notifications` adds the nine `notifications.backend.*` method shapes (`NotificationBackendBridgeMethods`, `notificationBackendBridgeMethods`), their typia validators (`assertNotificationBackendBridge*Payload` and `*Result`; the repository publishes their JSON Schemas under `docs/specs/notifications/schemas`), and `NotificationBackendReminderSetStatus`, which `NotificationRuntimeReminderSetStatus` now names. Every call but `getSession` carries `expectedPlayer`, only as a cross-check: the host acts for its own authenticated player and refuses a call for another.
  
  `@mpgd/bridge` adds the methods to `BridgeMethod` as `BridgeNotificationsBackendMethod` (`bridgeNotificationsBackendMethods`, `isBridgeNotificationsBackendMethod`), apart from the nine provider methods, and `createNotificationsBackendUnavailableBridgeError`, which answers `NOTIFICATIONS_CONFIGURATION_REQUIRED`. `@mpgd/bridge/notifications` adds `assertBridgeNotificationsBackendPayload`, `assertBridgeNotificationsBackendResult`, `notificationsBackendBridgeHostCodes`, and `createNotificationsBackendBridgeHandler`, which serves the methods from the host's backend for its own session: a request without a player answers `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` with host code `NOTIFICATIONS_SIGNED_OUT`, one whose `expectedPlayer` is another player the same code with `NOTIFICATIONS_SESSION_CHANGED`, and a backend failure that is not a notifications failure crosses with a fixed message.
  
  Changed for outside callers:
  
  - `@mpgd/bridge`: `BridgeMethod` gains the nine `notifications.backend.*` methods. A `switch` over `BridgeMethod` that names every member (an exhaustive check with `never`) no longer compiles until it handles them or has a default; a `Record<BridgeMethod, …>` needs entries for them.
  - `@mpgd/platform/notifications-conformance`: `NotificationConformanceBackend.authenticate` now returns `NotificationConformanceSession | Promise<NotificationConformanceSession>`, and the runner awaits it. Code that calls `authenticate` on a `NotificationConformanceBackend` and uses the result directly now awaits it. Implementations that answer synchronously still compile, and `NotificationConformanceFakeBackend.authenticate` still answers synchronously. — Thanks @imjlk!

## 0.27.2 — 2026-10-21

### Patch changes

- [3f519a74](https://github.com/imjlk/mpgd-kit/commit/3f519a74a3eaf7aeec7a35d208ed951ff61ff8df) Add an optional attempt generation to purchase presentation events. A coordinator can set it on the request; a provider that restarts its sequence echoes it. The field does not grant. — Thanks @imjlk!

## 0.27.1 — 2026-10-21

### Fixed

- [510804d5](https://github.com/imjlk/mpgd-kit/commit/510804d5f0245d6d3c770d234c85c8e901df3f18) Reject a credit spend whose debits do not cover the price. An absolute comparison of `1e-9` treated `sameCreditAmount(0, 1e-9)` as equal, so `planCreditDebits` and `createCreditCommerceProvider` accepted an empty wallet (and an empty debit list) as payment for a price of `1e-9`. A later relative `1e-9` of the price turned that same constant into one credit at a price of `1e9`, so a balance of `999,999,999` was accepted for `1,000,000,000`.
  
  Coverage no longer forgives a shortfall that grows with the price. Float residue may sit a few units in the last place under the price, capped at an absolute `1e-9` and at one unit in the last place of the magnitude, so a one-credit gap is never a payment and half of a subnormal price is not either. Sums of many fractional lots are compensated, and a balance check stops once a lot meets the unpaid gap so two `Number.MAX_VALUE` lots do not overflow into a false shortfall. `creditPriceMultiple` uses the same comparison. Ordinary fractional amounts, including `0.1 + 0.2` and `0.7 + 0.1`, still spend. — Thanks @imjlk!

## 0.27.0 — 2026-10-21

### Added

- [f772a896](https://github.com/imjlk/mpgd-kit/commit/f772a8964437d512349736e609668792b480fbc1) `@mpgd/platform/notifications-runtime` is the production notifications runtime (RFC "Runtime"): `createNotificationRuntime({ provider, backend, catalog, defaultLocale })` composes a target's provider with the game backend for the authenticated player and returns the `NotificationRuntime` with `start`, `stop`, and `runUntilIdle`. The backend is the `NotificationRuntimeBackend` port, which `@mpgd/game-services/notifications/client` implements over the game-services Worker. What survives a restart (the last acknowledged registration and the unbound state after `unregister()`) goes through the `NotificationRuntimeStorage` port: `createNotificationRuntimeStorage({ storage: gateway.storage })` keeps it under one platform storage key, and without a port it lives in memory. A storage read or write that fails surfaces as a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, and `onError` observes background failures as they happen. `loadRegistryEntry` fetches the backend's registry entry at `start()` (for example the Worker's `GET /providers`); a load that fails is reported and the runtime starts without the comparison. A sign-in the runtime did not observe (before `start()`, or while stopped) still registers at the next start or read: when the last acknowledged registration names another player or session, when nothing was acknowledged yet, and after `unregister()` when the session differs from the one it left.
  
  `createNotificationConformanceRuntime` now returns this runtime, so every conformance vector exercises production code; its inputs and the vector results are unchanged. Its runtime now also behaves as above where no vector looks: it registers for a sign-in it did not observe, keeps `unboundSession` in the storage object, and reads that object through `notificationRuntimeStateOf`, so a hand-built object that is not a runtime state reads as empty. `NotificationConformanceBackendClient`, `NotificationConformanceSession`, and `NotificationConformanceReminderSetStatus` extend or alias the new runtime types. — Thanks @imjlk!

## 0.26.0 — 2026-10-20

### Changed

- [ce953b5b](https://github.com/imjlk/mpgd-kit/commit/ce953b5b319cf6358d3a1b7845022bcba811bf2d) Under the Korean advertising rules, `assertNotificationDeployment` refuses an advertising sender name, contact, or opt-out line that is still a common template marker (a `REPLACE-WITH-…` marker; a whole value that is an unreplaced `__TOKEN__`, `{{token}}`, `${token}`, `<token>`, or `[token]`; a reserved `example.com` address; or only `TODO`/`TBD`/`CHANGEME`/`PLACEHOLDER`/`XXX`), so a backend built from the starter's deployment file fails closed instead of sending advertising with an unusable sender line. `isNotificationPlaceholderText` and `notificationDeploymentPlaceholders` export the check, and `assertNotificationDeployment(input, { allowPlaceholders: true })` lets a validator report placeholders itself.
  
  `createNotificationService` and `createNotificationServiceCatalog` in `@mpgd/game-services` assert the deployment, so they now throw for such a deployment, and the game-services Worker reports its notifications as misconfigured. — Thanks @imjlk!

## 0.25.0 — 2026-10-19

### Minor changes

- [96d8add4](https://github.com/imjlk/mpgd-kit/commit/96d8add43a4eff1f790b4cc8514a8839f7f7608c) Add optional recovery-only promotion calls that read persisted or authority-confirmed receipts without authorizing or starting a provider payment. Preserve pending markers even when the resolver permits a retry; a fresh explicit grant remains separate. — Thanks @imjlk!

## 0.24.0 — 2026-10-19

### Minor changes

- [07b1cb72](https://github.com/imjlk/mpgd-kit/commit/07b1cb72d5e1843238dda6bdc904d7c3227c8795) `NotificationConformanceReminderSetStatus` gains `capacity-exceeded` and `unavailable`, which a backend under test may answer when it caps a player's pending server reminders or when no provider the player can be reached on maps the topic. The fake backend answers neither; the reference runtime passes them through as the reminder's status. — Thanks @imjlk!
- [089efeb0](https://github.com/imjlk/mpgd-kit/commit/089efeb0dd6ca4d3f5efb218b97b8f3e9fadfbe2) Let the notifications conformance runner drive a backend under test: `runNotificationConformanceVector` accepts `createBackend`, which receives the inputs the fake backend would, and awaits `revokeSession` and `registerInstallation` when a backend finishes them asynchronously. A production notifications service can now pass the server vectors. `createNotificationConformanceBackend` returns `NotificationConformanceFakeBackend`, whose `revokeSession` and `registerInstallation` are synchronous, so callers need not await them. — Thanks @imjlk!

## 0.23.1 — 2026-10-16

### Changed

- [d11a2f9b](https://github.com/imjlk/mpgd-kit/commit/d11a2f9b083c11ef9602f5afa4bfe74859089f9d) Align the compiler, typed script runner, lint, Evidence, graph, paths, and bundler toolchain on ttsc 0.32.1. Preserve runtime assertion checks and use the graph-specific native packages. — Thanks @imjlk!

## 0.23.0 — 2026-10-15

### Minor changes

- [d8486b02](https://github.com/imjlk/mpgd-kit/commit/d8486b0279dd6b1e6d83e4bef192e62413aa1636) Notifications v2, PR N3: the capability snapshot block and stricter bridge
  answers and events.
  
  - `PlatformCapabilities.notifications` is the optional notifications v2
    capability block of the `notificationsV2` provider a gateway exposes. Like
    the commerce block, it is a fresh object on every read with no unknown keys,
    and `providerAvailability.pushNotifications` equals its `availability`.
  - `@mpgd/platform/capability-conformance` checks the block the way it checks
    the commerce block: exact keys, known values, positive integer counts,
    `remote.addressing` `'none'` exactly when remote delivery is unsupported,
    and no record or purposes list, empty or not, shared across reads. The block
    must be present exactly when the gateway exposes `notificationsV2`, with the
    push readiness equal to its availability. A fixture may now expect a
    malformed block or commerce block as is: the runner copies the expected
    state whatever its shape, so only the block checks reject it.
  - `assertNotificationBridgeGetCapabilitiesResult` now also checks the block's
    `remote.addressing` rule, as `assertNotificationCapabilities` does, and
    `assertNotificationBridgeRegisterResult` checks the registration's time zone,
    as `assertNotificationEndpointRegistration` does.
  - `assertNotificationEvent`, `assertNotificationEventEnvelope`,
    `isNotificationEvent`, and `isNotificationEventEnvelope` apply the same time
    zone rule to an `endpoint-changed` registration.
  
  The conformance runner rejects reused notification blocks, nested records,
  and purposes lists even when frozen, and rejects holes in purposes arrays. — Thanks @imjlk!
- [0234f853](https://github.com/imjlk/mpgd-kit/commit/0234f853cffff19e181587cef79fd0465144ed61) `isRootRelativeNotificationRoute` now accepts a route only when it is at most
  2,048 characters and `normalizeRootRelativeRoute(route) === route`, the rule
  share links and v1 notification deep links follow, instead of its own copy.
  Topic `route` and `optOutRoute` in a catalog, a local reminder's `route`, and
  the route a router opens all follow it.
  
  Root-relative normalization uses string operations, so catalog and notification
  policy validation works in runtimes without the DOM `URL` constructor.
  
  - A route that is not already in its normalized form is refused, and the
    catalog issue and the thrown error name that form. Examples are `/é`
    (`/%C3%A9`), `/a b` (`/a%20b`), a backslash in the path, and an empty `?` or
    `#` (`/a?`). A local reminder whose route is built at run time, such as
    `/?name=Ada Lovelace`, now throws until the game writes it in that form
    (`/?name=Ada%20Lovelace`).
  - Escapes that stay on the game's origin once decoded are no longer refused,
    because no client can read them as another host. Examples are
    `/levels/%252e%252e`, `/a/%2E%2E%2Fb`, `/a/%09b`, a malformed escape such as
    `/50%`, and a backslash in the query or fragment. A route a client could read
    as another host is still refused. — Thanks @imjlk!
- [0f3614e2](https://github.com/imjlk/mpgd-kit/commit/0f3614e2180c0c11e2ce89798b29ae8e4f1c528a) `@mpgd/platform/notifications` gives consent notices one copy per variant, so
  a result notice can say whether the player consented, refused, or withdrew,
  and to advertising or to night sending (decree art. 62-2), and a
  re-confirmation which consent it confirms (decree art. 62-3). It adds
  `NotificationNoticeVariant` with `notificationNoticeVariants`, including the
  two optional refusal variants, whose text falls back to the withdrawal's
  (`notificationNoticeVariantFallbacks`); `NotificationNoticeCopy` (the
  catalog's `notices.copy`: per locale, a `NotificationNoticeLocaleCopy` with a
  title and a body per variant); and `notificationNoticeVariantCopy`, which
  reads one variant's copy per locale as a topic's copy. A listed
  `NotificationNotice` carries its `variant`, which `listNotificationNotices`
  sets: a `withdrawn` record whose latest earlier record of its kind is not a
  consent reports a refusal. The game shows that variant, the scheduler pushes
  it, and `recordShown` still takes the listed notice as is.
  `NotificationNoticeSettings` is the catalog's whole `notices` block,
  `{ topic, copy }`, the one notice setting a backend takes, and
  `notificationNoticeCopyIssues` holds the rules its copy follows wherever it is
  read: the default locale, every required variant in every locale, no blank
  title or body, `{{consentDate}}` in each variant, and no other placeholder or
  brace outside one, as `readNotificationTemplate` reads a text the way
  `fillNotificationTemplate` fills it. `notificationProviderCarriesNotices`
  (free-form content, and no title or body the mapping must carry) and
  `notificationNoticeTopic` (the notice topic as the gate renders one notice:
  no title or body from its mapping, and the variant's copy in place of its
  own) hold what a scheduler needs to send one. The conformance fake backend
  takes the `notices` block, refuses one without its topic or with copy that
  breaks those rules, and pushes each notice in its listed variant, filled
  with `{{consentDate}}`, through `notices.topic` and only through a provider
  that can carry it. A game send or reminder through the notice topic throws
  `NOTIFICATIONS_INVALID_INPUT`, and a notice whose push cannot render, first
  or replayed, is not tried again, so the game still owes it. Vectors gain an optional `notices` block, `{ topic, copy }`,
  which the loader checks by the same rules, and can expect a listed notice's
  `variant`; `advertising-notices` moves its notice text there, and the new
  `advertising-notice-variants` vector pushes both re-confirmations and every
  kind of result notice, one refusal in its own text and one in the
  withdrawal's. — Thanks @imjlk!
- [3dc12fde](https://github.com/imjlk/mpgd-kit/commit/3dc12fde93056d225400d5d0a770a98c2fe2209b) BREAKING: commerce v2, PR C4 removes the commerce v1 surfaces from the platform
  contract. `CommerceProvider` (`@mpgd/platform/commerce`) is the only commerce
  surface of a gateway, and the `commerce` capability block is the only commerce
  capability source.
  
  - `CommerceAdapter` is removed. `PlatformGateway.commerceV2` is renamed to
    `PlatformGateway.commerce` and is now `CommerceProvider | undefined`: a
    gateway whose target sells nothing omits it. The v1 methods map to the
    provider as `getProducts` to `fetchProducts`, `purchase` to `requestPurchase`
    (a `RequestPurchaseResult`, never a grant), `restore` to `restorePurchases`
    and `getAvailablePurchases`. `getEntitlements` has no replacement on the
    gateway: ownership comes from the backend ledger (server-side
    `listActiveEntitlementTransactions` in `@mpgd/game-services`), and
    `@mpgd/game-services` drives the provider, so a scene never calls it.
  - `PlatformCapabilities.nativeIap` and `.subscriptionIap` are removed, and
    `PlatformCapabilities.commerce: CommerceCapabilities` is now required. Read
    `commerce.availability` and `commerce.purchase` instead (`nativeIap` was
    `availability === 'available'` with a consumable or durable kind;
    `subscriptionIap` was `purchase.subscription`).
    `PlatformProviderFeature` no longer contains `'nativeIap'` or
    `'subscriptionIap'`, so `providerAvailability.nativeIap` and
    `.subscriptionIap` are gone too: the block's own `availability` carries
    commerce readiness. `deriveLegacyCommerceCapabilities` and
    `LegacyCommerceCapabilities` are removed.
  - `createUnsupportedCapabilities()` now includes
    `commerce: createUnsupportedCommerceCapabilities()`, which is exported from
    both `@mpgd/platform` and `@mpgd/platform/commerce` and returns a fresh object
    on every call. A gateway that sells nothing reports it instead of omitting the
    block.
  - `toCommerceAdapter`, `ToCommerceAdapterOptions` (`@mpgd/platform/commerce`)
    and `findAuthoritativePurchaseSettlement` are removed. The result vocabulary
    adapters and `GameServicesPurchaseResult` still use is kept: `PurchaseResult`,
    `PurchaseRestoreResult`, `PurchaseSettlement`, `ProductInfo`, `ProductType`,
    `Entitlement`, `CommerceDiagnostic`, and `PlatformPurchasePresentationEvent`.
    A platform purchase result is never an input to a grant.
  - `CommerceProvider` gains an optional `presentation.subscribe(listener)` of
    trusted native facts about the payment surface (opened, closed, never
    started), for providers whose host can prove closure; the game runtime's
    presentation gate uses it. Providers that cannot prove closure omit it.
  - `@mpgd/platform/capability-conformance` requires the `commerce` block and
    rejects `nativeIap` and `subscriptionIap` as unknown keys.
    `optionalPlatformCapabilityKeys` is now `['bannerAds']`, and
    `platformCapabilityKeys` no longer lists `nativeIap`.
  - `createGooglePlayTokenPurchaseKey` is the only Play token key helper. — Thanks @imjlk!
- [0234f853](https://github.com/imjlk/mpgd-kit/commit/0234f853cffff19e181587cef79fd0465144ed61) Every target whose host builds or receives a share URL now checks
  `ShareIntent.deepLink` with one rule before the host sees the intent.
  
  - `@mpgd/platform/routes` adds `normalizeShareLink(deepLink)`, the share-link
    rule web sharing already followed. A root-relative link becomes the route
    `normalizeRootRelativeRoute` returns. An absolute link must spell out
    `https://` or `http://`, carry no credentials, and keep a path no client
    reads as another host. Anything else answers `undefined`.
  - `@mpgd/platform/routes` also adds `readShareIntent(intent)` and
    `withShareIntentCheck(sharing)`. The wrapper answers
    `{ status: 'unavailable' }` for an intent that is not an object, has no
    string `text`, or has a link the rule refuses, without calling the adapter.
    An accepted intent reaches the adapter with its link normalized. They stay
    out of the main entry, which headless consumers type-check without the
    `URL` global.
  - `@mpgd/platform/share-link-conformance` adds `runShareLinkConformance`. It
    shares every vector in `rootRelativeRouteVectors` and the new
    `shareLinkVectors` (`@mpgd/platform/route-vectors`), plus malformed intents,
    through an adapter's `share`. It checks the answers and the link the host
    was handed, and it throws one error that lists every failure. Each adapter
    that maps share links runs it, and the root
    `pnpm validate:share-link-conformance` fails for an adapter that defines a
    share without running it. WeChat is listed as exempt: its share card carries
    no link, and mini-game runtimes have no `URL` global.
  - The Capacitor and Devvit gateways wrap `sharing` with
    `withShareIntentCheck`. A link outside the contract, such as
    `mygame://invite`, `./daily`, or `/%2F%2Fevil.example/x`, now answers
    `unavailable` without reaching the native or server bridge, and the bridge
    receives the normalized link. Before, they passed every intent on as is.
    The common reader also requires a supported `kind` and string `title` and
    `text` before dispatching to these adapters.
  - Apps in Toss reads links that are not `intoss://<app>` links with
    `normalizeShareLink` before reducing them to their path. It now also refuses
    `https:/daily`, `https:evil.example/x`, and links with credentials, which it
    used to reduce to a path. — Thanks @imjlk!
- [dd76b8d7](https://github.com/imjlk/mpgd-kit/commit/dd76b8d736cc90b1e1d810d18745b2cd043d2c55) `@mpgd/platform/routes` exports one route-safety rule for links a game hands
  to the kit, and `@mpgd/platform/route-vectors` exports the shared `normalized`
  and `rejected` vectors that every package mapping such links runs:
  
  - `normalizeRootRelativeRoute(input)` returns the path, query, and hash a
    root-relative link names on the game's origin. It answers `undefined` when a
    client could read the link as another host: a second slash or a backslash
    after the leading slash, a control character, or a path that begins with an
    empty segment after dot segments collapse. The same holds when the path is
    percent-decoded once and parsed again, with the path ending at any decoded
    `?` or `#` or keeping them all. A path with more than 16 decoded `?` and `#`
    is refused.
  - `hasNetworkPathPrefix(pathname)` and `hasRouteControlCharacter(value)` are the
    checks it builds on. `hasNetworkPathPrefix` answers `true` for anything that
    is not a URL path.
  
  Notification delivery in `@mpgd/game-services` and Apps in Toss sharing in
  `@mpgd/adapter-ait` use this rule instead of their own copies. They now also
  refuse a path that reaches another host when a decoded `?` or `#` stays in the
  path instead of ending it, such as `/%3F%2F..%2F%2Fhost`, and a path with more
  than 16 decoded `?` and `#`.
  
  Web sharing in `@mpgd/adapter-browser` now follows the `ShareIntent.deepLink`
  contract:
  
  - A root-relative link is normalized and stays relative, so Web Share resolves
    it against the document as before.
  - An absolute link must spell out `https://` or `http://`, carry no
    credentials, and keep a path no client can read as another host.
  - It answers `unavailable` for anything else, including page-relative links
    (`./daily`, `?x=1`), `javascript:`, `data:`, and `intoss:` links, and a
    `text` or `deepLink` that is not a string. Before, it passed any string on.
  
  The Apps in Toss sandbox bridge now reads share requests exactly as the host
  bridge does:
  
  - It answers `unavailable` for a request the host refuses, and
    `{ status: 'shared', completion: 'presented' }` otherwise. Before, it
    answered `{ status: 'shared' }` for any request, which reads as completed.
  - A new optional `appName` option sets the app name `intoss://` links must
    carry. It defaults to `mpgd-kit`, as on the host. — Thanks @imjlk!
- [0234f853](https://github.com/imjlk/mpgd-kit/commit/0234f853cffff19e181587cef79fd0465144ed61) Game links a native app opens are checked with the shared route rule before
  any router sees them.
  
  - `NativeOpenUrlEvent` gains an optional `route`: for a game link, the path,
    query, and fragment of its URL, normalized with `normalizeRootRelativeRoute`
    from `@mpgd/platform/routes`. The URL's host is not part of it
    (`mygame://level/3` gives `/3`). The `LifecycleAdapter.onGameUrlOpen` and
    `NativeOpenUrlEvent` docs say a router that builds its route from anything
    else in the URL, such as a custom-scheme host, must check it with
    `normalizeRootRelativeRoute`.
  - Query-only or fragment-only hierarchical links preserve a root route:
    `mygame://game?entry=daily` gives `/?entry=daily` and `mygame://game#top`
    gives `/#top`.
  - The Capacitor adapter discards a game link, cold or warm, whose path that
    rule refuses, such as `mygame://game//evil.example/x` or
    `https://game.example/%2F%2Fevil.example/x`. It also discards one with a
    control character or one that does not parse as a URL. A delivered game link
    carries its `route` (`/daily` for `mygame://game/daily`). A link with no path
    to check, such as `mygame://daily`, is delivered without one, and OAuth
    redirects are unchanged. — Thanks @imjlk!
- [5889d88a](https://github.com/imjlk/mpgd-kit/commit/5889d88a16b45e8b304ca509723d4913da39bfcd) `@mpgd/platform` adds the notifications v2 contract as three new subpaths.
  `./notifications` holds the client contract types (`NotificationProvider` with
  `revokePermission` for game-rendered consent, `NotificationCapabilities` with
  `permission.promptLimit` and `remote.addressing: 'none'` exactly when remote
  delivery is unsupported, permission snapshots and results with
  `requiredAction`, endpoint registrations without an installation id, local
  reminders, events, consent records including provider answers, consent
  notices, and the `NotificationRuntime` surface with `revokePermission`,
  `unregister()`, and `notices`, whose `recordShown` takes a listed notice as
  is, or its kind, its record's kind and time, and its `dueBy`, and records the
  notice only while it is listed, so a retry changes nothing), `NotificationError`
  with the `NOTIFICATIONS_*` codes including `NOTIFICATIONS_INVALID_INPUT` and
  `NOTIFICATIONS_IDEMPOTENCY_CONFLICT` and the host's own `hostCode`, the bridge
  v2 payload shapes and event envelope, typia validators that reject unknown
  keys and read every timestamp and date strictly (`isNotificationTimestamp`: a
  date that exists, `T`, and an offset), the delivery provider registry entry
  with reference entries for FCM, Apps in Toss, and Devvit, the backend
  deployment settings (`advertisingRules`, the advertising sender and opt-out
  line, the zone), and the pure policy gate
  `evaluateNotificationDelivery`: an unknown topic, channel, and purpose;
  recipients and the Devvit link; positively granted permission per provider
  kind, host agreements unless a topic needs none (then the host decides each
  send, after a provider's denial too), and per-send acceptances; the topic
  preference; advertising consent; the Korean night window with an expiry at the
  next 21:00 and quiet hours in the recipient's zone; frequency caps and
  provider limits over rolling windows, deferring short ones; and, under the
  Korean rules, the advertising sender, the `(광고)` label, the opt-out line, and
  the opt-out action, read by `resolveNotificationAdvertisingSettings`: a blank
  sender contact suppresses the send, and a blank sender name or opt-out line is
  left out or replaced by the default. It also holds send bounds, reserved key
  prefixes, request fingerprints, reminder routing and the client-evaluable
  local and set-time server reminder checks (a local reminder of a topic that is
  not deferrable answers `quiet-hours` inside its quiet hours), consent notice
  due dates with the re-confirmation series (each re-confirmation listed from 60
  days before its `dueBy`), canonical reminder keys and notice keys that name
  each notice by its kind, its record's kind and time, and its `dueBy`,
  root-relative route checks that refuse any route a URL parser or a decoding
  client would resolve to a protocol-relative path, and the v1
  `toNotificationSubscriptionAdapter` wrapper over the runtime and the topics
  resolved for its target, which reads any failure with the configuration code
  as `configuration-required`. `./notifications-vectors` fixes the conformance
  vector format, and `./notifications-conformance` runs the vectors with a
  reference runtime (which also cancels a pending local reminder whose topic an
  app update took off the local route, cancels a reminder key on both routes,
  re-sends a registration older than 7 days at start and on reads, and keeps an
  unregistered installation unbound across restarts), fake host, fake backend
  (sessions, an idempotency ledger with fingerprints and leases, device fan-out
  under derived keys, the five provider answers, deferred replay with backoff, a
  paced scheduler, and notices pushed through the catalog's `notices` block,
  `{ topic, copy }`), and clock, substituting the fixture provider id
  and evidence schema in the fields that name them for a provider under test,
  failing prompt and local expectations without a host actor, comparing
  timestamps as strict instants, and skipping a vector whose `appliesTo` its
  capabilities do not satisfy; all forty vectors pass. `PlatformGateway`
  gains an optional `notificationsV2` provider, declared through a typia-free
  contract module so the main entry stays free of typia. This is additive: no
  provider implements v2 yet, and the protocol version stays `2.0.0-draft.1`. — Thanks @imjlk!

## 0.22.0 — 2026-10-12

### Minor changes

- [8c870580](https://github.com/imjlk/mpgd-kit/commit/8c87058002249260d63dbffe8a305417aa1db6ad) Commerce v2, PR C2: the provider capabilities endpoint shape.
  
  `@mpgd/platform/commerce` adds `CommerceServiceCapabilities` and
  `CommerceServiceStoreCapabilities` (RFC "Provider capabilities endpoint"): the
  protocol version a backend speaks and, per store its evidence registry
  accepts, the evidence schemas, the finish owner, and the purchase kinds. They
  are typia-validated (`assertCommerceServiceCapabilities`,
  `isCommerceServiceCapabilities`) and published as
  `docs/specs/commerce/schemas/commerce-service-capabilities.schema.json`, which
  `validate:commerce-alignment` keeps in step with the types. — Thanks @imjlk!
- [e7fb9c54](https://github.com/imjlk/mpgd-kit/commit/e7fb9c548f1057715bf39c3b4baf95589cdd68db) Commerce v2, PR C1: the conformance runner accepts the runtime under test.
  
  `runCommerceConformanceVector` and `runCommerceConformanceVectors` gain
  `options.createRuntime(input, context)`, which builds the runtime a vector
  drives (`CommerceConformanceRuntime`) over the harness provider, the fake
  backend, and the reference journal in place of the reference reconciler
  (`createCommerceConformanceRuntime`). `@mpgd/game-services` uses it to run
  the fourteen vectors through its `createCommerceReconciler`. The reference
  run an adaptive vector's expectations are derived from keeps using the
  reference reconciler, so a derived expectation never depends on the runtime
  under test.
  
  `createDerivedPurchaseIdempotencyKey` percent-encodes the Apps in Toss order
  id (`apps-in-toss:purchase:<encodeURIComponent(orderId)>`), which is the
  byte-for-byte form of the v1 `createAppsInTossPurchaseIdempotencyKey` helper
  in `@mpgd/game-services`; ids without reserved characters are unchanged.
  `CommerceProvider.finishTransaction` documents that it is called again after
  a crash between a successful finish and its journal write, so it must be
  idempotent per transaction. — Thanks @imjlk!

## 0.21.0 — 2026-10-12

### Minor changes

- [1c340264](https://github.com/imjlk/mpgd-kit/commit/1c34026433f01f432b57d7c9530a3f30dcb3570e) Commerce v2, PR B7: the credit wallet contract.
  
  `@mpgd/platform/commerce-wallet` is a new public subpath (RFC "Credit wallet",
  "Credit lots", "Billing authority and memberships", "Subscriptions"):
  
  - `createCreditCommerceProvider(client, { titleId, billingAuthority, currencies?, capabilities?, now? })`
    turns a project-owned `CreditWalletClient` into a `CommerceProvider`:
    `fetchProducts` lists the wallet's offers (memberships omitted where the
    billing authority is `store`), `requestPurchase` spends the offer price
    times the quantity under the game's idempotency key and answers `purchased`
    with `adapter-settled` evidence `credit-wallet.spend.v1` carrying the debits
    and the wallet's entitlement id and no `settlement` pointer (the backend
    ledger entry exists only after that evidence is verified), a membership
    under `store` authority fails with `ITEM_UNAVAILABLE`, a wallet
    `INSUFFICIENT_BALANCE` is a `failed` outcome with that code,
    `getAvailablePurchases` lists unredeemed entitlements, `finishTransaction`
    redeems one and refuses to run without the ledger entry id of its grant,
    `restorePurchases` re-reads the unredeemed entitlements as `purchaseUpdated`
    events (buffered once per transaction before the first listener; recovery
    reads skip a malformed offer or entitlement and treat an offers outage as
    no offers rather than hiding purchases), `getActiveSubscriptions` exists
    when the client has it, a listener that throws is logged and never stops
    the others, the client's events
    for the title pass through the standard pre-listener buffer, and
    `dispose()` releases the client subscription. A `purchased` answer requires
    the wallet's debits to add up to the price; `purchasedAt` is the wallet's
    settlement time, so a replay and a later `getAvailablePurchases` read show
    one purchase with one evidence payload; entitlements the wallet lists for
    another title are dropped. The capability block is the RFC profile row
    (`purchase.subscription` only under `host` and only when the client has
    `getActiveSubscriptions`, `lifecycle.events: true`,
    `lifecycle.finish: 'server'`, `authority.evidence: 'adapter-settled'`,
    `accountBinding: 'host'`; `createCreditCommerceCapabilities` reports
    subscriptions only when told `{ subscriptions: true }`); a wallet that
    reports no settlement time gets one fallback `purchasedAt` per entitlement
    that every replay repeats; malformed client answers, including a
    `subscription`-kind offer without membership terms, are `INVALID_RESPONSE`
    and an offer priced in an undeclared catalog currency is
    `CONFIGURATION_REQUIRED`.
  - Pure lot and membership rules shared by consumer wallet services and the
    reference wallet: `deriveCreditLotSpendScope` with a `CreditScopeRegistry`
    (`assertCreditScopeRegistry` rejects `cross-title` for `google-play` and
    `app-store`, and a promotion lot attributed to either cannot be issued
    `cross-title`), `selectEligibleCreditLots`, `isCreditLotEligible`,
    `compareCreditLotSpendOrder`, `planCreditDebits`, `sumCreditLotRemaining`,
    `sumCreditDebits`, `creditPriceMultiple`, `sameCreditAmount`,
    `createMembershipRenewalKey` (`membership:<subscriptionId>:<periodIndex>`),
    `createCreditSubscriptionEventId` (`<subscriptionId>:<periodIndex>:<type>`),
    the `CreditSubscriptionEvent` shape with the four lifecycle types,
    `createCreditWalletSpendEvidence` / `readCreditWalletSpendEvidence`,
    `parseIsoDuration`, `isIsoDuration`, `addIsoDuration(at, period, times)`
    (positive periods only, months anchored on the start date with the day
    clamped), and `normalizeIsoTimestamp`.
  - `resolveCommerceBillingAuthority(profile, override?)`: `google-play` and
    `app-store` are always `store` and reject a `host` override, `web` and
    `web-preview` default to `host`, every other profile to `store`.
  - `createInMemoryCreditWallet({ store, currencies, now?, offers?, creditScope?, maxRenewalsPerTick? })`
    is the reference wallet implementing `CreditWalletClient` plus the
    owner-side operations (`creditFromGrant` keyed by `ledgerEntryId`,
    `addOffers`, `startMembership`, `renewDue(now)`). It prices every spend by
    its offers (`amount` must be a whole number of the price; an unknown
    `logicalId` is `ITEM_UNAVAILABLE`), records a membership start under the
    client's key as well as `membership:<key>:0` so every replay of that key
    returns the original debits even after the membership lapsed, refuses a
    subscription id reused with other terms, judges renewal lot eligibility at
    the period boundary it pays for and ignores lots granted after it
    (`CreditLotEligibility.createdBy`), charges at most `maxRenewalsPerTick`
    periods per tick (12 by default), rejects a conflicting grant replay
    (different amount, currency, origin, timestamps, or scope), reserves the
    `membership:` key prefix, and rejects a key reused for a different spend.
    `subscribe(listener, { titleId })` delivers a title-scoped membership's
    events only to that title's listeners.
  - typia validators `assertCreditLotGrant`, `assertCreditMembershipTerms`,
    `assertCreditRedeemInput`, `assertCreditSubscriptionEvent`,
    `assertCreditMembershipStartInput`, `assertCreditLotSpendScope`, and
    `assertCreditWalletOffer` (membership terms only on `subscription` offers,
    every `subscription` offer with terms, a positive period, and a membership
    priced as its terms say).
  
  `@mpgd/platform/commerce`: `CreditWalletClient` gains the optional
  `getActiveSubscriptions({ titleId })` and an optional second `subscribe`
  argument `CreditWalletSubscribeInput` (`{ titleId? }`); a `debited`
  `CreditSpendResult` may carry `createdAt`, the wallet's settlement time, which
  the provider uses as `purchasedAt`; a `CreditEntitlement` may carry
  `quantity`, the units bought at spend time, which the provider reports instead
  of deriving one from the current price (the derivation stays as a fallback).
  
  `@mpgd/platform/commerce-conformance`: `createCommerceConformanceWallet` and
  `createCommerceConformanceWalletProvider` now delegate to the wallet module
  (the provider is `createCreditCommerceProvider` with the vector profile as its
  capability block, after registering the vector catalog as the wallet's offers
  when it lists none), so the three wallet vectors run through the public
  provider. Behaviour changes a caller of the conformance wallet sees:
  
  - `addIsoDuration`, `normalizeIsoTimestamp`, `compareCreditLotSpendOrder`, and
    `deriveCreditLotSpendScope` are re-exports of the wallet module;
    `deriveCreditLotSpendScope` takes an options object (`{ explicit, creditScope }`)
    instead of a positional explicit scope (a JS caller still passing a scope
    gets the derived `title` scope), and `addIsoDuration` gains a `times`
    argument, rejects zero-length durations (`P0D`, `PT0S`, `P1DT`), and anchors
    month arithmetic with the day clamped (`2026-01-31` + `P1M` is now
    `2026-02-28`, not `2026-03-03`).
  - `CommerceConformanceWallet` has `offers`, `addOffers`,
    `getActiveSubscriptions(input?)`, and `subscribe(listener, input?)`; a
    `spend` with a `logicalId` is priced by the registered offers.
  - `redeem` is no longer unconditional: an empty ledger entry id returns
    `{ redeemed: false }`, redeeming again under the same ledger entry id is a
    no-op `true`, and a different ledger entry id cannot claim an entitlement.
    `finalize` is async and redeems through `redeem` with the backend's ledger
    entry id.
  - `startMembership` replays answer with the original period-0 debits in any
    state; a subscription id reused with other terms is `INVALID_RESPONSE`.
  - The wallet provider surfaces unredeemed entitlements whose offer is gone
    (under their logical id), carries `credit-wallet.spend.v1` evidence instead
    of the fixture schema, no longer sets `settlement` on wallet purchases, and
    omits memberships whenever `purchase.subscription` is false.
  - A client key that equals the id of a membership the owner started is
    rejected on `spend` unless it replays that membership's start, and
    `startMembership` refuses a subscription id already used as a spend key. — Thanks @imjlk!

## 0.20.0 — 2026-10-12

### Minor changes

- [5ccf7d2a](https://github.com/imjlk/mpgd-kit/commit/5ccf7d2aff6eea146da37f366782a5936c08987d) Commerce v2, PR A3b: profile-adaptive conformance vectors in
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
  which the fake backend answers from its own grant state); `available` is
  what the reference store still lists once idle, empty after a completed
  finish. Derived keys carry the provider's store id in the `store:<store>:`
  prefix only. Owner-independent fields keep the fixture expectation, and the
  reference harness ignores the flag, so the fourteen committed vectors pass
  unchanged.
  
  `CommerceConformanceVectorResult` gains `status: 'passed' | 'failed' |
  'skipped'`, `reason` for skipped vectors, and `adaptive` (the derived
  expectation, store id, finish owner, and evidence authority) for adaptive
  runs. A skipped vector has `passed: false` and no failures; a throwing
  `createProvider`, `getCapabilities()`, or expectation read is a `failed`
  result, never a rejection, and a reference run that cannot play the scenario
  under the provider's capabilities is a skip naming the failing step. Derived
  keys are re-derived with `createDerivedPurchaseIdempotencyKey` for the
  provider store (`adaptDerivedPurchaseKey`), so store-specific key forms such
  as Play token keys adapt too. The runner skips a vector when a `requestPurchase` names a product
  kind or quantity the provider does not sell, a store-side `pending` purchase
  needs `lifecycle.pending`, a store `error` event needs `lifecycle.events`, a
  store completion cannot be polled by the next `reconcile` or `start` under
  `events: false`, or a `queueFinish` script needs a `client` or `host` finish
  owner, and it runs only one member of the `purchase-<owner>-finish` family
  per run (the one named after the provider's owner, else the first by name),
  reporting the others as duplicates. The reference reconciler now polls
  `getAvailablePurchases` on every pass for a provider without
  `lifecycle.events`, and the fake store emits no events for such a profile.
  `createCommerceConformanceBackend` accepts `finalizeOnReread`, which answers
  a replayed granted key as finalized. New exports:
  `isAdaptiveCommerceConformanceVector`,
  `commerceConformanceAdaptiveSkipReason`,
  `deriveAdaptiveCommerceConformanceExpectation`,
  `adaptDerivedPurchaseKeyStore`, `CommerceConformanceVectorStatus`,
  `CommerceConformanceAdaptation`, and `CommerceConformanceResolvedExpectation`.
  The `CommerceConformanceVector` JSON Schema includes the new optional
  `profile.adaptive` field. — Thanks @imjlk!
- [d59304d8](https://github.com/imjlk/mpgd-kit/commit/d59304d8eec21ad61f8e24c07bbafb44e953b268) Commerce v2, PR B5: `@mpgd/platform/commerce-conformance` lets a store actor
  declare the token it reports for a fixture purchase.
  
  `CommerceConformanceStoreActor.tokenOf?(purchase)` names the `token` the
  provider under test reports for a scripted purchase when it is not the
  fixture's own, for example a host-order store that reports the transaction id
  (RFC "Client contract"). An adaptive run replays the fixture purchases with
  that token into the reference store (`withStoreTokens`, now exported), so the
  derived `verifyRequests` carry the token the provider reports instead of the
  fixture's. Actors without the hook keep the fixture token; the committed
  vectors and the reference harness are unchanged. — Thanks @imjlk!
- [b9520179](https://github.com/imjlk/mpgd-kit/commit/b952017944bc6f1978fb922be405d148bf3175c0) Commerce v2, PR B1: the `StoreSdk` provider and registry wiring in
  `@mpgd/adapter-capacitor`, and the transitional `commerceV2` gateway field in
  `@mpgd/platform`.
  
  `@mpgd/adapter-capacitor` adds `StoreSdk`, the in-process surface a store
  plugin exposes (`fetchProducts`, `requestPurchase`, `getAvailablePurchases`,
  optional `finishTransaction`, `restorePurchases`, and `getAvailability`,
  `addListener`, and a static `capabilities` declaration), with its event,
  product, purchase, and error types, `defaultStoreSdkErrorCodeMap`, and
  `normalizeStoreSdkError`. `createStoreCommerceProvider({ sdk, products,
  evidenceSchema, evidencePayload?, accountBinding?, capabilities?, authority,
  mapError? })` returns a `CommerceProvider` from `@mpgd/platform/commerce` that
  maps logical ids to store SKUs, fails closed before the store UI opens, builds
  purchases with the store token and evidence envelope, buffers events until the
  first subscriber, composes fresh capabilities on every read, validates every
  SDK answer, and normalizes every SDK failure into a `CommerceError` with the
  store code kept; it never grants and never sets `settlement`. The provider
  registry accepts a `CapacitorServiceProvider` with a `commerce` field
  (`createCommerceServiceProvider` builds one): the six `commerce.v2.*` bridge
  methods are served through `createCommerceProviderBridge` with the A2 payload
  and result asserts and the `{ protocol: 'mpgd.commerce.v2', sequence, event }`
  event envelope, the four v1 `commerce.*` methods through `toCommerceAdapter`,
  and a provider may not declare both. `createCapacitorPlatformGateway` exposes
  the registered provider as `gateway.commerceV2` (through the validated bridge
  path, with `createBridgeCommerceProvider`) and adds the `commerce` capability
  block from which `nativeIap` and `subscriptionIap` are derived. The
  conformance test runs every store vector against a fake `StoreSdk` directly
  and through the gateway bridge path. Without a v2 provider nothing changes.
  
  Two provider rules follow the RFC "Errors" section: a store failure that
  normalizes to `OUTCOME_UNKNOWN` or `ALREADY_OWNED` answers `launched` (the
  attempt stays recoverable; `recoverableErrorCodes`) and such `purchaseError`
  events are not forwarded, and a `lifecycle.restore` override without
  `sdk.restorePurchases` is rejected at construction. The gateway reads the
  commerce block through the registry's bounded `getCapabilitySnapshot()` (a
  stalled or invalid provider yields `createDegradedCommerceCapabilities()`
  instead of a rejected read) and keeps a `launched` purchase's external
  activity open until the product's event, `launchedPurchaseActivityTimeoutMs`,
  or dispose.
  
  `@mpgd/platform` adds the optional `PlatformGateway.commerceV2?:
  CommerceProvider` field, transitional until C4 removes the v1 adapter. The
  client contract types (`StoreProduct`, `StorePurchase`, `CommerceProvider`,
  and the rest of the RFC "Client contract") now live in the typia-free
  `commerce-contract` module and are re-exported unchanged by
  `@mpgd/platform/commerce`; validators and the committed JSON Schemas are
  identical. — Thanks @imjlk!

## 0.19.0 — 2026-10-11

### Minor changes

- [a4fa5b14](https://github.com/imjlk/mpgd-kit/commit/a4fa5b14440e94c775baaf574dece7abaa0092b7) `@mpgd/platform` adds the commerce v2 contract module as the new `./commerce`
  and `./commerce-vectors` subpaths: the client contract types (`StoreProduct`,
  `StorePurchase`, `RequestPurchaseInput`, `CommerceEvent`, `CommerceProvider`,
  `CommerceCapabilities`, `ActiveSubscription`, credit wallet types), the bridge
  v2 payload shapes and event envelope, `CommerceError` with normalized codes,
  the purchase lifecycle state machine, typia validators that reject unknown
  keys, `createDerivedPurchaseIdempotencyKey`, the bounded pre-listener event
  buffer, `assertRequestPurchaseSupported`, the v1 `toCommerceAdapter` wrapper
  (which never grants), and the conformance vector format. `PlatformCapabilities`
  gains an optional `commerce` block that the capability conformance runner
  checks for fresh objects, exact keys, and agreement with `nativeIap` and
  `subscriptionIap`. This is additive: no reference provider implements v2 yet,
  and the protocol version stays `2.0.0-draft.1`. The package now depends on
  `typia`.
  
  `@mpgd/catalog` opens `ProductGrant.currency` and `AdReward.currency` to any
  non-empty string validated against a new optional `ProductCatalog.currencies`
  list (non-empty, unique, trimmed); when absent the catalog accepts `coin` and
  `gem` as before. `assertProductCatalog` and `validate:catalog` reject a currency
  grant that names an undeclared currency, `validate:ads` cross-checks reward
  currencies against the catalog, and `resolveCatalogCurrencies` and
  `defaultCatalogCurrencies` are exported. The kit adds no wallet currency
  literal.
  
  `@mpgd/adapter-verse8` keeps its `coin` and `gem` balance map and now fails a
  currency grant for any other catalog currency with a clear error instead of
  writing an untracked balance.
  
  `@mpgd/game-services` accepts any currency the product catalog declares: the
  ledger grant validator no longer hard-codes `coin` and `gem` (it requires a
  trimmed non-empty code), and `createGameServicesBackend` rejects a catalog
  product grant or placement reward whose currency the catalog does not declare,
  so an undeclared currency fails at startup instead of at the first grant. — Thanks @imjlk!
- [b8183b9a](https://github.com/imjlk/mpgd-kit/commit/b8183b9a93fd47b83d2fb4f27f0f8d5fd56db86f) `@mpgd/platform` adds the commerce v2 conformance runner as the new
  `./commerce-conformance` subpath. `runCommerceConformanceVector` and
  `runCommerceConformanceVectors` execute the RFC vector files against a
  provider and report `{ vector, passed, failures: [{ path, expected, actual }] }`,
  matching only the listed expectation fields. The subpath also exports the
  in-memory reference pieces every vector needs and that B-phase provider tests
  can compose: a fake clock, a fake store with its `CommerceProvider`
  (scripted `requestPurchase` and `finishTransaction` answers, buffered
  pre-listener events, unfinished purchase listing), a fake backend with a
  scripted verify queue and an append-only ledger with server-push grants,
  revocations, and ledger status reads, a `CommerceJournalStore` interface with
  an in-memory journal that keeps every state revision, the reference
  reconciler runtime implementing the RFC purchase lifecycle (derived keys for
  discovered purchases, `IN_PROGRESS` serialization per product, client, host,
  server, and none finish owners, ledger-driven revocation), and a reference
  credit wallet with a wallet-backed provider implementing the credit lot spend
  order, idempotent spends and grants, and credit-funded memberships with
  idempotent per-period renewal and lapse. All fourteen vectors pass with the
  reference provider; `options.createProvider` lets another provider run the
  same files. The protocol version stays `2.0.0-draft.1`. — Thanks @imjlk!

## 0.18.0 — 2026-10-11

### Minor changes

- [e14ba051](https://github.com/imjlk/mpgd-kit/commit/e14ba0514288111447a5272e052682e1aae8f06a) Harden the built-in Apps in Toss purchase flow with recovery rules proven by a
  production game. Purchase verifiers now receive the game's own purchase key as
  `clientIdempotencyKey` on every path that can link an order to it, including
  restore after a reload. A new checkout is no longer opened while a paid order
  for the same product is still ungranted, only one checkout runs at a time
  (restore waits its turn with a retryable code), and a `PRODUCT_NOT_GRANTED_BY_PARTNER`
  error triggers one direct re-check of that order. Restore returns
  `settledPurchases` and reports failures as coded errors instead of an empty
  success; `getEntitlements` likewise rejects when the configured authority read
  fails. Catalog and purchase outcomes carry stable diagnostic codes
  (`aitIapDiagnosticCodes`). Add `aitBrowserOrigins()` and `isAitBrowserOrigin()`
  (`@mpgd/adapter-ait/origins`) for exact CORS allowlists. `@mpgd/platform` adds
  the optional `CommerceDiagnostic` type, `diagnostic` fields on purchase and
  restore results, and `idempotencyKey` on `PurchaseSettlement`.
  `@mpgd/adapter-capacitor` validates the new `diagnostic` and settlement
  `idempotencyKey` fields in native provider responses. — Thanks @imjlk!

## 0.17.0 — 2026-10-09

### Added

- [537c6168](https://github.com/imjlk/mpgd-kit/commit/537c6168a902332e6c62ab0585d2cdfac946e51a) Add the ONE play H5 Web SDK target and browser adapter subpath, asynchronous host loading acknowledgements, synchronous exit checkpoints, platform asserted identity, audio/safe-area integration, and interstitial presentation handling that keeps uncertain native outcomes quarantined. Include target build, hosting headers, generated starter wiring and explicit server authority gates for subsequent monetization integrations. — Thanks @imjlk!
- [a483af3f](https://github.com/imjlk/mpgd-kit/commit/a483af3fb7f789a9edc71cc513e7c122d0b1e4b6) Add ONE play managed purchases with authenticated checkout intents, independent API V7 verification, ledger-before-consume or acknowledge finalization, signed PNS recovery and authoritative cancellation hooks. Map partial product detail batches and expose trusted native checkout presentation facts through the shared commerce contract and runtime. Keep subscriptions unsupported and server integrations required. — Thanks @imjlk!

## 0.16.0 — 2026-10-09

### Minor changes

- [2d35eb0e](https://github.com/imjlk/mpgd-kit/commit/2d35eb0ecd89eef1058e4b9983eb284f7ba38adc) Add a CrazyGames web target and the browser adapter's `/crazygames` entry point with official v3 SDK initialization, loading/gameplay reporting, and interstitial ads using the shared presentation contract. Basic Launch keeps monetization disabled; Full Launch enables configured interstitial placements. Rewarded ads and purchases remain unavailable pending independent backend verification. Generated starters enter free play directly and retain scene, lifecycle, and native presentation ownership through game-owned gameplay scopes. — Thanks @imjlk!

## 0.15.0 — 2026-10-09

### Added

- [da9fe97b](https://github.com/imjlk/mpgd-kit/commit/da9fe97b32d888a1f42acbd58aa48dbf35d07d35) Coordinate full-screen purchase and advertising ownership, independent execution blocks, caller deadlines, duplicate invocations, and late claim evidence. Keep native closure separate from backend settlement, and carry proof-lookup correlation without asserting reward eligibility. — Thanks @imjlk!
- [dadcf725](https://github.com/imjlk/mpgd-kit/commit/dadcf725cd9939130f4790e1b20fd037f6888f8b) Add versioned advertising provider and conformance entrypoints with separate presentation and reward eligibility, validated event/result envelopes, pure session transitions, and a compatibility facade that leaves grants to the backend ledger. Run provider fixtures against shared scenario vectors with intermediate ownership checks and isolated expectations. — Thanks @imjlk!

## 0.14.0 — 2026-09-28

### Minor changes

- [9c3b6cc0](https://github.com/imjlk/mpgd-kit/commit/9c3b6cc0656ac7b2722cc658b585e6775e9b20b6) Add an opt-in durable monetization operation journal and explicit pending purchase and rewarded-ad outcomes, so games can reconcile server grants and provider finalization without replaying purchase or ad UI. — Thanks @imjlk!

## 0.13.0 — 2026-09-25

### Minor changes

- [bd7d0125](https://github.com/imjlk/mpgd-kit/commit/bd7d0125fc8201e17f92988c4ad177563e004175) Connect Capacitor app state, Android back navigation, and classified cold/warm
  URL entry to the platform lifecycle contract. Keep OAuth redirects separate
  from game links, own and dispose only registered listeners, and hold game
  execution while optional external provider UI is still active. Include the
  App plugin in generated native projects. — Thanks @imjlk!
- [f6e47baa](https://github.com/imjlk/mpgd-kit/commit/f6e47baa9c84aee3b3ea67bdba192bbeae2ba4af) Add optional Capacitor provider composition with per-method bridge validation and
  fail-closed readiness reporting. Distinguish uninstalled, unconfigured,
  action-required, transient, and available features without changing existing
  purchase result states. Expose subscription and native/remote leaderboard
  availability separately while preserving legacy target configuration defaults.
  Fix the base plugin's ESM-relative export so the published tarball can be
  imported by Node-based consumers and native build tooling.
  Keep generated starter target-availability checks aligned with the new readiness states. — Thanks @imjlk!
- [7a27b7f8](https://github.com/imjlk/mpgd-kit/commit/7a27b7f8b033ca987eefe859a702d0c08eba0800) Expose an optional Capacitor viewport state and change subscription with
  separate safe-area, system-bar, keyboard, and named occupied-surface geometry.
  Resolve one usable CSS-pixel rectangle without double-counting overlapping
  native or CSS insets, and convert provider-owned physical-pixel surfaces at
  the adapter boundary.
  Align newly scaffolded games with the SystemBars CSS safe-area fallback. — Thanks @imjlk!
- [b7ffbf9d](https://github.com/imjlk/mpgd-kit/commit/b7ffbf9d8baedbae894063e89a07509fc96dfd46) Add a separate fail-closed credential storage contract to the Capacitor base
  bridge. Android uses a Keystore-held AES-GCM key with no-backup ciphertext
  files, and iOS uses device-only
  Keychain items; neither falls back to ordinary game JSON storage. — Thanks @imjlk!

## 0.12.2 — 2026-09-24

### Added

- [095d603](https://github.com/imjlk/mpgd-kit/commit/095d603e33061975bfd1e46a5e24639eee2e8597) Expose server-confirmed consumable purchase settlements from restore flows and
  provide a shared resolver that never treats native checkout completion alone as
  a durable grant. — Thanks @imjlk!

### Patch changes

- [a8cba3e](https://github.com/imjlk/mpgd-kit/commit/a8cba3e5168d94c0bdfc13b0992e7e8c32bcdb2c) The capability conformance runner now rejects a provider that reuses an earlier snapshot after a transition or mutates the fixture's aliased expectation, even when later values appear to match. — Thanks @imjlk!

## 0.12.1 — 2026-09-23

### Changed

- [c25bfb5](https://github.com/imjlk/mpgd-kit/commit/c25bfb52149c10ab9a5ab47fd8a58a960774d232) Build and validate published package metadata with ttsc 0.30.4, and generate Phaser games and target wrappers with the same toolchain. Preserve authored source siblings in the ttsx runner and verify graph presets against the current request and response contracts.
  
  Pin the monorepo runtime source root so cross-project imports keep emitted files inside the ttsx cache. Generated workspace games use the common game/kit root instead of inheriting the kit's narrower source root. — Thanks @imjlk!

## 0.12.0 — 2026-09-02

### Minor changes

- [916f648](https://github.com/imjlk/mpgd-kit/commit/916f648d113c975f8a2bf7074deb38d9506ce014) Add experimental WeChat and TikTok native mini-game target contracts, shared runtime classification, and notification target validation. — Thanks @imjlk!

## 0.11.0 — 2026-08-29

### Minor changes

- [c1c39a2](https://github.com/imjlk/mpgd-kit/commit/c1c39a2aaaefcde6a2a04e5ae06c784df07d0fce) Preserve provider-neutral platform operation codes and retry hints across adapter boundaries. Apps in Toss now uses the current anonymous identity API, coalesces concurrent identity reads for one wrapper session, retries a rejected identity read after the host recovers, and gives generated games an explicit native Sandbox wrapper command without local SDK or identity mocks. — Thanks @imjlk!

## 0.10.0 — 2026-08-26

### Added

- [17cbec9](https://github.com/imjlk/mpgd-kit/commit/17cbec9de406aae06949b1c9df832f3ae0446b95) Add provider-neutral inline banner placements and surface lifecycle methods. Apps in Toss hosts now
  initialize and attach Toss banner ads by game-owned surface ID, report rendered/no-fill/failure
  states, and destroy active attachments on unmount. Target configuration, effective artifacts,
  starter validation, and bridge contracts understand optional `bannerAds` capability flags while
  remaining compatible with previously published adapters and target matrices. — Thanks @imjlk!

## 0.9.0 — 2026-08-12

### Added

- [8d8e36a](https://github.com/imjlk/mpgd-kit/commit/8d8e36ae790d2dfa1971a10ce5c3aab64f1a31fe) Add fail-closed Microsoft Store PWA Digital Goods checkout with player-scoped retry storage, provider-purchase- and generation-bound server recovery ownership, explicit historical product mappings, first-class target configuration, opt-in remote leaderboard capability discovery, submission product mappings with effective-target revalidation, and authoritative Collections query and consume fulfillment. — Thanks @imjlk!

## 0.8.0 — 2026-07-23

### Added

- [d88309c](https://github.com/imjlk/mpgd-kit/commit/d88309c46dd0df84fc33580eff643fd8c820eab4) Add server-authorized platform promotion rewards and Apps in Toss notification agreement support. — Thanks @imjlk!

## 0.7.0 — 2026-07-17

### Added

- [204fe80](https://github.com/imjlk/mpgd-kit/commit/204fe807cdc476bb8555693433c636c8fa6b06ea) Add reusable local and remote storage conformance checks, injectable browser
  storage, and fail-closed persistence behavior across browser, native bridge,
  Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
  identity, provider, serialization, and quota failures without switching to a
  browser fallback store. Bridge-backed targets preserve top-level JSON `null`
  without confusing it with a missing key. Capacitor's shipped Android and iOS bridges now persist
  bounded JSON values through native local storage and run native conformance
  tests in CI. — Thanks @imjlk!
- [5845206](https://github.com/imjlk/mpgd-kit/commit/5845206ec7675e43873b8232ecd9a1628b167040) Add a first-class Verse8 iframe target with verified host identity mapping, target-isolated starter builds, notification target normalization, and explicit unavailable monetization and Agent8 service capabilities. — Thanks @imjlk!
- [e3fb909](https://github.com/imjlk/mpgd-kit/commit/e3fb90993fa5b33fdbd293413903d77f52686c08) Add a provider-neutral PlatformGateway capability conformance runner, keep target-configured capability reads live, and isolate bridge-owned capability snapshots before exposing them to callers. — Thanks @imjlk!

## 0.6.0 — 2026-07-15

### Added

- [ec79bf0](https://github.com/imjlk/mpgd-kit/commit/ec79bf095f2a35b78d18b0b8a91ebdb5124c9df2) Added a provider-neutral purchase and rewarded-ad evidence verifier boundary,
  versioned adapter evidence envelopes, explicit development verifier helpers,
  bounded verifier execution, authority-level replay protection, and fail-closed
  entitlement grants when production verification is unavailable. Idempotency
  retries now reject changes to the original logical grant or platform target,
  including raced writes, while concurrent identical retries return the original
  successful ledger result. Existing stores can use list fallbacks when optional
  indexed idempotency, authority-evidence, or historical platform-evidence
  lookups are not implemented; both evidence identities are serialized per store
  instance before the fallback write. — Thanks @imjlk!

## 0.5.1 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

## 0.5.0 — 2026-07-13

### Added

- [81b1bab](https://github.com/imjlk/mpgd-kit/commit/81b1bab1be4e9234187cc1db673d9b724f80d728) Distinguish a presented share surface from confirmed share completion and expose a conservative Devvit share-sheet wrapper. — Thanks @imjlk!

## 0.4.0 — 2026-07-11

### Added

- [ecd7a9c](https://github.com/imjlk/mpgd-kit/commit/ecd7a9c6dc79f585d767518b060baffb792ec112) Add shared identity-session, launch/presentation, share, inbound-link, and notification-subscription contracts with safe browser, Apps in Toss, Capacitor, and Devvit adapter behavior. — Thanks @imjlk!

### Changed

- [84b3f83](https://github.com/imjlk/mpgd-kit/commit/84b3f836041c5c3513f3b2bf8b2c5414adfded0a) Allow games to define their own logical product and ad placement identifiers while preserving the starter identifiers as suggested literals. — Thanks @imjlk!

## 0.3.2 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy

## 0.3.1 — 2026-07-06

### Patch changes

- Bumped due to fixed dependency group policy

## 0.3.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

## 0.2.0 — 2026-07-06

### Minor changes

- Bumped due to fixed dependency group policy

## 0.1.0 — 2026-07-04

### Changed

- [0863a9a](https://github.com/imjlk/mpgd-kit/commit/0863a9a6b6cd7e457d8d39c1cde6ae38077edc65) Prepare npm package publishing by building runtime JavaScript and declaration files into `dist/`, exposing package entrypoints from `dist`, and adding pack smoke validation before release automation. — Thanks @imjlk!
- [e882f8e](https://github.com/imjlk/mpgd-kit/commit/e882f8e8a9594274bef4062e71c3d303fa496653) Reduce the public package surface around platform, bridge, catalog, analytics, and game-services packages. Move backend ledger modules, demo game primitives, save/economy/anti-cheat helpers, and release-manifest tooling behind private workspace boundaries while keeping game-services analytics events wired through purchase, rewarded ad, and leaderboard flows. — Thanks imjlk!
- [c1bf605](https://github.com/imjlk/mpgd-kit/commit/c1bf605064901abe3d3fa02c68e541d25ded14d2) Prepare the repository for public visibility with MIT licensing, package metadata, community files, issue templates, and automated public-readiness validation. — Thanks imjlk!

### Added

- [b4cf146](https://github.com/imjlk/mpgd-kit/commit/b4cf1469758dcd64ee684b4787ac717bf4bed45b) Add target-managed localization support through localized content capabilities, target runtime snapshots, a shared Paraglide-backed message package, demo locale resolution, and mock platform capability responses. — Thanks imjlk!
- [851a3f1](https://github.com/imjlk/mpgd-kit/commit/851a3f194898bb66863cd06dd2732d6d39e4c88a) Bootstrap the initial `mpgd-kit` monorepo with Phaser, platform contracts, adapters, validation tools, target build orchestration, Capacitor native plugin mocks, Apps in Toss artifacts, and idempotent backend ledger flows. — Thanks imjlk!

