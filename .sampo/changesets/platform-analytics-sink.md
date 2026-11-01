---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/bridge: minor (Added)
npm/@mpgd/adapter-ait: minor (Added)
npm/@mpgd/adapter-browser: patch (Added)
npm/@mpgd/adapter-capacitor: patch (Added)
npm/@mpgd/adapter-devvit: patch (Added)
npm/@mpgd/adapter-verse8: patch (Added)
---

Platform analytics: `PlatformGateway.analytics`, an optional `PlatformAnalyticsSink` from the new `@mpgd/platform/analytics`, forwards a game's bounded logs to the host's own analytics, so a game no longer wires a platform SDK itself. A log is `{ logName, logType, params }` with `logType` `screen`, `event`, `click` or `impression`, a lowercase snake_case name of 2 to 64 characters, and at most 8 flat parameters (finite numbers, booleans, strings of up to 64 characters). `readPlatformAnalyticsLog` drops the whole log when any part is outside those bounds, or when a parameter name or value looks like an identifier or a score (an `id`, `key`, `token`, `email` or `score` part such as `room_id` or `user_id_hash`, `highscore`, `userid`; long hex or opaque tokens, e-mail addresses, URLs). Numbers must stay below 1e15 in magnitude and are not otherwise inspected, so a game must not send scores under another name. `log` resolves `true` once the host handed the log to its SDK and `false` when it was dropped; `getStatus()` reports `{ provider, state, logTypes }`. The sink never throws, and the first-party analytics pipeline stays the source of truth.

`@mpgd/adapter-ait` sends the logs over two new host bridge methods (`analytics.getStatus` and `analytics.log` in `@mpgd/bridge`); the wrapper's host bridge re-validates each log and calls `Analytics` from `@apps-in-toss/web-framework`: `Analytics.screen` for screens and `Analytics.log` for the other types on Toss 5.208.0 or later. Older Toss apps fall back to `Analytics.click` and `Analytics.impression` and drop `event` logs, and `getStatus()` lists only the types the app sends. A host bridge from an earlier release reads as `unsupported`. The local SDK mock acts as a Toss app older than 5.208.0 and prints screen, click and impression logs to the developer console. The browser, Capacitor, Devvit and Verse8 adapters expose a sink that reports `unsupported` and drops every log (`createUnsupportedPlatformAnalyticsSink`).
