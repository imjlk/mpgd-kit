# Native foundation release gate A

This gate covers the optional Capacitor foundation, not a configured store,
advertising, identity, push, or signing provider. A type declaration, a mock
bridge response, an unsigned archive, and a physical-device result are different
forms of evidence. None substitutes for another.

## Source and packed consumer checks

Run `pnpm build:packages` before `pnpm smoke:native-packed-consumer`. The smoke
packs the public dependency closure into npm tarballs, installs only those
tarballs in a temporary project outside the workspace, verifies that the
installed dependency graph resolves to those exact tarballs, type-checks its
imports,
and exercises the installed JavaScript adapter, storage bridge, lifecycle, and
scoped native HTTP transport. It also builds a minimal external Vite app from
the installed package exports. It verifies that a missing optional provider is
reported as unsupported and an installed but unconfigured provider is reported
as configuration-required and cannot perform an operation.

The same smoke checks that the published plugin tarball contains its Gradle,
Java and Swift implementation, Capacitor registration metadata, Swift Package
manifest, and `PrivacyInfo.xcprivacy`. It parses the plist hierarchy to require
the UserDefaults `CA92.1` reason in one accessed-API entry. That reason covers
legacy `UserDefaults` migration; an app must still review its own privacy
disclosures and other SDKs. The macOS CI job also runs
`pnpm smoke:native-packed-swift` to compile the extracted npm tarball's Swift
target for the iOS simulator SDK and process its privacy resource. The CI native
jobs separately compile and exercise the Android and iOS source helpers, then
build unsigned staging targets. The tarball check is not a substitute for
compiling a signed external app.

For game-owned shell creation, also pack `@mpgd/cli` and run
`MPGD_PACKED_CLI_TARBALL=/absolute/path/to/mpgd-cli.tgz pnpm
smoke:cli-capacitor-shell-materialize`. This installs the public CLI in an
external game, creates both native projects, rejects kit checkout references,
and checks repeat initialization is a no-op.

## Native target and release checks

- `pnpm test:target-artifacts` and `pnpm test:native-ios-signing` verify build
  mode, artifact, and signing-plan contracts without host signing secrets.
- `pnpm build:target android staging` and `pnpm build:target ios staging`,
  followed by `pnpm smoke:target android` and `pnpm smoke:target ios`, verify
  unsigned staging artifacts and their release manifest entries.
- CI routes native-owned adapter, plugin, and shell changes to the focused
  packed-consumer check plus both native build jobs. Shared platform,
  game-services, CLI, target, and release-manifest contract changes retain the
  broader prepared validation. A required job skip is never counted as success.
- Signed Android AAB, signed iOS archive and IPA, device lifecycle/storage,
  real HTTPS, and store submission require game-owned credentials, devices,
  and production configuration. Record their results separately; this gate
  makes no claim that they have passed.

After N-01 through N-09 are merged, run this gate against the intended release
commit, then use the normal Sampo release PR and npm provenance workflow. Verify
published versions with `npm view` before calling baseline A released.
