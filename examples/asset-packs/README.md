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
renderer is WebGL; append `?renderer=canvas` for Canvas. Run through Vite, not by
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
`artifacts/browser` and uploaded by CI. Public API tests additionally cover timeouts,
non-cooperative decode cleanup, shutdown, graph validation and observer failures.

Persistent/offline caching, audio, prefetch scheduling, target-config integration
and publication adapters remain follow-ups in issue #173. This PR has a changeset
for the existing public package; the example itself remains private.
