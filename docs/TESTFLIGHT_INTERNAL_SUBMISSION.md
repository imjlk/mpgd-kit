# TestFlight internal submission (D-09)

`@mpgd/cli` exposes `submitVerifiedIosBuild()` for an immutable iOS build
record from `recordNativeReleaseBuild()`. It checks the IPA SHA-256, bundle ID,
signing team ID, and reserved marketing/build versions before contacting Apple.
It does not rebuild, re-sign, submit for App Review, or answer export-compliance
questions.

Use the reviewed `asc` 5.5.0 binary whose host-specific SHA-256 is pinned in
the published CLI's `asc-pin.json`. The caller passes its absolute path and a
game-owned App Store Connect API key ID, issuer ID, and base64-encoded `.p8`
material. The CLI verifies the binary checksum, disables telemetry and
keychain access, isolates the temporary home, limits process time and output,
redacts credentials, and removes the temporary session afterward. The `.p8`
API key is not the iOS signing private key.
It stages and hashes a private copy of the IPA so the upload reads the same
bytes that passed preflight even if the caller's original file changes.
On macOS, the existing Kit IPA inspector also verifies the staged app's code
signature, team, bundle ID, and versions before any App Store Connect mutation.
The first iOS submission implementation does not run on Linux or Windows.

The submission confirms the numeric App Store Connect app ID has the expected
bundle ID and the configured TestFlight group is internal. It checks for an
existing version/build number before uploading, then uses separate `asc builds
upload`, build lookup, and group-assignment commands. It never uses `asc
publish` or an all-in-one public-release command. An upload result is not
treated as a processed or tester-ready build.
The upload requests checksum verification when Apple provides a source-file
checksum; its absence is not represented as a successful checksum proof.

Possible result statuses are `uploaded`, `processing`, `testflight-ready`,
`action-required`, `failed`, and `unknown`. Only a processed build whose
membership in the internal group is confirmed by a read is marked
`testflight-ready`. Store processing can take longer than one CLI invocation;
persist the upload ID supplied to `onUploadCommitted` alongside the immutable
record's artifact SHA-256, then resume with `resumeUploadId` and
`resumeArtifactSha256`. Resume verifies that upload under the same app, version,
and platform and rejects a mismatched local artifact hash before skipping the
transfer. Apple may not provide a checksum for a remote upload, so this is a
checkpoint consistency check, not independent proof of its bytes. An unclear upload response returns
`unknown`; do not retry blindly. If the checkpoint write fails after a
confirmed upload, `IosSubmissionUncertainError` carries the upload ID.

The credential-free state and schema tests run with:

```sh
pnpm smoke:cli-testflight-submission
```

These tests do not contact App Store Connect. Live signing, upload, processing,
tester availability, and device installation remain separate D-12 release
evidence requiring the game owner's account and approval.
