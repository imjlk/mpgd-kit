---
npm/@mpgd/bridge: minor (Changed)
---

oRPC moves from 2.0.0-beta.14 to exactly `2.0.0-beta.46` (`@orpc/client`, `@orpc/contract`, and `@orpc/server`, all pinned with no range). Three wire changes come with it:

- **oRPC error bodies drop the `inferable` field** (oRPC 2.0.0-beta.34). A bridge client and server on different oRPC versions see each other's errors as malformed responses. The bridge client and server ship in the same Devvit app build, so the bridge carries no compatibility shim: keep `@mpgd/adapter-devvit` and the Devvit server on the same kit release. Bridge method errors and request-validation failures travel inside the bridge response envelope and are unaffected; only internal server errors (500) and oRPC transport errors (413, 400 for an undecodable body) use the oRPC error body.
- **RPC routes accept only POST, PUT, PATCH, and DELETE.** A GET now gets the unmatched result: 404 from `createBridgeRpcFetchHandler`, `false` from `createBridgeRpcNodeHandler`. The bridge client always POSTs.
- **`Infinity` gets its own meta marker** in the encoding.

`createBridgeRpcNodeHandler`'s `maxBodySize` is now enforced by oRPC's `RequestLimitHandlerPlugin`, and oversized bodies still answer 413 `PAYLOAD_TOO_LARGE`. `BridgeRpcEndpoint` is now spelled out as the same URL-path template type that oRPC 2.0.0-beta.46 stopped exporting as `StandardUrl`.

This is a minor release because the error body and GET behaviour change on the wire.
