# @mpgd/capacitor-game-services

Capacitor bridge plugin shell for MPGD platform requests.

The public API intentionally starts with a single `request(input)` method using `@mpgd/bridge`, so Android, iOS, Apps in Toss, and future wrappers can share one request/response contract.

`storage.load` and `storage.save` persist bounded JSON values in native local
storage. Android uses `SharedPreferences`; iOS uses atomic files under the
application-support directory so write failures reach the bridge. On first
access, iOS migrates legacy `UserDefaults` values and removes each legacy entry
only after its atomic file write succeeds. Missing values return `null`, while
serialization, quota, and provider failures reject through bridge errors
without replacing a previously committed value.

Native CI exercises the shipped storage helpers with JUnit on Android and a
small Swift conformance executable on iOS. The TypeScript storage smoke covers
the JavaScript bridge boundary separately.
