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
Play here starts gameplay inside the post, and the `game` entry opens the
separate expanded mode Phaser document. Inline gameplay must remain tap/click
only and must not trap feed scrolling.

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
