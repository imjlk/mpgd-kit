# @mpgd/phaser-assets

Typed Phaser 4 manifests and optional texture-pack ownership. Existing
`definePhaserAssetManifest` / `loadPhaserAssets` enqueue helpers remain available
from the root entrypoint. The optional `/packs` entrypoint adds awaitable loading
without taking over or resetting `scene.load`.

```ts
import {
  createPhaserAssetPackLoader,
  definePhaserAssetPacks,
} from '@mpgd/phaser-assets/packs';

const catalog = definePhaserAssetPacks([
  {
    id: 'shared', revision: '1', assets: [
      { kind: 'spritesheet', key: 'hero', url: 'assets/hero.png',
        frameConfig: { frameWidth: 64, frameHeight: 64 } },
    ],
  },
  {
    id: 'forest', revision: '2', dependsOn: ['shared'], assets: [
      { kind: 'atlas', key: 'terrain', textureUrl: 'assets/forest.png',
        atlasUrl: 'assets/forest.json' },
    ],
  },
]);

// In scene.create(), create one loader for consumers that should share resources.
const packs = createPhaserAssetPackLoader(this, catalog, {
  resolveURL: (url) => new URL(url, document.baseURI).href,
  timeoutMs: 15_000,
});
const abort = new AbortController();
const lease = await packs.acquire('forest', {
  signal: abort.signal,
  onProgress: (ready, total) => console.info(`${ready}/${total} textures ready`),
});
const hero = this.add.sprite(100, 100, lease.key('shared', 'hero'), 0);
const ground = this.add.image(300, 300, lease.key('forest', 'terrain'), 'grass');

// On transition, acquire the replacement before releasing the old lease.
// First destroy ALL display objects and animations using these keys.
hero.destroy();
ground.destroy();
lease.release();
```

Handle rejected acquisitions in your game's loading UI. Failed or cancelled
acquisitions release only their own claims; previously acquired leases stay valid.
`release()` is idempotent, and keys cannot be obtained from a released lease.
Abort signals cancel pending acquisitions; returned leases require release. Do not
replace or remove generated textures directly; the loader owns them.
Scene shutdown/destroy permanently disposes its loader and invalidates its leases.
Create a new loader after restarting a scene. For cross-scene ownership, keep the
loader in a dedicated long-lived asset scene and release game-scene leases before
those scenes shut down. Do not dispose the asset scene while textures are in use.

Pack IDs, revisions and manifest keys are logical identity. Engine texture keys
are generated and must be obtained from the lease. Catalog data is copied on
loader construction. Shared dependencies are deduplicated within that loader;
separate loaders have separate lifetimes and do not share textures. The URL
resolver receives `{ packId, revision }`, so delivery policy can choose packaged
URLs or a static origin without changing gameplay.

Image, spritesheet and single-texture JSON atlas assets use the existing manifest
shapes. PNG, JPEG, WebP and SVG decoding follows browser support and correct HTTP
MIME headers. The integration fixture exercises PNG and JSON atlases in WebGL and
Canvas. Atlas metadata must include `frames`; at least one usable frame is
required. Array/multi-texture atlas manifests, audio, JSON data and binary assets
remain with the existing enqueue helpers for now.

Preparation means the image has decoded and the texture/frames are registered.
It does not promise shader warmup, arbitrary first-frame performance, GPU recovery
after context loss, or audio unlock. Progress counts prepared assets, not files or
HTTP bytes. An atlas's image and JSON are one asset.

Defaults are conservative starting limits, not performance targets: one retry for
network errors/429/5xx (exponential backoff with jitter and `Retry-After`), a 15-second per-asset deadline (including all queue waits),
a 10-second `requestTimeoutMs` for each HTTP attempt including its body,
32 MiB encoded bytes per file and 16 million decoded pixels per image.
`maxConcurrentDownloads` defaults to 4 and `maxConcurrentDecodes` to 1.
`maxBufferedBytes` defaults to 64 MiB across downloading, queued and decoding
assets. The loader reserves each asset's declared file sizes before downloading;
files without integrity reserve `maxFileBytes` each. An atlas reserves both files.
A reservation larger than the budget fails before any network request. This
conservative admission policy prevents completed Blobs from accumulating behind
slow decodes. Supply integrity sizes for better utilization and tune limits using
your devices and catalog. The sample explicitly uses 2 downloads, 1 decode and an
8 MiB encoded reservation budget.

Timeout aborts actual fetch/body reads. A browser's native decode may keep running
after cancellation: the caller rejects promptly, its image URL is revoked, and
its decode slot and byte reservation remain occupied until native completion.
Late completion cannot register a texture. A decoder that never settles can thus
stall the decode queue; later callers still hit their own preparation deadlines.
Encoded reservations are a logical payload bound, not an exact heap/GPU bound:
stream chunks, Blob construction, parsed JSON and browser internals add overhead.

All ownership returns complete even if a Phaser texture disposer throws.
`release()` and `dispose()` do not throw cleanup failures; drain them with
`takeCleanupErrors()` for diagnostics. Failed engine deletion is not retried:
`snapshot()` shows ownership, so an empty snapshot does not prove that an engine
which threw during deletion removed its physical texture. Image references are
cleared regardless. Cancellation/failure keeps its original rejection reason.
Optional `integrity: { texture: { bytes, sha256 }, atlas: { bytes, sha256 } }` verifies
encoded content before decoding/parsing. SHA-256 verification requires HTTPS or
localhost. Known size or integrity failures are not retried. Requests omit
credentials. `requestCache` defaults to `no-store`; choose `default` for ordinary
browser HTTP caching of versioned immutable URLs, or `reload` to refresh that
cache from the network. Integrity is checked even when bytes come from HTTP cache.
Changing a bad immutable response requires a new revision or a fresh-cache policy. A static host must provide CORS and MIME
headers. `resolveURL` does not affect ordinary `scene.load` URL settings. Pack URLs are
page-relative by default; they do not inherit `scene.load.baseURL/path/prefix`.

There is no managed disk cache, offline download storage, prefetch scheduler or
upload service in this API. `snapshot()` reports owned textures and width × height
× 4 estimates, excluding engine overhead, GPU format, mipmaps and transient
buffers. Games own catalog rollout, bundle membership and memory budgets.

## File sources

File delivery is a separate boundary from texture preparation. By default the
loader uses an internal URL source that keeps the behavior described above:
`resolveURL`, `requestCache`, per-attempt deadlines, bounded retries, streaming
size caps, credential-free requests and shared download permits. Pass a custom
`PhaserPackFileSource` through `fileSource` to deliver file bytes from another
store without touching decoding, texture registration, leases or rollback.
Sources never initialize `scene.load` and never create textures.

The contract is a small lifecycle per file. The loader first calls
`open(request, context)` to acquire source-side ownership — every file of the
asset is opened before byte-budget admission, so shared source work survives
admission batching; `open` must not transfer the body. Once admission approves
the asset, the loader calls `read()` exactly once, which resolves with
`{ bytes, release() }`. The
loader verifies the returned body, decodes and registers the texture, then
returns the bytes via `release()`; `close()` returns source-side ownership once
`read()` has settled. Cancellation of an in-flight read flows through
`context.signal`, not through `close()`. Requests carry `packId`, `revision`,
`assetKey`, `role`
(`'texture'` or `'atlas'`), the original manifest `url` and the optional
`integrity` the loader will enforce. An atlas's image and JSON are two files of
one asset, distinguished by role. Sources that share work across files (an
archive, for example) must key that work on the logical request identity —
`{ packId, revision, assetKey, role }` — never on temporary blob or expirable
URLs; the `open`-before-`read` split exists so such sources are not forced to
download or extract one archive per file.

`context.signal` carries caller cancellation and the asset's preparation
deadline; reads must observe it. `context.budgets` shares the loader's
preparation budgets: `transfers.acquire(signal)` reserves one transfer permit
(the default source holds one per HTTP file transfer), and
`bytes.acquire(weight, signal)` reserves encoded bytes from the same budget the
loader reserves declared asset sizes from. The loader already reserves each
file's declared size (or `maxFileBytes`); sources reserve only additional
transient bytes they buffer themselves.

Which layer owns which concern:

| Concern | Owner |
| --- | --- |
| File identification, location resolution, byte acquisition | File source |
| Transport retries, per-attempt deadlines, HTTP cache policy, credential-free requests | Default URL source; custom sources own their transport |
| Byte-budget admission for each asset, before any read | Loader |
| Transfer permits and the encoded-byte budget | Shared: loader for declared files, source for extra transient bytes |
| Final integrity verification (declared size equality and SHA-256) and the `maxFileBytes` cap | Loader, for every source |
| Streaming size caps during transfers | Default URL source |
| Image decoding, atlas parsing, texture/frame registration, leases, cancellation, rollback | Loader |

Replacing the source never disables verification or limits. Injected bytes are
still checked against declared sizes and digests, capped at `maxFileBytes`,
admitted against `maxBufferedBytes`, and decoded under `maxDecodedPixels` and
`timeoutMs`. Transport-only options (`resolveURL`, `retries`,
`requestTimeoutMs`, `requestCache`) apply to the default URL source and are
ignored when `fileSource` is provided.

File bytes and textures have different lifetimes. Bytes return with
`release()` once decoding/parsing finishes; textures stay resident until their
last lease owner releases. Returning bytes never removes a registered texture,
and decode slots and byte reservations stay held until native decoding actually
settles. Bytes arriving after shutdown or cancellation are returned but never
registered as textures. `release()` and `close()` failures are isolated like
other cleanup: they never abort the remaining cleanup, decode slots or
reservations, and surface through `takeCleanupErrors()`.

Integrity describes the file body the platform hands the application — after
HTTP content decoding. `Content-Encoding` is never re-decoded in game code, and
`Content-Length` is never used as size or verification evidence; actual network
transfer can be smaller or larger than the buffered body.

## Pack delivery format

The `/pack-format` entrypoint is the pure, dependency-free contract shared by
pack producers and consumers: build config and versioned delivery manifest
types, untrusted-input validators, normalized entry path rules (UTF-8 NFC
relative paths only) and the supported media types with their default ZIP
entry methods. It never touches Node, the DOM, Phaser or compression. The
`mpgd assets build-packs` command in `@mpgd/cli` produces files or ZIP
delivery artifacts against this contract; see
[Asset pack delivery builds](../../docs/ASSET_PACK_DELIVERY.md) for the config
schema, determinism guarantees and ZIP v1 scope.

## Archive decoding

`@mpgd/phaser-assets/archives` decodes the ZIP v1 delivery profile produced by
`mpgd assets build-packs` under explicit resource bounds. Decoding accepts only
that profile — STORE and DEFLATE entries with the writer's fixed metadata — and
rejects encrypted, ZIP64, split, symlinked, corrupt, truncated, duplicated,
traversal-carrying or manifest-diverging archives instead of repairing them;
the writer requires 1–65,535 entries per archive, so empty manifests are
rejected before any work starts.
Archive and per-entry integrity (lengths and SHA-256) is mandatory; there is no
optional-integrity mode here, unlike the files loader. SHA-256 requires a
secure context (HTTPS or localhost), mirroring file integrity.

Output is bounded while inflating, not after the fact: each entry's produced
bytes are counted against the per-entry and total-expanded limits as they come
out of the inflater, using fflate's streaming `Inflate` (the DEFLATE algorithm
itself is not reimplemented). These limits bound observable decoded output;
they are not a proof of total process memory. Independent limits cover archive
bytes, entry count, path length, a decode deadline and concurrent jobs.

Decoding runs in a worker the application deploys: bundle
`@mpgd/phaser-assets/archive-worker` as a module worker (the example re-exports
it as its own worker entry and references it with
`new Worker(new URL(...), { type: 'module' })`), then pass a factory to
`createBoundedZipDecoder`. Importing the client module never creates workers,
fetches or timers; environments that cannot create workers fail with a clear
`unsupported` error — there is no silent main-thread fallback for large
archives. The worker posts at most one decoded entry ahead: releasing the
credit accompanies each handover once the entry's digest verifies, so a slow
consumer never queues unbounded
bytes. Each delivered entry is copied into client-owned storage and re-verified
against the manifest digest before it reaches the consumer, so a custom worker
cannot swap bytes under a success status. By default the archive buffer is
cloned for transport (the caller's
buffer is never detached); opting into `transferArchive` requires an
exact-fit, non-shared buffer — views into larger buffers or shared memory
are rejected with `unsupported` — and freezes the
submission once into a client-owned snapshot, transfers that snapshot
without a second copy, and returns the exact submitted snapshot with the
final status, so caller mutations during submission cannot desynchronize
the verification digest. The
returned buffer is verified to be the exact bytes submitted — which may
legitimately differ from the manifest — so a completed job's `archiveBuffer` is
not a manifest verification. Jobs hash the archive on the client before
submission, and that time counts against the decode deadline;
size `decodeDeadlineMs` accordingly for large archives. The submission digest
also backs the completion boundary: a worker that skips the core's
archive-integrity check cannot complete an archive the manifest rejects.
Transport copies and
client-side verification hashes sit outside the decode output limits but
within the job's wall clock. The deadline is one absolute budget over the
job's execution: it starts when the job acquires a concurrency slot (queue
wait is not counted) and is spent by worker creation, the transport copy,
the client hash, the worker's decode, entry verification and the
returned-archive verification. The worker receives only the unspent
remainder of the budget, and the client keeps deadline authority — a
completion landing after the deadline stays a `deadline` result even when
it arrives inside the cleanup grace, and a submission preparation that
outlasts the budget ends the job before the archive is ever posted.
`cancelGraceMs` is the cooperative cleanup window after a cancellation or
deadline has been decided (the worker gets that long to finish and return
buffers); it never widens the deadline. Limits and the expected manifest
are snapshotted when `decode` is called, so mutating the request objects
afterwards cannot change an in-flight job's checks.

Jobs are cancellable: a cancelled job stops producing entries, its iterator
ends, and late worker messages cannot flip the decided outcome — a
completion, failure or echo arriving after a cancellation or deadline
settles as the decided cause rather than the late status. Cancelling again
shares the same cleanup window and
settlement. Worker
crashes, invalid messages and missed deadlines surface as distinct result
statuses (`worker-error`, `deadline`) after best-effort termination. Each job
uses one fresh worker; concurrency across jobs is capped by
`maxConcurrentDecodes`. Loader-based `files` delivery is unaffected: nothing
about the decoder or its worker is imported by `/packs` users.

See `examples/asset-packs` in the repository for two build layouts and executable
fault/lifetime tests, including a real module-worker decode scenario. Adding
this API does not make generated games depend on the
sample or require remote hosting.
