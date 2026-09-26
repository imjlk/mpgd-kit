# Resumable native test deployment

`mpgd deploy` uses the game-owned Capacitor shells and the packaged Kit builder. It does not create a second native build engine or publish to production tracks. The first supported destinations are Google Play internal testing and an App Store Connect internal TestFlight group.

## Prepare the game

Commit `mpgd.targets.json`, `mpgd.deploy.json`, `pnpm-lock.yaml`, and the game source before a release. The selected profile uses a `production` build profile; the destination is still an internal test channel. Give the iOS target an existing internal TestFlight **group ID** in `testGroup`, not a display name. The release-state Git branch on the game's `origin` remote is the shared version ledger. For its first reservation, provide an explicit initial ledger; the command never guesses existing store version numbers.

```sh
pnpm exec mpgd deploy plan --game ./games/example --profile beta \
  --targets android,ios --out ./release-plan.json
pnpm exec mpgd deploy doctor --game ./games/example --profile beta
pnpm exec mpgd deploy run --plan ./release-plan.json \
  --game-id example --game-version 1.0.0 --release beta-001 \
  --initial-ledger ./initial-ledger.json --approve
pnpm exec mpgd deploy status --game ./games/example \
  --game-id example --release beta-001
pnpm exec mpgd deploy submit --plan ./release-plan.json \
  --game-id example --release beta-001 --target ios --approve
```

Only use `--initial-ledger` on the first release for that game ID. Later runs reuse the existing ledger. `run` reuses recorded builds and does not allocate a second version for the same release ID. `submit` never builds: it reads an immutable build record and verifies the stored artifact before calling the store. An Android committed edit or TestFlight-ready build is not submitted again. An unresolved remote result is preserved as `unknown`, not treated as success. If an artifact is missing, restore its original bytes from the release artifact archive; do not silently rebuild under the same immutable record.

## Credential references

`mpgd.deploy.json` names environment variables for each target's signing and submission credential. It does not contain keys. Additional required variables are:

| Target | Build signing | Store submission |
| --- | --- | --- |
| Android | `MPGD_ANDROID_UPLOAD_STORE_PASSWORD`, `MPGD_ANDROID_UPLOAD_KEY_ALIAS`, `MPGD_ANDROID_UPLOAD_KEY_PASSWORD`, `MPGD_ANDROID_UPLOAD_CERT_SHA256` | The profile's submission credential points to a Google service-account JSON file. |
| iOS | `MPGD_IOS_SIGNING_P12_PASSWORD`, `MPGD_IOS_PROVISIONING_PROFILE`, `MPGD_IOS_TEAM_ID` | `MPGD_ASC_BINARY`, `MPGD_ASC_APP_ID`, `MPGD_ASC_KEY_ID`, `MPGD_ASC_ISSUER_ID`; the profile's submission credential contains the ASC API private key as base64. |

The Android profile's signing credential points to its upload keystore file. The iOS profile's signing credential points to its P12 file. The ASC `.p8` API key is **not** the iOS app-signing key. Use `mise` or the game's CI secret store to supply variables at runtime; do not commit them to Git or put them in `release-plan.json`. `MPGD_ASC_BINARY` must refer to the pinned asc 5.5.0 binary, whose hash the CLI checks before executing it.

The CLI keeps only release IDs, hashes, artifact locations and remote edit/upload/build IDs in `release-state`; passwords and private keys are not stored there. A store call obtains a 20-minute submission lease so two CI jobs cannot start the same target submission concurrently. A command that returns `processing` or another nonterminal state relinquishes that lease for immediate status polling. If a process disappears mid-call, a later attempt waits for the lease to expire, then reuses the recorded remote ID. An `unknown` state without a remote ID requires operator reconciliation before another upload. The Git state branch records metadata, **not** AAB or IPA bytes; game CI must retain those artifacts for retry on a different runner.

## Evidence boundary

Mock store tests, packaged CLI tests and signed build inspections are separate from a real store result. A `processing` TestFlight status is not test-ready. Production App Review, public Play promotion, device installation and game-feature acceptance are outside these commands. The D-12 release gate requires actual game-owned signing keys, account access, upload/processing evidence and device verification; ordinary CI passing does not supply that evidence.
