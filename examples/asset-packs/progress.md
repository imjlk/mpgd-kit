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
