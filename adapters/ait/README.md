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

Explicit failures retain the pending marker with their code. A restarted host reports that code
again and returns `failed` without another SDK call. The resolver may still return a verified receipt;
only an explicit authority `retry` decision can remove the marker and reach authorization again.
A stored failure is not short-circuited in memory, so that retry can clear it in the same process.
If storing the code fails, the same host process still treats the claim as an explicit failure and
does not take the retry path. A process restart cannot recover a code that was never stored.
A client-reported failure is **not** independent proof that no payment happened. Neither the observer
nor a timeout should reset the server's monetary dispatch fence. A legacy failure whose marker was
already removed cannot recover its old error code.

<!--
@link src/host.ts#createAitHostBridge Grant and recover share one idempotency-key lock, re-read storage before payout, keep undurable receipts and undurable explicit failures fenced, and fail closed when a scoped marker's campaignId does not match its key.
@link src/index.ts#createAitPlatformGateway An older host's unsupported recoverReward method, including a protocol validator rejection, is pending, not an exception.
-->

`gateway.promotions.recoverReward({ campaignId, idempotencyKey })` is an optional recovery-only
capability. It reads a persisted receipt or consults the configured authority resolver, including
a new installation without local state. It never calls the authorizer or native payout API, and
a resolver's `retry` result leaves pending storage untouched. An explicit `grantReward` request
is still required for a newly authorized payment. An unknown provider outcome remains pending;
this API cannot reconstruct a lost provider key or prove non-payment. Grant and recover for the
same idempotency key run one at a time, including when the campaigns differ, so two campaigns
cannot both bind one unscoped legacy marker. After authorization, and again immediately
before the native payout, grant re-reads storage and the bridge-local receipt cache and returns
a granted receipt instead of paying again.

Recovery does not require current native payout support. A missing local marker has no known
`pendingSince`, so the resolver receives no invented timestamp. A failed local read can fall back
to the authority; that fallback does not run while a grant for the same claim is in flight, and it
writes only a terminal authority receipt. Confirmed receipts are cached for later restarts. The
receipt contract is the same for markerless and existing-marker resolution. New markers are stored under
`mpgd:ait:promotion-grant:v2:<campaignId>:<idempotencyKey>` and include `campaignId`. A legacy
`v1` marker, which was keyed only by the idempotency key, is still readable. The first campaign
that reconciles an unbound legacy marker binds it; another campaign does not receive that receipt.
Server-issued idempotency keys should stay unique across campaigns. A legacy marker that could not
be copied remains fenced in the current process by that binding. The campaign id is written onto
the legacy marker before it is removed, so a failed delete still fences a restarted bridge.
An authority `retry` also removes
that migrated copy, so it cannot block the authorized payout. A v2 marker whose embedded
`campaignId` does not match its key stays pending and is not overwritten or paid again.

An older host that does not implement `promotions.recoverReward` answers `{ status: 'pending' }`
instead of throwing. That includes a host whose protocol validator rejects the method and whose
request wrapper reports `AIT_BRIDGE_REQUEST_FAILED`, not only an `UNSUPPORTED_METHOD` fallback.
`grantReward` is unchanged and still throws. Other host failures still throw.

Undefined/malformed SDK responses and exceptions retain a bounded diagnostic code in the pending
marker. They remain ambiguous, not confirmed non-payment. Thrown provider codes are preserved when
safe; raw messages are not persisted. Recovery replays these observations for an unavailable game
server to catch up. Terminal receipts also have a bridge-local fallback when
native storage fails. Entries whose durable write failed are not evicted; other entries stay
bounded at 256. This fallback does not survive host termination, never grants eligibility,
and does not replace durable storage or the server ledger. The observer stops blocking after three
seconds, and a late observer rejection is ignored.
