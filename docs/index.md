# mpgd-kit documentation

Start with the [game development guide](GAME_DEVELOPMENT.md) and
[project model](GAME_PROJECT_MODELS.md) to choose a target and keep game logic
behind the platform gateway. The [shared platform flow](PLATFORM_GAME_FLOW.md)
explains identity, capability, sharing, and notification boundaries.

## Evidence-backed guides and examples

- [Read platform capabilities](guides/platform-capabilities.md) explains fresh
  gateway snapshots, fixture validation, failure paths, and the difference
  between contract checks and device readiness.
- [Platform capability examples](https://github.com/imjlk/mpgd-kit/blob/main/docs/examples/platform-capabilities.ts) are checked
  with `pnpm docs:examples:check` and run against local source fixtures with
  `pnpm docs:examples:test`; neither step certifies a published tarball.

The [documentation evidence policy](DOCUMENTATION_EVIDENCE.md) names the exact
API, spec, implementation, test, and example populations currently enforced by
`pnpm docs:evidence`. The [confirmed capability spec](specs/platform-capability-snapshots.md)
and [guide principles](standards/documentation-principles.md) are review targets.
Evidence checks citations and review freshness; tests and human review still
decide whether the explanation is correct.

## Integration and release material

The [game services backend guide](GAME_SERVICES_BACKEND.md) describes
server-owned purchase grants and verified data paths. Target-specific
production and deployment notes, such as
[Apps in Toss production evidence](APPS_IN_TOSS_PRODUCTION_EVIDENCE.md),
describe their stated verification scope; a shared type or local fixture does
not mean that a device has passed or a release is ready.

The [production integration roadmap](PRODUCTION_INTEGRATION_ROADMAP.md) and
[roadmap checklist](ROADMAP_CHECKLIST.md) track intended work. They are not
confirmed behavior specs and are not implementation-coverage targets. The
[commerce v2 RFC](specs/commerce/commerce-v2-rfc.md) is a draft proposal for
the next commerce contract, in the same category until its types and
conformance runner land.

The [advertising behavior RFC](specs/ads/ads-behavior-rfc.md) proposes common
rewarded/interstitial semantics, presentation ownership, evidence registration,
and fake-SDK conformance vectors. It is also a draft; its scenarios do not yet
certify adapter behavior.

To ship a game to Google Play and the App Store, follow the
[mobile launch checklist](MOBILE_LAUNCH_CHECKLIST.md); the
[store privacy disclosures](STORE_PRIVACY_DISCLOSURES.md) map kit features to
the Data safety and App Privacy answers.

The [notifications guide](NOTIFICATIONS.md) explains what each target supports,
the consent flow, the Korean advertising rules, and how to add a topic; the
[Firebase setup guide](FIREBASE_NOTIFICATIONS.md) covers Android and iOS push,
and the [live test runbook](NOTIFICATIONS_LIVE_TEST.md) the first run against
real FCM on an emulator.
The [notifications v2 RFC](specs/notifications/notifications-v2-rfc.md)
proposes capability-declared notification providers, server-side consent
records, one delivery policy gate, reminders, and conformance vectors. Its
types, conformance runner, providers, and backend have landed; it is still a
draft, and a conformance vector is not device or release verification.
