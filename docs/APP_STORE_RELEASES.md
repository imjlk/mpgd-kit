# App Store releases: version, review submission and release

`mpgd deploy run` and `mpgd deploy submit` upload an iOS build to an internal
TestFlight group ([TestFlight internal submission](./TESTFLIGHT_INTERNAL_SUBMISSION.md)).
`mpgd store release` takes it from there to App Review and the App Store:

- `plan` and `apply` create the iOS version (or reuse the one in
  preparation), attach the build, write What's New, the copyright line and
  App Review information, set the release options, add the in-app purchases
  that must be reviewed with the version, and submit it for review;
- `status` reports where the version and its review submission stand;
- `publish` releases an approved version that waits for a manual release;
- `phased` pauses, resumes or completes a phased release.

It is the App Store counterpart of [Google Play releases](./GOOGLE_PLAY_RELEASES.md)
and uses the same reviewed plan / apply style as the
[store page sync](./STORE_PRESENCE_SYNC.md) and the
[store product sync](./STORE_PRODUCT_SYNC.md). iPhone and iPad share one
version, one build and one submission.

Sources, all read on 2026-10-31: App Store Connect API
[`AppStoreVersion`](https://developer.apple.com/documentation/appstoreconnectapi/appstoreversion)
(`releaseType` `MANUAL`, `AFTER_APPROVAL`, `SCHEDULED`) and
[`AppVersionState`](https://developer.apple.com/documentation/appstoreconnectapi/appversionstate),
[`Build`](https://developer.apple.com/documentation/appstoreconnectapi/build)
(`processingState`, `usesNonExemptEncryption`),
[modify the build for a version](https://developer.apple.com/documentation/appstoreconnectapi/patch-v1-appstoreversions-_id_-relationships-build),
[App Store review details](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstorereviewdetails),
[phased releases](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstoreversionphasedreleases)
and [`PhasedReleaseState`](https://developer.apple.com/documentation/appstoreconnectapi/phasedreleasestate),
[review submissions](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-reviewsubmissions)
(`state` `READY_FOR_REVIEW` … `COMPLETE`),
[review submission items](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-reviewsubmissionitems),
[`InAppPurchaseState`](https://developer.apple.com/documentation/appstoreconnectapi/inapppurchasestate)
and [`InAppPurchaseVersion`](https://developer.apple.com/documentation/appstoreconnectapi/inapppurchaseversion),
and [manual release requests](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-appstoreversionreleaserequests).
The kit calls them through the pinned `asc` 5.5.0
([tooling decision](./NATIVE_DEPLOY_TOOLING_DECISION.md)); the commands it
runs are listed in `packages/cli/src/app-store-release-asc.ts`.

## The game files

Nothing new to learn: the release reads files the game already has.

`mpgd.store-presence.json` ([store page sync](./STORE_PRESENCE_SYNC.md)):

- **What's New** is `appStore.localizations.<locale>.whatsNew`, the field the
  store page sync already writes. App Store Connect requires it for every
  locale of an update and takes none on the app's first version.
- **`appStore.copyright`** (new): the version's copyright line, for example
  `"2026 Block Party Studio"`. App Review refuses a version without one.
- **`appStore.review`** (new): App Review information.

```json
{
  "appStore": {
    "localizations": { "en-US": { "name": "Block Party", "whatsNew": "New puzzles.", "...": "..." } },
    "copyright": "2026 Block Party Studio",
    "review": {
      "contact": {
        "firstName": "Dev",
        "lastName": "Support",
        "email": "support@example.com",
        "phone": "+82 10 1234 5678"
      },
      "notes": "Tap Play as guest on the title screen; no sign-in is needed.",
      "demoAccount": { "nameEnv": "MPGD_REVIEW_DEMO_NAME", "passwordEnv": "MPGD_REVIEW_DEMO_PASSWORD" }
    }
  }
}
```

`contact` is required (the phone with its country code). `notes` is at most
4,000 characters. Leave `demoAccount` out when the notes are enough (a
guest flow): App Review then sees "sign-in not required". With it, the file
holds only the **names** of two environment variables, never the values,
the same way the deployment profile names the store credential. `plan` and
`apply` read both variables and fail when one is unset; the values never go
into a plan file (the plan keeps only a digest of the user name, to
notice a change). The password is at most 100 characters; a value that starts or ends with
whitespace is refused, because asc strips it before sending.

`mpgd.targets.json`: the ios target's `metadata.iosDeviceFamily`. `universal`
(and an unset value, the Capacitor iOS template's iPhone and iPad) makes the
13-inch iPad screenshots a requirement; `iphone` drops it.

The build comes from the release ledger (`--game-id` and `--release`, the
build `deploy run` recorded, checked against App Store Connect's build ID; a
record whose TestFlight submission never learned that ID is refused)
or from `--marketing-version` and `--build-number`.

## Workflow

The App Store Connect app and the API key come from the deployment profile,
exactly as for `deploy submit` and `store presence`: the bundle ID,
`MPGD_ASC_APP_ID`, `MPGD_ASC_KEY_ID`, `MPGD_ASC_ISSUER_ID`, the iOS profile's
`submissionCredential.env` and `MPGD_ASC_BINARY`. The key needs the App
Manager role.

```sh
# 1. The version does not exist yet: the plan creates it, and only that.
pnpm exec mpgd store release plan --game . --game-id mygame --release launch-002 --out release-1.json
pnpm exec mpgd store release apply --plan release-1.json --approve

# 2. Its store page: text and screenshots from mpgd.store-presence.json.
pnpm exec mpgd store presence plan --game . --store app-store --out presence.json
pnpm exec mpgd store presence apply --plan presence.json --approve

# 3. Build, What's New, App Review information, release options, purchases, submit.
pnpm exec mpgd store release plan --game . --game-id mygame --release launch-002 \
  --release-type manual --phased-release --out release-2.json
pnpm exec mpgd store release apply --plan release-2.json --dry-run   # re-check and print; write nothing
pnpm exec mpgd store release apply --plan release-2.json --approve

# 4. Follow the review, then release.
pnpm exec mpgd store release status --game . --marketing-version 1.0.1
pnpm exec mpgd store release publish --game . --marketing-version 1.0.1 --approve
pnpm exec mpgd store release phased --game . --marketing-version 1.0.1 --action pause --approve
```

`plan` flags:

| Flag | Meaning |
| --- | --- |
| `--game-id`, `--release` | The release ledger's iOS build record: its marketing version, build number and App Store Connect build ID. |
| `--marketing-version` | The marketing version. Required without `--release`; with it, must match the record. |
| `--build-number` | The build to submit. Without it (and without `--release`), the newest build of the version, compared as numbers. |
| `--release-type` | `manual` (default), `after-approval` or `scheduled`. |
| `--release-date` | With `scheduled` only: the earliest release date, ISO 8601 with time and offset (`Z` or `+09:00`), in the future when the plan writes it. |
| `--phased-release` | Release over 7 days. Off by default; an inactive phased release on the version is removed. |
| `--skip-iap` | Comma-separated product IDs to leave out of this submission (below). |
| `--rotate-demo-password` | Send the demo password again although App Store Connect has one. |
| `--presence` | Another store presence file. |
| `--out` | Save the plan for `apply`; an existing file is never overwritten. |

`apply` takes `--plan`, `--approve` (or `--dry-run`) and `--game` when the
game moved since the plan.

`plan` prints the numbered writes, then `BLOCKED` lines, `note` lines and the
`manual` steps. A plan with any blocker can be saved and read, but `apply`
refuses it, names every blocker, and writes nothing.

## The version

| On App Store Connect | Plan |
| --- | --- |
| No iOS version with this version string, none in preparation | **create** it (with the release type; a scheduled release is created manual and gets its date on the next plan). Nothing else: the version needs its store page first. |
| This version in preparation (`PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `REJECTED`, `METADATA_REJECTED`, `INVALID_BINARY`), or `READY_FOR_REVIEW` (in a submission that was not submitted, as after a failed apply) | **reuse** it |
| Another version string in `PREPARE_FOR_SUBMISSION` or `DEVELOPER_REJECTED` | **rename** it to this version string (App Store Connect keeps one version in preparation) |
| Another version string returned by App Review (`REJECTED`, `METADATA_REJECTED`) | blocked: resubmit or remove it in App Store Connect |
| This version waiting for or in review | nothing to do: `already submitted` |
| This version approved (`PENDING_DEVELOPER_RELEASE`, `PENDING_APPLE_RELEASE`, `ACCEPTED`) | nothing to do: use `publish` for a manual release |
| This version released | blocked: submit a new marketing version (re-applying the plan that released it is `unchanged`) |
| Another version waiting for review or approved | blocked: wait for it |

## The build

The build must be of the same marketing version (App Store Connect lists
builds by it). With `--release`, the build ID App Store Connect lists must be
the one `deploy run` recorded, or the plan stops.

Blockers, each with what to do: the build is not listed yet, is still
`PROCESSING`, is `FAILED` or `INVALID`, has expired, or is missing its export
compliance answer (`usesNonExemptEncryption` unset; ship
`ITSAppUsesNonExemptEncryption` in Info.plist). Without `--build-number`, a
newest build that is still processing blocks the plan instead of falling
back to an older one; pass `--build-number` to choose one. A build that
declares non-exempt encryption is noted: its export compliance
documentation is approved in App Store Connect. A different build already
attached to the version is replaced, and the plan says which.

## Checks before submitting

The plan fails closed. Every blocker names its fix:

| Check | Blocked when |
| --- | --- |
| Store page | A locale of the store presence file has no localization on the version (run `store presence apply`), or an update's locale has no What's New in the file nor on App Store Connect. A locale only on App Store Connect is noted, or blocked when it lacks What's New. |
| Screenshots | The primary locale's version localization has no 6.9-inch (or 6.5-inch) iPhone set, or, for a universal app, no 13-inch iPad set (`APP_IPAD_PRO_3GEN_129` or `APP_IPAD_PRO_129`). Only the primary locale is checked; the other locales' sets are left to the store page sync. |
| Age rating | The age rating declaration of the app information record being prepared (else the live one) has no answer at all. |
| Copyright | Neither the file nor the version has one. |
| App Review contact | Neither the file nor the version has one. |
| In-app purchases | A purchase is unfinished (below). |
| Review submissions | Another iOS submission is waiting for or in review, canceling or completing; the submission holding this version has unresolved issues; or the open draft holds items the plan did not add. |

## What's New, copyright and App Review information

What's New is written per locale only where it differs (line breaks
normalized). The copyright line and the release options go in one version
update. App Review information is created, or only its differing fields are
updated. asc never shows the demo password (it prints `(redacted)`), so the
plan sends it when the review detail is created, when the user name or the
"sign-in required" switch changes, when App Store Connect has none, or with
`--rotate-demo-password`; otherwise it notes that the password is kept.

asc 5.5.0 takes the demo password only as a command-line flag
(`review details-create|details-update --demo-account-password`). It is
therefore visible in the local process list for the second that `asc` call
runs; the kit redacts it from the captured output and never writes it to a
file. Run `apply` on a machine (or CI runner) that other users cannot list
processes on. Because the plan holds no form of the password, a password
changed in the environment between `plan` and `apply` is sent without making
the plan stale; the user name is covered.

## Release options

`--release-type` becomes the version's `releaseType`: `manual` (release with
`publish`), `after-approval`, or `scheduled` with `--release-date` as its
`earliestReleaseDate` (App Store Connect then releases it after approval, not
before that date). The default is `manual`, so nothing reaches players
without a second, deliberate command.

`--phased-release` creates an inactive phased release: App Store Connect
starts it when the version is released and serves the update to automatic
updates over 7 days. Without the flag, an inactive phased release is
removed; one that already started is left alone.

## In-app purchases

The plan reads every in-app purchase of the app (the same `iap list` read as
the [store product sync](./STORE_PRODUCT_SYNC.md)):

- `READY_TO_SUBMIT`: its one in-app purchase version that can go to review
  (`PREPARE_FOR_SUBMISSION`, `READY_FOR_REVIEW`, `REJECTED` or
  `DEVELOPER_REJECTED`) is added to the version's review submission as an
  `inAppPurchaseVersions` item. Two such versions block the plan.
- `MISSING_METADATA`, `WAITING_FOR_UPLOAD`, `DEVELOPER_ACTION_NEEDED`,
  `REJECTED`: blocked. Finish it with `mpgd store products apply --store
  app-store` (or in App Store Connect), or leave it out on purpose with
  `--skip-iap <productId>`. `PROCESSING_CONTENT` blocks until App Store
  Connect finishes.
- Approved, in review or removed from sale: nothing to do.

App Review takes an app's first in-app purchase of each type only together
with an app version; the plan notes which purchases are those firsts, and
notes when every one of a type was skipped (they then wait for a later
version). Subscriptions are not part of the release.

## The review submission

The plan reuses the open iOS review submission (`READY_FOR_REVIEW`) or
creates one, adds the version (`appStoreVersions`) and the purchases, then
submits it. Items already in the submission are not added again; items the
plan did not add block it, so nothing unexpected is submitted along.

## Apply, re-runs and partial failures

`apply` reads App Store Connect again and plans again. It refuses with
"plan again" when App Store Connect, the store presence file, the device
family or the demo account changed since the plan, and refuses any plan with
a blocker. A plan whose writes have all landed is `unchanged`, so running
`apply` twice is safe. `--dry-run` does every check and prints the writes
without making them (no `--approve` needed).

App Store Connect has no transaction. The writes run in the printed order;
when one fails, the error names the step, whether App Store Connect refused
it (nothing from that step landed) or the result is unknown (a timeout or a
lost answer), and the steps already written. Run `plan` again: it finds what
landed (the created version, the attached build, the open submission and its
items) and lists only what is left, then `apply` that plan.

## Status, publish and phased release

`status` reads the version (the named one, else the newest), its build, the
newest review submission that holds it with each item's state, and its
phased release, and prints one sentence: in preparation (with what to run),
waiting for review since when, in review, returned by App Review, approved
and waiting for `publish`, or released (with the phased release day).

`publish --marketing-version <x.y.z> --approve` sends a release request for
a version in `PENDING_DEVELOPER_RELEASE`; a version already released is `unchanged`,
any other state is refused.

`phased --marketing-version <x.y.z> --action pause|resume|complete --approve`
moves an `ACTIVE` phased release to `PAUSED`, a `PAUSED` one back to `ACTIVE`, or
either to `COMPLETE` (every user, at once). A phased release that has not
started (`INACTIVE`) is refused; one already in the requested state is
`unchanged`.

## What stays manual

- **App Privacy answers.** The public App Store Connect API has no resource
  for them; asc 5.5.0 reaches them only through `asc web` and Apple's private
  web session, which the kit excludes. The kit can neither write nor check
  them: answer them in App Store Connect (App Privacy) before the first
  submission ([store privacy disclosures](./STORE_PRIVACY_DISCLOSURES.md)).
- **Age rating answers.** The plan checks that the questionnaire was
  answered at all; it does not answer it, and cannot tell a questionnaire
  missing only Apple's newest questions.
- **Sandbox testers**, the app's price, availability, category and content
  rights, the review notes and screenshots of each in-app purchase (the
  products plan lists them), and the export compliance documentation of a
  build with non-exempt encryption.
- **Replying to App Review and resubmitting** a version it returned
  (`UNRESOLVED_ISSUES`): the plan stops and says so.

## Verify on the first live run

These behaviours are mock-tested only. Check them on the first submission to
a real App Store Connect account and correct the kit if Apple disagrees:

- [ ] A version created through the API copies no localization from the
      previous version, so the store page sync must run before the second
      plan (the plan blocks until it did).
- [ ] `review items-list --include appStoreVersion,inAppPurchaseVersion`
      returns each item's version relationship, and an in-app purchase that
      is `READY_TO_SUBMIT` has exactly one version in a submittable state.
- [ ] Adding the first consumable and first non-consumable as
      `inAppPurchaseVersions` items to the version's submission is accepted
      and reviewed with the version.
- [ ] The age rating declaration of an app that never answered the
      questionnaire has no content descriptor set.

## Tests

```sh
pnpm smoke:cli-store-products
```

It runs `packages/cli/src/app-store-release.test.ts` with the other store
suites: plan and apply over a fake App Store Connect (create, reuse and
rename; build selection; every blocker; in-app purchase attachment and
skipping; review information and the demo password; release options;
idempotent re-apply; partial failure and resume; dry run), the asc commands
and output parsing, and the `plan|apply|status|publish|phased` commands
with the deployment profile, the release ledger and the saved plan. No live
App Store Connect account was used.
