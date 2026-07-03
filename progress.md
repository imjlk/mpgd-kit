Original prompt: PLEASE IMPLEMENT THIS PLAN: Phase 8 Plan: Smoke Tests, Bridge Contracts, SDK Demo Loop, Emulator Smoke.

## Progress

- Started Phase 8 implementation.
- Confirmed local graph anchors around release manifest and target validation.
- Confirmed local iOS simulators exist and Android AVD `Pixel_6_API_33` exists via `$ANDROID_HOME/emulator/emulator`.
- Added target artifact smoke verification and wired it into CI after `build:web`.
- Added bridge protocol fixtures plus adapter tests using injected test bridge objects for AIT and Capacitor.
- Added bridge-protocol files to the tools TS project so typia-based fixture tests run through `run-ttsx`.

## TODO

- Verify bridge fixtures and adapter tests.
- Expand the Phaser demo loop around identity, save/load, ads, purchase, and leaderboard.
- Add local emulator smoke scripts and docs.
