# Store page sync (`mpgd store presence`)

Every language of a store page needs the same text and graphics typed into
Play Console and App Store Connect: the app name, descriptions, keywords,
URLs, the icon and feature graphic, and phone and tablet screenshots.
`mpgd store presence plan|apply` keeps them in one game file and writes them
to the store, in the same reviewed plan / apply style as the
[store product sync](./STORE_PRODUCT_SYNC.md).

Supported stores: Google Play (`--store google-play`) and App Store Connect
(`--store app-store`, through the pinned `asc` 5.5.0; iPhone and iPad share
one store page).

## The store presence file

`mpgd.store-presence.json` sits next to the other game files. It is not
`mpgd.store-listings.json`: that file describes one-time products (keyed by
catalog product); this one describes the app's own store page. The name
follows Play Console, which groups the main store listing and graphics under
"Store presence". The game runtime never reads it.

```json
{
  "version": "2026-10-27",
  "privacyPolicyUrl": "https://example.com/privacy",
  "googlePlay": {
    "listings": {
      "en-US": {
        "title": "Block Party",
        "shortDescription": "Stack blocks with friends.",
        "fullDescription": "Stack blocks with friends.\nA new puzzle every week.",
        "video": "https://www.youtube.com/watch?v=VIDEO_ID",
        "graphics": {
          "icon": "store/play/icon.png",
          "featureGraphic": "store/play/feature.png",
          "phoneScreenshots": ["store/play/en/1.png", "store/play/en/2.png"],
          "sevenInchScreenshots": ["store/play/en/tablet7-1.png"],
          "tenInchScreenshots": { "files": ["store/play/en/tablet10-1.png"], "complete": true }
        }
      },
      "ko-KR": {
        "title": "블록 파티",
        "shortDescription": "친구와 블록을 쌓아요.",
        "fullDescription": "친구와 블록을 쌓아요."
      }
    },
    "contact": { "email": "support@example.com", "website": "https://example.com" }
  },
  "appStore": {
    "localizations": {
      "en-US": {
        "name": "Block Party",
        "subtitle": "Stack with friends",
        "description": "Stack blocks with friends.\nA new puzzle every week.",
        "keywords": "blocks,puzzle,party",
        "promotionalText": "Season 2 is here.",
        "whatsNew": "New puzzles.",
        "supportUrl": "https://example.com/support",
        "marketingUrl": "https://example.com",
        "screenshots": {
          "iphone69": ["store/ios/en/iphone-1.png", "store/ios/en/iphone-2.png"],
          "ipad13": { "files": ["store/ios/en/ipad-1.png"], "complete": true }
        }
      }
    }
  }
}
```

Rules the file is checked against before any store is asked anything
(`assertStorePresence` and `assertStorePresenceImage` in `@mpgd/catalog`):

| Field | Google Play | App Store |
| --- | --- | --- |
| App name | `title`, 30 characters | `name`, 2 to 30 characters |
| Short text | `shortDescription`, 80 characters | `subtitle`, 30 characters |
| Description | `fullDescription`, 4,000 characters | `description`, 4,000 characters |
| Keywords | (none) | `keywords`, 100 bytes (UTF-8) |
| Promotional text / what's new | (none) | 170 / 4,000 characters |
| URLs | `video` (YouTube), `contact.website` | `supportUrl` (required), `marketingUrl`, `privacyPolicyUrl` (https) |
| Icon | 512 x 512 PNG, at most 1 MB | (from the build) |
| Feature graphic | 1024 x 500 JPEG or PNG without alpha | (none) |
| Screenshots | JPEG or PNG without alpha, 320 to 3,840 px per side, long side at most twice the short side, at most 8 MB, at most 8 per device type | JPEG or PNG without alpha, exact sizes per display, 1 to 10 per display |

App Store display keys and the sizes they accept (portrait, or the same pair
swapped for landscape): `iphone69` (`APP_IPHONE_67`: 1260 x 2736, 1290 x 2796,
1320 x 2868), `iphone65` (`APP_IPHONE_65`: 1242 x 2688, 1284 x 2778),
`iphone63` (`APP_IPHONE_61`: 1179 x 2556, 1206 x 2622) and `ipad13`
(`APP_IPAD_PRO_3GEN_129`: 2048 x 2732, 2064 x 2752).

Texts must be trimmed; names, titles and short texts must be one line.
Graphics are paths relative to the file and must stay inside its directory
(symbolic links included). Pixel size, format and alpha are read from the
PNG or JPEG header, and the file extension must match the format.

### Image sets

A screenshot slot is either a list or `{ "files": [...], "complete": true }`:

- A **list** adds the images the store lacks (compared by SHA-256), after the
  ones it holds. Images the store holds that the list does not name are kept.
- A **complete** set makes the store hold exactly the list, in its order.
  When the store already starts with the list's images, the rest is
  appended; otherwise the slot is cleared and the set uploaded again in the
  file's order. Removing an image the list no longer names needs
  `apply --confirm-image-removal`; a pure reorder does not.

The icon and feature graphic are single images: naming one replaces the one
the store holds.

## Workflow

The app and the store credential come from the deployment profile, the same
ones `mpgd deploy submit` and `mpgd store products` use:

- Google Play: the package ID and the service account file named by the
  Android profile's `submissionCredential.env` (default
  `MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT`).
- App Store Connect: the bundle ID, `MPGD_ASC_APP_ID`, `MPGD_ASC_KEY_ID`,
  `MPGD_ASC_ISSUER_ID`, the iOS profile's `submissionCredential.env` (the
  base64 `.p8`) and `MPGD_ASC_BINARY`, the pinned `asc` 5.5.0
  ([tooling decision](./NATIVE_DEPLOY_TOOLING_DECISION.md)). The key needs
  the App Manager role.

```sh
# Read the store, print the changes, save the plan; nothing is written.
pnpm exec mpgd store presence plan --game . --store google-play --out play-presence.json
pnpm exec mpgd store presence plan --game . --store app-store --out app-store-presence.json

# Write exactly what was reviewed.
pnpm exec mpgd store presence apply --plan play-presence.json --approve
pnpm exec mpgd store presence apply --plan app-store-presence.json --approve
```

`plan` prints, per language, `create`, `update` or `unchanged`, the text
fields that change (old and new length, and the texts themselves only while
both are at most 80 characters), and per image slot the uploads (`+`, by
path and SHA-256) and removals (`-`, by the store's image ID and SHA-256). Languages only in the store are listed as
`remote` and never deleted. `manual` lines are what the reviewer does in the
console.

`apply`:

- needs `--approve`;
- reads the store again and refuses when the store page or the file (text or
  graphic bytes) changed since the plan: run `plan` again and review;
- is a no-op when an earlier apply already wrote the plan, so re-running it
  is safe;
- needs `--confirm-image-removal` when a complete set removes images;
- `--game <dir>` applies a plan made in another checkout of the same game.

## Google Play

All reads and writes go through one
[edit](https://developers.google.com/android-publisher/edits): `plan` opens
an edit to read and discards it (`edits.delete`). `apply` opens one edit,
re-plans inside it, writes the contact details (`edits.details.update`), each
language's text (`edits.listings.update`, which also creates a new language)
and its images (`edits.images.deleteall` and `edits.images.upload`), then
commits once (`edits.commit` with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`).
When any step fails, apply deletes the edit, so nothing is published; when
the commit itself fails, its outcome is unknown and the next `plan` shows
what is left.

- `video` absent in the file keeps the video Play has.
- `contact` fields absent in the file stay as Play has them; Play's default
  language is never changed.
- If the app requires changes to be sent for review by hand (managed
  publishing), `apply --changes-not-sent-for-review` commits them without
  sending; send them from Play Console's "Publishing overview".

Edits and releases share one rule: "if anyone commits an edit or makes
changes to an app through the Play Console, all other edits for the app
(owned by any user) are invalidated", and a user may have only a single edit
open, so a new edit replaces the service account's other open edit
([Edits](https://developers.google.com/android-publisher/edits)). `plan`
opens an edit too. Do not run `store presence plan` or `apply` while
`mpgd deploy run`, `deploy promote` or `deploy rollout` is in progress with
the same service account, and do not edit the store listing in Play Console
during an apply: the other edit fails and has to be run again. The Edits API also works only for an app with at
least one uploaded bundle: upload the first build (`mpgd deploy run`, which
commits a draft release for a never-published app) before the first apply.

What stays manual on Play (printed by `plan`):

- The privacy policy URL (Play Console > Policy and programs > App content):
  the Android Publisher API has no field for it.
- Data safety, content rating, target audience, ads declaration, app
  category and tags.
- Custom store listings, store listing experiments, the TV banner, Wear and
  TV screenshots.

### Google Play references

- [Edits](https://developers.google.com/android-publisher/edits) (one open
  edit per user, invalidation on commit, bundle required)
- [`edits.listings`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.listings),
  [`edits.images`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images)
  (`Image.sha256`), [`AppImageType`](https://developers.google.com/android-publisher/api-ref/rest/v3/AppImageType),
  [`edits.details`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.details),
  [`edits.commit`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit)
  (`changesNotSentForReview`, `changesInReviewBehavior`)
- Play Console Help, [Create and set up your app](https://support.google.com/googleplay/android-developer/answer/9859152)
  (title 30, short description 80, full description 4,000 characters) and
  [Add preview assets](https://support.google.com/googleplay/android-developer/answer/9866151)
  (icon, feature graphic and screenshot rules, at most 8 screenshots per
  device type)

## App Store Connect

The App Store page has two parts with different lifetimes:

- **App information** (name, subtitle, privacy policy URL, per locale):
  editable only while an app information record is being prepared
  (`PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `REJECTED`), which App
  Store Connect opens with a new version.
- **Version localizations** (description, keywords, promotional text, what's
  new, support and marketing URLs) and their **screenshot sets**: written
  only to the one editable iOS version (`PREPARE_FOR_SUBMISSION`,
  `DEVELOPER_REJECTED`, `REJECTED`, `METADATA_REJECTED`).

The sync never creates a version, never submits for review, and never
touches pricing, availability or release settings. When nothing is
editable, `plan` marks the parts `blocked`, shows what would change, and
prints the step as `manual` (create the next version in App Store Connect,
then plan again). The app's first version takes no what's new text, so the
sync leaves it out there.

Commands (pinned `asc` 5.5.0, one session per command):

| Read / write | `asc` command |
| --- | --- |
| App record and bundle ID check | `apps view --id` |
| App information records | `apps info list --app` |
| App information localizations | `localizations list --type app-info --app --app-info --paginate` |
| Create or update one | `app-setup info set --app --app-info --locale --name [--subtitle] [--privacy-policy-url]` |
| iOS versions | `versions list --app --platform IOS --paginate` |
| Version localizations | `localizations list --version --paginate` |
| Create / update one | `localizations create --version --locale ...`, `localizations update --id ...` |
| Screenshot sets | `screenshots list --version-localization` |
| Upload one screenshot | `screenshots upload --version-localization --path <file> --device-type <APP_...>` |
| Delete one screenshot | `screenshots delete --id --confirm` |

Screenshots are compared by MD5 (App Store Connect's `sourceFileChecksum`).
Each upload is one file: `asc` appends it to the set (creating the set),
waits until the asset delivery reaches `COMPLETE` and fails on `FAILED`; the
sync then requires the result to report `COMPLETE`. A screenshot whose
delivery `FAILED` counts as missing: the plan reports it and a complete set
replaces it. While App Store Connect is still processing a screenshot
(awaiting upload, or delivered without a checksum yet), `plan` refuses and
asks to plan again later. When the store's screenshots are not the first
ones of a complete set, the set is replaced: every file is checked first,
then the set's screenshots are deleted and the file's uploaded in order.
`asc` gets each file's real path (it refuses a source reached through a
symbolic link).

Locale keys are App Store Connect's codes (`en-US`, `ko`, `ja`, `de-DE`,
`zh-Hans`): `asc` rejects a bare language root such as `de` that App Store
Connect spells with a region, and only at apply time.

App Store Connect has no transaction. `apply` writes per locale (app
information, version localization, screenshots) and, on a failure, names
the steps already written; when screenshots were deleted before a failed
upload it says so. `plan` then shows what is left.

`asc` cannot clear a field (an empty flag means "leave it"), so removing a
subtitle or promotional text stays manual. App previews (videos) are not
synced.

What stays manual in App Store Connect (printed by `plan`): App Privacy
answers, the age rating, App Review notes and demo account, pricing,
availability, release settings, and submitting for review.

### App Store Connect references

- App Store Connect Help, [App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)
  (name 2 to 30 characters, subtitle 30, privacy policy URL required for iOS),
  [Platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
  (description 4,000, keywords 100 bytes, promotional text 170, what's new
  4,000 and not on the first version) and
  [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
  (sizes per display, 1 to 10 per display, `.jpeg`, `.jpg` or `.png`, no
  alpha or transparency).
- `asc` 5.5.0 source: `internal/cli/localizations`, `internal/cli/apps/app_setup.go`,
  `internal/cli/versions`, `internal/cli/assets/assets_screenshots*.go`,
  `internal/screenshotcatalog/catalog.go` (the same size table).

## Verify on the first live run

Mock-tested only. Check on the first run against a real Play app:

- [ ] `edits.images.upload` and `edits.images.list` return each image's
      `sha256` as the SHA-256 of the uploaded file, so a second `plan` after
      an apply reports every slot `unchanged`. Images are matched by that
      digest; if Play answers an upload with another one (re-encoding),
      `apply` stops before the commit and discards the edit rather than let
      every later run upload the image again, and the comparison needs
      another key.
- [ ] `edits.images.list` returns images in the order Play Console shows
      them, and uploads are appended in upload order.
- [ ] Texts read back exactly as written (line breaks in `fullDescription`
      included), and the contact email, website and phone are not
      normalised (a trailing slash, a phone format), so a second `plan`
      reports the listing and details `unchanged`.
- [ ] The file size limits the kit enforces (feature graphic 15 MB,
      screenshots 8 MB) match what `edits.images.upload` accepts; the help
      page states only the icon's 1 MB.
- [ ] Tablet screenshots: whether Play requires the large-screen rules
      (1,080 to 7,680 px, 16:9 or 9:16, at least 4) for `sevenInchScreenshots`
      and `tenInchScreenshots`; the kit checks only the general screenshot
      rules.
- [ ] A commit on an app with managed publishing: whether Play asks for
      `changesNotSentForReview`.
- [ ] The service account permission that covers store listing writes.

And against a real App Store Connect app:

- [ ] Which screenshot sizes App Store Connect requires to submit. Its
      specification page names the 6.3" iPhone ("iPhone with Dynamic Island,
      medium display") under "Required device sizes" but marks the 6.5"
      iPhone as required when 6.9" is missing; the kit accepts all four
      display keys and requires none (see the maintainer questions).
- [ ] `asc screenshots list` returns a set's screenshots in display order,
      so a complete set that matches reports `unchanged`.
- [ ] `sourceFileChecksum` is the MD5 of the uploaded file, so a second `plan`
      reports every set `unchanged`.
- [ ] Texts read back exactly as written (line breaks, trailing spaces that
      `asc` trims), and `localizations update` accepts every field on a
      `PREPARE_FOR_SUBMISSION` version.
- [ ] `app-setup info set` creates a new app information locale on the
      editable record, and App Store Connect accepts the locale codes the file
      uses (`ko`, not `ko-KR`).
- [ ] The editable app information record and version states the sync
      writes to: whether `READY_FOR_REVIEW` or `INVALID_BINARY` should count.

## Tests

```sh
pnpm smoke:cli-store-products
pnpm --filter @mpgd/catalog test
```

The store presence parts run the planner and apply against an in-memory Play
with edit semantics (`packages/cli/src/store-presence-play.test.ts`), the SDK
adapter against a local mock of the REST paths
(`adapters/play-publisher/src/play-store-listing.test.ts`), the App Store
planner and apply against an in-memory App Store Connect and the `asc` command
lines and output parsing against recorded `asc` 5.5.0 output shapes
(`packages/cli/src/store-presence-app-store.test.ts`), and the file and image
rules on generated PNG and JPEG headers
(`packages/catalog/src/store-presence.test.ts`). No Google or Apple endpoint is
called, and no `asc` binary runs.
