# Public Release Checklist

Use this before making the repository public or announcing a package release.

## Repository

- [ ] `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` are present.
- [ ] GitHub issue templates and the pull request template are present.
- [ ] `README.md` explains setup, validation, game-services, target config, and release flow.
- [ ] `.gitignore` excludes generated artifacts, local credentials, signing keys, and platform build output.
- [ ] No generated source-side `*.js` or `*.d.ts` files are present outside approved generated i18n runtime files.
- [ ] No generated release output is tracked under `artifacts/`, `release-output/`, `apps/target-ait/public/game/`, or `apps/mobile-capacitor/www/`.
- [ ] `pnpm validate:public` passes.

## Packages

- [ ] Publishable package metadata includes `description`, `license`, `repository`, `bugs`, `homepage`, and `keywords`.
- [ ] Publishable packages expose `dist/index.js` and `dist/index.d.ts`.
- [ ] Sampo changesets cover public package additions and behavior changes.
- [ ] `pnpm pack:packages` passes.

## Validation

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
pnpm build:web
pnpm smoke:target web-preview
```

## Manual Public Gates

- [ ] Run an external secret scanner such as `gitleaks detect --source .` before changing repository visibility.
- [ ] Confirm GitHub repository settings: branch protection, default branch, Actions permissions, issue/discussion settings, and repository topics.
- [ ] Confirm npm publishing settings: `NPM_TOKEN`, package access, provenance policy, and Sampo release automation permissions.
- [ ] Confirm Cloudflare Worker settings: account id, API token, D1 database binding, and whether `MPGD_STORE` should stay `memory` for demo-only deploys.
- [ ] Confirm Android release settings: package id, Google Play app, billing products, AdMob app/placement ids, signing keystore, and Play Games leaderboard ids.
- [ ] Confirm iOS release settings: bundle id, App Store app, StoreKit products, AdMob app/placement ids, signing credentials, and Game Center leaderboard ids.
- [ ] Confirm Apps in Toss release settings: app id, Toss product ids, Toss ad placement ids, review metadata, and release credentials.
- [ ] Confirm placeholder IDs in `packages/product-catalog/catalog.json`, `packages/ad-placements/placements.json`, and `apps/game-services-worker/wrangler.toml` are either intentionally sample-only or replaced.
- [ ] Confirm README/docs state that real Google Play Billing, StoreKit/App Store Server API, AdMob SSV, and Apps in Toss production verification adapters are not bundled yet.
- [ ] Confirm emulator smoke results are attached or explicitly skipped for the public release.

## Release Artifacts

- [ ] For Android, run `pnpm build:android && pnpm smoke:target android`.
- [ ] For iOS, run `pnpm build:ios && pnpm smoke:target ios`.
- [ ] For Apps in Toss, run `pnpm build:ait && pnpm smoke:target ait`.
- [ ] Emulator smoke is optional but recommended for local release confidence.

## Known Starter Limits

- The Game Services Worker is deployable, but the default config is a starter profile. Production persistence requires a D1 binding and `MPGD_STORE = "d1"`.
- Platform SDK callbacks are treated as evidence only. Production grants should add real Google Play, App Store, AdMob SSV, and Apps in Toss backend verification.
- Catalog and ad placement IDs are sample defaults until replaced by a game-specific release configuration.
- Emulator smoke currently checks install, launch, crash-free startup, screenshot capture, and embedded target config evidence. Full gameplay E2E remains a follow-up.
