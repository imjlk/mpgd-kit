# MPGD Kit Roadmap Checklist

This checklist tracks the Codex roadmap from the initial project brief.

## Phase 0 - Toolchain Bootstrap

- [x] pnpm workspace created
- [x] Node >= 22 declared
- [x] typescript@rc installed at the root toolchain
- [x] ttsc installed
- [x] @ttsc/lint installed
- [x] @ttsc/unplugin installed
- [x] @ttsc/graph installed
- [x] @ttsc/paths installed
- [x] @ttsc/strip installed
- [x] typia@rc installed
- [x] tsconfig.base.json written
- [x] lint config written
- [x] strip config written
- [x] .mcp.json written
- [x] AGENTS.md written
- [x] README.md draft written

Note: active lint and strip config files use `lint.config.js` and `strip.config.js`
because the current ttsc RC config loader path is more reliable with JS config files.

## Phase 1 - Phaser 4 App

- [x] apps/game-phaser created
- [x] Phaser 4.2.0 exact pinned
- [x] Vite configured
- [x] @ttsc/unplugin/vite connected
- [x] BootScene created
- [x] PreloadScene created
- [x] LobbyScene created
- [x] GameScene created
- [x] ResultScene created
- [x] createGame.ts created
- [x] installPlatform.ts created
- [x] browser mock adapter connected
- [x] pnpm --dir apps/game-phaser dev succeeds
- [x] pnpm --dir apps/game-phaser build succeeds
- [x] pnpm --dir apps/game-phaser check succeeds

## Phase 2 - Contracts And Typia Boundary

- [x] packages/platform-contract written
- [x] packages/monetization-contract written
- [x] packages/leaderboard-contract written
- [x] packages/bridge-protocol written
- [x] packages/product-catalog written
- [x] packages/ad-placements written
- [x] typia validators created
- [x] tools/validate-product-catalog.ts written
- [x] tools/validate-ad-placements.ts written
- [x] tools/validate-target-config.ts written
- [x] tools/target/validate-target-config.ts written
- [x] all validation scripts execute through ttsx

## Phase 3 - Capacitor v8 Mobile Shell

- [x] apps/mobile-capacitor created
- [x] @capacitor/core installed
- [x] @capacitor/cli installed
- [x] @capacitor/android installed
- [x] @capacitor/ios installed
- [x] capacitor.config.ts written
- [x] webDir = "www" configured
- [x] cap add android executed
- [x] cap add ios executed
- [x] native-plugins/capacitor-game-services created
- [x] request(input: BridgeRequest): Promise<BridgeResponse> defined
- [x] Android mock native response implemented
- [x] iOS mock native response implemented
- [x] game-phaser build output copied to www
- [x] cap sync android succeeds
- [x] cap sync ios succeeds

Note: apps/mobile-capacitor uses TypeScript 5.9.3 only for Capacitor CLI config
loading compatibility. The root project toolchain remains TypeScript 7 RC.

## Phase 4 - Apps In Toss Target

- [x] apps/target-ait created
- [x] @apps-in-toss/web-framework 2.x installed
- [x] @apps-in-toss/cli 2.x installed
- [x] granite.config.ts written
- [x] aitBridge.ts written
- [x] globalThis.__GAME_PLATFORM_BRIDGE__ injected
- [x] game-phaser build output copied to public/game
- [x] AIT wrapper build succeeds
- [x] ait build succeeds
- [x] sandbox README written

## Phase 5 - Build Orchestration

- [x] platform.targets.json written
- [x] release.manifest.schema.json written
- [x] tools/target/build-target.ts written
- [x] tools/target/generate-release-manifest.ts written
- [x] pnpm build:web succeeds
- [x] pnpm build:android succeeds
- [x] pnpm build:ios succeeds
- [x] pnpm build:ait succeeds
- [x] artifacts/release-manifest.json generated

Note: Android builds a release AAB by default. iOS performs cap sync by default;
set `MPGD_RUN_IOS_ARCHIVE=1` on a runner with a compatible iOS platform installed
to run xcodebuild archive.

## Phase 6 - Backend Skeleton

- [x] backend/purchase-verifier created
- [x] backend/entitlement-ledger created
- [x] backend/ad-reward-ledger created
- [x] purchase idempotencyKey type defined
- [x] ad reward idempotencyKey type defined
- [x] product grant transaction schema written
- [x] typia request/response validators written
- [x] in-memory idempotent ledger mock implemented

## Phase 7 - CI

- [x] GitHub Actions ci.yml written
- [x] pnpm install covered
- [x] pnpm check covered
- [x] pnpm validate:catalog covered
- [x] pnpm validate:ads covered
- [x] pnpm validate:targets covered
- [x] pnpm build:web covered
- [x] android build job added
- [x] ios build job added
- [x] ait build job added
- [x] release manifest artifact upload added
- [x] Sampo config and bootstrap changeset added
- [x] Sampo release dry-run succeeds

## Phase 9 - Package Publish Readiness

- [x] publishable package exports point at dist artifacts
- [x] publishable packages declare main and types entries
- [x] scoped npm packages set public publish access
- [x] package build tool emits JavaScript and declarations into dist
- [x] package pack smoke verifies npm tarball payloads
- [x] CI validate job runs package pack smoke
- [x] release workflow runs package pack smoke before Sampo automation

## Phase 10 - Graph-Guided Preflight

- [x] graph-specific tsconfig covers tools, packages, adapters, backends, and app sources
- [x] target release graph preset added
- [x] package publish graph preset added
- [x] bridge contract graph preset added
- [x] SDK demo loop graph preset added
- [x] graph preflight runner validates answer-ready graph anchors
- [x] CI and release workflows run graph preflight before package publish smoke
- [x] root test command builds package dist before recursive workspace tests

## Phase 11 - Target Availability Runtime

- [x] target config maps runtime browser target to web-preview config
- [x] platform capabilities are clamped by target config
- [x] disabled commerce, ad, and leaderboard actions return unavailable/no-op results
- [x] Phaser demo installs target-configured gateways for every target
- [x] Result scene disables target-disabled feature actions
- [x] target config validator checks platform target coverage
- [x] graph preflight covers target config runtime flow

## Phase 12 - Target Feature Availability Diagnostics

- [x] target-configured gateways expose runtime feature snapshots
- [x] feature snapshots distinguish target-disabled and capability-unsupported states
- [x] ad placement runtime state follows rewarded/interstitial target config
- [x] Phaser lobby renders the active config target and feature states
- [x] Result scene test hook exposes target-config-driven action states
- [x] target config smoke verifies browser/web-preview feature behavior
- [x] target config smoke verifies every configured release target

## Phase 13 - Target Availability Guardrails

- [x] root test command runs target config runtime smoke
- [x] CI validate job runs target config runtime smoke
- [x] release validate job runs target config runtime smoke
- [x] manual target build workflow validates target config before build
- [x] manual target build workflow runs target config runtime smoke before build
- [x] per-target release workflows run target config runtime smoke before target release build
- [x] target artifact smoke supports focused single-target validation
- [x] CI target jobs smoke the artifacts they build
- [x] release target jobs smoke the artifacts they build

## Phase 14 - Target Managed Localization

- [x] platform capabilities expose localized content support
- [x] target config controls localization availability
- [x] target config runtime snapshots include localization feature state
- [x] target availability clamps localized content capability
- [x] browser, AIT, Android, and iOS mocks report localized content capability
- [x] `@mpgd/i18n` package owns en/ko translation-key message catalogs
- [x] Paraglide generates typed message functions from the shared catalog
- [x] Phaser demo resolves localized UI text through target-configured capabilities
- [x] Phaser demo renders translated lobby/result messages from `@mpgd/i18n`
- [x] package build and pack smoke include generated i18n runtime subpaths
- [x] i18n smoke verifies locale fallback and translated message output
- [x] target config smoke verifies localization locale fallback and availability

## Phase 15 - Effective Target Config Bundles

- [x] target config package computes effective per-target config from target config, product catalog, and ad placements
- [x] effective config includes product ids, ad placement ids, leaderboard id, storage support, localization, release profile, and nested policy restrictions
- [x] effective config validator catches enabled products or ads with missing platform ids
- [x] build tooling writes `artifacts/target-config/*.json`
- [x] build tooling embeds active `mpgd-effective-target.json` into each target payload
- [x] release manifest records target config version plus effective config path, version, and sha256 digest
- [x] target artifact smoke verifies effective config path, digest, target match, and embedded payload match

## Phase 16 - Demo Effective Config Runtime

- [x] Phaser platform installation creates effective config for the active target
- [x] target-configured gateway exposes effective config on runtime snapshots
- [x] lobby diagnostics render effective product/ad/storage summary
- [x] result actions use effective product, rewarded ad placement, and leaderboard availability
- [x] demo test hooks expose effective config and configured items

## Phase 17 - Adapter Effective Config Parity

- [x] browser adapter smoke verifies web-preview disables mapped products and ads
- [x] Capacitor Android/iOS smoke verifies enabled effective config delegates purchase, rewarded ad, and leaderboard calls
- [x] Apps in Toss smoke verifies enabled effective config delegates purchase, rewarded ad, and leaderboard calls
- [x] root test command runs effective config and adapter parity smoke
- [x] CI and release workflows run effective config validation and parity smoke
- [x] graph target-config preset covers effective config generation and demo action flow
- [x] Android emulator smoke verifies the debug APK embeds Android effective config before launch
- [x] iOS simulator smoke verifies the simulator app embeds iOS effective config before launch

## Phase 18 - Real Game Development Readiness

- [x] Phaser game app separates manifest assets, authored stage config, and input actions
- [x] `packages/game-core` supports stage-specific completion thresholds
- [x] root `validate:game-assets` checks public asset registration and budget
- [x] game-development guide documents the daily loop and platform readiness checks
- [x] root `tsconfig.json` exposes the graph project for ttsc graph MCP workflows

## Phase 19 - Ledger-First LiveOps Vertical Slice

- [x] reusable `@mpgd/liveops-client` orchestrates purchase, rewarded ad, and leaderboard flows
- [x] purchase grants go through backend purchase verifier plus entitlement ledger
- [x] rewarded ad grants go through backend ad reward ledger after platform reward evidence
- [x] leaderboard submissions are recorded by backend leaderboard ledger
- [x] Phaser demo result actions use the liveops client before mutating save state
- [x] `pnpm smoke:liveops` validates Android, iOS, and Apps in Toss target simulations
