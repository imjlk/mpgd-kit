# Asset packs: first design and executable study

Status: **private exploration**, related to [issue #173](https://github.com/imjlk/mpgd-kit/issues/173).
This document and `examples/asset-packs` are the first slice. They do not close the
issue, establish a public API, add an npm package, or migrate generated games.

## Question and proposed boundaries

Can a game use the same level code with all assets bundled, or with shared assets
bundled and optional themes on an ordinary static origin, while making preparation
and resident ownership explicit?

Keep three responsibilities separate:

| Layer | Responsibility | First-slice location |
| --- | --- | --- |
| Description and planning | Stable logical IDs, dependencies, pinned revisions, digest, encoded bytes and image dimensions | Private `packs.ts` and build catalog |
| Preparation and ownership | Await required resources; per-caller cancellation; share active work; issue a releasable lease | Private `leases.ts` |
| Browser/engine adaptation | Resolve delivery URLs, bound and verify responses, decode, prepare Canvas images, release Phaser textures | Private fetch and Phaser adapters |

The game chooses pack membership, level/theme associations and loading UX. It
receives prepared texture keys and destroys its image users before releasing a
lease. It does not choose an object-store provider or call a storage SDK.

`@mpgd/phaser-assets` remains the typed manifest/enqueue foundation. The sample
uses its existing `definePhaserAssetManifest` and `loadPhaserAssets` functions;
their public signatures and behavior are unchanged. Do not promote the private
sample contracts to exports until the remaining target and lifecycle questions
have concrete acceptance evidence. Package ownership remains open.

## What the sample demonstrates

The catalog contains a shared explorer image and two independent ground themes.
Both themes depend on the shared pack. Build-time policy selects one of two layouts:

| Mode | Game artifact | Separate static origin |
| --- | --- | --- |
| `bundled` | Shared + both themes | None required |
| `hybrid` | Shared only | Both themes; requested only when selected |

The same gameplay source runs in both. The Vite configuration supplies location
policy; it is an example-specific configuration, not an addition to public
`target-config`. HTTP is permitted for the loopback fixture; configured remote
origins require HTTPS. Public asset requests omit credentials. An origin is a base
URL, including an optional path prefix, with no signed query or embedded password.

Files live outside Vite's public directory. The sample build emits selected files
into the game artifact and writes remote files into a separate, append-only local
origin fixture. Revisions are content-derived. Existing revision files with
different bytes are rejected. The browser retains a private catalog snapshot for
the session; changing build configuration does not rewrite a running session's
resource identities.

## Preparation and lifetime semantics

1. Resolve the complete dependency closure; reject unknown IDs and cycles.
2. Claim each revision-qualified image identity for this caller. Concurrent claims
   share in-flight preparation and ready resident images.
3. Fetch with an exact encoded-byte bound. Reject truncated or oversized responses
   and verify SHA-256 against the pinned catalog before engine decoding.
4. Retry network failures, 429 and 5xx once after a short delay. Other HTTP errors,
   size/digest failures and decode failures are terminal for that attempt. Retry
   is an explicit new level-entry request after the error is shown.
5. Reuse the existing Phaser loader, await its complete cycle and image decode,
   validate dimensions, and perform a scratch Canvas draw. Only then count an
   image as prepared. This image-only sample uses the Canvas renderer; it does not
   claim WebGL upload, shader, audio-unlock or atlas readiness.
6. Enter the new level only when every required image is prepared. Keep the old
   level and its lease while preparing a replacement. Failure preserves those
   resources and presents retry/selection/unload controls; gameplay is paused in
   the error state until the user chooses a recovery action.
7. Destroy old display objects before releasing the old lease. Shared images stay
   resident while any owner remains. Releasing the last owner removes the image.

Cancellation releases only that caller's claims, synchronously. Losing the last
owner aborts fetches. Browser image decoding is not assumed to be interruptible:
late results are disposed, and unique engine-generation keys prevent cancelled
work from deleting a replacement texture. Cancelled/superseded requests cannot
commit a level. Release is idempotent.

Progress is **prepared image count**, including decode/draw readiness, not HTTP
download percentage. The sample performs no background prefetch. A production
prefetch scheduler must account for bandwidth and decode/renderer work during
active gameplay before that feature is added.

## Cache and measurement limits

This slice caches resident images only while leases own them. It deliberately uses
`fetch` with `cache: 'no-store'`; browser HTTP caching is not presented as managed
offline storage. A cold offline request fails visibly. An already owned shared
image remains usable independently of network state. New cancellation/failure
does not evict images owned by an existing level.

The build report distinguishes **encoded asset file bytes included in the game**
from per-pack source bytes and a **width × height × 4 RGBA estimate**. The latter
is not measured process, decoded-image, or GPU memory and excludes duplication,
mipmaps, engine overhead and transient preparation buffers. Compressed transfer
bytes and total application size, including Phaser/JavaScript, must be measured
separately. This tiny fixture proves routing/exclusion and lifecycle behavior; it
does not establish a production size or startup-performance benefit.

Artifact checks enumerate actual packaged files, verify bytes/digests, check the
reported packaged-byte sum and reject copied remote-only payloads in the game
artifact. They validate this sample pipeline, not every target's bundler or an
arbitrary user-authored inlining transformation.

## Acceptance evidence and remaining work

| Issue concern | First slice | Before a production API |
| --- | --- | --- |
| Existing local use | Existing package unchanged; bundled sample requires no origin | Run compatibility cases for each supported asset kind/target |
| Shared + two themes, origin-independent gameplay | Both builds and real cross-origin browser test | Integrate explicit per-target configuration after API design |
| Concurrent work, cancellation, retry, partial failure | Ownership unit tests and browser failure/recovery cases | Scheduling limits, timeouts, more providers and asset types |
| Stale/corrupt content | Revision-qualified identities, pinned catalog, size/digest rejection | Catalog authentication/update policy and rollout retention |
| Offline/cache eviction | Cold offline error; active resident sharing and last-owner eviction | Persistent content-addressed storage, quotas, unavailable storage, disk eviction and offline cache hits |
| Readiness and entry | Image decode + Canvas draw gates logical level entry | WebGL upload, audio, atlases and target-specific preparation |
| Resident lifetime | Real texture counts across switches, cancellation and unload | Measure memory pressure and in-use resource behavior on devices |
| Build visibility | Real bundled/hybrid asset inclusion and byte report | Target artifact inspection, compression and measured memory/startup budgets |
| Publication/delivery | Static HTTP fixture only; no client credentials/SDK | Upload only when justified; test exactly the required provider operations |

A later publication design may use an existing static host or a tested subset of
an S3-compatible API behind a CDN. It does not need a service per game, map or
pack. CORS, MIME types, cache headers, immutable revision retention and rollback
are deployment responsibilities. Do not delete revisions referenced by supported
builds. No production upload adapter or protected delivery is implemented here.

Prioritize follow-ups using measurements from a real consumer: submitted asset
bytes, first-entry latency, transition latency, retained images/audio and memory
pressure. Persistent caching, production target integration and a public API need
separate decisions and tests. Issue #173 should remain open.
