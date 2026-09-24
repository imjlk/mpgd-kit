# Documentation evidence

The documentation pipeline has four separate jobs: use `@ttsc/graph` to find
the public code and related callers, use `@ttsc/evidence` to require explicit
citations, run type checks and tests for behavior, and publish the checked
Markdown. A green Evidence result checks coverage and review freshness, not
whether a paragraph is semantically true or a device integration is release
ready.

## Current enforced scope

The first pilot is the `@mpgd/platform/capability-conformance` export in
`packages/platform/package.json`. Claim 1 selects exported callable symbols
from the source module behind that subpath, whether or not a guide happens to
import them. Claims 2–4 independently require the guide, implementation, and
tests to cite each confirmed section of
[`platform-capability-snapshots.md`](specs/platform-capability-snapshots.md).
Claim 5 uses a checklist so each selected guide must acknowledge each
applicable [documentation principle](standards/documentation-principles.md).
The source of truth for the claim definitions is the Evidence block in
[`lint.config.js`](https://github.com/imjlk/mpgd-kit/blob/main/lint.config.js).

This scope does **not** cover every `@mpgd/platform` export or the historical
documents in `docs/`. It does not treat roadmap, proposal, operational, or
target-readiness notes as confirmed behavior. Widen coverage by adding a
published entrypoint or subpath and a deliberately selected guide/spec/test
population; do not use whichever symbols happen to appear in examples as the
API inventory. Keep documentation, implementation, and test coverage in
separate claims so one citation cannot satisfy another obligation.
The `docs:evidence` command also checks that the claimed conformance source
still backs the package's published `./capability-conformance` export.

The follow-on example claim selects
[`platform-capabilities.ts`](https://github.com/imjlk/mpgd-kit/blob/main/docs/examples/platform-capabilities.ts) separately
from the platform test claim. Each spec section must therefore have an
example citation as well as a test citation; neither population stands in for
the other. Run `pnpm docs:examples:check` for TypeScript validity and
`pnpm docs:examples:test` for source-backed local behavior checks. These
examples do not validate the published tarball or extend the enforced public API
inventory beyond the pilot subpath.

## Authoring and review

- Put Markdown citations in HTML comments next to the paragraph they justify.
  Use `@link` with a path relative to the guide for public TypeScript symbols,
  and `@evidence` with a root-relative Markdown path for confirmed specs or
  principles. Name the narrowest relevant section or symbol.
- Use `@evidenceReview` for protected references. When `pnpm docs:evidence`
  reports a missing or stale fingerprint, inspect the changed contract and
  the citing paragraph, check its test/example where applicable, then update
  the review explanation and fingerprint. Do not copy a new digest solely to
  clear the diagnostic.
- Distinguish a type or helper from an adapter implementation, a real-device
  test, and release readiness. Record each validation level independently.
- Run `pnpm docs:evidence` from the repository root. It activates the Evidence
  contributor only for this command, preserving the normal `ttsc`/`ttsx`
  plugin cache and prepared-suite runtime. Run the relevant package tests
  separately; Evidence is not a runtime test.

The guide for this pilot is
[`platform-capabilities.md`](guides/platform-capabilities.md). The enforced
scope is intentionally small; additional guides should join it only after
their claims and examples are verified. The site can still label and display
legacy reference material without treating it as a confirmed spec.

## Site and CI

Rspress builds the original files under `docs/` without copying their prose
into another site tree. The index distinguishes enforced guides and specs from
older integration notes and roadmaps. `pnpm docs:site:build` checks internal
page links and anchors while building the static site.

For PRs that change only `docs/**` or the root README, the main CI classifier
skips package, browser, game, and native jobs; `docs-validation` runs Evidence,
example type checks and source-backed tests, and the site/link build. Changes
to the conformance implementation or its test still run normal code CI and
documentation validation. A successful Evidence result or Pages deployment
does not upgrade local checks into device or release verification.

Every successful `main` push also rebuilds and publishes the current site.
This ensures a newer, unrelated push can publish the site when an older Pages
artifact is skipped as stale; it does not add the prepared/native suite to
documentation-only PRs.
