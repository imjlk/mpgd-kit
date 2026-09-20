# @mpgd/phaser-assets

## 0.6.0 — 2026-09-21

### Minor changes

- [5ff0813](https://github.com/imjlk/mpgd-kit/commit/5ff08137ab98e7ec02609207ba41f874918dc947) Separate pack file delivery from texture preparation. `createPhaserAssetPackLoader`
  now accepts an optional `fileSource` implementing the public `PhaserPackFileSource`
  contract: per-file `open` → `read` → body `release`/`close` lifecycles keyed on
  `{ packId, revision, assetKey, role }`, with cancellation and shared transfer/byte
  budgets through the file context. Integrity verification (declared size equality
  and SHA-256), the `maxFileBytes` cap, byte admission, decoding, texture
  registration and lease ownership remain loader responsibilities for every source.
  The default URL transport keeps `resolveURL`, `requestCache`, deadlines, retries
  and streaming caps unchanged; omitting `fileSource` preserves the existing API
  and behavior. — Thanks @imjlk!
- [eeefb60](https://github.com/imjlk/mpgd-kit/commit/eeefb60133f64e066fdc90465f581d6e0c483673) Add prepared pack delivery. The new `@mpgd/phaser-assets/delivery`
  subpath turns a CLI-built delivery manifest into the existing pack
  loader's catalog and file source: zip packs are staged per dependency
  closure under an explicit archive+expanded byte budget (checked before
  any request), decoded and verified by the application-deployed module
  worker with a whole-prepare deadline that stages never restart, and
  admitted only on a fully completed decode; `files` packs keep plain
  HTTP through the same source and mixed manifests route each file by its
  pack's delivery kind. Artifact paths URL-encode each segment exactly
  once against a `baseUrl` or custom resolver. `prepared.release()`
  returns staging while textures stay alive under the loader lease and
  open readers keep their bytes; failures throw
  `PhaserPackDeliveryError` with stable codes (config, not-prepared,
  busy, budget, transport, integrity, cancelled, deadline, disposed) and
  preserve decoder statuses in the message. No new codec, persistent
  cache or prefetch; the module imports without network, worker or timer
  side effects. — Thanks @imjlk!
- [66e572d](https://github.com/imjlk/mpgd-kit/commit/66e572dce7eb4a0bbbd097bf40a9ee47db44ec6b) Add `mpgd assets build-packs` for deterministic asset pack delivery builds.
  A JSON build config (image, spritesheet and JSON atlas assets with pack ids,
  logical revisions, dependencies and per-asset compression overrides) produces
  individual files or per-pack ZIP artifacts plus an external versioned delivery
  manifest: per-file media types, original bytes and SHA-256 digests, archive
  digests, entry methods and counts. ZIP v1 uses STORE/DEFLATE only with fixed
  metadata for reproducible bytes; pack artifacts are immutable per revision
  while the manifest tracks the latest successful build. The new
  `@mpgd/phaser-assets/pack-format` subpath publishes the shared pure contract
  (types, untrusted-input validation, entry path rules) free of Node, DOM, Phaser
  and compression concerns, and the CLI now depends on the package at runtime. — Thanks @imjlk!
- [2e9609f](https://github.com/imjlk/mpgd-kit/commit/2e9609f2a074f77c3ca0568bd0ab15c414e27c17) Add `delivery.subscribe(listener)` as the single observation surface for
  pack delivery: listeners receive prepare and files-delivery read events
  with an operation correlation id, per-operation sequencing, observed
  phases (planning, downloading, decoding-and-verifying, one terminal of
  prepared/completed, failed, cancelled or disposed) and strictly measured
  progress — network-delivered body bytes against the manifest's declared
  size, and verified entry counts and byte totals. Observation is
  containment-safe: throwing or rejecting listeners never change delivery
  results, unsubscription is idempotent, terminals fire exactly once per
  operation, and late events from superseded operations are dropped.
  
  `PhaserPackDeliveryError` gains an optional additive `details` field
  (stage, operationId, pack/asset identity, httpStatus,
  decoderStatus/decoderCode, expectedBytes/receivedBytes) captured at the
  failing execution point — no message parsing, no URL or response data.
  `readCappedDeliveryBody` accepts an optional `onBodyBytes` observation
  hook. Existing codes, constructor calls and behavior are unchanged. — Thanks @imjlk!
- [20e3583](https://github.com/imjlk/mpgd-kit/commit/20e3583394671dcb46157364f8bbac6799ba0dd3) Add `mpgd assets verify-delivery`, a local read-only pre-deployment check
  for built asset pack artifacts: `--manifest <asset-pack-delivery.json>
  --root <artifact-directory>`. The command validates the manifest against
  the shared pack-format contract, resolves every referenced path under the
  root (rejecting absolute paths, traversal, symlinks and non-regular
  files), streams and SHA-256-verifies every referenced file, decodes each
  ZIP archive through the same pure core that powers runtime delivery
  (exposing a narrow `@mpgd/phaser-assets/archive-validation` entry), and
  optionally checks static-host object limits (`--max-object-bytes`,
  `--max-files`, `--max-total-bytes`) against the full root inventory —
  distinguishing referenced integrity from deployment budget — and caps the
  largest archive it will read with `--max-archive-bytes` (512 MiB by
  default) plus decompression bounds `--max-entry-bytes` (256 MiB) and
  `--max-expanded-bytes` (1 GiB) that are independent of the manifest's own
  declared sizes, failing in the limits stage before reading or decoding
  oversized declarations. Reports carry
  per-stage failure codes; `--json` emits stdout as exactly one
  machine-readable JSON document (parseable with JSON.parse(stdout), no
  banner) on success and failure alike, framework argument errors move to
  stderr, and failures exit non-zero. The check never
  modifies inputs, extracts archives, or contacts a network. — Thanks @imjlk!
- [9f62678](https://github.com/imjlk/mpgd-kit/commit/9f62678b5729001138cc665e68537e8e6f03d0c5) Add `delivery.inspectPreparation(packId)`: a read-only preparation cost
  plan computed from the manifest snapshot and the current staging state —
  dependency-ordered closure, per-pack cold artifact list (one object per
  ZIP archive, one per files-delivery file), cold object count and
  manifest body-bytes sum, ZIP packs already staged versus the ones a
  prepare would stage, the additional staging reservation under the
  current archive-plus-expanded policy, current/projected staging usage
  against the budget with `fitsBudget`, and the current busy state. The
  inspection starts nothing and reserves nothing; `prepare` runs the same
  pure planner on live state so a stale inspection can never bypass
  admission. Byte sums are overflow-checked, and an `accountingModel`
  identifier pins what the reservation numbers cover (staging only — not
  transport copies, decoder internals, decoded pixels or GPU resources). — Thanks @imjlk!
- [2292040](https://github.com/imjlk/mpgd-kit/commit/22920400c6f418bc98b2f86bec041970b20ba34d) Add bounded ZIP pack decoding. The new `@mpgd/phaser-assets/archives` subpath
  decodes the ZIP v1 delivery profile against the shared manifest contract under
  explicit limits (archive/entry/total-expanded bytes, entry count, path length,
  decode deadline, concurrency), counting inflated output while it is produced.
  Archive and entry integrity is mandatory. The `archive-worker` subpath is an
  application-deployed module worker entry; the client enforces one-outstanding-
  entry backpressure, per-job cancellation with late-message protection and
  distinct worker-crash/deadline statuses, never silently falling back to
  main-thread decoding. The decode deadline is one absolute budget from slot
  acquisition through returned-archive verification (queue wait excluded); the
  worker receives only the unspent remainder, completion inside the cleanup
  grace cannot turn a decided deadline into success, and cancellation shares a
  single cooperative cleanup window. The worker-message boundary is hardened end to
  end: worker buffers must be genuine ArrayBuffers in any realm (shared,
  detached and forged buffers are rejected), every message field is captured
  once through a guarded read that settles the job when a getter throws,
  terminal statuses fix their failure codes (detailed codes only accompany
  error statuses), and settled jobs release their worker reference after
  best-effort termination. Adds a pinned `fflate` dependency for
  DEFLATE. — Thanks @imjlk!

### Patch changes

- [5135132](https://github.com/imjlk/mpgd-kit/commit/5135132bffd4957de932199f445152a0c019a0df) Measure the whole pack-preparation budget on one monotonic clock
  (`performance.now`) instead of `Date.now`, so a system clock correction
  during `prepare` can no longer extend or prematurely exhaust the
  `prepareTimeoutMs` budget. The decoder still receives only the unspent
  remainder, now floored to its integer deadline contract so rounding can
  never mint budget; no new archive request or decode starts once the
  monotonic clock says the budget is spent, and a decode that resolves
  after the budget is spent no longer earns staging handles. Existing
  responsibilities are unchanged: `prepareTimeoutMs` still covers one
  whole prepare, `requestTimeoutMs` still ends with each HTTP body, and
  user-cancel, dispose and deadline causes stay distinct. — Thanks @imjlk!

## 0.5.0 — 2026-09-14

### Minor changes

- [832638b](https://github.com/imjlk/mpgd-kit/commit/832638b072639946b605a5794eae71b86b44a059) Add the opt-in `@mpgd/phaser-assets/packs` entrypoint for reusable image,
  spritesheet and JSON atlas packs. Acquire shared dependency textures with
  per-caller cancellation, preparation deadlines, bounded file retries and optional
  size/SHA-256 verification; release them explicitly or on scene shutdown.
  Existing manifest and enqueue helpers remain compatible.
  
  Isolate cleanup failures and bound acquisition with separate request deadlines, download/decode permits and encoded-byte reservations. — Thanks @imjlk!

## 0.4.1 — 2026-07-14

### Changed

- [5230c6b](https://github.com/imjlk/mpgd-kit/commit/5230c6b4f49cdd38b4cde2449a7dc7751f9dacff) Update published package metadata and generated Phaser starters to the current ttsc, TypeScript, and typia toolchain releases. — Thanks @imjlk!

## 0.4.0 — 2026-07-08

### Added

- [33f2598](https://github.com/imjlk/mpgd-kit/commit/33f259881be5932e3f155dfc17c3b75f6f78da09) Add target-portable Phaser asset manifest helpers that accept Vite-emitted asset URLs for generated games. — Thanks @imjlk!

