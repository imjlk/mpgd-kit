# Public npm starter acceptance

`published-starters.yml` runs after a successful `release` workflow, on demand,
and when a PR changes this consumer harness or the CI Windows host. It requires
both Phaser and Lite consumers on Linux and Windows, followed by MSIX startup
on native x64 and ARM64 Windows runners. Its final gate fails if any required
matrix job fails, is cancelled, or is unexpectedly skipped.

The release publisher records its actual verified checkout SHA and CLI/create-game
versions in a same-run artifact. The consumer checks out that exact commit and waits briefly for those exact public
npm versions to become visible. It never falls back to `latest`. PR runs use
their base commit's released versions; manual runs may supply exact stable
`cli_version` and `create_version` inputs. Generated manifests remain unchanged;
an older pair fails if its generated CLI range now selects a different version.
Release runs intentionally skipped because main moved do not launch consumers.
Missing source metadata after a successful publisher is an error.

The harness runs with plain Node and no repository dependency installation or
package build. It installs the public create-game and CLI packages in a fresh
temporary folder outside every Kit checkout, generates a game under a path
containing spaces, then installs its unchanged generated dependency manifest.
It removes inherited Kit paths, TypeScript loader/cache settings, npm credentials
and user registry configuration. The pinned Go executable remains available to
the consumer's own compiler. Local dependency specs and external registry URLs
are rejected, and installed direct dependencies must resolve inside the consumer.

Checks cover a frozen reinstall, type checking, CLI acceptance help and web
build. The Windows jobs package the generated bundle in the existing CI-only
WinUI host and import the acceptance module and shared host sources from the
installed npm CLI. As in ordinary PR acceptance, this verifies startup and
fixture bridge behavior, not real Store login, purchases or Store submission.

Artifacts retain requested versions and npm integrity metadata, installed direct
dependency versions, the generated lockfile, command logs and bundle hashes for
30 days. Native receipts identify the actual checked-out source commit and this
workflow; unsigned MSIX packages are retained for 7 days. Failures remain visible
as failed workflow runs; this test does not undo a published npm version.

For local generation, npm installation and web checks, use the pinned toolchain:

```powershell
$env:MPGD_PUBLISHED_TEMPLATE = 'lite' # or phaser
mise exec -- node tools/smoke/published-starter-consumer.mjs
```

The script prints its fresh temporary evidence directory. MSIX packaging,
signing, installation and cleanup only run on isolated GitHub Windows runners.
Do not replace registry packages with local tarballs to make this check pass:
fix and publish the defective package, then rerun against the corrected version.

The dependency-free `.mjs` harness is a documented published-JavaScript consumer
exception, checked by `tsconfig.bootstrap-js.json`. Its policy regressions are
authored in TypeScript and run in the prepared contracts suite. Changes limited
to this harness and workflow do not require a publishable-package changeset.
