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

Defaults: one retry for network errors/429/5xx, 15-second per-asset deadline,
32 MiB encoded bytes per file, 16 million decoded pixels per image. Options can
adjust these limits; cancellation and timeout also clean up a pending image decode.
Optional `integrity: { texture: { bytes, sha256 }, atlas: { bytes, sha256 } }` verifies
encoded content before decoding/parsing. SHA-256 verification requires HTTPS or
localhost. Known size or integrity failures are not retried. Requests omit
credentials and use `cache: 'no-store'`. A static host must provide CORS and MIME
headers. `resolveURL` does not affect ordinary `scene.load` URL settings.

There is no managed disk cache, offline download storage, prefetch scheduler or
upload service in this API. `snapshot()` reports owned textures and width × height
× 4 estimates, excluding engine overhead, GPU format, mipmaps and transient
buffers. Games own catalog rollout, bundle membership and memory budgets.

See `examples/asset-packs` in the repository for two build layouts and executable
fault/lifetime tests. Adding this API does not make generated games depend on the
sample or require remote hosting.
