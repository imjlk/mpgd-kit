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
