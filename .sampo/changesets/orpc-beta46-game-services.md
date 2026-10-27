---
npm/@mpgd/game-services: patch (Changed)
---

oRPC moves from 2.0.0-beta.14 to exactly `2.0.0-beta.46` (`@orpc/client`, `@orpc/contract`, and `@orpc/server`, all pinned with no range). Use the same exact version for any oRPC a game or Worker uses directly. oRPC 2.0.0-beta.34 removed the `inferable` flag from RPC error bodies, and each oRPC version rejects the other's error shape. The oRPC transport now bridges both directions so that games and Workers from different releases keep their error codes (`BAD_REQUEST`, `NOT_FOUND`, and the commerce reconciler's "unpublished" detection):

- `createGameServicesRpcFetchHandler` adds `inferable: false` to error bodies.
- `createGameServicesOrpcClient` removes a boolean `inferable` from error bodies before oRPC validates them.

Success responses are unchanged. This shim lives in one module and will be removed once the oldest supported client and Worker both come from this release or later.

Two other behaviour changes come with the new oRPC:

- RPC routes now accept only POST, PUT, PATCH, and DELETE. A GET, including a cross-site GET, now answers 404 instead of running the procedure. The kit's clients always POST.
- An `Infinity` input is now encoded with its own meta marker, which a 0.30.5-or-older Worker cannot decode.

The request body limit is now applied through oRPC's `RequestLimitHandlerPlugin`. Oversized bodies still answer 413 `PAYLOAD_TOO_LARGE`.
