---
npm/@mpgd/phaser-assets: minor
---

Separate pack file delivery from texture preparation. `createPhaserAssetPackLoader`
now accepts an optional `fileSource` implementing the public `PhaserPackFileSource`
contract: per-file `open` → `read` → body `release`/`close` lifecycles keyed on
`{ packId, revision, assetKey, role }`, with cancellation and shared transfer/byte
budgets through the file context. Integrity verification (declared size equality
and SHA-256), the `maxFileBytes` cap, byte admission, decoding, texture
registration and lease ownership remain loader responsibilities for every source.
The default URL transport keeps `resolveURL`, `requestCache`, deadlines, retries
and streaming caps unchanged; omitting `fileSource` preserves the existing API
and behavior.
