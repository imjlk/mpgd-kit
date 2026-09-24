# mpgd-kit documentation

Start with the [game development guide](GAME_DEVELOPMENT.md) and
[project model](GAME_PROJECT_MODELS.md) to choose a target and keep game logic
behind the platform gateway. The [shared platform flow](PLATFORM_GAME_FLOW.md)
explains identity, capability, sharing, and notification boundaries.

## Evidence-backed guides and examples

- [Read platform capabilities](guides/platform-capabilities.md) explains fresh
  gateway snapshots, fixture validation, failure paths, and the difference
  between contract checks and device readiness.
- [Platform capability examples](examples/platform-capabilities.ts) are checked
  with `pnpm docs:examples:check`; their local behavior test is run with
  `pnpm docs:examples:test` after building `@mpgd/platform`.

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
confirmed behavior specs and are not implementation-coverage targets.
