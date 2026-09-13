Original prompt: 이슈 한번 pr 진행해보자 — issue #173, following the proposal to start with a design and a small local/static-HTTP sample.

This private fixture explores pack ownership and preparation. It does not add a
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
