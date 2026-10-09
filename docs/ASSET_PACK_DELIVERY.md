# Asset pack delivery builds

## Per-target packaged and remote placement

Targets can opt into `assetPacks` in `mpgd.targets.json`. Omission preserves
existing builds. Keep source assets outside Vite `public` and JavaScript imports;
the target builder owns the `mpgd-asset-packs/` namespace in the web bundle.

```json
{
  "assetPacks": {
    "buildConfig": "packs.config.json",
    "defaultLocation": "remote",
    "packs": { "ui": "packaged" },
    "offlineRequired": ["first-level"],
    "remoteBaseUrl": "https://cdn.example.com/game/release-1/",
    "maxPackagedBytes": 8388608
  }
}
```

`buildConfig` resolves relative to `mpgd.targets.json`. `offlineRequired` promotes
the complete dependency closure to packaged delivery. An explicit remote override
inside that closure fails validation. Unknown pack IDs and missing remote origins
also fail. URLs require HTTPS, a trailing slash and no credentials, query or
fragment; HTTP loopback origins are supported for development. These assets are
public data, never executable code. Store credentials belong in deployment tools.

Build just the deployment without building the game:

```sh
mpgd assets stage-target --target web-preview --out artifacts/assets/release-1 --json
```

The output directory must be fresh and disjoint from source output. Its
`packaged/` child contains local objects plus `asset-pack-delivery.json` and
`target-policy.json`; `remote/` contains only remote objects. The command verifies
source artifacts and copied bytes, reports SHA-256 and actual packaged/remote
bytes, and rejects symbolic links and packaged-byte overruns. The limit covers
the entire packaged asset namespace including metadata, rather than the game
JavaScript or decoded resources. ZIP transfer bytes remain distinct from expanded
entry bytes. No upload or network dependency is introduced by staging.

Normal target builds use the same policy on web, Capacitor, Apps in Toss and
Devvit. They stage local files before native sync or wrapper packaging,
check required files and metadata against their digests, and reject byte-identical
remote-only objects copied elsewhere in the artifact. Transformed or embedded
payloads are outside this file-inventory check: keep source assets out of imports.
Remote objects and the byte report are written separately under
`artifacts/asset-packs/<target>/`. Experimental mini-game runtimes retain their
existing package-local texture rules and reject this web-runtime opt-in.

The consumer fetches the manifest and policy from its packaged namespace once
at boot, then uses the provider-neutral URL resolver. Scene and level code keep
the same logical IDs and pinned revisions:

```ts
import { createAssetPackTargetURLResolver } from '@mpgd/target-config/asset-packs';
import { createPhaserPackDelivery } from '@mpgd/phaser-assets/delivery';

const base = new URL('./mpgd-asset-packs/', document.baseURI);
const manifest = await (await fetch(new URL('asset-pack-delivery.json', base))).json();
const policy = await (await fetch(new URL('target-policy.json', base))).json();
const delivery = createPhaserPackDelivery(manifest, {
  resolveURL: createAssetPackTargetURLResolver(policy, manifest.packs, base.href),
  // Supply the application's module Worker when any pack uses ZIP delivery.
  createWorker,
});
```

`resolveURL` receives paths already encoded once by delivery. The resolver
snapshots locations and revisions and rejects mismatched contexts and escaping
paths. `EffectiveTargetConfig.assetPacks` exposes the configured policy without
introducing any storage provider SDK. A packaged first-level closure needs no
download cache to enter offline; a remote-only uncached pack still fails clearly.

`mpgd assets build-packs` turns a game's logical pack composition into
deliverable artifacts — individual files or per-pack ZIP archives — from one
explicit build config. Logical composition and delivery format are separate
axes: choosing ZIP never requires a CDN, a remote origin or any particular
host; `files` and `zip` outputs can both be served locally or remotely.

```sh
mpgd assets build-packs --config packs.config.json --out dist/asset-packs
```

The command runs entirely from the published `@mpgd/cli` package; it does not
need a kit checkout or any `tools/` script. It never executes remote code,
never downloads anything implicitly and never modifies source files.

## Build config

```json
{
  "root": "assets",
  "packs": [
    {
      "id": "shared",
      "revision": "1",
      "delivery": "files",
      "assets": [
        {
          "kind": "spritesheet",
          "key": "pilot",
          "file": "shared/pilot.png",
          "frameConfig": { "frameWidth": 64, "frameHeight": 64 }
        }
      ]
    },
    {
      "id": "grove",
      "revision": "3",
      "dependsOn": ["shared"],
      "delivery": "zip",
      "assets": [
        {
          "kind": "atlas",
          "key": "ground",
          "texture": "grove/grove.png",
          "atlas": "grove/grove.json"
        }
      ]
    }
  ]
}
```

- `root` is the project root that every relative source path resolves against,
  relative to the config file itself. The output directory must be outside it.
- Pack ids match `[A-Za-z0-9][A-Za-z0-9._-]*` and revisions match
  `[A-Za-z0-9][A-Za-z0-9._+=-]*`; revisions are logical content labels, not
  artifact digests.
- Supported assets are `image`, `audio` (one encoded file), `spritesheet` (with a Phaser-compatible
  `frameConfig`) and single-texture JSON `atlas`. `packId`, `assetKey`,
  dependencies, frame configs and atlas references are preserved verbatim in
  the manifest.
- `delivery` selects `files` or `zip` per pack. Dependencies are resolved to
  their revisions but never copied into dependent packs; pack composition is
  exactly what the input declares, with no automatic regrouping and no
  folder-wide mega-archives.
- An optional per-asset `compression` (`store` or `deflate`) forces that
  asset's entry method; anything else is rejected.

## ZIP v1 scope

Archives use only STORE and DEFLATE. PNG/JPEG/WebP textures and audio default to STORE;
JSON/SVG default to DEFLATE, falling back to STORE when compression does not
shrink the entry. Explicit per-asset overrides force their method without the
fallback. Excluded: ZIP64, split archives, encryption, symlink entries,
directory entries, comments and executable packaging. This builder produces a
limited, documented format; it is not a general-purpose ZIP tool.

Entries require normalized relative paths: UTF-8 NFC, forward slashes, no
absolute or drive paths, no NUL, no `.`/`..` or empty components, no `:`
inside components. Paths that collide after normalization fail the build.
ZIP entry names and deployment URL encodings are handled by separate rules;
this format only governs archive-internal names.

## Determinism

Given identical inputs, options and Node/zlib build, repeated builds produce
byte-identical archives and manifest bytes:

- Entry order follows the configured asset order (texture before atlas
  within an asset); semantically ordered arrays are never re-sorted.
- Fixed metadata: DOS timestamp 1980-01-01 00:00:00, permissions 0644 regular
  file, UTF-8 name flag, `versionMadeBy` 0x0300, no extra fields or comments.
- Filesystem traversal order, absolute paths and current time never reach the
  output; the config's explicit file list is the only input.
- DEFLATE uses `zlib` `level: 9`. Compressed bytes can differ across zlib
  builds; pin the Node version when comparing archives across machines.

## Outputs and immutability

- `files` delivery writes each source under `packs/<id>@<revision>/<path>`.
- `zip` delivery writes `packs/<id>@<revision>.zip` containing exactly that
  pack's own files, entry paths equal to their source paths.
- `asset-pack-delivery.json` at the output root is the external, versioned
  manifest describing every artifact, file role, media type, original bytes
  and SHA-256, plus archive totals (bytes, digest, entry count). The manifest
  never travels inside an archive, so no artifact contains its own hash.
- Pack artifacts are immutable: a rebuild refuses to write different bytes at
  an existing artifact path — change the content or revision, or build into a
  new directory. The manifest is the replaceable summary of the latest
  successful build and is written only after every artifact is in place.
  Failed builds leave previous outputs untouched and never delete output.
- Digests are integrity information. They are not origin authentication, and
  the builder makes no such claim.
- HTTP wire bytes, ZIP archive bytes, uncompressed entry bytes and decoded
  pixel memory are distinct quantities; the manifest records the second
  aggregated per archive and the third per file, and nothing about pixels.

The report lists written/unchanged files with sizes and digests, per-archive
entry counts and methods, and source-versus-archive byte totals. It contains
only measured or computed facts — no performance or memory conclusions.

## Bounded decoding

`@mpgd/phaser-assets/archives` consumes this same manifest and ZIP v1 profile —
no second manifest or ZIP dialect. The pure core verifies the archive digest
and structure first, then yields entries one at a time, counting actually
inflated output against the configured limits (archive bytes, entry bytes,
total expanded bytes, entry count, path length, decode deadline). The worker
entry `@mpgd/phaser-assets/archive-worker` is deployed by the application
(never extracted from an asset archive), and the client enforces one
outstanding entry of backpressure, per-job cancellation with late-message
protection, and distinct failure statuses for worker crashes and deadlines.
See the package README for the exact contract and limitations.

### Public delivery integration

`@mpgd/phaser-assets/delivery` turns this manifest into the loader
catalog plus a prepared file source (staged ZIP packs via the real
module worker, plain HTTP for `files` packs, mixed manifests routed per
pack). The whole-prepare budget runs on one monotonic clock and hands
the decoder only the unspent remainder. `delivery.subscribe(listener)`
observes prepare and files-delivery read work with measured progress and
structured failure details; see the package README's "Observing delivery
work" section for the event contract and the error `details` fields.
`delivery.inspectPreparation(packId)` answers — read-only, before any
download — what a cold prepare of the closure costs and whether it fits
the staging budget; see "Inspecting preparation costs before loading".

### Pre-deployment verification

`mpgd assets verify-delivery --manifest <asset-pack-delivery.json> --root <dir>`
checks the built output read-only before deployment: manifest validation,
path safety (no absolute/traversal/symlink/non-regular artifacts), streaming
size and SHA-256 verification of every referenced file, full ZIP v1 interior
verification through the runtime decode core, and optional static-host object
limits (`--max-object-bytes`, `--max-files`, `--max-total-bytes`) evaluated
against the entire root inventory (old revisions included) rather than just
the referenced set. `--max-archive-bytes` caps how many bytes a single zip
archive may declare and occupy during verification (512 MiB by default),
and `--max-entry-bytes` (256 MiB) / `--max-expanded-bytes` (1 GiB) bound
decompression independently of the manifest's own declared sizes — a
self-consistent manifest cannot make verification allocate past them.
Larger declarations fail in the `limits` stage before being read or
decoded. Roots with
more than a million files fail the inventory check as truncated rather
than certifying limits that could not be fully walked.

`--json` is a machine-readable output contract: stdout is exactly one
JSON document — `JSON.parse(stdout)` works with no banner stripping —
on success and on verification failures alike, and any failure exits
non-zero while the document still carries the `failures` list with a
stage and stable code per problem. Two documented boundaries: framework
argument errors rejected before the command runs (for example a
non-numeric `--max-files` value or a missing required argument) print
their message to stderr and leave stdout blank, and `--help` /
`--version` take precedence over `--json`, printing their own text.
Human-readable text mode keeps its banner and per-stage lines.

The command reads inputs only — it never extracts archives, modifies
the manifest, or contacts a network. The `notVerified` field records
what only the real host can confirm (CDN caching, CORS/Content-Type,
device rendering).

### Browser acceptance

The private fixture in `examples/asset-packs` exercises the full product path
with real artifacts: `mpgd assets build-packs` output (files, all-ZIP and
mixed files+ZIP variants) served from an ordinary static origin, archives
downloaded once per pack, decoded by the real application-deployed module
worker, staged under an explicit byte budget, and supplied to the stock
`createPhaserAssetPackLoader` through a prepared file source. The suite
verifies display, theme switching with shared-pack reuse, cancellation
mid-download, shutdown during preparation, staging release with surviving
textures, re-preparation after release, HTTP 404 and corrupted archives,
oversize (rejected before any request) and exact staging budgets, and a
files-vs-ZIP entry comparison. It runs as part of
`pnpm --dir examples/asset-packs test:browser`.

## Format module

`@mpgd/phaser-assets/pack-format` exports the shared pure contract: build
config and delivery manifest types, untrusted-input validators, the entry path
rules and the media-type/method mapping. The module is free of Node, DOM,
Phaser and compression concerns, so producers and runtime consumers verify the
same shapes. Client-side ZIP loading, persistent caches and deployment upload
remain out of scope for this slice.
