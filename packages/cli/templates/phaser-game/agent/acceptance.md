# Acceptance

Run these checks before handing off a generated game starter:

```sh
pnpm icons:generate
pnpm icons:verify
pnpm accept
```

`pnpm accept` runs the configured game check, optional test and playtest scripts,
game build, kit TypeScript graph preflight, and the reusable target build/smoke
matrix. It writes `artifacts/acceptance/acceptance-report.json` and
`acceptance-report.md` for handoff. Missing optional `test` or `playtest` scripts
are recorded as skipped; check and build remain required.

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

For Microsoft Store changes, keep the first pass as a PWA/web target that uses
the browser adapter. Add a dedicated Store commerce adapter only when wiring
Digital Goods API and Payment Request through backend ledger verification.

Verify the first screen reports the viewport orientation policy, and treat
locked orientation modes as soft prompts instead of unsafe WebView hard locks.
