# @mpgd/adapter-capacitor

The base adapter uses `@mpgd/capacitor-game-services` for bounded local JSON
storage and a small fail-closed bridge. It does **not** install a store, ad,
identity, leaderboard, or push SDK. Pass separately installed modules through
`createCapacitorPlatformGateway({ providers })`; each module declares its
owned bridge methods, provider features, and current availability. Duplicate
method/feature registrations and attempts to replace base storage are errors.

```ts
import {
  createCapacitorPlatformGateway,
  type CapacitorServiceProvider,
} from '@mpgd/adapter-capacitor';

export function createGameGateway(providers: readonly CapacitorServiceProvider[]) {
  return createCapacitorPlatformGateway({
    target: 'android',
    appVersion: '1.0.0',
    buildId: 'game-build',
    providers,
    classifyIncomingUrl(url) {
      const incoming = new URL(url);
      // Replace this example scheme with one registered by your native host.
      if (incoming.protocol !== 'mygame:') return null;
      if (incoming.hostname === 'oauth') return 'oauth';
      if (incoming.hostname === 'game') return 'game';
      return null;
    },
  });
}
```

`getCapabilities()` reports a fresh boolean snapshot and optional
`providerAvailability` detail. The possible states are `unsupported`,
`configuration-required`, `action-required`, `temporarily-unavailable`, and
`available`. A target's `features` configuration is an upper bound, **not**
proof that a provider is installed or ready. `nativeIap` describes one-time
purchases; `subscriptionIap` is separate. Rewarded, interstitial, and banner
ads and native versus remote leaderboards remain distinct. Target-config
applies the configured upper bound to this live provider state.

When native and remote leaderboard routes coexist, the target-config wrapper
selects a `route` on score/open calls; direct adapter callers can request
`route: 'remote'` to use the base remote bridge instead of the native provider.
When one ads provider handles multiple formats, pass `format` to `ads.preload`
so its readiness check cannot use an available format for an unavailable one.

Provider initialization failures and availability reads stalled beyond three
seconds leave the base bridge and local guest boot available. A registered
provider never silently falls back for purchase, ad, or native leaderboard
operations; an explicit remote leaderboard route is a separate path. Errors
retain a stable code and retry hint. The
provider bridge must return a method-shaped response. In particular, an ad
`rewardGranted: true` result requires a backend ledger entry. A native callback
alone is evidence, not a grant. Game-specific product, consent, entitlement,
and identity policy belongs to the consuming game and its backend.

The source tests and installed-tarball consumer validate composition, types,
error paths, and fallback behavior. They do not establish that any optional
SDK works on a physical device or that a store/ad setup is release-ready.

## App lifecycle and native entry

The adapter uses the official Capacitor App plugin for foreground state,
Android back navigation, and incoming URLs. Install `@capacitor/app` in the
native shell and run `cap sync` so the native plugin is present. The reference
shell and generated game template include it. A `classifyIncomingUrl` callback
must explicitly return `game` or `oauth`; unknown URLs are discarded rather
than being delivered to gameplay. Register your URL scheme or App/Universal
Links in the native host separately. See the [Capacitor App API](https://capacitorjs.com/docs/apis/app).

`lifecycle.onPause` and `onResume` deduplicate App and web visibility events.
Purchases, ads, and identity upgrades keep execution paused until their
provider operation settles. Use `beginExternalActivity` for other external UI.
On Android, a back handler returns `true` if the game consumed the event;
otherwise the adapter navigates browser history when possible or exits the
app. Cold URLs are read through `getInitialGameUrl` or
`getInitialOAuthRedirect`; warm URLs use separate `onGameUrlOpen` and
`onOAuthRedirect` callbacks. OAuth responses never enter the game-link
callback. Call `lifecycle.dispose()` when the host tears down this gateway;
the adapter removes only its own listener handles, never every App listener.

Save progress at checkpoints and transaction boundaries. A pause callback can
request a best-effort save, but neither pause nor back is guaranteed to run
before the operating system terminates a process. The lifecycle tests use an
injected App API and do not claim device-level lifecycle verification.

For example, let the game's checkpoint flow own durability; the native pause
event is only an additional opportunity to flush the latest checkpoint:

```ts
import type { PlatformGateway } from '@mpgd/platform';

export function attachCheckpointSaving(
  gateway: PlatformGateway,
  saveCheckpoint: () => Promise<void>,
): () => void {
  return gateway.lifecycle.onPause(() => {
    void saveCheckpoint().catch((error: unknown) => {
      console.error('Best-effort pause save failed.', error);
    });
  });
}

// The game also awaits saveCheckpoint() at level and transaction boundaries;
// it must never defer its only save until a close, back, or pause event.
```

## Scoped native JSON HTTP

`createCapacitorNativeJsonTransport` uses the explicit `CapacitorHttp.request`
helper from `@capacitor/core`; it does not enable global `fetch` or XHR patching.
Use it with the HTTP JSON path of `createGameServicesRuntime`, not the oRPC
path. The game imports only public kit APIs:

```ts
import { createCapacitorNativeJsonTransport } from '@mpgd/adapter-capacitor';
import { createGameServicesRuntime } from '@mpgd/game-services/runtime';

const baseUrl = 'https://api.example.com';
const httpTransport = createCapacitorNativeJsonTransport({
  target: 'android',
  baseUrl,
  allowedOrigins: ['https://api.example.com'],
});
const runtime = createGameServicesRuntime({
  gateway,
  playerId,
  authorityMode: 'production',
  baseUrl,
  transport: 'http',
  httpTransport,
  getHeaders: () => ({ authorization: `Bearer ${currentAccessToken()}` }),
});
```

The game supplies its real gateway, player ID, and token resolver. The native
transport permits only configured HTTPS origins and relative JSON API paths;
it rejects changed response URLs and 3xx responses. It requests
`disableRedirects: true` from Capacitor. A native implementation that ignored
that option could have followed a redirect before JS sees the result, so
redirect and credential handling still require native integration testing.
The transport supports GET and POST JSON only, not streaming, file uploads,
or arbitrary Fetch semantics. `AbortSignal` and the overall timeout stop the
JS wait; they do **not** prove the native request or server operation was
canceled. Reconcile purchases and reward claims before retrying them.

Request size is checked before calling the native bridge. The response size
limit is checked **after** Capacitor returns data to JS; it is not a native
receive-memory cap. The injected Http tests and platform staging builds cover
the contract, not real network behavior on both physical OSes. See the
[Capacitor HTTP API](https://capacitorjs.com/docs/apis/http) for the native
helper and its redirect/timeout options.
