# Lite Game Acceptance

Use `agent/game-manifest.json` and `.agents/skills/use-mpgd-kit/SKILL.md` to select configured target checks.
Run `pnpm check`, `pnpm build`, `pnpm icons:generate`, `pnpm icons:verify`, and `pnpm accept`.
Preserve the generated JSON and Markdown in `artifacts/acceptance` or the target release-output directory.

- Confirm the first screen is playable and uses Canvas2D without a Phaser dependency or scene imports.
- Resize the game, verify DPR handling, and reserve safe-area geometry exactly once.
- Check pause/resume, browser history restoration, and audio ownership. A persisted `pagehide` must retain the game.
- Use the game-owned driver for gameplay and performance acceptance; unit tests do not certify live SDK behavior.
- Verify renderer teardown removes its own listeners and never updates a replacement view from an old promise.
- Purchases and rewarded-ad callbacks never grant locally; verify authoritative ledger grants and durable reconciliation before release.
- Keep unknown native outcomes and late recovery observers; closing one lease must not release another owner's presentation or audio.

## Reddit Devvit

Keep SDK calls in the adapter or `apps/target-devvit`. Verify both inline and expanded game modes, preserve feed scrolling, and run the configured inline build budget.
The inline first load must reject forbidden modules and include static imports, preloads, and CSS imports. Only declared dynamic imports can be deferred.
Run login/init/playtest for a real Devvit handoff after platform setup. Artifact smoke is not deployed-platform evidence.

## Other configured targets

Use the configured official MCP or SDK documentation before SDK or submission changes. Keep target secrets and signing material outside source control.
ONE play requires issued IDs, authenticated issuer routes, signed SSV/PNS, purchase verification, ledger-before-finalization, and atomic cancellation fencing.
Verse8 server records require authenticated senders and a game-specific completion verifier.
Apps in Toss and native Store builds require real-app identity, lifecycle, and SDK acceptance; generic fixtures do not certify live commerce or ads.
Uploading and deployment follow the target's release procedure after acceptance.
