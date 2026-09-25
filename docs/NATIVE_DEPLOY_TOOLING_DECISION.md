# Native store tooling decision (D-01)

Status: selected for the first **internal-test** deployment implementation. This
decision does not attest to a signed build, store upload, or device test.
Baseline: `main@c377cc0`, Node 24.11.0, TypeScript 7.0.2, ttsc 0.30.4.

## Selection

| Need | Selected implementation | Pinned version |
| --- | --- | --- |
| Google Play edit, AAB upload, internal track and commit | Official `@googleapis/androidpublisher` | 42.0.0 |
| App Store Connect IPA upload, processing lookup, internal TestFlight group | `asc` from `rorkai/App-Store-Connect-CLI` | 5.5.0 |

The Apple `appstore-connect-sdk` 2.0.0 was evaluated, not selected. It has typed
`buildUploads` and `builds` REST operations, but it does not provide the complete
IPA binary transfer and post-upload orchestration as a single operation. Adopting
it would make the kit implement and maintain that transfer itself. The selected
`asc` offers separate upload, build lookup, and group commands; the kit will call
only those steps after its own artifact verification, not `asc publish appstore`
or an all-in-one public-release flow. One Apple implementation is selected; do
not add a parallel SDK submitter or a public `--submitter` option.

`asc` is an unofficial CLI. Only public App Store Connect API-backed commands
needed for internal TestFlight are in scope. Its `asc web` features and other
private web-session endpoints are excluded. In particular, `asc builds upload
--dry-run` reserves upload operations and is **not** suitable for the kit's
read-only `mpgd deploy plan`.

## Repeatable compatibility evidence

The private `@mpgd/deploy-tooling-compat` fixture pins both Node SDK candidates.
Run from the repository with its `mise` toolchain:

```sh
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --dir packages/deploy-tooling-compat check
mise exec -- pnpm --dir packages/deploy-tooling-compat test
mise exec -- node tools/deploy/validate-asc.mjs --download
```

The fixture compiles JavaScript and declarations with ttsc, constructs both
client/auth objects, handles mocked Google edit and Apple build API responses,
then packs itself into a tarball and repeats type and runtime consumption in a
temporary project with no workspace link. The selected `asc` release is fetched
from its versioned GitHub release, SHA-256 checked against
[`asc-pin.json`](../tools/deploy/asc-pin.json), and checked for its version,
JSON capabilities, upload/list/group help, and usage-error exit code. The
published checksum set covers pinned macOS/Linux/Windows architectures; the
local D-01 execution verified the macOS arm64 binary only. Other host checks
remain CI or host-specific work.

The SDK probes use a local mock HTTP server and fixture token. They prove
toolchain, package, declaration, runtime import, and response compatibility;
they do **not** prove account permissions, AAB/IPA binary upload, Play edit
commit, TestFlight processing, or live store readiness. D-08/D-09 will add
submission-specific mock state tests. D-12 requires real account and game
evidence separately.

## Credentials and process boundary

For `asc`, launch with `ASC_TELEMETRY_DISABLED=1` by default and explicit
`--output json`. In CI use ephemeral environment-supplied API key material,
`ASC_BYPASS_KEYCHAIN=1`, and `ASC_STRICT_AUTH=1`; do not run `asc auth login` or
persist a private key in the game repository. On an interactive host, `asc`
can otherwise use system keychain or `~/.asc/config.json` / local `.asc/config.json`.
The `.p8` App Store Connect API key is distinct from the iOS app-signing key.
The kit will impose its own time limit, output-size limit, result validation,
redaction, and cleanup around `asc` subprocesses in later PRs.

The pinned binary and its hashes are versioned with this decision. An installed
`asc` with the same version string but a different binary is **not** accepted by
the compatibility verifier. The download path also compares the pinned hash
with the versioned GitHub release asset digest before execution. Download
errors and checksum mismatches fail closed; no automatic fallback to a
different `asc` version or SDK occurs. This does not independently attest the
upstream source or prove the release maintainer has not been compromised. A
future pin change requires separate maintainer review of the upstream release;
the checks do not replace that review.

## References

- [Google's Node client and media-upload guidance](https://github.com/googleapis/google-api-nodejs-client)
- [Apple's Build Uploads API](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads)
- [`appstore-connect-sdk` candidate](https://github.com/isaced/appstore-connect-sdk)
- [`asc` commands and telemetry policy](https://github.com/rorkai/App-Store-Connect-CLI)
- [`asc` credential profiles and storage](https://github.com/rorkai/App-Store-Connect-CLI/blob/main/configuration/profiles.mdx)
- [`asc` 5.5.0 release assets](https://github.com/rorkai/App-Store-Connect-CLI/releases/tag/5.5.0)
