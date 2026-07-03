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

The script uses `$ANDROID_HOME` or `$ANDROID_SDK_ROOT`, falling back to
`~/Library/Android/sdk`. It builds the release target first, then installs the
debug APK for emulator launch.

## iOS

```bash
pnpm smoke:ios:simulator
```

Defaults:

- Simulator: `iPhone 16`
- Runtime: `iOS 18.4`
- Overrides: `MPGD_IOS_SIM_NAME=<name>` and `MPGD_IOS_SIM_OS="iOS 18.4"`
- Screenshot: `artifacts/emulator/ios.png`

The script runs the iOS target sync, builds a Debug simulator app through
`xcodebuild`, installs `dev.mpgd.kit`, launches it, and captures a screenshot.
