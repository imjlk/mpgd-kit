Original prompt: PLEASE IMPLEMENT THIS PLAN: Phase 8 Plan: Smoke Tests, Bridge Contracts, SDK Demo Loop, Emulator Smoke.

## Progress

- Started Phase 8 implementation.
- Confirmed local graph anchors around release manifest and target validation.
- Confirmed local iOS simulators exist and Android AVD `Pixel_6_API_33` exists via `$ANDROID_HOME/emulator/emulator`.
- Added target artifact smoke verification and wired it into CI after `build:web`.
- Added bridge protocol fixtures plus adapter tests using injected test bridge objects for AIT and Capacitor.
- Added bridge-protocol files to the tools TS project so typia-based fixture tests run through `run-ttsx`.
- Expanded the SDK demo loop and aligned browser, AIT, Android, and iOS mock bridge responses with contract shapes.
- Verified the SDK demo loop in browser: lobby state, gameplay, result save, rewarded ad, purchase, and screenshot output.
- Added Android emulator and iOS simulator smoke scripts plus local usage docs.
- Adjusted Android smoke to capture emulator serial before the device is fully booted.
- Fixed Android emulator smoke device parsing and narrowed crash marker detection to fatal/ANR signals.
- Adjusted iOS simulator smoke to build the App target directly for local simulator installs.
- Added a smoke-only iOS plist and compile flag so local simulator smoke can bypass storyboard and asset catalog compilation when the installed Xcode SDK/runtime combination cannot compile those resources.
- Verified Android emulator smoke and iOS simulator smoke. Screenshots are generated at `artifacts/emulator/android.png` and `artifacts/emulator/ios.png`.

## Completed

- `pnpm check`
- `pnpm test`
- `pnpm validate:catalog`
- `pnpm validate:ads`
- `pnpm validate:target-config`
- `pnpm validate:effective-config`
- `pnpm validate:targets`
- `pnpm smoke:effective-config`
- `pnpm smoke:adapter-effective-config`
- `pnpm smoke:targets:build`
- `pnpm graph:inspect`
- `pnpm smoke:android:emulator`
- `pnpm smoke:ios:simulator`
