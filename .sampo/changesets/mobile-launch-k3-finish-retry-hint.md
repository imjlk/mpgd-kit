---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/adapter-capacitor: minor (Added)
---

`FinishTransactionInput` (and the `commerce.v2.finishTransaction` bridge payload) takes an optional `retry`: the caller already asked to finish this purchase, in an earlier attempt or session. A store may then read a consumable missing from its unfinished list as the lost acknowledgement of that earlier finish; a first finish never carries it. `createStoreCommerceProvider` forwards it to `StoreSdk.finishTransaction`. A bridge host on an earlier `@mpgd/platform` rejects the unknown field, so update the host and the webview together.
