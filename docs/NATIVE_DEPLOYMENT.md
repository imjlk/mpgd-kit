# Native test deployment planning

The installed `@mpgd/cli` can build game-owned Capacitor targets without a
Kit checkout. `mpgd deploy init`, `doctor`, and `plan` are the next layer: they
record test destinations and credential **references** in the game project,
check local prerequisites, and write a plan. They do not reserve version
numbers, build, sign, upload, or call either store. Store submission and
resumable state are later steps; a successful plan is not deployment evidence.

Start with `mpgd.targets.json` and a game-owned shell created by
`mpgd target init capacitor`. Keep the app ID and shell paths there, not in
the deployment config:

```sh
pnpm exec mpgd deploy init --game ./games/my-game
```

This creates `mpgd.deploy.json` once, without overwriting an existing file.
The `beta` profile uses a production build configuration targeting Play
internal testing and/or TestFlight. Its default approval policy is `manual`.
Credential fields contain environment variable **names**, never secret
values. Set `testGroup` in the iOS target profile to the exact internal
TestFlight group before planning iOS. The generated values are references,
not an indication that signing or store credentials have been verified.

```sh
pnpm exec mpgd deploy doctor --game ./games/my-game --profile beta
pnpm exec mpgd deploy plan --game ./games/my-game --profile beta \
  --targets android,ios --out ./release-plan.json
```

`doctor` checks the selected target config, game-owned shell, Node.js,
Java/Android SDK or Xcode, and whether signing and submission environment
references are present. It reports presence only; it does not inspect key
contents, authenticate to a store, or run a remote account check. On an
incomplete profile it exits nonzero with the configuration reason.

`plan` reads the target and deployment config, rejects unsupported or
conflicting combinations, and writes a new JSON file only at `--out`. It
includes config SHA-256 digests and destination metadata, but no credential
values. Existing output files are never overwritten. Planning works without
local platform toolchains or store access. Later deployment execution must
recheck the recorded digests against its inputs and must not treat the plan
as a version reservation.
