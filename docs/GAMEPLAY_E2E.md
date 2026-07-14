# Gameplay E2E

`@mpgd/cli` provides a target-neutral gameplay acceptance contract. Games own
the scenario-specific state inspection and platform automation driver; the kit
owns plan validation, lifecycle continuity checks, evidence hashing, and the
JSON/Markdown report format.

This boundary keeps browser automation, Android tooling, iOS tooling, and
platform credentials out of generated runtime code. It also prevents the kit
from guessing what a game-specific state such as a completed tutorial or a
settled score looks like.

## Manifest Plan

Declare reusable states under `acceptance.gameplay` in `mpgd.game.json`:

```json
{
  "acceptance": {
    "gameplay": {
      "schemaVersion": 1,
      "states": [
        {
          "id": "launch-ready",
          "label": "Launch ready",
          "expectation": "The initial state is ready for input.",
          "actions": [{ "type": "wait", "durationMs": 500 }]
        },
        {
          "id": "primary-input",
          "label": "Primary input",
          "expectation": "The playable state is visible.",
          "actions": [{ "type": "tap", "x": 0.5, "y": 0.72 }]
        },
        {
          "id": "resume-session",
          "label": "Resume session",
          "expectation": "The active session survives backgrounding.",
          "actions": [
            {
              "type": "pause-resume",
              "backgroundMs": 1000,
              "expectSameSession": true
            }
          ]
        }
      ]
    }
  }
}
```

Tap coordinates are normalized from `0` through `1`, so each driver maps the
same action to its current viewport. `key` actions use a target-native key
name. A `pause-resume` action always attempts to resume even if the background
wait fails, then compares the driver's before/after session ids when
`expectSameSession` is enabled.

Plan parsing is strict: unknown fields, duplicate or unsafe state ids,
out-of-range coordinates, excessive waits, and unsupported actions fail before
automation starts.

## Game-Owned Driver

Add a non-interactive `gameplay:e2e` package script only after the game has a
real driver. The Android-specific example below assumes acceptance runs with
`mpgd game accept . --targets android`; the script can import the reusable
runner from `@mpgd/cli`:

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  readGameplayE2EPlan,
  resolveGameplayE2EReportFile,
  runGameplayE2E,
  type GameplayE2EDriver,
} from '@mpgd/cli';

const gameRoot = process.cwd();
const configured = readGameplayE2EPlan(gameRoot);

if (configured === null) {
  throw new Error('mpgd.game.json does not define acceptance.gameplay.');
}

const reportFile = resolveGameplayE2EReportFile(gameRoot);
const driver: GameplayE2EDriver = createGameDriver();
const configuredReleaseManifest = process.env.MPGD_RELEASE_MANIFEST_FILE;
const releaseManifestFile = configuredReleaseManifest !== undefined
  && existsSync(configuredReleaseManifest)
  ? configuredReleaseManifest
  : undefined;
const result = await runGameplayE2E({
  gameRoot,
  reportDir: path.dirname(reportFile),
  reportFile,
  plan: configured.plan,
  planFile: configured.file,
  target: 'android',
  profile: process.env.MPGD_ACCEPTANCE_PROFILE ?? 'staging',
  artifactFile: 'release-output/android/app-release.aab',
  ...(releaseManifestFile === undefined ? {} : { releaseManifestFile }),
  driver,
});

if (result.report.status !== 'passed') {
  process.exitCode = 1;
}
```

The driver implements five operations:

- `perform` maps normalized tap, key, and wait actions to the selected target.
- `pause` backgrounds or suspends the app.
- `resume` foregrounds or restores the app.
- `inspect` decides whether the named manifest state matches and returns a
  stable session id plus JSON-scalar metadata.
- `captureScreenshot` writes a PNG to the exact path requested by the runner.

Keep browser/Playwright, ADB, XCUITest, Appium, or other automation imports in
the game-owned script or target test harness. Do not import them from Phaser
scenes. Standard `xcrun simctl` can boot, install, launch, and capture an iOS
Simulator screen, but it does not provide portable tap/key input; use an
XCUITest/Appium-compatible driver or another explicitly managed automation
tool for iOS gameplay E2E.

## Acceptance Handoff

`mpgd game accept` runs `gameplay:e2e` after the target build and smoke matrix.
The script is optional. When it exists and is not skipped, acceptance requires
the report at `MPGD_GAMEPLAY_E2E_REPORT_FILE` to exist, use schema version 1,
have passed, link a hashed target artifact, and contain only passed states. The
handoff report embeds that gameplay evidence alongside the release manifest.

Use `--gameplay-script <name>` to select another package script or
`--skip-gameplay-e2e` to record an intentional skip. The CLI also exposes
`MPGD_ACCEPTANCE_TARGETS`, `MPGD_ACCEPTANCE_PROFILE`,
`MPGD_RELEASE_MANIFEST_FILE`, and `MPGD_GAMEPLAY_E2E_REPORT_FILE` to the script.

The runner writes:

- `gameplay-e2e-report.json`
- `gameplay-e2e-report.md`
- one hashed screenshot per manifest state under `screenshots/`

Each report also hashes the selected target artifact, optional release
manifest, and source plan so reviewers can connect the observed game flow to
the artifact being handed off.
