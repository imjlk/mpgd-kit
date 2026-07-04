# Contributing

Thanks for helping improve `mpgd-kit`. This repository is an early-stage
Multi-Platform Game Distribution / Development kit for Phaser games, so changes
should keep the reusable platform and liveops boundaries clear.

## Setup

```sh
pnpm install
pnpm check
pnpm test
pnpm graph:preflight
```

Use `pnpm dev:game` for the Phaser demo loop.

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
pnpm graph:preflight
pnpm sampo:release:dry-run
```

For target changes, also run the focused build/smoke command, such as
`pnpm build:web && pnpm smoke:target web-preview`.

## Changesets

This repository uses Sampo for SemVer and changelog entries. Add or update a
changeset when public package behavior, package contents, or documentation
changes in a release-relevant way.
