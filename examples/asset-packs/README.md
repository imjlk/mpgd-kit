# Asset pack field study

A private image-only Phaser sample for [issue #173](https://github.com/imjlk/mpgd-kit/issues/173).
It reuses `@mpgd/phaser-assets` and explores preparation/ownership without adding
a public API or npm package. See the [design and acceptance matrix](../../docs/asset-packs-design.md).

From the repository root:

```sh
pnpm --dir examples/asset-packs dev
```

Choose Grove or Dunes, move with arrow keys, switch theme, and unload. Preparation
progress counts ready images. Shared explorer data stays resident across a
successful theme transition; unloading destroys users before releasing textures.

For a separate static origin, first generate the files, then keep the asset server
running in another terminal:

```sh
pnpm --dir examples/asset-packs build
pnpm --dir examples/asset-packs serve:assets
# In a second terminal:
pnpm --dir examples/asset-packs dev:hybrid
```

The default origin is `http://127.0.0.1:5196/`. Set `ASSET_PACK_REMOTE_ORIGIN` to an
HTTPS origin (or another loopback HTTP origin) before a build/dev run to change
delivery without changing gameplay. Copy `artifacts/origin/packs/` to that static
origin under the same path; configure CORS and SVG MIME types there. The local
server binds to loopback and is a development fixture, not a production server or
upload tool. Restart dev/build when changing source assets: catalog revisions are
pinned for each session.

Outputs:

- `dist/bundled`: game with all packs.
- `dist/hybrid`: game with shared assets only.
- `artifacts/origin`: separate, revision-addressed theme files, retained across builds.
- `asset-pack-report.json` in each game: included encoded asset bytes, per-pack
  metadata and a labeled RGBA estimate. This is not a wire-byte or process-memory measurement.

Validation:

```sh
pnpm --dir examples/asset-packs check
pnpm --dir examples/asset-packs test
pnpm --dir examples/asset-packs build
pnpm --dir examples/asset-packs test:browser
```

Browser tests use Chromium matched to this example's Playwright version
(`pnpm --dir examples/asset-packs exec playwright install chromium` when
needed). They build isolated fixtures under `artifacts/browser-build`, use an
ephemeral cross-origin server, and exercise both delivery modes, exclusion,
readiness, sharing, HTTP errors/retries, size/digest failures, cold offline entry,
cancel/replacement, unload and invalid level rollback. Screenshots and state evidence go to
`artifacts/browser`. No production origin or credentials are needed.

This is a first design slice. Persistent cache/quota behavior, audio/WebGL
preparation, prefetch scheduling, target integration and publication adapters are
documented follow-ups. There is no automatic game migration and no changeset is
needed: only private example, documentation and CI files change.
