# Game Project Models

`mpgd-kit` supports the same target contracts from different repository
layouts. Choose the model based on project ownership, not on the target being
built. The public kit does not require an organization-specific package scope
or workspace name.

## Choose a Model

| Model | Use it when | Public command entrypoint | Product owner |
| --- | --- | --- | --- |
| Single-game repository | One repository releases one game | `pnpm exec mpgd ...` from the game root | The game repository |
| Multi-game workspace | One repository releases several games and may share private packages or services | `pnpm exec mpgd ... --targets-file games/<game>/mpgd.targets.json`, optionally behind thin workspace wrappers | Each `games/<game>` project |
| Kit contributor checkout | You are changing the CLI, packages, adapters, templates, or target builders | Repository scripts and `examples/phaser-starter` | `mpgd-kit` maintainers |

These models share a boundary: `mpgd-kit` supplies reusable CLI, adapter,
configuration, build, smoke, and evidence contracts. A game owns its identity,
content, target wrappers, production credentials, console records, and release
decision.

## Single-Game Repository

A generated game is self-contained:

```text
my-game/
  apps/
    target-ait/
    target-devvit/
    target-cloudflare-pages/  # when selected
  src/
  agent/
  artifacts/
  mpgd.game.json
  mpgd.targets.json
  mpgd.target-config.json     # optional additive policy
  package.json
```

Create and validate it from outside the kit checkout:

```sh
pnpm create @mpgd/game my-game
cd my-game
pnpm install
pnpm check
pnpm build

pnpm exec mpgd target build-all \
  --targets-file ./mpgd.targets.json \
  --targets web,ait,reddit \
  --profile staging \
  --ait-variant wrapper \
  --kit-path ../mpgd-kit
pnpm exec mpgd target smoke-all \
  --targets-file ./mpgd.targets.json \
  --targets web,ait,reddit \
  --kit-path ../mpgd-kit
```

The game root is the authority for target paths and generated evidence. Use a
clean released kit checkout for production artifacts, and record both the game
revision and kit revision in release provenance.

## Multi-Game Workspace

A workspace adds discovery, shared private code, and release coordination
without changing the kit's target contract:

```text
game-workspace/
  apps/                 # deployable shared or game-owned services
  games/
    puzzle-one/
      apps/target-*/
      artifacts/
      src/
      mpgd.game.json
      mpgd.targets.json
    puzzle-two/
      ...
  packages/             # optional workspace-private shared packages
  tools/                # optional thin dispatch and acceptance wrappers
  package.json
```

Call the public CLI with the selected game's target file:

```sh
pnpm exec mpgd target build-all \
  --targets-file ./games/puzzle-one/mpgd.targets.json \
  --targets web,ait,reddit \
  --profile staging \
  --ait-variant wrapper \
  --kit-path ../mpgd-kit
pnpm exec mpgd target smoke-all \
  --targets-file ./games/puzzle-one/mpgd.targets.json \
  --targets web,ait,reddit \
  --kit-path ../mpgd-kit
```

A workspace may expose shorter commands such as:

```text
game:check <game>
game:accept <game>
target:build <game> <target> <profile>
target:build-all <game> --targets <targets>
target:smoke <game> <target>
target:smoke-all <game> --targets <targets>
```

Those commands are workspace conveniences. They should resolve the game,
expand the configured kit path, and delegate to the public CLI or kit target
builder. They must not introduce a second target schema, silently replace
game-owned configuration, or omit the game and kit revisions from provenance.

Shared code does not imply shared product identity. Each game continues to own:

- `mpgd.game.json`, `mpgd.targets.json`, and additive runtime policy;
- Apps in Toss, Devvit, native, web, and store wrapper directories;
- product IDs, placement IDs, package identities, app records, and signing;
- release artifacts, target smoke evidence, and deployment history;
- game-specific server verification and authoritative grant policy.

## Kit Contributor Checkout

The kit repository has two internal representations that downstream users
should not copy directly:

- `packages/cli/templates/phaser-game` is the source consumed by the game
  initializer.
- `examples/phaser-starter` is the checked-in reference fixture used to test
  starter and target behavior while changing the kit.

Use `--workspace` only when generating a temporary game inside the kit
workspace:

```sh
pnpm install
pnpm mpgd game create examples/my-game --title "My Game" --workspace --kit-path .
pnpm --dir examples/my-game install --filter . --filter ./apps/target-devvit
pnpm --dir examples/my-game exec mpgd game accept . \
  --targets default \
  --profile staging \
  --kit-path ../..
```

For the permanent reference fixture, use repository-maintainer commands:

```sh
pnpm dev:game
pnpm --dir examples/phaser-starter check
pnpm --dir examples/phaser-starter build
pnpm graph:starter
```

These are kit regression commands, not the recommended entrypoint for releasing
a downstream game.

## Build Is Not Deployment

Target build and smoke commands produce and validate artifacts. They do not
create external app records, activate a release, or submit a store review.

| Target | Kit responsibility | Game or workspace responsibility |
| --- | --- | --- |
| Web or Cloudflare Pages | Build the web/PWA artifact, effective config, and evidence | Own the Pages project or other host, deploy the exact artifact, and run production-origin smoke tests |
| Apps in Toss | Build and validate the game-owned wrapper and `.ait` artifact | Own the console app, credentials, metadata, promotion and product records, upload, and review submission |
| Reddit Devvit | Build and validate the game-owned Devvit wrapper | Own the Reddit app name, upload, playtest, publish, and App Directory lifecycle |
| Microsoft Store | Build the PWA target and provide preflight, package-generation, and acceptance commands | Host the exact PWA, own Partner Center identity and listing data, run Windows acceptance, and submit packages |
| Android and iOS | Build through the configured game-owned shell and record target evidence | Own bundle or package identity, signing, store metadata, upload, review, and rollout |

Keep external mutations behind explicit game-owned scripts. A workspace may
coordinate those scripts, but a generic `build-all` must remain safe to run
without publishing, promoting, or submitting anything.

## Production Checklist

Regardless of repository model:

1. Select a clean game revision and a clean released kit revision.
2. Validate game metadata and effective target configuration.
3. Build one target or a shared-identity target matrix.
4. Run target smoke and game-owned gameplay acceptance.
5. Preserve artifact hashes and game/kit provenance.
6. Deploy the unchanged reviewed artifact with a target-owned command.
7. Smoke the immutable deployment and stable production entrypoint.
8. Submit or promote only after the external checks pass.
9. Record the external deployment, review, and rollback evidence with the game.

See the target-specific runbooks for platform requirements. Repository layout
changes command routing and ownership organization; it does not weaken any
target's release gates.
