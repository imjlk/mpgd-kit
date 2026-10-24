# Notifications for game developers

This guide is for a game built on mpgd-kit that sends notifications: what
each target supports, how a player's consent flows, the Korean advertising
rules, and how to add a topic. The contract is the
[notifications v2 RFC](specs/notifications/notifications-v2-rfc.md); this page
is the practical summary. For Android and iOS also read the
[Firebase setup guide](FIREBASE_NOTIFICATIONS.md).

## Getting started

- **New game.** `mpgd game create my-game --providers notifications` (also
  with `--template lite`) adds the notifications starter: the topic catalog
  `notifications/topics.json`, the backend settings
  `notifications/deployment.json`, the wiring for Android, iOS, Apps in Toss,
  and Reddit, a game-rendered notification settings screen, and
  `pnpm validate:notifications`. A game created without the flag has none of
  it and bundles none of the notification code.
- **Existing game, Android and iOS.** `mpgd target init capacitor
  --providers notifications` installs the two Capacitor plugins into the
  game-owned shell and wires a Capacitor gateway that is still the
  template's; a game-owned gateway gets a warning that says what to
  register. It does not add the settings screen to an existing game: render
  one from the starter's `src/platform/notificationSettings.ts`.
- **Existing game, Apps in Toss and Reddit.** Add the catalog and wiring by
  hand, following the starter: the Apps in Toss wrapper already reads
  `notifications/topics.json` (or `MPGD_NOTIFICATION_TOPICS_FILE`). The Reddit
  gateway passes `notifications: { topics }` (the ids the catalog maps for
  `reddit`) and `loginPrompt: createDevvitWebLoginPrompt()` to
  `createDevvitPlatformGateway`, and the Devvit server passes
  `createDevvitNotificationsV2BridgeHandler({ notifications, currentUserId,
  topics })` to its bridge and runs `createDevvitNotificationService({ redis,
  notifications, catalog, deployment })` in its scheduler tasks. For
  reminders, records, and notices the server also passes
  `createDevvitNotificationsBackendBridgeHandler({ service, context: () =>
  context })` as the bridge's `notificationsBackend`, and the game runs
  `createNotificationRuntime` over `createDevvitNotificationsBackend({
  appVersion, buildId })` (see the
  [Devvit adapter README](https://github.com/imjlk/mpgd-kit/blob/main/adapters/devvit/README.md#notifications)).

Before every release run `pnpm validate:notifications`. It checks the catalog
against the providers each target enables and the deployment settings, and it
fails until the advertising sender's contact placeholder is replaced.

## What each target supports {#targets}

<!--
@link ../adapters/capacitor/src/notifications-provider.ts#createCapacitorNotificationProvider Android and iOS remote purposes match the standard FCM registry, including advertising.
@link ../packages/catalog/src/notification-topics.ts#validateNotificationTopicCatalog An advertising topic must not map to android until the shell renders the opt-out action.
@evidence specs/notifications/notifications-v2-rfc.md#profile-capacitor Map no advertising topic to Android until the shell renders the opt-out action.
-->

| Target | Consent UI | Remote | Local reminders | Opens | Notes |
| --- | --- | --- | --- | --- | --- |
| Android (Capacitor) | OS dialog for the app; on Android 13+ two denials leave only settings (a dismissed dialog counts none) | FCM, all three purposes, matching the standard registry. Map no advertising topic to Android until the shell renders the opt-out action; the catalog validator refuses that mapping | yes, inexact | push data `route` | Channels per purpose; an advertising topic, once the shell can render it, gets its own. |
| iOS (Capacitor) | OS dialog, once; a denial leaves only settings | FCM (relayed to APNs), all three purposes | yes, at most 64 pending | push data `route` | Advertising pushes carry the opt-out action through the `mpgd-advertising` category. |
| Apps in Toss | A Toss sheet per topic, from a tap | Functional messages (`service`, `requested`) through the partner API | no | landing URL per console template | No advertising, and functional messages may not carry benefits or retention content: check that a reminder qualifies before mapping it (the starter maps none). Each topic maps `targets.ait` to the console template code and `agreement`. Toss gives no read, so the backend record decides. |
| Reddit (Devvit) | The game's own toggle, from a tap; the player must be logged in | Devvit notifications (`service`, `requested`), copy pre-approved by Devvit admins | no | the linked post | Gated beta: keep `integrations.notifications` at `approval-required` until Reddit approves the app. Each send needs a post or comment link. |
| Web, Microsoft Store PWA, CrazyGames, OnePlay, Verse8 | none | none | none | none | Notifications read `unsupported`. |

The starter sets `integrations.notifications: "available"` for `android`,
`ios`, and `ait`. The provider still reports its own readiness (no plugin in
the shell, no mapped topic), which the target config follows. For `reddit` it
sets `integrations.identityUpgrade: "available"`, because the gateway passes
`loginPrompt: createDevvitWebLoginPrompt()`: a logged-out player taps
*Turn on* and is asked to log in.

## How consent flows

Consent has three layers, and the game never decides one alone:

1. **Delivery permission**: the OS dialog (Android, iOS), the Toss agreement
   sheet (Apps in Toss), or the game's Devvit opt-in. The host is the source
   of truth.
2. **Topic preference**: the player's on/off per topic in the game. For a
   `requested` topic (a reminder) this is the player's request, and the topic
   is off until the player turns it on.
3. **Purpose consent**: 광고성 정보 수신동의 (advertising consent) and the
   separate night consent, which an advertising push arriving between 21:00
   and 08:00 KST also needs, under the Korean rules.

Rules the starter's settings screen follows, and your own screen must too:

- **Ask from a player action.** Every prompt runs from a tap. Apps in Toss and
  Devvit refuse a prompt outside one; on iOS the dialog shows only once, so
  explain first and prompt only after the player chose to turn notifications
  on.
- **Nothing is pre-checked.** Reminders, advertising consent, and night consent
  start off. The advertising switch is labelled 광고성 정보 수신동의 and says it
  is optional; it is not phrased as a benefit alert.
- **Never pay for consent.** No reward for turning notifications on and no
  feature held back without them (App Review Guideline 5.1.2(i)), and the
  game keeps working when the player declines (Apps in Toss game
  checklist).
- **Agree per topic where the host asks per topic.** On Apps in Toss each
  template has its own agreement sheet. A reminder's sheet opens when the
  player turns it on; a `service` template that needs an agreement (mapped
  `agreement: "required"`) gets its own *Agree* action, since no reminder
  switch covers it. Only a service template may be mapped
  `agreement: "none"`. Name each such topic in the settings model's
  `reminderLabels`, or the screen shows its id.
- **Night consent only with advertising consent.** Night consent adds to
  advertising consent, so the screen offers it only while advertising
  consent is granted. Turning advertising consent off withdraws a granted
  night consent in the same `setAdvertisingConsent` call.
- **Show the records, not a guess.** Each switch shows the player's latest
  backend record of its kind, read when the screen opens and after every
  change, so a withdrawal made on another device or from a notice shows. A
  tap reads the records again and writes only the kinds that change. No
  device-side copy stands in for a record, and when the records cannot be
  read the screen shows no switch.
- **Turn off where it was turned on.** The game-rendered Devvit opt-in has a
  *Turn off* in the game; advertising and night consent are withdrawn in the
  same screen. A blocked OS permission offers only *Open system settings*
  (`@mpgd/capacitor-game-services` opens the app's notification settings).
- **The server keeps the records.** The game reports decisions through the
  notifications runtime (`NotificationRuntime` from
  `@mpgd/platform/notifications`): `requestPermission`, `revokePermission`,
  `setTopicPreference`, and `setAdvertisingConsent` with the consent text
  version. The backend's policy gate decides every send from those records.

> **The runtime needs a session.** `createNotificationRuntime` in
> `@mpgd/platform/notifications-runtime` composes the provider with a
> backend; `createGameServicesNotificationsClient` in
> `@mpgd/game-services/notifications/client` is that backend over the
> game-services Worker's notification routes. The Worker binds each request
> to the session its `Authorization` header names, through the identity
> service's `NotificationSessions` binding, which lives in the game's own
> identity Worker ([Sessions](./CLOUDFLARE_WORKER_DEPLOY.md)). The starter's
> `createStarterNotificationBackend` builds both when the game has a
> game-services URL (`VITE_MPGD_GAME_SERVICES_URL`) and sets its
> server-backed session with `setStarterServerSession`
> (`src/platform/serverSession.ts`): the signed-in `{ playerId, sessionId }`,
> a sign-in subscription, and the session's header, which the commerce
> client then sends too. `sessionId` must be the stable session-family id:
> the `sessionId` the identity service answers to
> `authenticateNotificationSession` for that header, the same across token
> refreshes. With a guest-session backend, pass
> `createGuestServerSession(coordinator)` from `@mpgd/game-services`: it
> answers the coordinator's `sessionFamilyId` (the backend's, or one the
> coordinator derives and keeps across refreshes and restarts), not a view's
> `sessionId`, which may rotate on refresh, and refreshes the access token
> as needed (an expired one before the request, one about to expire in the
> background). To try the switches before you have an identity
> service, run the Worker locally with
> `MPGD_ALLOW_INSECURE_DEVELOPMENT_NOTIFICATION_SESSIONS = "true"` (memory
> store only, and only on a local host) and start the game's dev server with
> `VITE_MPGD_DEV_NOTIFICATION_SESSION=<playerId>`: the starter then signs in
> with an unauthenticated development session (the generated game's
> `docs/NOTIFICATIONS.md`, "Try it locally", and the
> [Worker guide](./CLOUDFLARE_WORKER_DEPLOY.md#notifications-v2); the
> [live test runbook](./NOTIFICATIONS_LIVE_TEST.md) runs the same local
> Worker to send real pushes). Without a URL or a session (or
> with a production URL the commerce rule refuses, or no notifications
> provider) it returns `undefined`, and the settings screen asks for the OS or host
> permission (and withdraws a Devvit opt-in the game rendered), shows no
> reminder, advertising, or night switch, and says why. A Reddit game gets
> no Worker backend: its notifications backend is the Devvit server, and the
> starter runs the runtime over it (`createDevvitNotificationsBackend`, set
> by the Reddit gateway builder), with no game session: the server answers
> for the logged-in Reddit user. The settings screen then shows the reminder
> switches on Reddit too, once the player is logged in; advertising and
> night consent stay off there, because Devvit delivers `service` and
> `requested` topics only.
> The runtime compares its provider with the Worker's registry entry for the
> target (`GET /providers`), and runs without the check when the Worker
> cannot be reached or lists no entry for the target. The runtime keeps its last registration, push
> address included, in the platform storage, like other game data. A game
> created before this release has no `serverSession.ts`; `mpgd target init
> capacitor --providers notifications` writes one, and its commerce client
> sends the header only once `gameServices.ts` passes it, as the starter's
> now does.

Notification opens are hints, never grants: an open carries a route and
untrusted data, and anything worth claiming goes through the server. The
starter routes one kind of open itself: the advertising opt-out action and
the consent notices carry `/?entry=notification-settings`, and an open with
that route shows the settings screen (after boot, when the game was just
started by it), because the opt-out must open that screen directly. Route
your other topics' opens in the `other` route of
`subscribeStarterNotificationOpens`: it is the game's one open listener, the
first subscriber, which is the one a cold-start open reaches.

## Korean advertising rules

The deployment setting `advertisingRules` in
`notifications/deployment.json` decides how advertising is treated
([RFC](specs/notifications/notifications-v2-rfc.md#advertising-rules)):

- `kr` applies 정보통신망법 §50 to every recipient of the deployment: prior
  advertising consent separate from the OS permission, separate night consent
  (arrival between 21:00 and 08:00 KST), "(광고)" and the sender line at the
  start of each advertising message, the free opt-out line at the end, an
  opt-out action, and the consent notices below. Any deployment that may
  reach players in Korea must use it. The starter does.
- `none` keeps advertising consent and the opt-out route (App Review
  Guideline 4.5.4 needs them too) without the night window, labels, or
  notices.

Under `kr` the deployment names the **advertising sender**: its name (left
out only when it equals the app's name) and a phone number or address. The
starter's contact is the placeholder `REPLACE-WITH-SENDER-PHONE-OR-ADDRESS`,
which `pnpm validate:notifications` refuses. The backend refuses it too:
under `kr`, `assertNotificationDeployment` rejects a placeholder sender name,
contact, or opt-out line, so a game-services Worker given the starter file as
is reports its notifications as misconfigured and sends nothing.

**Notices.** The server sends, through the catalog's `notices.topic`
(`consent-notice` in the starter), a result notice within 14 days of each
advertising or night consent, refusal, or withdrawal (decree art. 62-2), and
a re-confirmation every two years from the consent date (art. 62-3). Their
text is the catalog's `notices.copy`, one title and body per variant and
locale, with the act's date as `{{consentDate}}`:

- A result notice states the sender's name, the act (consent, refusal, or
  withdrawal) with its date, and that it was processed.
- A re-confirmation states the sender's name, the consent and its date, and
  how to keep or withdraw it. The night re-confirmation must not say the
  player still receives night advertising: a night consent can stand after
  advertising consent is withdrawn (one recorded by an older client, or by a
  screen that does not withdraw both; the starter withdraws both). The
  starter's screen shows such a night consent as off, since it counts for
  nothing without advertising consent, and withdraws it with the next
  advertising consent, saying so.

The starter's Korean copy follows that wording, with the game's title in
brackets as the sender. The notice must name the same sender as
`advertisingSender.name` in `notifications/deployment.json`: when you change
one, change every `notices.copy` variant too. The settings screen also shows the notices the server lists and
records them as given in the game, for players who are not reachable by push.

**Which topics are advertising** is your decision, ideally with legal review.
KISA's guide counts as advertising anything sent for the sender's economic
benefit, including benefits handed out unasked, periodic use reminders,
deadline nudges, and abandoned-cart reminders; information the player
requested, or that a contract or transaction obliges you to send, is not.
The guide has no example about games: treating a message about another
player's action (a friend's challenge) as `service` is the kit's reading of
those exceptions, not the guide's.

## The starter topics

| Topic | Purpose | Why |
| --- | --- | --- |
| `daily-ready` | `requested` | A reminder the player turns on about their own daily run. |
| `streak-at-risk` | `requested` | A reminder the player turns on about their own streak. |
| `friend-challenge` | `service` | Relays a real player's action. |
| `events` | `advertising` | Sample advertising topic, iOS only: an Android FCM push cannot carry the opt-out action the Korean rules require until the shell renders it natively. |
| `consent-notice` | `service` | The notice topic; its text is `notices.copy`. |

The purposes of `daily-ready` and `streak-at-risk` were decided for the kit
(RFC open question 1): they are reminders of the player's own progress that
the player asked for. **The risk:** the KISA guide reads periodic reminders
that promote use (p.50, Q01-01) and deadline nudges (p.50, Q01-02) as
advertising; `daily-ready` has the shape of the first and a streak reminder is
close to the second. Repeated sends without a further request turn requested
information into advertising (p.11, p.52 Q01-10), so one opt-in followed by
daily sends is the weakest part of the `requested` reading: have it reviewed
before launch. Keep their copy to the player's own progress, with no reward,
benefit, event, or promotion, and send them only to players who turned them
on. A game that adds rewards or promotions to these messages must declare them
`advertising` instead, with the consent, night window, and labels that brings.
The same holds for `friend-challenge` if a challenge carries a reward or an
invitation to buy.

## Adding a topic

1. Add an entry to `notifications/topics.json`:

   ```json
   {
     "id": "energy-full",
     "purpose": "requested",
     "channels": ["local", "remote"],
     "route": "/?entry=continue",
     "copy": {
       "ko": { "title": "에너지 충전 완료", "body": "에너지가 가득 찼어요." },
       "en": { "title": "Energy full", "body": "Your energy is full." }
     },
     "frequency": { "maxPerDay": 3 },
     "quietHours": { "start": "22:00", "end": "08:00" },
     "targets": {
       "android": { "channelId": "mpgd-requested" },
       "ios": {},
       "ait": { "templateSetCode": "my-game-energy-full", "agreement": "required" },
       "reddit": { "title": "Energy full", "body": "Your energy is full again." }
     }
   }
   ```

   - **Purpose.** `service`, `requested`, or `advertising`, by what the
     message is for (see above). An `advertising` topic needs an
     `optOutRoute`, cannot use the `local` channel, and cannot map to Apps in
     Toss or Devvit.
   - **Routes** are root-relative and already normalized (`/a/../b` is
     refused, not rewritten).
   - **Targets.** A target that does not map the topic never delivers it.
     Apps in Toss needs the console template's code and `agreement`
     (`none` only for a `service` template without an agreement statement);
     Devvit needs its pre-approved `title` (60) and `body` (100 characters).
   - **Copy** must include the catalog's `defaultLocale`; `{{name}}`
     placeholders are filled from the reminder's or send's template data.
     A server reminder whose data cannot fill every locale copy, or the
     target mapping's own title and body, is refused when it is set,
     including a host-template provider whose mapping supplies its own title
     and body (its catalog copy is not filled).
     <!-- @link ../packages/game-services/src/notifications/service.ts#createNotificationService -->
     <!-- @evidence /docs/specs/notifications/notifications-v2-rfc.md#reminders -->
2. Run `pnpm validate:notifications`.
3. Give the Worker the new catalog (`MPGD_NOTIFICATIONS_CATALOG`) and, for
   Reddit, redeploy the Devvit app, whose server reads the catalog at build
   time. Apps in Toss reads it when the wrapper is built.
4. For a `requested` topic, add a switch for it to the settings screen (the
   starter lists every `requested` topic the target maps) and set reminders
   through `runtime.reminders.set({ key, topic, fireAt })`; the runtime picks
   a local or a server reminder from the target's capabilities.

## Validation scope

The starter's settings model, the CLI wiring, and the catalog are covered by
the kit's tests, and every provider passes the RFC's conformance vectors with
fakes. Delivery on a device, Firebase configuration, Apps in Toss templates,
and Devvit approval are verified by you, per target, before release. The
[live test runbook](NOTIFICATIONS_LIVE_TEST.md) walks through the first
Android run: a local Worker sending through FCM to a game on an emulator,
from the permission dialog to the tap that opens the game.
