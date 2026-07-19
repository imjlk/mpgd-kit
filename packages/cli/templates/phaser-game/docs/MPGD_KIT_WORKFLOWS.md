# mpgd-kit workflows

This guide is the capability map for this generated game. Start with
`agent/game-manifest.json`: configured targets are available now; `futureTargets`
are design directions, not implemented release paths.

## Core boundaries

| Concern | Owner |
| --- | --- |
| Deterministic rules and state | `src/game` and simulation modules |
| Rendering and input | `src/scenes` |
| Platform selection and services | `src/platform` through `PlatformGateway` |
| Target build ownership | `mpgd.targets.json` |
| Runtime/effective configuration | `@mpgd/target-config` and target config files |
| Agent capability and acceptance contract | `agent/` |

Do not import platform SDKs into scenes or pure game logic. Add a capability to
`PlatformGateway`, implement it behind an adapter or wrapper, and provide a
capability-disabled fallback where the target cannot support it.

## Shared game capabilities

### Assets and icons

- Keep Phaser-loadable assets in the game-owned asset manifest.
- Replace starter icons, then run `pnpm icons:generate`, `pnpm icons:verify`,
  and optionally `pnpm icons:inspect`.
- Use target icon profiles from `mpgd.targets.json`; do not maintain unrelated
  hand-copied icon sets.

### Localization and orientation

- Add game text through the generated i18n messages and resolve locale from the
  effective target configuration.
- Choose a responsive, preferred, or soft-lock orientation policy before
  building resize and rotate-prompt behavior. Keep the installed web manifest
  orientation aligned with the runtime policy.

### Analytics, saves, commerce, ads, and leaderboards

- Emit best-effort analytics through `@mpgd/analytics`; never depend on a debug
  or analytics side effect for game correctness.
- Route identity, saves, lifecycle, host presentation, commerce, ads, and
  leaderboards through `PlatformGateway`.
- Use `@mpgd/game-services` and a game-owned backend for purchase ledgers,
  rewarded-ad grants, entitlements, and verified leaderboard records. Client
  success callbacks are requests or pending evidence, never grant authority.

## Build and acceptance loop

Use `MPGD_KIT_PATH` or pass `--kit-path` to a nearby kit checkout.

```sh
pnpm check
pnpm build
pnpm icons:verify
pnpm exec mpgd target doctor --targets-file ./mpgd.targets.json --kit-path ../mpgd-kit --targets default
pnpm exec mpgd target build-all --targets-file ./mpgd.targets.json --kit-path ../mpgd-kit --targets default --profile staging --ait-variant wrapper
pnpm exec mpgd target smoke-all --targets-file ./mpgd.targets.json --kit-path ../mpgd-kit --targets default
pnpm accept
```

`pnpm accept` records checks, build, graph preflight, optional browser playtest,
target build/smoke, and optional gameplay E2E results under
`artifacts/acceptance`. Add a game-owned `playtest` or `gameplay:e2e` driver
when the release needs stronger browser or state-path evidence.

## Target routing

### Browser preview

Use the browser adapter for local and hosted web behavior. Verify installed-PWA
updates without forcing service-worker activation while old windows remain
open.

### Microsoft Store

This target is optional. Enable it in an existing generated game with:

```sh
pnpm exec mpgd target init microsoft-store --game . --kit-path ../mpgd-kit
```

The initializer adds the target, scripts, PWA runtime hook, Store config, and
`.agents/skills/release-microsoft-store/SKILL.md` without overwriting conflicts.
Use that skill for the complete release and evidence sequence.

### Verse8

Build through the Verse8 adapter. Keep host credentials and authenticated cloud
state behind target services. Treat client commerce as pending; authoritative
grants belong in a game-owned Agent8 server purchase event with consume-once
catalog handling and verified completion logic for leaderboards.

### Apps in Toss

Use official Apps in Toss documentation/MCP before SDK or review-flow changes.
Keep SDK imports in the wrapper/adapter, declare permission-gated Web APIs in
the game-owned config, and create a game-owned production wrapper instead of
shipping the kit reference wrapper.

### Reddit Devvit

Keep the app in `apps/target-devvit`, use official Devvit documentation/MCP,
and keep SDK calls behind the adapter or wrapper. Preserve separate lightweight
inline and expanded game modes, avoid trapping feed scroll, and validate login,
init, upload, and playtest with the generated scripts.

### Android and iOS

Use a game-owned Capacitor shell for production. Keep native plugin imports in
the shell, adapters, or native plugins; configure signing outside source
control. Validate the web game and effective target config before native store
packaging.

### Future targets

For Telegram, Tauri, or another platform, first add a target-config entry and
adapter behind `PlatformGateway`, then add build, smoke, agent manifest, and
acceptance coverage. Do not let a new SDK leak into existing game logic.

## Handoff evidence

Keep source revision, config, build/smoke results, gameplay evidence, target
preflight, artifact hashes, and target acceptance reports together. A generic
kit smoke test proves the reusable contract only; it does not replace
game-owned production credentials, deployment, signing, or store evidence.
