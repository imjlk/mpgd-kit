---
npm/@mpgd/bridge: patch (Changed)
---

oRPC moves from 2.0.0-beta.46 to exactly `2.0.0-beta.52` (`@orpc/client`, `@orpc/contract`, and `@orpc/server`). The bridge RPC wire format is unchanged (requests, success bodies, and error bodies are the same bytes as on beta.46), and a bridge client and its server still ship in the same app build. `createBridgeRpcFetchHandler` and `createBridgeRpcNodeHandler` answer 400 `BAD_REQUEST` to a body that is not a `{ json, meta }` object and ignore `meta` entries of an unknown type; `createBridgeOrpcClient` rejects a success body with any other top-level key as a `MalformedResponseError` and follows HTTP redirects.
