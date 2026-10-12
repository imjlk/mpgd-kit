---
npm/@mpgd/adapter-ait: patch
npm/@mpgd/adapter-capacitor: patch
npm/@mpgd/adapter-devvit: patch
npm/@mpgd/cli: patch
npm/@mpgd/create-game: patch
---

Notifications v2, PR N3: transports without v2 answer every
`notifications.v2.*` method with `NOTIFICATIONS_V2_UNAVAILABLE`, which is not
retryable, instead of `UNSUPPORTED_METHOD`. No adapter serves notifications v2
yet; P1–P3 add the providers.

- `@mpgd/adapter-ait`: the host bridge and the sandbox bridge, in every build,
  answer the code without reaching the host's agreement API. The commerce v2
  provider over the bridge validates events with the commerce envelope and
  ignores notifications envelopes on the shared channel.
- `@mpgd/adapter-capacitor`: the gateway's request path answers the code for
  a method no registered provider serves, before it pauses the game or
  reaches the base plugin, and a provider cannot declare those methods. For
  the provider P2 adds, `notifications.v2.requestPermission` and
  `notifications.v2.openSettings` pause the game, and the registry passes
  `notifications.v2.*` through `assertMethodReady` as it does `commerce.v2.*`.
  A launched commerce v2 purchase ends its pause on commerce events only.
- `@mpgd/adapter-devvit`: the sandbox bridge answers the code.
- `@mpgd/cli` and `@mpgd/create-game`: the generated Devvit server bridge
  answers the code, and the Apps in Toss sandbox gateway says so.
