---
npm/@mpgd/platform: minor
---

`@mpgd/platform` adds the notifications v2 contract as three new subpaths.
`./notifications` holds the client contract types (`NotificationProvider` with
`revokePermission` for game-rendered consent, `NotificationCapabilities` with
`permission.promptLimit` and `remote.addressing: 'none'` exactly when remote
delivery is unsupported, permission snapshots and results with
`requiredAction`, endpoint registrations without an installation id, local
reminders, events, consent records including provider answers, consent
notices, and the `NotificationRuntime` surface with `revokePermission`,
`unregister()`, and `notices`, whose `recordShown` takes a notice's kind, its
record's kind and time, and its `dueBy` and records the notice only while it
is listed, so a retry changes nothing), `NotificationError` with the
`NOTIFICATIONS_*` codes including `NOTIFICATIONS_INVALID_INPUT` and
`NOTIFICATIONS_IDEMPOTENCY_CONFLICT` and the host's own `hostCode`, the bridge
v2 payload shapes and event envelope, typia validators that reject unknown
keys, the delivery provider registry entry with reference entries for FCM,
Apps in Toss, and Devvit, the backend deployment settings (`advertisingRules`,
the advertising sender and opt-out line, the notice topic, the zone), and the
pure policy gate `evaluateNotificationDelivery`: an unknown topic, channel,
and purpose; recipients and the Devvit link; positively granted permission per
provider kind, host agreements unless a topic needs none, and per-send
acceptances; the topic preference; advertising consent; the Korean night
window with an expiry at the next 21:00 and quiet hours in the recipient's
zone; frequency caps and provider limits over rolling windows, deferring short
ones; and, under the Korean rules, the advertising sender, the `(광고)` label,
the opt-out line, and the opt-out action. It also holds send bounds, reserved
key prefixes, request fingerprints, reminder routing and the client-evaluable
local and set-time server reminder checks, consent notice due dates with the
re-confirmation series (each re-confirmation listed from 60 days before its
`dueBy`), canonical reminder keys and notice keys that name each notice by its
kind, its record's kind and time, and its `dueBy`, root-relative route checks
that refuse any route a URL parser or a decoding client would resolve to a
protocol-relative path, and the v1 `toNotificationSubscriptionAdapter` wrapper
over the runtime. `./notifications-vectors` fixes the conformance vector
format, and `./notifications-conformance` runs the vectors with a reference
runtime, fake host, fake backend (sessions, an idempotency ledger with
fingerprints and leases, device fan-out under derived keys, the five provider
answers, deferred replay with backoff, a paced scheduler, and notices), and
clock, substituting the fixture provider id and evidence schema for a provider
under test and skipping a vector whose `appliesTo` its capabilities do not
satisfy; all thirty-nine vectors pass. `PlatformGateway` gains an optional
`notificationsV2` provider, declared through a typia-free contract module so
the main entry stays free of typia. This is additive: no provider implements
v2 yet, and the protocol version stays `2.0.0-draft.1`.
