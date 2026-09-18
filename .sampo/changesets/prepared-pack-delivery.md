---
npm/@mpgd/phaser-assets: minor
---

Add prepared pack delivery. The new `@mpgd/phaser-assets/delivery`
subpath turns a CLI-built delivery manifest into the existing pack
loader's catalog and file source: zip packs are staged per dependency
closure under an explicit archive+expanded byte budget (checked before
any request), decoded and verified by the application-deployed module
worker with a whole-prepare deadline that stages never restart, and
admitted only on a fully completed decode; `files` packs keep plain
HTTP through the same source and mixed manifests route each file by its
pack's delivery kind. Artifact paths URL-encode each segment exactly
once against a `baseUrl` or custom resolver. `prepared.release()`
returns staging while textures stay alive under the loader lease and
open readers keep their bytes; failures throw
`PhaserPackDeliveryError` with stable codes (config, not-prepared,
busy, budget, transport, integrity, cancelled, deadline, disposed) and
preserve decoder statuses in the message. No new codec, persistent
cache or prefetch; the module imports without network, worker or timer
side effects.
