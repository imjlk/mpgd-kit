# TestFlight submission and external testing (D-09)

This guide covers the upload to the internal TestFlight group
(`mpgd deploy submit` / `deploy run`) and, after it,
[external testing with TestFlight App Review](#external-testing-and-testflight-app-review)
(`mpgd deploy testflight`).

`@mpgd/cli` exposes `submitVerifiedIosBuild()` for an immutable iOS build
record from `recordNativeReleaseBuild()`. It checks the IPA SHA-256, bundle ID,
signing team ID, and reserved marketing/build versions before contacting Apple.
It does not rebuild, re-sign, submit for App Review, or answer export-compliance
questions. Kit shells declare `ITSAppUsesNonExemptEncryption` = false in
`Info.plist` (the kit only uses HTTPS and OS cryptography, which Apple's
[export rules](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)
exempt), so App Store Connect does not ask the question for each build. A game
that adds its own non-exempt encryption sets the key to `true` and answers the
question in App Store Connect. A production build warns when the shell's
release `Info.plist` lacks the key.

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
The pre-upload check also reads upload records for the reserved version, so a
transfer with a lost response is not blindly repeated before the build is
discoverable.
The upload requests checksum verification when Apple provides a source-file
checksum; its absence is not represented as a successful checksum proof.

Possible result statuses are `uploaded`, `processing`, `testflight-ready`,
`action-required`, `failed`, and `unknown`. A processed build (`VALID`) is
then checked for its TestFlight internal state with `asc builds
build-beta-detail view --build-id <id>` (App Store Connect
`buildBetaDetails.internalBuildState`): `PROCESSING` stays `processing`,
`MISSING_EXPORT_COMPLIANCE` and `IN_EXPORT_COMPLIANCE_REVIEW` are
`action-required`, `PROCESSING_EXCEPTION` and `EXPIRED` are `failed`, and an
unknown state is `unknown`; none of them is added to the group. Only a build
in `READY_FOR_BETA_TESTING` or `IN_BETA_TESTING` whose membership in the
internal group is confirmed by a read is marked `testflight-ready`. That read
is `asc testflight groups list --build-id`, which asc 5.5.0 prints as its own
membership result (`{ buildId, complete, groups: [{ id, type }] }`), not as
App Store Connect group resources; an incomplete lookup stays `unknown`.
Store processing can take longer than one CLI invocation;
persist the upload ID supplied to `onUploadCommitted` alongside the immutable
record's artifact SHA-256, then resume with `resumeUploadId` and
`resumeArtifactSha256`. Resume verifies that upload under the same app, version,
and platform and rejects a mismatched local artifact hash before skipping the
transfer. Apple may not provide a checksum for a remote upload, so this is a
checkpoint consistency check, not independent proof of its bytes. An unclear upload response returns
`unknown`; do not retry blindly. If the checkpoint write fails after a
confirmed upload, `IosSubmissionUncertainError` carries the upload ID.

## External testing and TestFlight App Review

`mpgd deploy submit --target ios` stops at the internal group of the deploy
profile. `mpgd deploy testflight distribute` takes the same release's recorded
build further: more internal groups, external groups for the iPhone and iPad
QA before launch, the build's **What to Test** text per locale, the app's
TestFlight review details, and the TestFlight App Review submission an
external group needs. It reads the recorded marketing version and build number
from the release state (the IPA is not needed), finds the build in App Store
Connect, and checks the app's bundle ID and the build ID the submission
recorded. `distribute` needs that recorded build ID: until the submission has
found the build, it fails and asks to re-run `mpgd deploy submit --target ios`
until it reports `testflight-ready`. The read-only `status` works without it,
matching by app, version and build number, and reports
`buildIdRecorded: false`.

```sh
# Plan: read App Store Connect and print the changes; nothing is written
pnpm exec mpgd deploy testflight distribute --plan /tmp/release-plan.json \
  --game-id mygame --release launch-001-ios \
  --groups "Studio QA,iPad QA,iPhone QA" \
  --what-to-test ./testflight/what-to-test.txt \
  --beta-review ./testflight/beta-review.json --dry-run

# Apply the same request
pnpm exec mpgd deploy testflight distribute ... --approve

# Read the groups and the review state; never writes (poll it from CI)
pnpm exec mpgd deploy testflight status --plan /tmp/release-plan.json \
  --game-id mygame --release launch-001-ios
```

It uses the same pinned `asc` 5.5.0, isolated session and credential as the
upload (`MPGD_ASC_BINARY`, `MPGD_ASC_APP_ID`, `MPGD_ASC_KEY_ID`,
`MPGD_ASC_ISSUER_ID` and the profile's key variable). `--approve` is required
to write; the profile's `preapproved-internal-test` does not cover it.

Why a separate command: the internal upload is a checkpointed, resumable
store submission that ends once the build is in the internal group. External
testing starts later (the build must have finished processing) and waits on
Apple's review, sometimes for a day. Like `deploy promote` and `deploy rollout`
on Google Play, it acts on a build that is already in the store and reads the
store each time instead of extending the release-state checkpoint. The
internal submission is unchanged.

**Groups.** `--groups` takes group IDs or exact group names, internal and
external mixed. A group must already exist: create external groups in App
Store Connect > TestFlight (Apple needs an internal group first). An unknown
name fails before anything is written and lists the app's groups; a name two
groups share needs the group ID. A group that already has the build is left
alone, so a re-run never adds it again. Groups are added with
`asc builds add-groups` without `--submit`; the submission is a separate
step.

**What to Test.** `--what-to-test` reads the `--release-notes` file format of
[Google Play releases](./GOOGLE_PLAY_RELEASES.md#release-notes) (`<en-US>…</en-US>`
blocks, or JSON), without Google Play's 500-character limit, so one file can
serve both stores when its language tags are App Store Connect locales
(`en-US`, `ko`, `ja`). Each locale is created or updated only when its text
differs. External groups need What to Test: without the option and with none
in App Store Connect, the command fails.

**Review details.** `--beta-review` is a game-owned JSON file:

```json
{
  "contactFirstName": "Ada",
  "contactLastName": "Kim",
  "contactEmail": "qa@example.com",
  "contactPhone": "+82 10 0000 0000",
  "notes": "Guest play; no sign-in is needed.",
  "demoAccount": { "required": false }
}
```

A demo account never sits in the file: `"demoAccount": { "required": true,
"nameEnv": "MPGD_TESTFLIGHT_DEMO_NAME", "passwordEnv":
"MPGD_TESTFLIGHT_DEMO_PASSWORD" }` names environment variables, which are
read at run time. A `--dry-run` without them still plans the demo account
fields and lists the unset variables under `pendingInputs`
(`demo account values: missing MPGD_TESTFLIGHT_DEMO_PASSWORD`); `--approve`
refuses to run until they are set. Review notes allow 4,000 characters (App Store Connect
`BetaAppReviewDetail.notes`). The details are written only right before a
submission, and only the fields that differ. App Store Connect never returns
a stored password, so when the `--beta-review` file declares a required demo
account, its password is sent with that write. Without `--beta-review`, or
with a demo account that is not required, no password is sent and the one
stored in App Store Connect is kept. asc 5.5.0 takes the password only as a command-line value
(`asc testflight review edit --demo-account-password`), so it is visible to
other processes on the runner for the length of that call; the session
redacts it from asc's output. Before submitting, the command fails when the
contact name, email or phone (or a required demo account) would still be
missing, naming the fields.

**Review states.** The report's `betaReview.status` comes from the build's
`externalBuildState` (App Store Connect `ExternalBetaState`) and its
`betaAppReviewSubmission` (`BetaReviewState`):

| Status | Meaning |
| --- | --- |
| `not-needed` | No external group was asked for, or the build is testable externally without a submission of its own: Apple says "the first build you submit requires a full review, but later builds for the same version might not" ([invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)) |
| `not-submitted` | Ready to submit (`READY_FOR_BETA_SUBMISSION`); `distribute --approve` submits it |
| `waiting-for-review`, `in-review` | Submitted; nothing is submitted again |
| `approved` | `BETA_APPROVED`, or a testable build with an approved submission |
| `rejected` | `BETA_REJECTED`: fix it in App Store Connect (App Review > TestFlight) and resubmit there; `distribute` exits non-zero |
| `action-required` | TestFlight waits for the export-compliance answer, as for the internal group; nothing is written, the groups are reported `blocked`, and `distribute` exits non-zero |

`distribute` reads the review state again after adding the groups and submits
only a build that still waits for its first submission. A submission in a
`betaReviewState` this kit does not know is reported `action-required`, naming
the state, and is never submitted over. After adding groups, the membership
read is retried a few times (about 17 seconds in all) before the assignment
counts as unconfirmed. `testflight status`
also reports `build-not-ready` (not uploaded, still processing, or
`NOT_READY_FOR_TESTING`: poll again) and `build-unusable` (failed processing, expired, or an internal-only
upload: stop polling and upload a new build), each with a `detail`.

While a review is open or rejected, App Store Connect (and asc) refuse to add
the build to another external group: those groups are reported as
`after-review` and added by a re-run once the review passes. Apple allows one
build of each version in review at a time and six submissions in 24 hours.

**Failing closed.** The command stops before any write when the release has
no recorded iOS build, the build is not in App Store Connect yet, still
processing (`processingState`, or the TestFlight state of a requested group
`PROCESSING`), failed processing, or expired; and, for an external group,
when it is an internal-only upload (`NOT_APPLICABLE`). A
write that fails names the steps already written; re-running the same command
skips them.

Still in App Store Connect: creating groups and adding testers (or a public
link), the app-level test information (beta app description and feedback
email), and the answers to a rejection.

The generated deploy workflow does not run external distribution: the build
is usually still processing when the deploy job ends, and the review details
may need extra secrets. Run `distribute` from a terminal or a separate
game-owned job once `deploy status` shows the iOS submission
`testflight-ready`, and poll `testflight status` (`.betaReview`) from CI.

The credential-free state and schema tests run with:

```sh
pnpm smoke:cli-testflight-submission
```

They also cover `mpgd deploy testflight` over an in-memory App Store Connect
port and the asc 5.5.0 command shapes. These tests do not contact App Store
Connect. Live signing, upload, processing,
tester availability, and device installation remain separate D-12 release
evidence requiring the game owner's account and approval.

## In-app purchases (`store products`)

The same `asc` binary, key and isolated session also create and update the
game's in-app purchases: `mpgd store products plan --store app-store` and
`apply --approve` read the catalog and `mpgd.store-listings.json`
([store product sync](./STORE_PRODUCT_SYNC.md)). TestFlight and sandbox
purchases need the in-app purchase to exist in App Store Connect; App Review
of the first consumable and non-consumable still goes with an app version,
by hand.
