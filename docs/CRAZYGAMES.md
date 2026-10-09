# CrazyGames target

The CrazyGames target builds a Phaser game as a non-installable HTML5 upload. It uses `@mpgd/adapter-browser/crazygames`, loads the official [HTML5 v3 SDK](https://docs.crazygames.com/sdk/intro/), and initializes it before calling platform methods. The adapter is isolated from pure packages and Phaser scenes.

```sh
pnpm build:crazygames
pnpm smoke:target crazygames
```

Generated games include the target in `mpgd.targets.json`. Build through the CLI with a local kit checkout:

```sh
pnpm mpgd target build crazygames --targets-file ./mpgd.targets.json --kit-path /path/to/mpgd-kit
pnpm mpgd target smoke crazygames --targets-file ./mpgd.targets.json --kit-path /path/to/mpgd-kit
```

The output directory is `artifacts/crazygames`, with `index.html` at its root. Create a ZIP from the directory's contents for the developer portal; keep the enclosing directory outside the archive. Portal submission, live advertising approval, and device testing require the game's developer account.

## Launch and monetization

`crazyGamesLaunch` defaults to `"basic"`. Basic Launch keeps all ads and purchases disabled. After receiving Full Launch approval, set it to `"full"` in the CrazyGames entry of `mpgd.targets.json` and rebuild. See the official [launch requirements](https://docs.crazygames.com/requirements/intro/).

Full Launch supports configured interstitial placements through the SDK's `midgame` advertising API. The catalog maps `STAGE_END_INTERSTITIAL` to `midgame`; the adapter accepts only configured logical placement IDs. Games still own appropriate break placement and frequency policy.

Rewarded ads, banners, IAP, authenticated account identity, and platform leaderboards are unavailable in this integration. SDK reward callbacks are not independent backend evidence and must never grant inventory. A future rewarded integration needs a trusted verification path and backend ledger settlement before enabling that capability.

SDK environment `local` uses CrazyGames' test overlays. It does not certify real ad delivery. `disabled`, script blocking, or initialization failure keep the game playable and make platform advertising unavailable. Local saves use the browser storage port; this integration does not enable the SDK Data Module or promise account synchronization.

## Game activity and advertising ownership

The game-owned runtime reports loading start, loading stop before first playable scene, and gameplay start/stop through `PlatformGateway.gameActivity`. Starters enter free play directly for this target. Gameplay scopes dispose with their scene and share the game's execution controller, so menus, settings, and native presentation pauses retain independent ownership.

CrazyGames handles focus changes itself, so the runtime suppresses focus-only SDK gameplay transitions while continuing to pause simulation, input, and audio locally. Explicit scene pauses and sleep still end logical gameplay. The gateway also exposes host audio policy through `gameSettings`: SDK `muteAudio` changes own a separate audio block, so in-game sound controls cannot override the host. See [game activity requirements](https://docs.crazygames.com/sdk/game/).

The v2 advertising provider observes `adStarted`, `adFinished`, and `adError`. A documented load rejection before start releases native ownership. An error after start, an unknown error, or a thrown request keeps presentation uncertain and prevents another native request. Only a later physical finish releases that ownership. A caller timeout is not a cancellation. See [video ads](https://docs.crazygames.com/sdk/video-ads/).

## Submission verification

Build and smoke commands reject root-relative or remote asset references in `index.html`, non-regular artifact entries, more than 1,500 files, and total uploaded size over 250 MB. Vite emits bundled assets with relative paths, and the target omits an installable web app manifest.

The artifact check does not prove initial download size: profile the submitted game in the portal before release. CrazyGames requires initial downloads within 50 MB on desktop and 20 MB on mobile; the first gameplay-start event marks that boundary. Test live initialization, first play, menu transitions, focus behavior, and ad completion on supported devices. See [technical requirements](https://docs.crazygames.com/requirements/technical/).
