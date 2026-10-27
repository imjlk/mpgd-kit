---
npm/@mpgd/game-services: minor (Added)
---

`createGameServicesRuntime` and `createGameServicesClient` take `commerceStaleLaunchedAfterMs`, passed to the commerce reconciler as `staleLaunchedAfterMs`. It sets how long a `launched` purchase with no store purchase keeps its product serialized before it ends `failed`. The default stays 24 hours, and `Infinity` never expires the attempt. A value that is not a positive number (zero, negative, `NaN`) is refused with a `RangeError` where it enters, also when no reconciler is built.
