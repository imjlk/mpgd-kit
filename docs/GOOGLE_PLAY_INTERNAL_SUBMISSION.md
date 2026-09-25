# Google Play internal-test submission (D-08)

`@mpgd/cli` now exposes `submitVerifiedAndroidBundle()`. It accepts an immutable
Android build record from `recordNativeReleaseBuild()`, the same AAB file, the
verified package ID, and a game-owned service-account JSON file. It does not
build or re-sign the bundle. The AAB SHA-256, package ID, inspected signer,
and reserved version code must match the record before a network request.
`recordNativeReleaseBuild()` now compares the caller's signer fingerprint with
the signer inspected from those AAB bytes before storing the record; submission
independently repeats the signer check on the file it sends.

The submission creates a Play edit, checks for a conflicting version code,
uploads a missing bundle, preserves existing internal-track releases, validates
the edit, and commits it. The commit explicitly uses
`ERROR_IF_IN_REVIEW` so unrelated changes already in review are not cancelled.
The result says `committed` only when the edit is accepted. A lost commit
response remains uncertain: creating a fresh edit to check it would invalidate
the original edit for the same API user. It does **not** assert that the build is
processed, installable, or available to testers.

Persist the edit ID supplied to `onEditCreated` before uploading. If an upload,
track update, validation, or commit cannot be reconciled, the API raises
`PlaySubmissionUncertainError` with the stage and edit ID. Do not start a new
upload merely because an HTTP response was lost; inspect that edit and the
remote track first. Definitive upload rejections retain the original Play error.
SDK retries are disabled for mutating edit operations.
The first implementation is restricted to the `internal` track. Production
promotion, staged rollout, and release approvals remain out of scope.

The credential-free test uses the pinned official Google SDK against a local
mock API and covers authentication rejection, package mismatch, version
collision, preserved track releases, lost upload/commit responses, edit
conflict, and artifact tampering:

```sh
pnpm smoke:cli-play-internal-submission
```

The SDK's generated media-upload method takes its endpoint root from the
individual request options, rather than the publisher client's root URL.
The local mock explicitly overrides that request root so fixture traffic
cannot reach Google; production calls retain the official default endpoint.
The SDK import and network implementation live under `adapters/play-publisher`;
the CLI calls a small command port and includes the adapter in its tarball.

No Play Console account or live AAB submission was used for this test. D-12
requires a game-owned account and signed external-consumer bundle to verify
actual Play internal-test availability and installation separately.
