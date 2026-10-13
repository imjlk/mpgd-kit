---
npm/@mpgd/bridge: minor
---

Notifications v2, PR N3: the bridge methods, the event union, and the
fail-closed answer.

- `BridgeMethod` gains the nine `notifications.v2.*` methods
  (`getCapabilities`, `getPermission`, `requestPermission`,
  `revokePermission`, `register`, `scheduleLocal`, `cancelLocal`, `listLocal`,
  and `openSettings`), exported as `bridgeNotificationsV2Methods` and kept
  equal to `notificationBridgeMethods` from `@mpgd/platform/notifications`.
  `isBridgeNotificationsV2Method` tells them apart.
- The new `@mpgd/bridge/notifications` entry exports
  `assertBridgeNotificationsV2Payload(method, payload)` and
  `assertBridgeNotificationsV2Result(method, data)`, which validate a
  method's payload and answer with the `@mpgd/platform/notifications`
  validators, so unknown keys, timestamps without an offset, and routes that
  are not root-relative are rejected. It also exports the types that name the
  methods and shapes, `BridgeNotificationsV2Method`,
  `BridgeNotificationsV2Payload`, and `BridgeNotificationsV2Result`, which the
  main entry exports too. The main entry loads no notifications code, so
  bundles that only use the bridge do not grow.
- `createNotificationsV2UnavailableBridgeError` answers a notifications v2
  request with `NOTIFICATIONS_V2_UNAVAILABLE`
  (`notificationsV2UnavailableBridgeErrorCode`), which is not retryable. The
  Cloudflare Pages host answers every notifications v2 method with it.
- `BridgeEvent` is now a union discriminated by `protocol`: the commerce v2
  envelope (`BridgeCommerceEvent`) and
  `{ protocol: 'mpgd.notifications.v2', sequence, event }`
  (`BridgeNotificationsEvent`). Code that read `event.event` as a commerce
  event now narrows on `event.protocol` first, or types a commerce-only
  channel with `BridgeCommerceEvent`. `bridgeCommerceEventProtocol` and
  `bridgeNotificationsEventProtocol` name the protocols; `bridgeEventProtocol`
  stays the commerce protocol and is deprecated.
- `assertBridgeEvent` follows the union: it returns `BridgeEvent` rather than
  the commerce envelope and accepts notifications envelopes. Because it
  validates the union, a rejected input can report a different `path` and
  `expected` than before; a caller that wants the commerce envelope and its
  errors validates with `assertCommerceEventEnvelope` from
  `@mpgd/platform/commerce`. An `endpoint-changed` registration must name a
  `timeZone` that `Intl` knows, as a `register` answer must. It builds its
  validator on the first call, so a bundle that never validates a bridge
  event leaves the validator out.
- `createBridgeEventSource(protocol, stream)` is the host side of one
  protocol's events for one bridge session. It subscribes to the stream for
  the first listener, so events a provider buffered reach that listener, and
  numbers the events from 0 for the session. An event emitted during a
  delivery is delivered after it. A listener that throws, or returns a
  promise that rejects, is reported with `console.warn` and does not stop the
  others. The last listener leaving during a delivery detaches the stream once
  the delivery ends, reporting a failed detach the same way. If the stream's
  `subscribe` throws, every subscription made during that call is dropped;
  such a `subscribe` must not keep the listener. Its overloads pair each
  protocol with its own events. `BridgeEventStream` types the stream,
  `BridgeEventProtocol` names the protocols, and `BridgeEventOf<protocol>`
  names a protocol's events.
