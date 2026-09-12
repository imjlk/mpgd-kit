# Runtime controls fixture

A small kit-only Phaser fixture with a gameplay counter and an independent UI
scene. It exercises the private execution controller, scoped UI bridge, lifecycle
binding, and Phaser scene binding. It is not a starter template or a migrated game.

```sh
pnpm install
pnpm --dir examples/runtime-controls dev
pnpm --dir examples/runtime-controls build
pnpm --dir examples/runtime-controls exec playwright install chromium
pnpm --dir examples/runtime-controls test:browser
```

Open settings, enter background, return to foreground, and close settings.
Gameplay must remain paused until the final block is released, while the UI
keeps updating and accepting input. Other controls independently hide gameplay
rendering, block gameplay input, or restart the gameplay scene. Hold RIGHT or
tap the square to exercise input; the reset callback clears held input on pause.

Use `?inactive=1` to start with an inactive lifecycle source. Lifecycle events and
the audio sink are injected fakes. Actual rendering, scene lifecycle, pointer and
keyboard input run in Phaser 4.2.0. No platform SDK, real advertisement, purchase,
or production endpoint is called.

`test:browser` starts an ephemeral local Vite server and Chromium, drives real
canvas controls, advances actual Phaser frames deterministically, and checks
initial inactivity, settings/background overlap, stale input, rendering-only
suppression, shutdown/restart listener counts, and external sleep/stop. Browser
errors fail the test. Screenshots and final state are written to ignored
`artifacts/browser/`. CI runs this as a separate real-browser acceptance step.

The fixture exposes `render_game_to_text()` and `advanceTime(ms)` for the
`develop-web-game` tool loop. Advancing manually stops automatic RAF and steps
the engine; reload to return to ordinary live play. Business operations and
their UI scopes are added by the later action-controller PR.
