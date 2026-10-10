# Apps in Toss SDK 3 release checklist

MPGD Apps in Toss wrappers use SDK 3 only. Generated games contain
`apps/target-ait/apps-in-toss.config.ts`; SDK 2 `granite.config.ts` wrappers are
not supported.

## Configuration contract

The wrapper configuration owns only the SDK 3 fields:

- `appName`
- `brand.primaryColor`
- `permissions`
- `webView`
- `webBundleDir`

The app display name and icon are managed in the Apps in Toss console. Vite and
AIT commands live in `apps/target-ait/package.json`; its `build` script builds
the web bundle and then runs `ait build`.

## CORS origins

Before QR or production testing, allow all four exact origins on every backend
used by the mini-app:

```text
https://<appName>.web.tossmini.com
https://<appName>.private-web.tossmini.com
https://<appName>.apps.tossmini.com
https://<appName>.private-apps.tossmini.com
```

The `web` pair is used by the released service and console QR tests; SDK 3.x
bundles can also send requests from the `apps` pair. Do not use a wildcard when
the backend supports an explicit allowlist. A server can build the list from
the app name without importing the Apps in Toss SDK:

```ts
import { aitBrowserOrigins, isAitBrowserOrigin } from '@mpgd/adapter-ait/origins';

const allowedOrigins = aitBrowserOrigins(env.AIT_APP_NAME);
const allowed = isAitBrowserOrigin(env.AIT_APP_NAME, request.headers.get('Origin'));
```

`aitBrowserOrigins()` lower-cases the app name and rejects anything that is not
a single DNS label.

## Release gate

1. Build the target and retain the generated `.ait` and release manifest.
2. Upload the bundle to the Apps in Toss console.
3. Exercise identity, Storage, share, Game Center, ads, purchases, and every
   backend request through the Toss-app QR test appropriate to the game.
4. Confirm all four origins receive the expected CORS headers.
5. Publish only after the QR run succeeds.

An app that has released an SDK 3 bundle cannot roll back to an SDK 2 bundle.
Keep SDK 2 production traffic unchanged until the SDK 3 release candidate has
passed the complete QR and backend verification gate.

Official reference: [SDK 3.x migration](https://developers-apps-in-toss.toss.im/bedrock/reference/framework/%EC%8B%9C%EC%9E%91%ED%95%98%EA%B8%B0/SDK3.0.html).
