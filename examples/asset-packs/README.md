# Reusable asset packs example

This private game consumes the public `@mpgd/phaser-assets/packs` API. It exercises
PNG images, a four-frame spritesheet and a 2048×1024 JSON atlas in WebGL and Canvas.
The loader implementation and unit tests live in the existing package; no new npm
package is introduced. See [the API guide](../../packages/phaser-assets/README.md)
and [design/remaining work](../../docs/asset-packs-design.md).

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
\`mpgd assets build-packs\` output (built by \`pnpm --dir examples/asset-packs
build:delivery\` into \`artifacts/origin/delivery/\`) downloaded over plain
HTTP, decoded and verified by the real application-deployed module worker
(#191), staged once per pack, supplied to the very same Phaser loader
through a prepared file source, then displayed, switched, cancelled and
released. Append \`&delivery=zip\` (all packs as archives) or
\`&delivery=mixed\` (shared pack as plain files, themes as archives) to the
sample URL. \`&staging=<bytes>\` shrinks the staging budget to exercise the
pre-network rejection. Preparation precedes \`loader.acquire\`; staging is
returned as soon as the loader has consumed the files, and registered
textures keep the level playable afterwards. Re-entering a level
re-prepares from the network. The browser suite covers the happy path in
WebGL and Canvas plus 404/corrupt archives, oversize and exact staging
budgets, mid-preparation cancel, overlapping A→B→A transitions, shutdown
during preparation, mixed files+ZIP manifests, and a files-vs-ZIP
comparison recorded into \`artifacts/browser/evidence.json\`.

`dist/bundled` includes all pack files; `dist/hybrid` includes only the shared pack.
Remote theme revisions live separately under `artifacts/origin`. Each build's
`asset-pack-report.json` records actual encoded asset bytes and labeled RGBA
estimates. These fixture measurements are not total app size, compressed traffic,
measured GPU/process memory or a real-game performance benchmark.

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

Persistent/offline caching, audio, prefetch scheduling, target-config integration
and publication adapters remain follow-ups in issue #173. This PR has a changeset
for the existing public package; the example itself remains private.

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

## Persistent artifact reuse experiment (`?idcache=1`)

A private, example-only experiment (not a public cache API): verified
artifact bytes — files-delivery files and ZIP archives — are persisted in
a dedicated IndexedDB namespace and re-served to the **unchanged public
delivery** through managed Blob URLs.

- **Stored**: original artifact bytes only. Never expanded entries,
  images/textures, code, tokens or personal data.
- **Identity**: `namespace | sha256 | expectedDigest | expectedBytes` —
  host- and path-independent, so the same content from another origin
  resolves to the same record. MIME/roles always come from the current
  manifest, never from a stored record.
- **Write path**: bounded fetch → manifest verification → short
  readwrite transaction → atomic commit; `stored` requires the
  transaction's complete event. Network/crypto never run inside a
  transaction. Aborts and quota failures keep previous good records and
  are reported honestly (`origin-store-failed`), never as stored.
- **Read path**: every hit is re-verified against the current manifest
  (size + digest); corrupt or metadata-tampered records miss and are
  dropped. A cache hit is never "ZIP verified" or "texture ready" — the
  existing decoder and loader always run.
- **Outcomes per artifact**: `cache-hit`, `origin-stored`,
  `origin-store-failed`, `origin-store-skipped` (caps: 32 MiB/object,
  96 MiB total), `cache-unavailable` (bounded DB open/read/write
  deadlines), `origin-fetch-failed` (the delivery's own origin fetch
  then owns the outcome).
- **Bridge**: the async warm phase finishes all IndexedDB work before
  `prepare`; the delivery's `resolveURL` performs only synchronous
  Blob URL lookups and falls back to the origin URL. Blob URLs are
  revoked on unload/shutdown/next selection. This bridge is
  experiment-only — the follow-up cache PR wires the verified store at
  the real acquisition boundary instead.
- **Measurements** land in `artifacts/browser/evidence.json`
  (`baselineHttpOnly`, `persistentReuse`): origin artifact GET counts,
  fetch/write/cache-read/verify/Blob timings per artifact. On this
  machine: baseline reload = 2 origin GETs; cold = 2 GETs + stores;
  warm reload = 0 GETs with single-digit-ms cache reads.

The browser acceptance exercises cold/warm reload reuse, duplicate-store
idempotency, payload and metadata tampering, explicit deletion,
delete-vs-late-write races, quota and unavailable fault injection,
transaction-abort preservation, foreign-namespace isolation, and the
regular Phaser frame/transition/release regressions under the bridge —
against real Chromium IndexedDB, never a fake.
