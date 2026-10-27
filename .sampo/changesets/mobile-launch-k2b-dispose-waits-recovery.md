---
npm/@mpgd/game-services: patch (Fixed)
---

`GameServicesRuntime.dispose()` now also waits for a startup or resume recovery pass under way (`monetizationRecovery.reconcile()`), within the same `gameServicesDisposeWaitMs` bound as an open purchase or rewarded ad, before it stops the commerce reconciler. Before, a pass still awaiting the journal could start the reconciler after `dispose()` had stopped it and leave a disposed runtime subscribed to the store. New optional `closed` input on `createCommerceReconciler` (and `commerceClosed` on `createGameServicesClient`): while it answers true, `start()` subscribes nothing and starts nothing. The runtime passes its closed-for-good state, so a pass that outlives the dispose wait subscribes nothing. A signed-out session is not closed, and a reconciler without the input keeps its `stop()` then `start()` behaviour.
