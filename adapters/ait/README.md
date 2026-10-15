# Apps in Toss adapter

The adapter keeps the official Apps in Toss SDK at the host boundary. Games use
`PlatformGateway` rather than importing platform SDKs.

## Anonymous server authentication

```ts
import { createAitAnonymousAuthCode } from '@mpgd/adapter-ait/anonymous-auth';
const { code } = await createAitAnonymousAuthCode();
// Immediately send code to your game authority over HTTPS.
```

This host-only entry delegates to `@ait-kit/sdk/webview` and requires official
WebView SDK 3.6.0 or newer. Each request obtains a fresh, single-use code. It
never substitutes a cached game hash or falls back to Toss Login. Old SDK/runtime
versions reject instead. Do not persist or log codes.

The authority exchanges the code with
`createAppsInTossPartnerApiClient().exchangeAnonymousAuthorizationCode()` from
`@mpgd/game-services/apps-in-toss-partner-api`, then issues its own scoped session.
A client-provided identity hash or a successful key-existence check is not proof
of authentication. Purchase verification and durable grants remain server-owned.
