---
name: add-platform-adapter
description: Add or modify a platform adapter for browser, Capacitor, Apps in Toss, Reddit Devvit, Telegram, or Tauri using mpgd platform and bridge contracts.
---

# Add Platform Adapter

Use this skill when adding or changing a platform target.

1. Confirm the target model first.
   - `@mpgd/platform` owns the generic `PlatformGateway` contract.
   - `@mpgd/target-config` owns target feature availability.
   - `@mpgd/bridge` owns bridge request and response wire shape.

2. Keep SDK imports in allowed locations only.
   - `adapters/*`
   - `native-plugins/*`
   - `apps/target-*`

3. Never grant purchases or ad rewards from client callbacks alone.
   - Treat platform callbacks as evidence.
   - Send grants through `@mpgd/game-services` backend ledger APIs.

4. For Apps in Toss targets, use the apps-in-toss MCP before implementation.
   - Search Korean docs: `웹뷰 개발`, `인앱 결제`, `인앱 광고`, `샌드박스`, `심사`, `저장소`.
   - Check SDK version notes, pending order restore, grant completion, and sandbox scenarios.
   - Games may skip TDS, but non-game mini-apps must use TDS.

5. For future Reddit Devvit support, keep it generic.
   - Do not introduce Devvit imports into Phaser scenes or pure packages.
   - Add a target-config entry, adapter package, bridge fixtures, and smoke tests in the same shape as other targets.

6. Validate.
   - `pnpm validate:target-config`
   - `pnpm validate:targets`
   - `pnpm smoke:adapter-effective-config`
   - target-specific build or smoke when available
