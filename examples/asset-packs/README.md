# Reusable asset packs example

The packed-consumer acceptance also runs the installed `assets stage-target`
command and the published target-policy URL resolver. A fresh target artifact
packages Grove and its shared dependency, excludes remote-only Dunes/audio bytes,
enters Grove with the separate remote origin blocked, and prepares Dunes from that
origin with unchanged pack IDs and scene acquisition code.

This private game consumes the public `@mpgd/phaser-assets/packs` API. It exercises
PNG images, a four-frame spritesheet and a 2048×1024 JSON atlas in WebGL and Canvas.
The loader implementation and unit tests live in the existing package; no new npm
package is introduced. See [the API guide](../../packages/phaser-assets/README.md)
and [design and scope](../../docs/asset-packs-design.md).

From the repository root:

```sh
pnpm build:packages
pnpm --dir examples/asset-packs dev
```

Choose Grove or Dunes, move with arrow keys, switch theme and unload. The default
renderer is WebGL; append `?renderer=canvas` for Canvas. Add `http-cache=1` to the
query to opt into normal HTTP caching; the default no-store mode keeps failure
experiments reproducible. Run through Vite, not by
opening `index.html` as a local file. A shared spritesheet stays resident across
successful transitions; old display users are destroyed before releasing textures.

For optional themes on a separate ordinary static origin:

```sh
pnpm --dir examples/asset-packs build
pnpm --dir examples/asset-packs serve:assets
# Another terminal:
pnpm --dir examples/asset-packs dev:hybrid
```

The default origin is `http://127.0.0.1:5196/`. Set `ASSET_PACK_REMOTE_ORIGIN` before
dev/build to change it (HTTPS or loopback HTTP, with an optional path prefix).
Copy `artifacts/origin/packs/` to that base path, and configure CORS plus PNG/JSON
MIME types. This server binds to loopback for development only. Restart dev/build
when changing source assets; the session catalog is pinned.

### ZIP delivery acceptance

The same sample also runs the complete ZIP path end to end: real
`mpgd assets build-packs` output (built by `pnpm --dir examples/asset-packs
build:delivery` into `artifacts/origin/delivery/`) downloaded over plain
HTTP, decoded and verified by the real application-deployed module worker
(#191), staged once per pack, supplied to the very same Phaser loader
through a prepared file source, then displayed, switched, cancelled and
released. Append `&delivery=zip` (all packs as archives) or
`&delivery=mixed` (shared pack as plain files, themes as archives) to the
sample URL. `&staging=<bytes>` shrinks the staging budget to exercise the
pre-network rejection. Preparation precedes `loader.acquire`; staging is
returned as soon as the loader has consumed the files, and registered
textures keep the level playable afterwards. Re-entering a level
re-prepares from the network. The browser suite covers the happy path in
WebGL and Canvas plus 404/corrupt archives, oversize and exact staging
budgets, mid-preparation cancel, overlapping A→B→A transitions, shutdown
during preparation, mixed files+ZIP manifests, and a files-vs-ZIP
comparison recorded into `artifacts/browser/evidence.json`.

`dist/bundled` includes all pack files; `dist/hybrid` includes only the shared pack.
Remote theme revisions live separately under `artifacts/origin`. Each build's
`asset-pack-report.json` records actual encoded asset bytes and labeled RGBA
estimates. The separate playable-consumer measurement command below records complete app
artifacts, entry latency and observed main-isolate heap. Encoded payload reports
and RGBA estimates remain distinct from those measurements.

```sh
pnpm --dir packages/phaser-assets test
pnpm --dir examples/asset-packs check
pnpm --dir examples/asset-packs build
pnpm --dir examples/asset-packs exec playwright install chromium
pnpm --dir examples/asset-packs test:browser
```

Browser tests build isolated fixtures under `artifacts/browser-build`, use an
ephemeral CORS origin, and cover both renderers/layouts, real atlas/spritesheet
frames, artifact exclusion, sharing, 404/500, integrity/size errors, offline misses,
cancellation, failed transitions and release. Screenshots/state are written under
`artifacts/browser` and uploaded by CI. The transport failure matrix runs once in WebGL/hybrid; normal transitions and
release run in all four combinations. Another case checks HTTP cache reuse after
release. Public API tests additionally cover timeouts,
non-cooperative decode cleanup, shutdown, graph validation and observer failures.

Persistent reuse, audio, prefetch, published target policy and immutable S3
publication are implemented. See [delivery commands](../../docs/ASSET_PACK_DELIVERY.md).
The example remains private; public runtime changes carry Sampo changesets.

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

## Optional audio and prefetch

Add `?audio=1` to include the deterministic half-second WAV chime in the level
dependency closure. Click **Play chime** after entry; preparation never starts
playback. `audio-backend=html5` exercises the HTML5 backend explicitly. Audio is
delivered through the same files/ZIP/mixed manifest and has shared cache ownership.

Add `prefetch=1` to warm both landscapes while the menu is idle, with a two-pack,
16 MiB known-payload retention limit. Selecting a landscape ends the idle window,
aborts unfinished background work and enters through foreground admission. It
never starts prefetch while the explorer is playing. Scene shutdown disposes the
scheduler before the loader and returns warm audio/texture ownership.

## Persistent artifact reuse example (`?idcache=1`)

The example supplies an IndexedDB implementation to the public
`persistentCache` option. The package reads and stores verified original
files-delivery files and ZIP archives at the real acquisition boundary; no
Blob URL warm bridge or prefetch phase is involved.
The acceptance can use a bounded separator-containing namespace through
`cache-namespace=<ascii-name>` (up to 64 characters); the default is
`asset-pack-experiment`.

- **Stored**: original artifact bytes only. Never expanded entries,
  images/textures, code, tokens or personal data.
- **Identity**: host- and path-independent `namespace | sha256 | expectedDigest |
  expectedBytes` records remain readable for compatibility; namespaces containing
  `|` use an unambiguous `v2:<encodedNamespace>:<expectedDigest>:<expectedBytes>`
  form. MIME/roles always come from the current manifest, never from a stored
  record.
- **Write path**: bounded fetch → existing loader/decoder verification → short
  readwrite transaction → atomic commit. Network/crypto never run inside a
  transaction. Aborts and quota failures keep previous good records and are
  reported honestly (`cache-store-failed`).
- **Read path**: every hit is re-verified against the current manifest
  (size + digest); corrupt or metadata-tampered records miss and are
  dropped. A cache hit is never "ZIP verified" or "texture ready" — the
  existing decoder and loader always run.
- **Observations**: `cache-hit`, `origin-download`, `cache-read-failed`,
  `cache-corrupt`,
  `cache-unverifiable`, `cache-delete-failed` and `cache-store-failed` are
  emitted without URLs. `artifacts/browser/evidence.json` records the
  baseline and persistent-reuse origin GET counts; a warm reload performs
  zero origin artifact GETs while the decoder and loader still verify and
  prepare the bytes.

The browser acceptance exercises cold/warm reload reuse, duplicate-store
idempotency, payload and metadata tampering, explicit deletion,
delete-vs-late-write races, quota and unavailable fault injection,
transaction-abort preservation, foreign-namespace isolation, and the
regular Phaser frame/transition/release regressions through the public
acquisition boundary — against real Chromium IndexedDB, never a fake.

## Reproducible playable-consumer measurements

```sh
pnpm build:packages
pnpm --dir examples/asset-packs exec playwright install chromium
pnpm --dir examples/asset-packs test:measure
```

The command builds bundled/hybrid app artifacts, checks their physical payload
inclusion, and runs six Canvas scenarios in fresh Chromium contexts: bundled
files, remote files, remote files with prefetch, mixed ZIP, mixed ZIP with prefetch,
and mixed ZIP with IndexedDB reuse. Each run enters Grove → Dunes → Grove,
verifies explorer movement, confirms no required downloads during gameplay, and
checks texture/audio/staging ownership after shutdown. Prefetch scenarios wait
for both packs to warm and assert zero response-body bytes at first entry.

Defaults are three repetitions and a modeled 40 ms delay per remote response;
`ASSET_PACK_MEASURE_REPEATS=1..20` and
`ASSET_PACK_MEASURE_REMOTE_DELAY_MS=0..500` select other bounded runs. Outputs
are `artifacts/measurements/report.json` and screenshots. The report includes
whole app file bytes/digests, completed HTTP response-body bytes, selection-to-
display-object handover time, observed main V8 heap samples and post-GC checkpoints.
It separately reports known RGBA/PCM/Blob payload and persistent artifact bytes.
It does not measure physical wire overhead, exact peak, GPU, worker heap or total
process/native decoder memory. Canvas results do not establish a WebGL/device
performance budget. See [recorded evidence](../../docs/ASSET_PACK_MEASUREMENTS.md).
