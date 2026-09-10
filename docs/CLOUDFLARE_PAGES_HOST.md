# Cloudflare Pages Host Runbook

`@mpgd/bridge/cloudflare-pages` provides a Pages advanced-mode host helper for
game-owned legal/support microsites and optional same-origin APIs. It is a host
option for targets that do not provide native server resources; it does not
replace target SDK adapters such as Apps in Toss or Devvit.

## Responsibility Split

- Apps in Toss SDK features, including its leaderboard API, belong in the AIT
  wrapper/adapter behind `PlatformGateway`.
- Devvit SDK, Redis, and Reddit leaderboard behavior belong in the Devvit
  wrapper/adapter behind the same bridge contract.
- Cloudflare Pages advanced mode serves static legal pages and can expose
  same-origin `/api/*` routes for web/PWA targets.
- Authoritative purchase, rewarded ad, and leaderboard grants still go through
  `@mpgd/game-services`.

Game scenes should continue to depend on `PlatformGateway` and game-services
clients, not platform SDKs, Devvit APIs, Cloudflare bindings, or store APIs.

## Starter Layout

New Phaser starters include:

```txt
legal/
  privacy.html
  support.html
  terms.html
apps/target-cloudflare-pages/
  src/worker.ts
  vite.config.ts
  wrangler.jsonc
```

The legal sources are HTML documents, not Markdown. Build them into stable
Cloudflare Pages static assets:

```sh
pnpm legal:build
pnpm legal:check
```

The output directory is `artifacts/legal-site`:

```txt
artifacts/legal-site/
  privacy/index.html
  support/index.html
  terms/index.html
  _headers
  _redirects
  legal-site.json
```

## Pages Advanced Mode

The starter worker is TypeScript source. Vite bundles it into the Cloudflare
Pages advanced-mode output file, `dist/_worker.js`, and copies
`artifacts/legal-site` into the same `dist` directory.

```sh
pnpm pages:build
pnpm pages:dev
```

The default worker routes:

- `/api/mpgd/bridge`: JSON bridge endpoint
- `/api/mpgd/rpc`: bridge oRPC endpoint
- `/api/game-services/*`: optional proxy to a `GAME_SERVICES` service binding
- all other paths: `env.ASSETS.fetch(request)` for static legal pages

Bind a game-services Worker in `apps/target-cloudflare-pages/wrangler.jsonc`
when the Pages host should proxy authoritative backend APIs:

```jsonc
"services": [
  {
    "binding": "GAME_SERVICES",
    "service": "mpgd-game-services"
  }
]
```

The default Pages bridge reports no native IAP, ads, or leaderboard UI. Targets
with native SDK capabilities should implement those capabilities in their own
adapter/wrapper and set target-config availability accordingly.
It also leaves player identity anonymous and cloud save unavailable by default.
Use a custom bridge handler only after adding authenticated identity or session
verification; do not derive save ownership from a client-controlled header.

## Deployment

Local validation does not require a Cloudflare account:

```sh
pnpm pages:build
pnpm --dir apps/target-cloudflare-pages run preview
```

Deploy only after replacing the template legal content and configuring a stable
Pages project name:

```sh
pnpm --dir apps/target-cloudflare-pages run deploy
```

Use stable URLs in game metadata, for example:

```json
{
  "game": {
    "supportUrl": "https://example.pages.dev/support/",
    "privacyPolicyUrl": "https://example.pages.dev/privacy/"
  }
}
```

## Verifying a hosted PWA deployment

When a game merges its verified Microsoft Store PWA artifact into a Cloudflare
Pages deployment directory, `mpgd target verify-deployment` checks the merge
before anything ships. The command is read-only: it never modifies the source
artifact or the deployment directory.

The deployment directory is expected to be assembled by a game-owned merge
pipeline that combines the Microsoft Store PWA artifact with the reviewed host
configuration: the Pages worker, `_routes.json` for one of the two reviewed
profiles, and the PWA cache-policy `_headers`/`_redirects` files described
below. The starter's `pnpm pages:build` output alone is **not** such a
deployment: it contains only the legal-site copy, the generated legal
`_redirects` (including its root redirect), a single generic `_headers` block,
and no `_routes.json`, so running this command against it correctly fails.
Games replicate the reviewed configuration in their wrapper repositories (as
mpgd-games does) and verify that merged directory.

```sh
mpgd target verify-deployment microsoft-store \
  --source-artifact-root artifacts/microsoft-store \
  --deployment-root apps/target-cloudflare-pages/dist \
  --host cloudflare-pages \
  --profile api-only \
  --report-dir release-output/cloudflare-pages
```

The verification:

- re-validates the source artifact against its own `pwa-release.json` release
  evidence by recomputing the precache revision from the actual file bytes;
- requires every source artifact file to exist in the deployment directory
  with an identical sha256 digest, so tampered or missing game files, service
  workers, manifests, icons, and hashed assets fail loudly;
- classifies deployment-only files: the Pages worker, `_headers`,
  `_redirects`, `_routes.json`, `wrangler.jsonc`, and the pages declared by
  `legal-site.json` are recognized host files, while anything else is rejected
  as probable cross-build contamination;
- resolves every local `index.html` reference inside the deployment root and
  rejects path escapes and symlink escapes;
- checks `_routes.json` against one of the two reviewed routing profiles:
  `api-only` (worker handles `/api/*`) and `api-canonical-index` (worker also
  handles `/index.html`). Broader worker routes are rejected;
- parses `_headers` and `_redirects` (CRLF or LF, comments, duplicate blocks)
  and evaluates the effective `Cache-Control` per path under the documented
  Cloudflare semantics — matching blocks apply in file order, duplicate
  headers comma-join, and `!` removal directives clear the header. Required
  policies: immutable long cache for content-hashed `assets/*`, `no-store`
  for `service-worker.js` and stable-name `icons/*`, and
  `max-age=0, must-revalidate` for the index, manifest, release evidence, and
  other fresh metadata files;
- rejects redirects that move the game root or PWA-critical files.

The command writes `hosted-pwa-verification.json` and
`hosted-pwa-verification.md` evidence files and exits non-zero on any failure.

### Verified and not verified

This command verifies static deployment files only. It does not verify the
Pages worker runtime behavior (exercise it with `wrangler pages dev` or the
wrapper `pages:preview` script), does not deploy anything, and does not
validate CDN or account-level cache settings outside the deployment directory.
The two routing profiles are the reviewed mpgd configurations, not a claim
about all Cloudflare Pages projects. The legal-only Pages starter carries no
PWA files, so this command does not apply to it.

### Hosted-PWA smoke

`pnpm smoke:cli-hosted-pwa-deployment` runs the regression suite covering
faithful merges, tampered JavaScript, missing files, wrong cache blocks,
conflicting header combinations, CRLF equivalence, route mismatches, rejected
options, path and symlink escapes, legal-only deployments, local static
serving, and the read-only guarantee.
