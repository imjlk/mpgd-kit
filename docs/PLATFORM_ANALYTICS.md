# Platform analytics

Some hosts build their own analytics from logs the game sends through the
host SDK. The Apps in Toss console, for example, charts events and key or
conversion metrics only from `Analytics` logs of `@apps-in-toss/web-framework`.
`PlatformGateway.analytics` hands a game's logs to that host analytics, so a
game never imports a platform SDK to send them.

It is a mirror, not a pipeline. The game's first-party analytics
([`@mpgd/analytics`](MONETIZATION_OBSERVABILITY.md), game-services) keeps every
event and stays the source of truth. A host log never grants, ranks or verifies
anything, and forward only the product moments worth a console metric or a
funnel step.

## API

The port lives in `@mpgd/platform/analytics`, which has no SDK or DOM imports.

```ts
import type { PlatformAnalyticsLog } from '@mpgd/platform/analytics';

const log: PlatformAnalyticsLog = {
  logName: 'mygame_play_clear',
  logType: 'event', // 'screen' | 'event' | 'click' | 'impression'
  params: { kind: 'daily', stage: 3 },
};

// Never throws; resolves true when the host handed the log to its SDK.
void gateway.analytics?.log(log);

// { provider: 'apps-in-toss' | 'none', state: 'available' | 'unsupported', logTypes }
const status = await gateway.analytics?.getStatus();
```

`analytics` is optional on `PlatformGateway`, so a gateway from outside the
kit may leave it out; every kit adapter provides it. Branch on
`getStatus()`, not on the target name. `log` resolves `false` when it drops a
log: the log is invalid, the host does not send that `logType`, the target has
no host analytics, or the SDK failed. A game does not need to wait for it.

## What a log may carry

`readPlatformAnalyticsLog` checks every log, in the game's gateway and again in
the host before the SDK call. Any invalid part drops the whole log; a log is
never forwarded with a parameter removed.

| Part | Rule |
| --- | --- |
| `logName` | Lowercase snake_case, 2 to 64 characters, starting with a letter. Prefix it with the game, such as `nem_play_start`. |
| `logType` | `screen`, `event`, `click` or `impression`. |
| `params` | A plain object of at most 8 entries; optional. |
| Parameter name | Lowercase snake_case, up to 32 characters. Not `log_name`, `log_type` or `params`. No `id`, `ids`, `uid`, `uuid`, `key(s)`, `token(s)`, `email` or `score(s)` as a `_`-separated part (`room_id`, `user_id_hash`, `anonymous_key`, `score_band`), no name ending in `score(s)` (`highscore`), and no `userid`, `roomid` or similar. |
| Parameter value | A finite number, a boolean, or a string of up to 64 characters without a control character, `@`, `://`, a run of 16 or more hex digits and `-` that contains a digit, or a 32-character run of letters, digits, `_` and `-` that contains a digit. Numbers must stay below 1e15 in magnitude; nothing else about them is checked. |

Never send account ids, player ids, room or match ids, invite codes, scores,
or free text a player typed. The checks above refuse the common shapes of those
values, but they cannot recognise every identifier: a short invite code or a
score under a neutral name passes. The game decides what it sends; send
categories such as a mode, a theme, a stage number or an outcome.

## Targets

| Target | `getStatus()` | Behaviour |
| --- | --- | --- |
| Apps in Toss | `apps-in-toss`, `available` | See below. |
| Browser, Microsoft Store, CrazyGames, OnePlay | `none`, `unsupported` | Every log is dropped. |
| Android, iOS (Capacitor) | `none`, `unsupported` | Every log is dropped. Crash reports use [crash reporting](CRASH_REPORTING.md). |
| Reddit (Devvit) | `none`, `unsupported` | Every log is dropped. |
| Verse8 | `none`, `unsupported` | Every log is dropped. |
| WeChat (private adapter) | `none`, `unsupported` | Every log is dropped. |

### Apps in Toss

The game's gateway (`createAitPlatformGateway`) sends each log to the
wrapper's host bridge over `analytics.log`; the host bridge
(`installAitHostBridge` from `@mpgd/adapter-ait/host`) re-validates it and
calls `Analytics` from `@apps-in-toss/web-framework`:

| `logType` | Toss 5.208.0 or later | Older Toss app |
| --- | --- | --- |
| `screen` | `Analytics.screen({ log_name, ...params })` | same |
| `event` | `Analytics.log({ log_name, log_type: 'event', params })` | dropped |
| `click` | `Analytics.log({ log_name, log_type: 'click', params })` | `Analytics.click({ log_name, ...params })` |
| `impression` | `Analytics.log({ log_name, log_type: 'impression', params })` | `Analytics.impression({ log_name, ...params })` |

`Analytics.log` is ignored without an error before Toss 5.208.0, so the host
checks `isMinVersionSupported` and `getStatus()` lists only the types the app
sends. The host calls the SDK without waiting for it, and a thrown or rejected
call only drops the log. The SDK adds the player's `anonymous_key` to every log
itself; the game does not send it. In the Toss sandbox the SDK prints logs to
the console instead of sending them. The kit's local SDK mock (`pnpm dev:ait`
in a browser) acts as a Toss app older than 5.208.0: it prints `screen`,
`click` and `impression` logs with `console.debug` and drops `event` logs.

A host bridge from a release before platform analytics answers the
`analytics.*` methods with an error, which the gateway reads as `unsupported`.
Update the game and the wrapper together.

Register the log names and parameters you send in the Apps in Toss console
before you build metrics on them.

## Adding a target

An adapter whose host has analytics implements `PlatformAnalyticsSink` and
calls `readPlatformAnalyticsLog` before the SDK. Where the SDK lives outside
the game bundle, as in Apps in Toss, the game side sends the log over the host
bridge and the host validates it again. An adapter without host analytics
returns `createUnsupportedPlatformAnalyticsSink()`.
