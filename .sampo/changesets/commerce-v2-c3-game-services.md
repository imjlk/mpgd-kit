---
npm/@mpgd/game-services: minor
---

Commerce v2, PR C3: `createGameServicesRuntime({ commerceProducts })` passes
the catalog kinds and store SKUs (`CommerceReconcilerProduct`) to the
commerce v2 reconciler of both the plain and the recoverable client, so a
store purchase resolves its catalog kind without a store read. Generated
games derive the list from the product catalog's `platformProductIds` for
the build's target.
