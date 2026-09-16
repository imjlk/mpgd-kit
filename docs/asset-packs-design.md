# Asset packs: reusable texture loading

[Issue #173](https://github.com/imjlk/mpgd-kit/issues/173) remains open for the
production delivery/storage work listed below. The initial private study is now a
consumer of the opt-in `@mpgd/phaser-assets/packs` API, in the existing package.
See [API usage and lifecycle rules](../packages/phaser-assets/README.md).

## Ownership and boundaries

Games define logical pack IDs, revisions, dependencies, texture manifests and UX.
`createPhaserAssetPackLoader` snapshots that catalog and owns shared preparation
and resident textures. Consumers acquire a lease, obtain generated texture keys,
and destroy their display/animation users before releasing it. A failed transition
keeps an older lease alive. One caller's cancellation never evicts another owner's
resources. Scene shutdown closes the loader; a long-lived asset scene can own
resources used by several gameplay scenes.

The public API handles images, spritesheets and single-texture JSON atlases using
the existing manifest types. It does not change the existing enqueue helpers.
Its fetch/decode pipeline is independent of `scene.load`, allowing bounded deadlines
and cancellation without resetting unrelated application loads. Image decode and
texture/frame registration gate acquisition; shader warmup and arbitrary GPU
first-frame timing are not guaranteed.

No new package, object-storage SDK, credentials, deployment service or automatic
generated-game migration is introduced. A URL resolver separates gameplay keys
from location policy. Ordinary static HTTPS with CORS/MIME headers is sufficient.

File delivery is an explicit boundary of the public loader: each file is
requested as a logical `{ packId, revision, assetKey, role }` with an
`open` → `read` → `release`/`close` lifecycle, and the loader keeps integrity
verification, byte admission, decoding, registration and lease ownership for
every source. The default URL transport preserves existing behavior; archive or
on-device delivery is follow-up work that reuses the same preparation path
instead of adding per-file transport assumptions.

## Build and executable evidence

The private example uses a shared PNG spritesheet, a PNG/JSON atlas and a separate
PNG theme. The same game code runs in two layouts and in Canvas/WebGL:

| Layout | Game artifact | Static origin |
| --- | --- | --- |
| bundled | Shared + both themes | Not required |
| hybrid | Shared only | Optional themes, fetched when selected |

Source files stay outside Vite's public directory. Content-derived paths retain
immutable revisions on the separate local origin. Artifact checks independently
assert the intended inclusion policy, verify actual file sizes/digests, and reject
copied remote payloads in the game artifact. The runtime catalog receives explicit
packaged flags and per-file integrity metadata from the same build configuration.

The larger PNG fixtures exercise representative dimensions and common file formats;
they do not establish a production performance improvement. Encoded packaged asset
bytes, width × height × 4 estimates, transfer compression and measured memory are
different quantities. Reports include the first two only, excluding Phaser/app code
and transient buffers. Tests cover real frames, shared reuse, failure rollback,
bounded retries, cancellation, integrity, cold offline failure and last-owner release.
Unit tests cover cleanup exceptions, body/preparation deadlines, queue admission,
shutdown during download/decode and progress callbacks that throw. Browser checks
include physical texture cleanup at shutdown and pending-entry cancellation.

## Lifetime and admission bounds

The public helper isolates cleanup exceptions and exposes `takeCleanupErrors()`;
owner returns and physical engine cleanup success are separate. The sample's
shutdown handler cancels pending entry, invalidates late UI commits and destroys
consuming display objects before releasing the current lease. Cross-scene users
should share a dedicated long-lived asset scene and cancel/release only their
own acquisitions on consumer shutdown. Disposing that store ends all ownership.

Network attempts include a body deadline. Separate download/decode permits and
encoded-byte reservations bound preparation, including queue wait in the total
asset deadline. Native decode retains its reservation until it actually settles
even if its caller has already cancelled. Defaults are configurable starting
limits; there is no claim of measured production memory or frame-time bounds.
The sample uses 2 downloads, 1 decode and 8 MiB of encoded reservations. See the
package README for fallback reservations when integrity sizes are absent.

## Remaining work

| Concern | Current behavior | Follow-up evidence needed |
| --- | --- | --- |
| Archive delivery | `mpgd assets build-packs` emits deterministic files/ZIP artifacts; `@mpgd/phaser-assets/archives` decodes them boundedly in an app-deployed worker | Phaser texture creation and loader integration over the file-source boundary |
| Persistent storage | Resident leases; optional browser HTTP caching, no-store by default | Disk cache, quotas, eviction and offline cache hits |
| Asset readiness | Image decode + texture/frame registration; Canvas/WebGL fixture | Audio unlock, context-loss recovery, measured shader/upload budgets |
| Target configuration | Example build-time routing | Published per-target schema and installed/embedded target artifact tests |
| Scheduling | Separate download/decode permits, encoded reservations, body and preparation deadlines | Prefetch priorities and device-specific contention/latency measurements |
| Rollout | Catalog snapshot and optional SHA-256 | Catalog authenticity, retention and rollback policy on a real host |
| Publication | Ordinary HTTP fixture | Only the required upload/provider operations; protected delivery if justified |
| Size/performance benefit | Actual fixture artifact exclusion | A real consumer's package bytes, entry latency and memory pressure |

Public immutable assets do not require a service per game or pack. CORS, MIME,
cache headers and immutable revision retention belong to deployment. Keep supported
builds' revisions available. Promote additional API/storage features only with a
concrete consumer and acceptance cases; issue #173 is not completed by this slice.
