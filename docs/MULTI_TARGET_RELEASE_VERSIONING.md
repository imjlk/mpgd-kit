# Multi-target release versioning

Each game owns one final SemVer, a never-resetting game release revision, and
an immutable release provenance record. Target wrappers and backend services
are released with that game; they are not independent store versions.

## One common label, independent target counters

Keep four values separate:

| Value | Owner | Example | Purpose |
| --- | --- | --- | --- |
| Game SemVer | Sampo | `0.3.30` | Product behavior and changelog version. |
| Release revision | Game release ledger | `42` | Never-resetting serial for a new immutable release manifest. |
| Common release label | Derived | `0.3.30-v42` | In-game settings, support reports, Pages build metadata, and provenance. |
| Target build version | Target ledger | `1.1.7.0`, `versionCode 84` | Store- or platform-specific monotonic update requirement. |

`-v42` is not appended to `package.json.version` and is not a platform package
version. In SemVer it would be a prerelease suffix, which is not the intended
meaning. Store `gameVersion: "0.3.30"` and `releaseRevision: 42` separately,
then derive the label. When the next game SemVer is `0.3.31`, the next new
release manifest is `0.3.31-v43`, never `0.3.31-v0`.

Allocate a new release revision when source, kit provenance, target config, or
release behavior changes. Do not allocate one for a retry of the same artifact
or a store-review resubmission. A target added later to the same immutable
release manifest uses the existing common label while receiving its own next
target build number.

Set the shared identity for production target builds:

```sh
export APP_VERSION=0.3.30
export MPGD_RELEASE_REVISION=42
export MPGD_RELEASE_LABEL=0.3.30-v42
```

mpgd-kit validates that the supplied label is derived from the SemVer and
revision, writes it into the release manifest, and refuses stale labels.

## Private Sampo workspaces

Private game workspaces can use Sampo without publishing to npm:

```toml
[packages]
ignore_unpublished = false
ignore = ["npm/@example/game-target-*", "npm/@example/game-services"]
```

Version game apps and shared game packages independently. A shared package
change needs its own changeset and one for every directly consuming game.
Treat `package.json.version` as the game SemVer source and propagate that value
to every game-owned release ledger and native release environment. If a game
maintains its own metadata version, validate it against `package.json.version`
before every production target build. Use `sampo release` for version/changelog
updates; do not use `sampo publish` when npm publishing is out of scope.

## Devvit release lifecycle

Use `devvit upload --bump prerelease` for a test subreddit RC only. Do not
submit a prerelease to public review: after verification, end the Sampo
prerelease and publish one new immutable final SemVer with `devvit publish
--public`.

## Native ownership and monotonic build numbers

Android and iOS production builds must reference a game-owned Capacitor shell,
not `mpgd-kit/apps/mobile-capacitor`. Keep a committed release ledger per game
for these values:

| Target | Game version | Monotonic value |
| --- | --- | --- |
| Microsoft Store | package version | four-part package build counter |
| Android | `versionName` | `versionCode` |
| iOS | `MARKETING_VERSION` | `CURRENT_PROJECT_VERSION` |

For a native release, set all required generic environment variables before
running the target command:

```sh
export APP_VERSION=1.4.0

# Android
export MPGD_TARGET_VERSION_NAME=1.4.0
export MPGD_TARGET_VERSION_CODE=42

# iOS
export MPGD_TARGET_MARKETING_VERSION=1.4.0
export MPGD_TARGET_BUILD_NUMBER=42

mpgd target build android production \
  --targets-file ./mpgd.targets.json \
  --kit-path ../mpgd-kit
```

When these variables are set, mpgd-kit checks the game-owned native source
before packaging:

- Android `applicationId`, `versionName`, and `versionCode` in
  `android/app/build.gradle` must match target metadata and the release ledger.
  Release builds using `applicationIdSuffix` or `versionNameSuffix` are
  rejected because their emitted identity differs from the declared source.
- iOS `PRODUCT_BUNDLE_IDENTIFIER`, `MARKETING_VERSION`, and
  `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj` must
  match target metadata and the release ledger. Only the Capacitor `App`
  target's `Release` configuration is inspected, so valid extension and Debug
  identities do not block the archive.

The values are also captured in the release manifest. A mismatch fails before
an artifact is produced; the target tool never silently rewrites a store
identity.

For Microsoft Store packages, keep the fourth component at `0` for
Windows 10/11 compatibility and advance a permitted earlier component, for
example `1.1.6.0` → `1.1.7.0`. This counter is linked to, but does not need to
equal, the common release revision.

## CI and promotion

Keep PR checks limited to changeset ownership, version synchronization, target
validation, type/tests, graph preflight, and artifact evidence. Build once from
the pinned game SHA and kit SHA, then require a protected-environment approval
for each external promotion. A typical order is Devvit test upload, Devvit
public review, backend/Pages, Microsoft Store, Apps in Toss, Android, then iOS.
