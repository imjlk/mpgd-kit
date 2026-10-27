---
npm/@mpgd/game-services: patch (Fixed)
---

`GameServicesRuntime.dispose()` now also waits for a startup or resume recovery pass under way (`monetizationRecovery.reconcile()`), within the same `gameServicesDisposeWaitMs` bound as an open purchase or rewarded ad, before it stops the commerce reconciler. Before, a pass still awaiting the journal could start the reconciler after `dispose()` had stopped it and leave a disposed runtime subscribed to the store. The runtime's reconciler instance itself now refuses `start()` once the runtime closed for good, so a pass that outlives the wait subscribes nothing. A reconciler created outside a runtime keeps its `stop()` then `start()` behaviour.
