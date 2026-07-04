# Public Release Checklist

Use this before making the repository public or announcing a package release.

## Repository

- [ ] `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` are present.
- [ ] GitHub issue templates and the pull request template are present.
- [ ] `README.md` explains setup, validation, liveops, target config, and release flow.
- [ ] `.gitignore` excludes generated artifacts, local credentials, signing keys, and platform build output.
- [ ] No generated source-side `*.js` or `*.d.ts` files are present outside approved generated i18n runtime files.
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
pnpm graph:preflight
pnpm sampo:release:dry-run
pnpm build:web
pnpm smoke:target web-preview
```

## Release Artifacts

- [ ] For Android, run `pnpm build:android && pnpm smoke:target android`.
- [ ] For iOS, run `pnpm build:ios && pnpm smoke:target ios`.
- [ ] For Apps in Toss, run `pnpm build:ait && pnpm smoke:target ait`.
- [ ] Emulator smoke is optional but recommended for local release confidence.
