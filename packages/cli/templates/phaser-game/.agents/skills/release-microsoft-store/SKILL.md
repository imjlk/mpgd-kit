---
name: release-microsoft-store
description: Prepare, package, and verify this game's Microsoft Store PWA release. Use when configuring Store identity or listing data, building the microsoft-store target, running submission preflight, generating a PWABuilder package ZIP, inspecting MSIX/AppX bundles, collecting optional WACK evidence, or preparing Partner Center submission evidence.
---

# Release to Microsoft Store

Read `docs/MPGD_KIT_WORKFLOWS.md`, `mpgd.microsoft-store.json`, and the
`microsoft-store` entry in `mpgd.targets.json`. If the target is absent, stop
and run `pnpm exec mpgd target init microsoft-store --game .` before editing
Store-specific files.

## Prepare the PWA

1. Replace every placeholder in `mpgd.microsoft-store.json` with the reserved
   Partner Center identity, publisher, listing, age-rating, privacy, and
   screenshot data.
2. Keep the web manifest ID, start URL, scope, orientation, icons, and deployed
   URL aligned with the game-owned PWA.
3. Generate and verify production icons with `pnpm icons:generate` and
   `pnpm icons:verify`.
4. Run `pnpm build:microsoft-store`, `pnpm smoke:microsoft-store`, and
   `pnpm preflight:microsoft-store`. Fix warnings that reflect missing
   submission inputs; retain the resulting preflight JSON and Markdown.

## Generate and accept packages

1. Deploy the exact bytes that passed preflight. Do not rebuild between
   preflight, deployment, and package generation.
2. Set `PWA_URL` and `MANIFEST_URL` to the public production endpoints, then
   run:

   ```sh
   pnpm package:microsoft-store -- \
     --pwa-url "$PWA_URL" \
     --manifest-url "$MANIFEST_URL" \
     --package-version <four-part-version> \
     --classic-version <lower-four-part-version>
   ```

3. Keep `release-input/microsoft-store/pwabuilder-package.zip` together with
   `release-output/microsoft-store/package-generation.json` and `.md`.
4. On Windows with the current SDK, inspect the generated MSIX/AppX bundles
   using:

   ```sh
   pnpm exec mpgd target accept-package microsoft-store \
     --packages <game-relative-package-paths>
   ```

   Keep `package-acceptance.json` and `.md`.
5. Treat WACK as optional recommended evidence. Pass `--appcert
   <path-to-appcert.exe>` only when the active Windows environment can run it;
   do not block otherwise valid package acceptance solely because WACK was not
   run.

Require identity, version, signature, payload, submission-evidence, and package
hash checks to pass before Partner Center submission. Never grant purchases
from client callbacks; add Store commerce only through a dedicated adapter and
backend ledger verification.
