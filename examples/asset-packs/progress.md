Original prompt: 이슈 한번 pr 진행해보자 — issue #173, following the proposal to start with a design and a small local/static-HTTP sample.

Initial #185 scope (historical): this private fixture explored pack ownership and preparation. It did not add a
public API or npm package. Existing release PR #184 stays open and unmerged.

Plan: shared image + two theme packs, bundled/hybrid builds, verified bytes,
bounded retry, cancellable shared leases, Phaser image preparation, explicit
failure/retry UI, artifact exclusion checks, unit and real-browser validation.
Disk caching/quota, audio/WebGL preparation, publication adapters and protected
delivery remain design follow-ups. Keep issue #173 open after this first PR.

Implemented the private catalog/planner, shared cancellable leases, bounded
verified image fetch, serialized Phaser decode and Canvas preparation, and level
selection/recovery UI. Bundled and hybrid builds emit different actual payloads;
browser tests use separate output directories and an ephemeral CORS origin.

Validation: 11 ownership/planning and stream-failure tests and sample typecheck pass. Both
browser passes cover bundled/hybrid, payload exclusion, prepared entry, shared
image reuse, HTTP 404 and bounded 500 retry, digest/size rejection, cold offline
failure, cancellation/replacement, and last-owner texture removal. The bundled
game client exercised movement in both themes; screenshots/state inspected.
Root `pnpm check` and existing phaser-assets tests passed. OCR review findings
were applied for shared delivery metadata, transactional level entry, MIME-aware
verified blobs, secure-context diagnostics and CI browser version isolation.
An errored-stream cleanup regression was reproduced and fixed; browser checks
also verify that an invalid prepared theme leaves the prior level intact.
Corrective OCR found no medium/high/critical issues. Its remaining low-severity
suggestions were applied: select the bundled report by mode, and reject unknown
source formats while sharing the catalog MIME with the dev response. Validation
CLI summaries use console.info per the repository contribution guide.
The complete pre-PR validation list and final local/GitHub reviews are required
submission checks; detailed run evidence is recorded in the PR.

Follow-up prompt: 좀 활용도 높게 반영좀 해보는걸로 pr 진행해볼래?

The reusable implementation now lives in @mpgd/phaser-assets/packs. The sample
consumes that public API and replaces SVG fixtures with PNG, spritesheet and
JSON atlas textures. Ownership, cancellation, deadlines and shutdown cleanup
are package responsibilities; build inclusion stays explicit in the example.
Validation in progress: public API tests, packed consumer import, Canvas/WebGL
acceptance, repository checks, local OCR and GitHub review.

Follow-up validation: 17 public-package tests, packed Node import and independent
consumer TypeScript checks pass. Canvas/WebGL × bundled/hybrid browser checks pass,
including named atlas frames, spritesheet frames and physical texture cleanup.
The root typecheck passes; full contribution checks and OCR/PR review are running.

Follow-up review incorporated: cleanup failure isolation with drainable diagnostics, full download/decode shutdown coverage, consumer display cleanup before lease release, separate request deadlines and download/decode/encoded-byte budgets. Package tests: 37 passing. Browser matrix including stalled body, cache reuse and shutdown passing. Public API remains in the existing phaser-assets package.

Final admission check: 38 package tests pass, including an independent decode limit with all downloads admitted. Active/pending real Phaser shutdown and 20 repeated 404/transient-500 recovery/unload cycles pass. OCR noted two low-severity diagnostic/documentation improvements; both applied.

OCR implementation review: moved integrity hashing outside the HTTP/body deadline, added asset-specific reservation errors, rejected unknown integrity fields, and honored Retry-After with jittered backoff. All-settled download handling intentionally remains to retain bytes until both atlas files settle. Global atlas budget cross-validation is intentionally not added: small budgets remain valid for catalogs with known small integrity sizes. Package regression tests: 42 passing.

ZIP acceptance round (PR: exercise built ZIP packs through the Phaser loader):
extended the private sample with a prepared ZIP delivery path — real
`mpgd assets build-packs` output (all-ZIP and mixed files+ZIP variants, built
through the actual CLI code path into the static origin), fetched over plain
HTTP, decoded by the real application-deployed module worker, staged under an
explicit archive+expanded byte budget, and supplied to the existing loader via
a prepared file source keyed by pack/revision/assetKey/role. Preparation
precedes acquire; staging returns once the loader consumed the files and
re-prepares on re-entry. Browser coverage adds both renderers for the happy
path plus 404/corrupt archive failures, oversize (pre-network) and exact
staging budgets, mid-preparation cancel, overlapping transitions, shutdown
during preparation, mixed manifests, and a files-vs-ZIP comparison recorded
in evidence.json. No public API, package or worker-protocol change.

Public delivery API round (PR: add prepared pack delivery): moved the
validated preparation/supply rules into the package as
`@mpgd/phaser-assets/delivery` (`createPhaserPackDelivery`): manifest
frozen at creation, catalog + file source derived once, zip closure
staging (pre-network budget check, whole-prepare deadline, worker decode
gated on a completed result), files packs over plain HTTP, mixed
routing, once-per-segment URL encoding, handle/reader lifetime
separation, single-flight prepare with busy rejection, typed error codes
preserving decoder statuses, import-safe module. The sample now consumes
the public API only (`src/zipDelivery.ts` removed; the sample fetches
the manifest itself). Package tests cover catalog derivation, snapshot
invariance, files-only no-op, mixed routing, not-prepared/dispose/
repeated release, reader lifetime, cancel/deadline cleanup, budget
pre-rejection, read order independence, corrupt archives, URL encoding
and config validation.

PR #204 follow-up: finish cache integration and review fixes without another
local OCR round. Reproduced the historical Chromium A-to-B-to-A transition
timeout on the latest code: ZIP staging completed but the loader timed out
preparing pilot; another run exposed lost staging during a subsequent prepare.
A deterministic regression confirms a prior handle/reader can release a resident
dependency while the next prepare downloads another archive. Pin those resident
dependencies until the complete closure has new handles, and return provisional
pins on failure/cancellation. The native-input-retention experiment was reverted;
only the deterministic staging fix remains. Package tests: 385 passing. Full
Canvas/WebGL bundled/hybrid/ZIP/mixed/cache browser acceptance passed three
consecutive runs. The skill client also exercised movement; its playing-state
JSON and gameplay screenshots were inspected with no console errors. Package
build and installed-tarball Chromium validation also pass. Next: push this
targeted fix, request GitHub re-review, and wait for the focused CI result.

PR #205 integration (2026-09-23): rebased the ttsc 0.30.4 upgrade after
#204 merged as dbdfb089. Resolved the two example conflicts by retaining the
public persistent-cache boundary, then applied the current formatter. Runtime
AST comparisons against main preserve the overlapping implementation; the
existing test-only explicit undefined initialization remains intentional.
The earlier A-to-B-to-A CI failure is covered by #204's resident-dependency
fix, not a timeout increase or disabled acceptance test. Validation passed:
root check, 385 asset tests, six tooling tests, assertion and CLI-output canaries,
all ten graph presets, package builds, full source Chromium acceptance, installed
tarball Chromium acceptance, and the Sampo release dry-run. The skill client
confirmed Grove gameplay and rightward movement with ready 2/2, two textures,
matching screenshots/state, and no console errors. Scoped integration OCR found
only one low-severity comment indentation issue, which was corrected. No local
test:prepared rerun. The original toolchain worktree's two uncommitted diagnostic
files were left untouched. Next: push the rebased PR, request fresh GitHub review,
and address CI/review findings before merging; keep the release PR last.
