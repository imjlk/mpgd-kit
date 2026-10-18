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

## Notifications v2

The host bridge serves the `notifications.v2.*` bridge methods from an Apps in
Toss provider, and the gateway exposes it as `notificationsV2` whenever the host
offers the notifications event channel. Games reach it through the
game-services notifications runtime, never directly (see the
[notifications v2 RFC](../../docs/specs/notifications/notifications-v2-rfc.md#profile-ait)).

```ts
installAitHostBridge({
  appName: 'my-game',
  // The catalog's targets.ait mapping per topic.
  notificationTopics: {
    'energy-full': { templateSetCode: 'my-game-energy-full', agreement: 'required' },
    'purchase-receipt': { templateSetCode: 'my-game-receipt', agreement: 'none' },
  },
});
```

- **Agreement.** `Notification.requestAgreement` (Toss 5.255.0 or later) shows
  one sheet per topic that needs an agreement. `newAgreement`,
  `alreadyAgreed`, and `agreementRejected` become `granted`,
  `already-granted`, and `denied`; no answer within 120 seconds is
  `dismissed`; `TERMS_DISAGREED_MEMBER` is `action-required` with
  `requiredAction: 'host-settings'`. An older Toss app answers
  `NOTIFICATIONS_HOST_VERSION_UNSUPPORTED`, and a bad template code
  `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
- **No read-back.** Neither the mini-app nor the server can read an agreement,
  and revoking it in Toss settings raises no event. Each decision comes back
  with `apps-in-toss.notification-agreement.v1` evidence for the backend's
  consent record. The host keeps no session copy, so a v1
  `notifications.getStatus` reads `not-subscribed` for a topic that needs an
  agreement; read it through the runtime instead.
- **Templates without agreement.** `agreement: 'none'` topics read `granted`
  and never show a sheet.
- **Opens.** A launch whose referrer is `push` or `inbox` reaches the game once,
  as a cold `opened` event with the landing route (the console template's
  landing URL, normalized by `normalizeRootRelativeRoute`).
  `presentation.getLaunchIntent()` answers `home` for that launch so it is not
  routed twice. Both apply only while a topic is configured.
- **Not on Apps in Toss.** Local notifications, a settings link, and
  advertising topics (promotional pushes are console campaigns).

The server side is
`createAitFunctionalMessageDeliveryProvider` in
`@mpgd/game-services/notifications/ait-functional-delivery`, which sends
functional messages over the partner API's mTLS certificate.
