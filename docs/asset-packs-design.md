# Asset packs: preparation, delivery and ownership

[Issue #173](https://github.com/imjlk/mpgd-kit/issues/173) is implemented through
opt-in entrypoints in the existing `@mpgd/phaser-assets` package, the published
`@mpgd/target-config/asset-packs` policy and the `mpgd assets` CLI commands.
The private playable explorer exercises these boundaries without changing the
starter's default bundle or requiring a separate service per game or pack.
See [runtime APIs](../packages/phaser-assets/README.md),
[build/deployment contracts](ASSET_PACK_DELIVERY.md), and
[consumer measurements](ASSET_PACK_MEASUREMENTS.md).

## Ownership and preparation

Games define logical pack IDs, immutable revisions, dependencies and UX.
`createPhaserAssetPackLoader` owns shared preparation and resident resources.
Acquire a lease, use its generated texture/audio keys, destroy consuming display
and sound objects, then release it. A failed transition keeps the previous level
alive. One caller's cancellation never evicts another owner's resources. A
long-lived asset scene can share ownership across gameplay scenes; disposing its
loader ends that ownership.

PNG images, spritesheets, single-texture JSON atlases and single-format audio
use the verified file-source path. Acquisition waits for image decode and frame
registration or audio readiness. Web Audio preparation decodes in the game's
context; HTML5 preparation waits for readiness and retains its Blob URL until
last-owner cleanup. Neither unlocks audio nor starts playback. Playback remains an
explicit game/user gesture. Shader warmup, context-loss recovery and arbitrary GPU
first-frame timing are outside this readiness contract.

Files follow `open → read → release/close`; URL, ZIP and cache-backed sources feed
the same preparation and ownership code. The module worker verifies bounded ZIP
archives/entries and stages original file bytes. `acquireDeliveredPack` returns
staging after the loader consumes them; decoded textures/audio remain playable.
The application deploys the worker. Pure packages do not import Phaser, browser
storage or platform SDKs.

## Scheduling, storage and delivery policy

Separate download/decode permits, encoded reservations, body deadlines and whole
preparation deadlines bound admission. Uncancellable native decode retains its
permit/input until settlement; caller cancellation is prompt but cannot terminate
the browser decoder. Cleanup errors are isolated and drainable. An empty ownership
snapshot does not prove physical engine deletion when engine cleanup threw.

The optional prefetch scheduler runs only in an explicitly enabled idle window.
Priorities and FIFO ties, bounded queued work, serial foreground admission and
bounded warm leases are public contracts. Warm handover takes independent
consumer ownership directly from the resident loader, avoiding repeated ZIP
preparation. Known retained payload counts shared RGBA estimates, accepted PCM
samples and HTML5 Blob bytes once; this is separate from total process memory.

The persistent-cache port reads/writes verified original files or ZIP archives.
Every hit is reverified and still decoded/prepared. Applications own quota,
eviction and namespaces. The private IndexedDB consumer validates warm offline
reuse, corruption, quota/unavailable failures and transaction/deletion races.

Per-target policy chooses packaged/remote packs, promotes offline dependency
closures, pins URL resolution and rejects contradictory configuration. Staging
verifies actual artifacts. Target builds audit the final web/wrapper output and
native APK/AAB/IPA or expanded iOS resources, including the packaged namespace and
absence of byte-identical remote payloads. Source assets stay outside Vite public
and imports. Transformed/embedded representations need producer-specific audits.

Optional `publish-s3` uses the official AWS SDK only in the deployment CLI. It
validates staged bytes, issues bounded HEAD/conditional PUT operations, reuses
matching immutable objects and writes a content-addressed manifest last. Named
environment credentials and sanitized diagnostics stay outside catalogs and game
code. This tool does not provision storage or CDN settings.

## Executable evidence and scope

| Concern | Implemented acceptance |
| --- | --- |
| Files/ZIP/mixed | Built artifacts → real module worker → verified loader → playable frames and release |
| Audio | Web Audio/HTML5 × files/ZIP/mixed, explicit playback, shared final-owner cleanup |
| Persistent reuse | Real Chromium IndexedDB, verified warm reuse and failure/race matrix |
| Prefetch | Idle/priority/ownership unit regressions and zero-body-download warm game entry |
| Target policy | Installed tarball consumer, offline dependency closure, separate-origin entry and actual native resource audits |
| Publication | Actual SDK HTTP/signature/checksum fixture: immutable reuse, conflicts, retry/deadline/cancel and secret isolation |
| Size/latency/memory | Reproducible playable explorer, complete app file inventory, entry timing, main V8 heap samples and separately labeled payload estimates |

The measurement report records the device/browser, samples, prefetch lead time,
artifact digests and metric limits. It measures this playable consumer; production
game/device/network budgets require their own runs. GPU/process memory, shader
warmup, context-loss recovery, catalog authenticity, protected delivery, real-host
retention/rollback and live S3-provider certification are outside this completed
slice. CORS, MIME, immutable cache headers and retaining revisions referenced by
supported builds remain deployment responsibilities.
