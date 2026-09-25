# Native test deployment planning

The installed `@mpgd/cli` can build game-owned Capacitor targets without a
Kit checkout. `mpgd deploy init`, `doctor`, and `plan` are the next layer: they
record test destinations and credential **references** in the game project,
check local prerequisites, and write a plan. They do not reserve version
numbers, build, sign, upload, or call either store. Store submission and
resumable state are later steps; a successful plan is not deployment evidence.

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
values. Set `testGroup` in the iOS target profile to the exact internal
TestFlight group before planning iOS. The generated values are references,
not an indication that signing or store credentials have been verified.

```sh
pnpm exec mpgd deploy doctor --game ./games/my-game --profile beta
pnpm exec mpgd deploy plan --game ./games/my-game --profile beta \
  --targets android,ios --out ./release-plan.json
```

`doctor` checks the selected target config, game-owned shell, Node.js,
Java/Android SDK or Xcode, and whether signing and submission environment
references are present. It reports presence only; it does not inspect key
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

This is an internal preparation API for the later `deploy run` command, not
yet a store deployment command. The read-only `deploy plan` file itself does
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

The CLI package now provides `withAndroidUploadSigningSession()` for the
later deployment runner. The game supplies its upload keystore file, alias,
store/key passwords, and expected upload certificate SHA-256; the Kit copies
the key to a mode-0600 temporary file, verifies the certificate and private
key with `keytool`, and removes the temporary key on success, failure, or
cancellation. The source key is not changed. A temporary Gradle init script
configures only the generated `:app` release build and reads passwords from
the child environment, not from command arguments or committed build files.
The existing `bundleRelease` builder and post-build AAB signer, app-ID, and
version inspections remain the release gates; missing or mismatched signing
inputs do not fall back to a debug key.

The session is a programmatic foundation, not yet a `deploy run` command.
The throwaway-key CI test validates key restoration, wrong passwords and
certificate, cleanup, and Gradle configuration. After preparing the reference
Android shell with `cap sync android`,
`MPGD_TEST_ANDROID_GRADLE_SIGNING=bundle pnpm smoke:cli-android-signing`
also builds an AAB and verifies its JAR signature and upload-certificate
fingerprint with the throwaway key. Neither test is evidence that a game-owned
key has signed a store-ready bundle or that Google Play accepted it.
