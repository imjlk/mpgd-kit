# Multi-target release versioning

Each game owns one final SemVer and one immutable release provenance record.
Target wrappers and backend services are released with that game; they are not
independent store versions.

## Private Sampo workspaces

Private game workspaces can use Sampo without publishing to npm:

```toml
[packages]
ignore_unpublished = false
ignore = ["npm/@example/game-target-*", "npm/@example/game-services"]
```

Version game apps and shared game packages independently. A shared package
change needs its own changeset and one for every directly consuming game.
Synchronize `package.json.version` with `mpgd.game.json.game.version` before
every production target build. Use `sampo release` for version/changelog
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
| Microsoft Store | package version | four-part package revision |
| Android | `versionName` | `versionCode` |
| iOS | `MARKETING_VERSION` | `CURRENT_PROJECT_VERSION` |

For a native release, set all required generic environment variables before
`mpgd build:target`:

```sh
# Android
export MPGD_TARGET_VERSION_NAME=1.4.0
export MPGD_TARGET_VERSION_CODE=42

# iOS
export MPGD_TARGET_MARKETING_VERSION=1.4.0
export MPGD_TARGET_BUILD_NUMBER=42
```

When these variables are set, mpgd-kit checks the game-owned native source
before packaging:

- Android `applicationId`, `versionName`, and `versionCode` in
  `android/app/build.gradle` must match target metadata and the release ledger.
- iOS `PRODUCT_BUNDLE_IDENTIFIER`, `MARKETING_VERSION`, and
  `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj` must
  match target metadata and the release ledger.

The values are also captured in the release manifest. A mismatch fails before
an artifact is produced; the target tool never silently rewrites a store
identity.

## CI and promotion

Keep PR checks limited to changeset ownership, version synchronization, target
validation, type/tests, graph preflight, and artifact evidence. Build once from
the pinned game SHA and kit SHA, then require a protected-environment approval
for each external promotion. A typical order is Devvit test upload, Devvit
public review, backend/Pages, Microsoft Store, Apps in Toss, Android, then iOS.
