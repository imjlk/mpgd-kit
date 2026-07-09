# Phaser Starter Brief

Use this brief when asking an agent to build a new game from `examples/phaser-starter`.

## Game

- Working title:
- Player fantasy:
- Primary verbs:
- Win or progression condition:
- Loss, reset, or fail condition:
- Camera model:
- Input actions:
- Orientation policy: responsive / prefer-landscape / prefer-portrait / lock-landscape / lock-portrait

## Platform Targets

- Browser preview:
- Microsoft Store PWA:
- Android Capacitor:
- iOS Capacitor:
- Apps in Toss:
- Reddit Devvit:
- Future targets:

## Reusable Blocks

Prefer capability-named blocks. Examples:

- `runtime.scene.shell`
- `simulation.loop.phase`
- `platform.gateway.target-config`
- `services.backend.game-services`

Do not name blocks after existing games or brands.

## Required mpgd Wiring

- `PlatformGateway`
- effective target config
- target viewport and orientation policy
- i18n locale resolution
- optional game-services backend client
- asset manifest keys

## Acceptance

- `pnpm validate:starter-workflow`
- `pnpm --dir examples/phaser-starter check`
- `pnpm --dir examples/phaser-starter build`

Manual playtest:

- Open the starter.
- Verify the target, player, effective config summary, and backend mode render.
- Verify the viewport orientation policy renders and does not assume hard locking in WebViews.
- Start the play scene.
- Verify the simulation loop advances without scene-local gameplay rules becoming the source of truth.
