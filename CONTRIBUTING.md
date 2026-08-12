# Contributing

Thanks for helping improve `mpgd-kit`. This repository is an early-stage
Multi-Platform Game Distribution / Development kit for Phaser games, so changes
should keep the reusable platform and game-services boundaries clear.

## Setup

```sh
pnpm install
pnpm check
pnpm test
pnpm graph:preflight
```

Use `pnpm dev:game` for the in-repo Phaser starter loop.

## Repository Roles

Keep kit contributor paths distinct from downstream game workflows:

- `packages/cli/templates/phaser-game` is initializer source. Change it when a
  newly generated game should receive different files or documentation.
- `examples/phaser-starter` is the checked-in regression fixture. Use it to
  exercise starter wiring and target builds while changing this repository.
- An external generated game is the user-facing product. Create it with
  `pnpm create @mpgd/game`; do not instruct users to copy the reference fixture.
- A multi-game workspace may place generated-game-shaped projects under
  `games/*` and add thin selection wrappers, but target configuration and
  external app ownership remain per game.

See [Game Project Models](docs/GAME_PROJECT_MODELS.md) for the full command and
deployment split.

For day-to-day work on the permanent reference fixture:

```sh
pnpm dev:game
pnpm --dir examples/phaser-starter check
pnpm --dir examples/phaser-starter build
pnpm graph:starter
```

To inspect a newly generated project inside this repository, use `--workspace`
and a disposable path rather than turning that project into release guidance:

```sh
pnpm mpgd game create examples/my-game --title "My Game" --workspace --kit-path .
pnpm --dir examples/my-game install --filter . --filter ./apps/target-devvit
pnpm --dir examples/my-game exec mpgd game accept . \
  --targets default \
  --profile staging \
  --kit-path ../..
```

## Development Rules

- Keep game rules outside Phaser scenes where practical.
- Do not call platform SDKs directly from scenes. Use `PlatformGateway`.
- Do not grant purchases or ad rewards from client callbacks alone. Grants must
  go through backend verifier or ledger APIs.
- Do not introduce Cocos Creator or React Native as the mobile baseline.
- Use `ttsx` through `node tools/run-ttsx.mjs` for TypeScript scripts.
- Use `ttsc` and `@ttsc/lint`; do not add ESLint or Prettier for TypeScript.
- Run `pnpm graph:preflight` after changing broad TypeScript flows.

## Before Opening a Pull Request

```sh
pnpm validate:public
pnpm check
pnpm test
pnpm validate:catalog
pnpm validate:ads
pnpm validate:target-config
pnpm validate:effective-config
pnpm validate:targets
pnpm smoke:game-services
pnpm smoke:game-services:worker
pnpm graph:preflight
pnpm sampo:release:dry-run
```

For target changes, also run the focused build/smoke command, such as
`pnpm build:web && pnpm smoke:target web-preview`.

## Changesets

This repository uses Sampo for SemVer and changelog entries. Add or update a
changeset when public package behavior, package contents, or documentation
changes in a release-relevant way.
