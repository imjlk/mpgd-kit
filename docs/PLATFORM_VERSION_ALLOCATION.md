# Platform Version Allocation Policies

`@mpgd/target-config` ships pure allocation and verification policies for
platform version numbers: `allocatePlatformVersions()`,
`assertPlatformVersionLedger()`, and `formatHostedPwaShellVersions()`. They
compute **candidate** numbers for a release from an explicit ledger and
provenance. They never touch the filesystem, a clock, the environment, git,
or the network, and they never reserve anything.

`mpgd target preview-versions` (delegating to
`pnpm preview:platform-versions`) is the read-only CLI entry: it reads a
ledger and prints the candidate plan as JSON or a human summary, exits
non-zero on validation failure, and never modifies its inputs.

## Which number answers which question

| Identifier | Meaning | When it advances |
| --- | --- | --- |
| `gameVersion` | Player-facing game SemVer | A product release changes the game |
| `releaseRevision` (label `<gameVersion>-v<revision>`) | One immutable source/kit/config build | A new release plan is prepared |
| Microsoft Store numbers | Windows package identity | A new Store package must be uploaded |
| `android.versionCode` | Play upload ordering | A new Android package is uploaded |
| `ios.buildNumber` | App Store upload ordering | A new iOS build is uploaded |

The label format and identity validation reuse the existing
`MpgdReleaseIdentity` contract (`createMpgdReleaseIdentity`,
`isMpgdFinalSemVer`), and a plan's `buildId` keeps the form
`<gameId>-<releaseLabel>-<sourceSha[0..12]>` so existing build scripts keep
working. Provenance is validated per kind: Git revisions must be full
40-character lowercase SHAs; the target configuration digest must be a
64-character SHA-256. The two are never interchangeable.

## Plan reuse contract

Feeding a valid `existingPlan` back with the same provenance reuses it
verbatim: no counter advances, and the plan is revalidated against the ledger
(plan numbers may not run ahead of the ledger, and the revision must be one
the ledger already allocated). Changing any identity or provenance field of
an existing plan is rejected; a changed source/kit/config tuple gets a **new**
`releaseRevision` even when the game SemVer is unchanged. Targets an existing
plan lacks may still be added — that extension is part of the contract — but
a target's recorded intent is immutable.

These checks only see the ledger and plan you hand them: they do not infer
past submissions and do not claim to match what an external store actually
accepted.

## Platform policies

- **Android**: `versionCode` increments monotonically; allocation rejects the
  documented Play maximum of `2_100_000_000`. `versionName` mirrors the game
  SemVer (the displayed version), separate from the upload counter.
- **iOS**: `buildNumber` increments monotonically within the safe integer
  range; `marketingVersion` mirrors the game SemVer.
- **Microsoft Store, legacy (ledger schema 2)**: `packageVersion` and
  `classicPackageVersion` are independent four-part histories. The fourth
  component must be `0` and the third is bounded to `65535`; increments
  advance the third component of each number separately.
- **Microsoft Store, opt-in `hosted-pwa-shell-revision-v1` (schema 3)**: one
  `shellRevision` derives both numbers — `modern = 2.0.<r>.0`,
  `classic = 1.0.<r>.0` — so modern always sorts above classic, the fourth
  component stays `0`, and `r` is bounded to `65535`. This is an opt-in kit
  policy for hosted-PWA shells, not a mandatory version scheme for Microsoft
  apps; existing Store products keep their schema-2 histories, and nothing
  migrates them automatically.
- **hosted-content-only** (`microsoft-store` target intent): a web-content
  release that does not upload a new Windows package records the intent in
  the plan and consumes **no** Store number — and building other targets
  never consumes the Store number as a side effect. A plain
  `microsoft-store` request does allocate a package-upload candidate when
  the plan has no Store entry yet; the CLI expresses the split as
  `microsoft-store` versus `microsoft-store:hosted-content-only`.

Ledger schema 1 is rejected with an explicit message: converting an
operational legacy ledger is a deliberate migration this module never
performs. Unknown `versionPolicy` discriminators fail; they are never
silently read as the default.

## Preview is not reservation

- The pure functions and the CLI produce **candidate** numbers. They are not
  reserved, and calling them repeatedly with the same inputs returns the same
  candidates — determinism, not a lock.
- Two processes reading the same ledger can compute the same candidate
  numbers concurrently. Operational reservation needs external
  serialization: a lock, a queue, or a single-writer store.
- A consumer implementing persistence must separately solve duplicate
  reservation, crash recovery, and storing the ledger and plan atomically.
  None of that is provided here, and writing two files in a row is not a
  transaction.

## Adoption notes

A game repository adopting these policies needs at minimum: a ledger file in
schema 2 or 3, the provenance inputs (source SHA, kit SHA, config digest)
supplied by its own tooling, and — when it wants persistence — the
serialization and atomic-write layer described above. The plan's target
entries (Store package numbers, `versionCode`, `buildNumber`) map onto the
`MPGD_*` environment inputs the kit's build tooling already reads.

## Verification status

The policies are covered by
`packages/target-config/test/platform-version-allocation-smoke.ts` (pure
allocation, reuse, provenance, policies, boundaries, validation, determinism)
and `tools/smoke/cli-platform-version-allocation.ts` (CLI read-only behavior,
input-hash stability across runs, deterministic output, candidate wording,
manifest cross-checks). The commands above are the ones that exist; nothing
here submits to a store or deploys anything.
