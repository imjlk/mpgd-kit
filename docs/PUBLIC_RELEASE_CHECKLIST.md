# Public Release Checklist

Use this before making the repository public or announcing a package release.

## Current Public Repo Status

- GitHub repository visibility is public.
- GitHub topics are set for Phaser, Vite, TypeScript, Capacitor, Apps in Toss,
  Cloudflare Workers, and game development discovery.
- GitHub Issues, Discussions, and security policy are enabled.
- The main branch has force-push and delete protection enabled.
- Required PR checks and required reviews are not enforced yet. Keep this as an
  explicit follow-up once the public contribution flow is settled.
- `gitleaks detect --source . --redact --verbose` was run before public polish
  work and reported no leaks.
- npm publishing policy is trusted publishing/OIDC with provenance. Token-based
  publishing should be treated as a fallback, not the default path.

## Repository

- [ ] `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` are present.
- [ ] GitHub issue templates and the pull request template are present.
- [ ] `README.md` explains setup, validation, game-services, target config, and release flow.
- [ ] `.gitignore` excludes generated artifacts, local credentials, signing keys, and platform build output.
- [ ] No generated source-side `*.js` or `*.d.ts` files are present outside approved generated i18n runtime files.
- [ ] No generated release output is tracked under `artifacts/`, `release-output/`, `apps/target-ait/public/game/`, `apps/target-devvit/dist/`, or `apps/mobile-capacitor/www/`.
- [ ] `pnpm validate:public` passes.

## Packages

- [ ] Publishable package metadata includes `description`, `license`, `repository`, `bugs`, `homepage`, and `keywords`.
- [ ] Publishable packages expose `dist/index.js` and `dist/index.d.ts`.
- [ ] Sampo changesets cover public package additions and behavior changes.
- [ ] PRs merging to `main` explicitly include a Sampo changeset when they change a published package contract, or state why no changeset is needed.
- [ ] New publishable npm packages are registered with one local initial publish before being merged as publishable packages. Keep unfinished new packages private until that registration is complete.
- [ ] New publishable package PRs include the package in `.sampo/config.toml` release groups once initial publish and OIDC readiness are done, or intentionally keep the package private.
- [ ] npm Trusted Publishing/OIDC is configured per package for `.github/workflows/release.yml` before relying on automated publishes.
- [x] `@mpgd/adapter-devvit` has been initial-published locally and verified with `npm view @mpgd/adapter-devvit version` before the first automated Devvit adapter release.
- [x] `@mpgd/adapter-devvit` npm Trusted Publishing/OIDC is configured for `.github/workflows/release.yml` before adding it to the Sampo fixed release group.
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
pnpm build:devvit
pnpm smoke:target reddit
```

## Manual Public Gates

- [ ] Run an external secret scanner such as `gitleaks detect --source .` before changing repository visibility.
- [ ] Confirm GitHub repository settings: branch protection, default branch, Actions permissions, issue/discussion settings, and repository topics.
- [ ] Confirm npm publishing settings: package access, local initial publish for new packages, OIDC trusted publishing, provenance policy, and Sampo release automation permissions. Use token-based publishing only for the initial registration or a documented fallback path.
- [ ] Confirm Cloudflare Worker settings: account id, API token, D1 database binding, and whether `MPGD_STORE` should stay `memory` for demo-only deploys.
- [ ] Confirm Android release settings: package id, Google Play app, billing products, AdMob app/placement ids, signing keystore, and Play Games leaderboard ids.
- [ ] Confirm iOS release settings: bundle id, App Store app, StoreKit products, AdMob app/placement ids, signing credentials, and Game Center leaderboard ids.
- [ ] Confirm Apps in Toss release settings: app id, Toss product ids, Toss ad placement ids, review metadata, and release credentials.
- [ ] Confirm Reddit Devvit release settings: app name, test subreddit, Devvit login state, Redis usage, and whether playtest/upload/publish are intentionally local-only.
- [ ] Confirm placeholder IDs in `packages/catalog/catalog.json`, `packages/catalog/placements.json`, and `apps/game-services-worker/wrangler.toml` are either intentionally sample-only or replaced.
- [ ] Confirm README/docs state that real Google Play Billing, StoreKit/App Store Server API, AdMob SSV, and Apps in Toss production verification adapters are not bundled yet.
- [ ] Confirm emulator smoke results are attached or explicitly skipped for the public release.

## Release Artifacts

- [ ] For Android, run `pnpm build:android && pnpm smoke:target android`.
- [ ] For iOS, run `pnpm build:ios && pnpm smoke:target ios`.
- [ ] For Apps in Toss, run `pnpm build:ait && pnpm smoke:target ait`.
- [ ] For Reddit Devvit, run `pnpm build:devvit && pnpm smoke:target reddit`.
- [ ] Emulator smoke is optional but recommended for local release confidence.

## Known Starter Limits

- The Game Services Worker is deployable, but the default config is a starter profile. Production persistence requires a D1 binding and `MPGD_STORE = "d1"`.
- Platform SDK callbacks are treated as evidence only. Production grants should add real Google Play, App Store, AdMob SSV, Apps in Toss, and Devvit payment/reward backend verification.
- Catalog and ad placement IDs are sample defaults until replaced by a game-specific release configuration.
- Emulator smoke currently checks install, launch, crash-free startup, screenshot capture, and embedded target config evidence. Full gameplay E2E remains a follow-up.
