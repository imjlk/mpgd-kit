---
npm/@mpgd/cli: minor (Added)
---

`mpgd target init capacitor --providers notifications` now wires iOS push into an iOS project it generates: `App/App.entitlements` with `aps-environment` (set as `CODE_SIGN_ENTITLEMENTS` on the App target), the AppDelegate forwarding of the APNs registration callbacks to `@capacitor-firebase/messaging`, and the reference shell's cold-start notification-tap forwarder in `SceneDelegate`. An existing iOS project is not rewritten; the initializer prints each missing piece with the exact edit. `mpgd target build ios` checks a shell that installs `@capacitor-firebase/messaging` for the entitlement and both forwarders and fails a `production` build while one is missing, and warns while the App target does not bundle `GoogleService-Info.plist`. The iOS store export of such a shell also reads the signed IPA's entitlements and fails unless `aps-environment` is `production` (a profile without the Push capability, or an export with a development profile).
