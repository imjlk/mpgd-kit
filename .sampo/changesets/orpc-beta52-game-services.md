---
npm/@mpgd/game-services: patch (Changed)
---

oRPC moves from 2.0.0-beta.46 to exactly `2.0.0-beta.52` (`@orpc/client`, `@orpc/contract`, and `@orpc/server`). Pin the same exact version for any oRPC a game or Worker uses directly. The RPC wire format is unchanged: requests, success bodies, and error bodies (with the legacy `inferable` flag) are the same bytes as on beta.46, so clients and Workers from 0.31.0 or later, and from 0.30.5 or older through the existing error-body shim, still work together in both directions. Picked up with it: `createGameServicesRpcFetchHandler` answers 400 `BAD_REQUEST` to an RPC body that is not a `{ json, meta }` object and ignores `meta` entries of an unknown type; `createGameServicesOrpcClient` rejects a success body with any other top-level key as a `MalformedResponseError`, ignores unknown `meta` types, and follows HTTP redirects (a redirect used to fail the call in a browser and resolve it with `undefined` under Node).
