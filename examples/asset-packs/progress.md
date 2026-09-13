Original prompt: 이슈 한번 pr 진행해보자 — issue #173, following the proposal to start with a design and a small local/static-HTTP sample.

This private fixture explores pack ownership and preparation. It does not add a
public API or npm package. Existing release PR #184 stays open and unmerged.

Plan: shared image + two theme packs, bundled/hybrid builds, verified bytes,
bounded retry, cancellable shared leases, Phaser image preparation, explicit
failure/retry UI, artifact exclusion checks, unit and real-browser validation.
Disk caching/quota, audio/WebGL preparation, publication adapters and protected
delivery remain design follow-ups. Keep issue #173 open after this first PR.

Validation pending: unit tests, both builds, browser fault/lifetime cases,
bundled game-client screenshots/state, root checks, pre-push OCR, GitHub review.

Implemented the private catalog/planner, shared cancellable leases, bounded
verified image fetch, serialized Phaser decode and Canvas preparation, and level
selection/recovery UI. Bundled and hybrid builds emit different actual payloads;
browser tests use separate output directories and an ephemeral CORS origin.

Validation so far: 8 ownership/planning tests and sample typecheck pass. Both
browser passes cover bundled/hybrid, payload exclusion, prepared entry, shared
image reuse, HTTP 404 and bounded 500 retry, digest/size rejection, cold offline
failure, cancellation/replacement, and last-owner texture removal. The bundled
game client exercised movement in both themes; screenshots/state inspected.
Root checks, final review and PR submission remain pending.
