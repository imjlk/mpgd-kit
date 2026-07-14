# Emulator Smoke Tests

Local emulator smoke tests install and launch the Capacitor shell after the target
build has copied the Phaser app into the native project.

## Android

```bash
pnpm smoke:android:emulator
```

Defaults:

- AVD: `Pixel_6_API_33`
- Override: `MPGD_ANDROID_AVD=<name>`
- Screenshot: `artifacts/emulator/android.png`
- Logcat: `artifacts/emulator/android-logcat.txt`
- Embedded target config evidence: `artifacts/emulator/android-effective-target.json`

The script uses `$ANDROID_HOME` or `$ANDROID_SDK_ROOT`, falling back to
`~/Library/Android/sdk`. It builds the release target first, then installs the
debug APK for emulator launch. Before launch, it verifies the debug APK contains
`mpgd-effective-target.json` for the Android target.

## iOS

```bash
pnpm smoke:ios:simulator
```

Defaults:

- Simulator: `iPhone 16`
- Runtime: `iOS 18.4`
- Overrides: `MPGD_IOS_SIM_NAME=<name>` and `MPGD_IOS_SIM_OS="iOS 18.4"`
- Screenshot: `artifacts/emulator/ios.png`
- Embedded target config evidence: `artifacts/emulator/ios-effective-target.json`

The script runs the iOS target sync, builds a Debug simulator app through
`xcodebuild`, verifies the app contains `mpgd-effective-target.json` for the iOS
target, installs `dev.mpgd.kit`, launches it, and captures a screenshot.

## Gameplay E2E Boundary

These smoke scripts intentionally stop at build, install, launch, crash/config
checks, and screenshot capture. A game that needs input/state coverage declares
its shared states in `mpgd.game.json` and implements the optional game-owned
`gameplay:e2e` driver described in [Gameplay E2E](GAMEPLAY_E2E.md).

Android drivers can map normalized actions through ADB or a dedicated test
harness. Standard `xcrun simctl` does not expose portable tap/key injection, so
iOS gameplay drivers must use XCUITest, Appium, or another explicitly managed
automation tool. Both targets return state observations and stable session ids
to the same kit runner for pause/resume validation and hashed evidence output.
