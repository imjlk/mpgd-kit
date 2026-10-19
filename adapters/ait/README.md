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
offers the notifications event channel, which it does while a topic is mapped.
The game side loads the bridge client and its validators as a separate chunk,
which a game without notifications never loads. Games reach it through the
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

The generated wrapper does not list them by hand: its build config reads the
catalog with `readAitNotificationTopicsFile` from
`@mpgd/adapter-ait/notification-config` (`MPGD_NOTIFICATION_TOPICS_FILE`, else
the game's `notifications/topics.json`) and passes the `targets.ait`
mappings. The catalog goes through `validateNotificationTopicCatalog` from
`@mpgd/catalog` with the Apps in Toss registry entry, which refuses an
advertising topic mapped for Apps in Toss; other targets' mappings and the
deployment are left to `pnpm validate:notifications`, which reads the
backend's settings.
`extractAitNotificationTopicConfig` does the same for an already parsed
catalog.

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
  consent record. v2 reads stay `unknown`. For v1, a topic agreed to during
  this bridge's lifetime reads `subscribed` from a v1-only session cache (a
  denial clears it); otherwise `notifications.getStatus` reads
  `not-subscribed` for a topic that needs an agreement (`unsupported` on Toss
  older than 5.255.0). Read through the runtime to see agreements across
  restarts.
- **Templates without agreement.** `agreement: 'none'` topics read `granted`
  and never show a sheet.
- **Opens.** A launch whose referrer is `push` or `inbox` is routed exactly
  once, by whichever comes first: the cold `opened` event with the landing
  route (the console template's landing URL, normalized by
  `normalizeRootRelativeRoute`), when the notifications runtime subscribes
  first, after which `presentation.getLaunchIntent()` answers `home`; or the
  launch intent, when the game asks before subscribing. Start the runtime
  before reading the launch intent to get the `opened` event. Opens apply only
  while `notificationTopics` maps a topic; a game that maps only v1
  `notificationTemplateCodes` keeps routing push launches through the launch
  intent.
- **Not on Apps in Toss.** Local notifications, a settings link, and
  advertising topics (promotional pushes are console campaigns).

The server side is
`createAitFunctionalMessageDeliveryProvider` in
`@mpgd/game-services/notifications/ait-functional-delivery`, which sends
functional messages over the partner API's mTLS certificate.

## Promotion outcome observation

Configure `observePromotionGrant` beside the existing authorizer and pending resolver to record a
claim's outcome at your authenticated authority. Observations contain the logical campaign, the
server-issued idempotency key and `status`; native success includes `receiptKey`, explicit failure
includes a bounded `errorCode`. Raw provider messages are deliberately excluded. The observer is
best effort and stops blocking the native response after three seconds. Its failure cannot turn a
successful payment into a failure.

Explicit failures now retain the pending marker with their code. A restarted host reports that code
again and returns `failed` without another SDK call. The resolver may still return a verified receipt;
only an explicit authority `retry` decision can remove the marker and reach authorization again.
A client-reported failure is **not** independent proof that no payment happened. Neither the observer
nor a timeout should reset the server's monetary dispatch fence. A legacy failure whose marker was
already removed cannot recover its old error code.
