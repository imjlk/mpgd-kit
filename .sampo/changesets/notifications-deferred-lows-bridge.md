---
npm/@mpgd/bridge: minor (Added)
---

The shared notifications bridge handlers (`createNotificationsV2BridgeHandler`, `createNotificationsBackendBridgeHandler`) read a thrown value defensively. A thrown `Proxy` whose `getPrototypeOf` trap throws no longer rejects the request when `onError` is set: a class check that throws counts as no match. Each field of a thrown value is read once, and a field whose read throws counts as missing, so a readable notifications code and retryable flag still cross when the message getter throws, instead of falling back to a retryable `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`. A value whose `toString` throws crosses as `<method> failed: a failure that cannot be read`. An `unexpectedFailureMessage` callback that throws, or answers a value that is not a string, is reported through `onError`, and the failure crosses as `<method> failed.` with its code and retryable flag.

The main entry exports the helpers it reads them with, so adapters share one implementation: `readThrownField(value, key)` (a field, or `undefined` when the read throws), `isThrownInstance(value, Class)` (`false` when the check throws), and `thrownMessage(value)` (the `message`, else the text, else `a failure that cannot be read`). None of them throws.
