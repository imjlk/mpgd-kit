# Acceptance

Run these checks before handing off a generated game starter:

Use `agent/game-manifest.json` and `.agents/skills/use-mpgd-kit/SKILL.md` to
select any target-specific acceptance workflow required by the configured
targets.

```sh
pnpm icons:generate
pnpm icons:verify
pnpm accept
```

`pnpm accept` runs the configured game check, optional test and browser playtest
scripts, game build, kit TypeScript graph preflight, the reusable target
build/smoke matrix, and an optional `gameplay:e2e` target script. It writes
`artifacts/acceptance/acceptance-report.json` and `acceptance-report.md` for
handoff. Missing optional `test`, `playtest`, or `gameplay:e2e` scripts are
recorded as skipped; check and build remain required. When `gameplay:e2e`
exists, it must execute the `mpgd.game.json` acceptance states through a
game-owned driver and write the standard hashed report requested by
`MPGD_GAMEPLAY_E2E_REPORT_FILE`.

For Apps in Toss changes, use the apps-in-toss MCP before implementation and
keep SDK calls inside adapters or target wrappers.
Resolve identity and launch intents during bootstrap, treat inbound share data as
untrusted, and keep notification delivery on the server.

For Reddit Devvit changes, keep Devvit SDK calls inside the adapter or target wrapper and
continue to expose game-facing behavior through `PlatformGateway`. The Devvit
app root is game-owned in `apps/target-devvit`; run `pnpm devvit:init` once
after login before upload or playtest.
Verify the default post entry renders a lightweight inline mode launch screen,
does not load Phaser or create a scroll container, and Play full screen opens
the separate expanded mode Phaser document. Inline gameplay remains available
only as an explicit adapter opt-in and must preserve Reddit-native gestures.

<!-- mpgd:microsoft-store:start -->
For Microsoft Store changes, keep the first pass as a PWA/web target that uses
the browser adapter. Add a dedicated Store commerce adapter only when wiring
Digital Goods API and Payment Request through backend ledger verification.
Run the generated Store release skill from build and preflight through package
acceptance; WACK is optional recommended evidence.
<!-- mpgd:microsoft-store:end -->

## Verse8 Agent8 Structured Server

Keep the Agent8 server in a separate game-owned project. Its acceptance flow
must call `createVerse8Agent8LeaderboardBoundary` with an authenticated sender
account and a game-specific completion verifier, then cover rejected malformed
submissions, verified recording, and account-scoped snapshot reads.

Inject endpoints, persistence secrets, encryption keys, and authentication at
runtime. Do not commit personal MCP configuration, `.env` files, credentials,
tokens, or Agent8 authentication state to this generated game. The kit command
`pnpm smoke:verse8-agent8-acceptance` validates the generic structured-server
contract and generated Verse8 target surface; it does not validate a deployed
game server or replace game-owned production evidence.

Verify the first screen reports the viewport orientation policy, and treat
locked orientation modes as soft prompts instead of unsafe WebView hard locks.
Verify safe-area geometry is reserved exactly once: CSS-padded containers must
not also subtract `safeArea.contentBounds`, while full-bleed game surfaces use
the snapshot bounds for persistent controls.

## Shared native presentation

- Purchase, rewarded, and interstitial requests use the same game-owned scope.
- Native closure resumes gameplay while backend verification can remain pending.
- Timeouts preserve unknown occupancy and late native/recovery observers.
- Scene shutdown removes its action view and keyboard handler; it never unmutes
  a live ad or updates a replacement scene from an old Promise.
- Background and settings ownership remain after another native lease closes.
- Rewarded v2 is unavailable until a durable encrypted journal is supplied via
  bootstrap monetization ports. A test memory store is not durable recovery.
- Use the real adapter's SDK-driven conformance tests and a game-owned platform
  test environment; generic unit tests do not certify live ad delivery.

## ONE play acceptance

Build and smoke the configured ONE play target using the game-owned kit path. Validate server-issued reward/checkout binding, raw-byte signed SSV, purchase token API verification, ledger-before-consume/acknowledge, retries without duplicate grants, signed PNS orphan-purchase recovery and atomic cancellation fences. Missing finalization must keep PNS pending; a busy SDK must report native not-started before rejecting a new checkout. Permit five minutes of provider/server clock skew while rejecting timestamps outside the intent window.

Use an authenticated server session rather than the SDK player pseudonym. Confirm ad IDs, real payments, lifecycle, HTTPS iframe hosting and PNS/SSV in ONE store with issued ONEconsole credentials. Generic fixture and artifact smoke do not certify real-app commerce.

Performance evidence can be required with `mpgd game accept . --performance`.
Provide a game-owned `performance:e2e` script and `agent/performance.budget.json`;
collect a fresh foreground report at `MPGD_PERFORMANCE_REPORT_FILE`. Calibrate
per-device/scenario CPU and cadence budgets independently, link the tested
artifact/budget hashes and keep trace/screenshots in separate diagnostic runs.
See the [report contract](https://github.com/imjlk/mpgd-kit/blob/main/docs/GAME_PERFORMANCE_ACCEPTANCE.md).
