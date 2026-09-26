# Native test deployment planning and execution

The installed `@mpgd/cli` can build game-owned Capacitor targets without a
Kit checkout. `mpgd deploy init`, `doctor`, and `plan` record test destinations
and credential **references**, check local prerequisites, and write a plan.
These three commands do not reserve numbers, build, sign, upload, or call
either store. `deploy run`, `status`, and `submit` connect the later execution
stages; see [Resumable native test deployment](NATIVE_DEPLOY_RUN.md).
A successful plan is not deployment evidence.

Start with `mpgd.targets.json` and a game-owned shell created by
`mpgd target init capacitor`. Keep the app ID and shell paths there, not in
the deployment config:

```sh
pnpm exec mpgd deploy init --game ./games/my-game
```

This creates `mpgd.deploy.json` once, without overwriting an existing file.
The `beta` profile uses a production build configuration targeting Play
internal testing and/or TestFlight. Its default approval policy is `manual`.
Credential fields contain environment variable **names**, never secret
values. Set `testGroup` in the iOS target profile to the existing internal
TestFlight group **ID** (not its display name) before planning iOS. The
generated values are references, not an indication that signing or store
credentials have been verified.

```sh
pnpm exec mpgd deploy doctor --game ./games/my-game --profile beta
pnpm exec mpgd deploy plan --game ./games/my-game --profile beta \
  --targets android,ios --out ./release-plan.json
```

`doctor` checks the selected target config, game-owned shell, Node.js,
Java/Android SDK or Xcode, and whether signing, submission, and their required
companion environment variables are present. It reports presence only; it does not inspect key
contents, authenticate to a store, or run a remote account check. On an
incomplete profile it exits nonzero with the configuration reason.

`plan` reads the target and deployment config, rejects unsupported or
conflicting combinations, and writes a new JSON file only at `--out`. It
includes config SHA-256 digests and destination metadata, but no credential
values. Existing output files are never overwritten. Planning works without
local platform toolchains or store access. Later deployment execution must
recheck the recorded digests against its inputs and must not treat the plan
as a version reservation.

## Pinned release workspace (builder foundation)

The deployment runner now has a separate preparation layer. Immediately before
building, it rechecks a plan against the current target/deployment configs,
rejects uncommitted changes in those configs or the root lockfile, then records
the game's full Git SHA, the root `pnpm-lock.yaml` digest, and the
selected Kit package version/revision. It clones that exact commit into a
temporary worktree-like checkout, preserving sibling workspace packages for
`games/*` repositories. A frozen-lockfile install and the existing
`mpgd target build` run inside that checkout; the original game and another
release's output are not touched. Configuration digests are checked before
and after installation/build, and a build is accepted only when a new
successful attempt, artifact, and matching release manifest are present.

`deploy run` now uses this preparation API. The read-only `deploy plan` file itself does
not pin a source revision; the revision is captured when execution starts.
The installed `@mpgd/cli` must contain a clean packaged native builder with
the recorded Kit revision. Process execution bounds runtime and captured log
size, redacts configured secrets, kills child process groups on cancellation,
and removes its temporary checkout when disposed. It is input/output
isolation, not a sandbox for hostile build scripts. Signed store submissions
and actual device evidence remain separate acceptance gates.

Pinned builds reject inherited catalog, ad placement, target-config extension,
release-manifest, effective-config output, and icon-manifest path overrides.
Place configuration files in the committed game checkout so the build cannot
read or write through mutable paths in the original working directory. A
build target and build profile must also match the pinned deployment plan.
Existing symlinks under the standard `artifacts`, `release-output`, or `dist`
output roots are rejected before installation or build rather than followed.
Target paths are resolved again inside the cloned checkout so an absolute
`gameApp` symlink that points back to the source game cannot escape the pin.
The lockfile and deployment configuration input paths cannot be symlinks,
including through a parent directory. Each native build receives a disposable
checkout-owned `TMPDIR`/`TMP`/`TEMP`, removed even if the build fails or is
cancelled, so interrupted native staging does not leave signed output under
the host's shared temporary directory.
Auto-discovered catalog and ad-placement inputs are also checked for escaping
symlinks. The installed CLI entrypoint and executable must resolve inside the
checkout, and the build runs that checked executable directly rather than an
unrelated `mpgd` binary from `PATH`. A pre-existing generated targets file
cannot be a symlink to another location. Before dependency installation,
tracked symlinks anywhere in the game repository are checked so they cannot
point outside the cloned checkout; this also covers optional target-config
extensions and workspace package sources.
On Windows checkouts where Git materializes a symlink as a plain file, its
recorded target is still checked. Git submodules are not yet supported as
release inputs; pinning rejects them explicitly instead of cloning an empty
gitlink directory and failing later in the build.
The install explicitly includes development dependencies because game build
tools are normally declared there. The pinned child clears the parent CLI's
argument override, and the installed target-config matrix must resolve inside
the checkout along with the CLI itself.

## Android upload signing session

The CLI package provides `withAndroidUploadSigningSession()` for the
deployment runner. The game supplies its upload keystore file, alias,
store/key passwords, and expected upload certificate SHA-256; the Kit copies
the key to a mode-0600 temporary file, verifies the certificate and private
key with `keytool`, and removes the temporary key on success, failure, or
cancellation. The source key is not changed. A temporary Gradle init script
configures only the generated `:app` release build and reads passwords from
the child environment, not from command arguments or committed build files.
The existing `bundleRelease` builder and post-build AAB signer, app-ID, and
version inspections remain the release gates; missing or mismatched signing
inputs do not fall back to a debug key.

`deploy run` invokes this session for Android signed builds.
The throwaway-key CI test validates key restoration, wrong passwords and
certificate, cleanup, and Gradle configuration. After preparing the reference
Android shell with `cap sync android`,
`MPGD_TEST_ANDROID_GRADLE_SIGNING=bundle pnpm smoke:cli-android-signing`
also builds an AAB and verifies its JAR signature and upload-certificate
fingerprint with the throwaway key. Neither test is evidence that a game-owned
key has signed a store-ready bundle or that Google Play accepted it.

## Isolated iOS signing session

For a signed iOS archive or App Store IPA export, the native builder can use a
game-owned P12 identity and provisioning profile instead of relying on an
identity already installed in the host's default keychain. Set
`MPGD_IOS_SIGNING_P12`, `MPGD_IOS_SIGNING_P12_PASSWORD`,
`MPGD_IOS_PROVISIONING_PROFILE_FILE`, and `MPGD_IOS_TEAM_ID` in the build
environment. Keep the P12 and password out of the game repository. The
configured target's bundle ID remains the source of truth.

The session imports the identity into a temporary keychain and registers that
keychain only within an isolated per-build home, leaving the user's default
keychain and search list unchanged. It gives code signing tools access to the
imported private key without placing credential passwords in command arguments.
It checks the decoded profile's team, bundle ID, expiration, distribution
entitlements, and embedded signing certificate, then places the profile in
the same isolated home. Xcode receives explicit manual signing settings and
an App Store export options plist pinned to the imported certificate SHA-1.
Each concurrent build gets its own home and profile copy. Normal completion,
failure, or handled cancellation removes only that session's files. The
existing signed archive and exported IPA inspections still run afterward.

This local preflight does not establish Apple trust in an arbitrary CMS profile
or prove that Xcode can sign with a real Apple Distribution identity. The
throwaway test validates import, profile matching, and cleanup only. A signed
external game build, App Store Connect processing, and device install remain
separate release gates.
