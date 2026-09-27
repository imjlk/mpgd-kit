# Game-owned native deployment CI

`mpgd deploy workflow init` writes one non-overwriting GitHub Actions workflow into the **game repository**, not the Kit repository. It calls the same installed `mpgd deploy plan` and `mpgd deploy run` commands used locally. Run it after configuring game-owned Android/iOS shells and a deployment profile:

```sh
pnpm exec mpgd deploy workflow init \
  --game ./games/alpha --profile beta --targets android,ios \
  --release-branch main --approval-environment protected-beta
```

The selected game workspace must declare `@mpgd/cli` in its committed pnpm lockfile. The generated commands execute from that workspace, not the repository root. The generator accepts a single-game repository (`--game .`) or a selected `games/*` path, rejects unsafe Git/workflow paths, and does not overwrite an existing workflow. For generated CI, profile credential environment names must use distinct, unreserved `MPGD_` names; local CLI profiles can use other names. Review the generated file before committing it. The release branch input must be the branch on which maintainers intentionally dispatch signed builds.

## Protection and credentials

**Configure the named GitHub Environment with required reviewers and the intended release-branch restriction before enabling manual dispatch.** A workflow's `environment:` line alone does not establish an approval policy. The generated deployment jobs also check the exact branch, run only on `workflow_dispatch`, serialize each app/target, and receive `contents: write` only to update the game-owned `release-state` branch. The pull-request job has `contents: read`, creates a read-only plan, and optionally runs the game's `test:deploy-mock` script; it receives no signing or store secrets. It runs for every PR so changes to shared workspace dependencies cannot silently skip validation. Never change the deployment job to `pull_request_target` or run untrusted PR code with these credentials.

The generated secret names are prefixed with the uppercase game slug visible in the workflow (for example, `MPGD_GAMES_ALPHA_<HASH>`). Put each secret in the protected Environment or another deliberately scoped GitHub secret store:

| Target | Secret suffixes |
| --- | --- |
| Both | `NPM_READ_TOKEN` only when the committed `.npmrc` needs private registry access |
| Android | `ANDROID_KEYSTORE_B64`, `PLAY_SERVICE_ACCOUNT_B64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_CERT_SHA256` |
| iOS | `IOS_P12_B64`, `IOS_PROFILE_B64`, `IOS_P12_PASSWORD`, `IOS_TEAM_ID`, `ASC_API_KEY_B64`, `ASC_APP_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID` |

File secrets are single-line base64 of the game-owned files. The workflow restores them in a private temporary directory for the deployment step, unsets the base64 inputs before launching the CLI, and removes the directory afterward. The iOS job downloads the selected `asc` 5.5.0 asset; the installed CLI verifies its reviewed SHA-256 before use. The workflow grants the detached release-state Git operation a short-lived GitHub token header and removes that header and token from dependency-install/native-build and asc submission subprocesses. A private-registry token is passed to the pinned dependency install, then excluded from the native build subprocess. These controls do not make arbitrary game build scripts a security sandbox: protect the release branch and review code before dispatch.

## Dispatch and resume

The dispatch inputs choose a target, a unique release label, the game version, and optionally a committed repository-relative initial-ledger path. The workflow appends `-android` or `-ios` to the release label, so each target has an explicit independent release key and version reservation. Set `initial_ledger` only when creating the first release-state ledger for that game ID; inspect real store counters first. A release plan is written under `$RUNNER_TEMP` so the game's Git checkout remains clean for HEAD pinning.

The workflow stores each inspected AAB/IPA and its release manifest together in one release artifact for 30 days. This prevents one half of a paired upload from succeeding while the other fails. The release-state branch stores hashes and remote IDs, **not binary bytes**. For a later runner to resume an existing release, dispatch with the same release/target/version and set `artifact_run_id` to a successful run containing the paired release artifact. The generated download step restores the exact binary and manifest; the CLI verifies their recorded hashes before submission and refuses a substituted file. Restored files are not re-uploaded when the release already has a build record; if the restore run creates a new immutable build record, it retains that newly built pair under the new run ID. The workflow refuses a game that tracks `.mpgd` output and adds a checkout-local Git exclude before restoring artifacts, so the fixed-input preflight still sees a clean checkout. If the paired artifact upload itself fails completely, recover the exact bytes from a game-owned archive or retained runner before retrying; a fresh runner cannot reconstruct an already recorded signed build. Intermediate build files are not retained because no later step consumes them.

PR validation, a generated workflow, and mock store calls do not prove signed builds, Play internal-track processing, TestFlight readiness, or device installation. Keep those results as separate game-owned release evidence before treating the native deployment feature as production-ready.
