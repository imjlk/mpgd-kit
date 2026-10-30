---
npm/@mpgd/game-runtime: minor (Changed)
---

`runtime.actions` reports `busy` while any purchase holds the runtime's full-screen scope, one started outside the actions included (a game shop or a reconciler calling `runtime.gateway.commerce.requestPurchase`), with or without an ad provider, and turns `ready` again on that purchase's `closed` or `not-started` fact. An action started meanwhile rejects with `GameActionExecutionError` `busy` before the service call and keeps its key, which can run later.

**Behaviour change on a gateway without an ad provider:** such an action purchase used to resolve `failed` (the coordinated store's retryable `PRESENTATION_BUSY` refusal), and its key was spent: a retry replayed the failure and later rejected with `already-completed`. It now rejects with `busy` and keeps its key, as games with an ad provider already got.

The same answer covers the window between the action's reservation and its own store call: when the commerce coordinator itself refused that call before its provider ran (new `onRefusal` option of `createCoordinatedCommerceProvider`, `onPurchaseRefusal` of `createCoordinatedPlatformGateway`, fed to the new `purchaseRefusals` option of `createGameActionCoordinator`) and the service result is exactly that refusal, the action rejects with the matching code (`busy`, `history-full` or `disposed`), returns to `idle` and forgets the key. A store's own failure with the same codes still settles `failed`. The refusal answers and their matcher are exported from `@mpgd/game-runtime/commerce` as `coordinatorRefusalAnswers` and `matchCoordinatorRefusal`.

`getAvailability()` now checks `reconciliation-required` before `busy`, the order in which `execute` refuses a new key. New `subscribeAvailability(listener)` hears each availability change (no initial delivery, ends with `disposed`, watches its sources only while someone listens), and the new `actionBlock: 'always'` option keeps each action's own block while a `presentation` scope only gates; the runtime uses it without an ad provider, so those actions keep their block until the backend answers.
