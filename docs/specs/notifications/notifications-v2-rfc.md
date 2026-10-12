# Notifications v2 contract (RFC)

Status: **draft proposal (N1)**. This RFC describes a contract that does not
exist yet. It is not confirmed runtime behavior, and it is outside the
enforced [documentation evidence](../../DOCUMENTATION_EVIDENCE.md) scope until
N2 lands the types and a conformance runner that cite it. Baseline:
`main@2f70328e`, 2026-10-12. Draft protocol: `mpgd.notifications.v2`,
version `2.0.0-draft.1`.

Platform facts below were checked on 2026-10-12 against the sources listed in
[References](#references). Host policies change; re-check a fact before a
provider pull request depends on it.

## Summary {#summary}

Notifications differ more between targets than commerce does. Android and iOS
ask the operating system once for the whole app and can schedule local
notifications. Apps in Toss asks the user per message template, cannot tell
the mini-app afterwards whether the user agreed, and sends only functional
messages through its API. Devvit has no consent screen at all: the game draws
its own toggle and the Devvit server records the opt-in. Web targets have no
notification path the kit uses.

Notifications v2 describes each target by declared capabilities instead of
branching on its name. The game declares topics and what each topic is for.
A topic's purpose decides which consent it needs, both under host policy and
under the Korean advertising rules in
[Advertising rules](#advertising-rules). The client asks for permission and
reports what the user decided; the server keeps the consent records, applies
one policy gate, and sends. A reminder is expressed as an intent, and the kit
picks a local notification or a server-scheduled push from the target's
capabilities.

## Current state {#current-state}

| Area | Today |
| --- | --- |
| Client contract | `PlatformGateway.notifications` (`NotificationSubscriptionAdapter`): `getStatus(topic)` and `requestSubscription(topic)` over a closed `NotificationTopic` union of `daily-ready`, `streak-at-risk`, `friend-challenge`. It manages subscription state only and never sends. |
| Apps in Toss | The host bridge maps topics to template codes and calls the deprecated `requestNotificationAgreement`. Agreements live in a session-only `Set`, so after a restart a user who agreed reads as `not-subscribed`. `TERMS_DISAGREED_MEMBER` collapses into `unavailable`. |
| Android, iOS | `@mpgd/capacitor-game-services` answers `configuration-required` and `unavailable`. No push or local-notification plugin is installed. |
| Devvit | The server bridge answers `approval-required` and `unavailable`, which matches Devvit's gated beta. |
| Web targets, WeChat | `getStatus` answers `unsupported` and `requestSubscription` answers `unavailable` (browser, WeChat, and the Cloudflare Pages bridge). |
| Target config | `integrations.notifications` is `configuration-required` for `android`, `ios`, and `ait`, `approval-required` for `reddit`, and `unsupported` elsewhere. |
| Server | `@mpgd/game-services/notification-delivery` defines a claim/lease delivery ledger contract, an in-memory test ledger, and an idempotent `NotificationDeliveryProvider`, keyed by the closed `PlatformTarget` and `NotificationTopic` sets. No durable ledger implementation ships. `apps-in-toss-partner-api` can send one functional message over mTLS but is not wired as a delivery provider. |

Missing everywhere: device endpoint registration, consent records, local
notifications, notification-open handling, reminder scheduling, and any rule
that separates functional messages from advertising.

## Goals and non-goals {#goals}

Goals:

- One client contract for permission, endpoint registration, local
  notifications, and notification opens, implemented by every target
  provider.
- Capability declarations that capture the real differences: who renders the
  consent UI, whether consent is per app or per topic, whether the client can
  read it back, and whether one consent allows one send or many.
- Game-declared topics with a declared purpose, mapped per target to host
  templates, channels, and copy.
- Server-side consent records and a single policy gate that enforces purpose,
  preference, advertising consent, the night window, and provider limits
  before any send.
- Reminder intents that use local notifications where the target has them and
  a server-scheduled push elsewhere, in the first release wave.
- Shared conformance vectors that every provider and the reference runtime
  pass.

Non-goals:

- Web Push or PWA notifications on any web target, including the Microsoft
  Store PWA.
- Direct APNs delivery. iOS remote notifications go through FCM; see
  [Delivery providers](#remote-delivery).
- Apps in Toss promotional campaigns. They are console-only and outside the
  kit; see [Apps in Toss](#profile-ait).
- Deciding for a game whether a topic is advertising. The kit records and
  enforces the purpose the game declares; [Advertising rules](#advertising-rules)
  collects the criteria.
- New top-level directories. SDK code stays in `adapters/*`,
  `native-plugins/*`, and `apps/target-*`.

## Principles {#principles}

1. **The server sends.** Only a backend delivery provider sends a remote
   notification. A local notification is a device-side reminder and carries
   no authority.
2. **Opens are hints, never grants.** A notification tap carries a route and
   optional data. A reward offered in a notification is claimed through a
   server-issued, single-use claim, never from the tap payload.
3. **Declarations, not names.** Code branches on `NotificationCapabilities`,
   topic purposes, and provider registry entries, never on a target or
   provider string.
4. **Open identifiers.** Topic ids, provider ids, and evidence schemas are
   strings the project declares. The kit ships reference values only.
5. **The server keeps consent.** Hosts own their permission state; the server
   keeps the records the kit relies on, including the ones a host will not
   expose again. A client report of a host decision is a hint for the server,
   not proof.
6. **Pure contract.** Types, the permission and policy decisions, reminder
   routing, and the conformance runner live in `@mpgd/platform` and stay free
   of Phaser, DOM, network, and SDK imports.
7. **Additive until the major.** The v1 `NotificationSubscriptionAdapter`
   keeps working through a wrapper until the major release that also removes
   commerce v1.

## Topics and purposes {#topics}

A **topic** is a kind of notification the game sends, such as `energy-full`
or `friend-challenge`. Its id is an open `NotificationTopicId` string declared
in the [topic catalog](#topic-catalog).

Every topic declares one **purpose**:

| Purpose | Meaning | Consent needed besides delivery permission |
| --- | --- | --- |
| `service` | Information the player needs because of their own account, a transaction, or another real player's action: a purchase or refund result, a friend's challenge, a security notice | None. The player can still turn the topic off. |
| `requested` | A reminder the player explicitly turned on for that topic: "tell me when my energy is full" | A recorded opt-in for that topic. Off until the player turns it on. |
| `advertising` | Anything sent to promote use or sales: events, sales, new items, and the cases the Korean guide lists as advertising, such as benefits handed out unasked and deadline nudges | Advertising consent, night consent for 21:00–08:00 KST, labels, and an opt-out link. See [Advertising rules](#advertising-rules). |

The purpose also selects the host path. On Apps in Toss, `service` and
`requested` topics are functional messages and `advertising` topics are not
deliverable through the API. On iOS, an `advertising` topic also needs the
explicit opt-in and in-app opt-out that App Review Guideline 4.5.4 requires.

A topic has one or more **channels**: `remote` (a server-sent push) and
`local` (a device-scheduled notification). Purpose rules apply to both,
because a local notification reaches the player outside the game exactly as a
push does.

## Consent model {#consent}

Consent has three layers. Each layer has one source of truth.

1. **Delivery permission.** The operating system or host decides whether a
   notification can be shown at all: the OS permission on Android and iOS,
   the per-template agreement on Apps in Toss, the Devvit opt-in, a WeChat
   subscription. The device or host is the source of truth. The client reads
   it when the host allows and reports every decision to the server. When the
   host gives no read (Apps in Toss), the server record is what the kit uses,
   and the host still enforces on send.
2. **Topic preference.** The player's on/off choice per topic inside the
   game. The server is the source of truth. For a `requested` topic this
   record is the player's request.
3. **Purpose consent.** Advertising consent and the separate night consent,
   per medium. The server is the source of truth and also computes the
   notices the law requires.

Rules for asking:

- **Ask from a player action.** `requestPermission` runs only inside a user
  gesture where the capability says `userGesture: true` (WeChat requires a
  tap; Apps in Toss forbids opening the agreement sheet on entry).
- **Explain before a one-shot prompt.** iOS shows its permission dialog once.
  The kit expects a game-rendered explanation first and calls the OS prompt
  only after the player accepts it. A `blocked` state only offers
  `openSettings`.
- **Never pay for consent.** No reward for turning notifications on (App
  Review Guideline 5.1.2(i)); the game must keep working when the player
  declines (Apps in Toss game checklist).
- **Never prompt as a side effect.** Scheduling a local notification without
  permission returns `permission-required`. It never opens the OS dialog,
  even though `@capacitor/local-notifications` 8.3 would if called directly.

## Capabilities {#capabilities}

```ts
// packages/platform/src/notifications (pure) — proposed for N2

export interface NotificationCapabilities {
  readonly availability: PlatformProviderAvailability;
  readonly permission: {
    /** Where delivery permission lives: one for the app, or one per topic. */
    readonly scope: 'app' | 'topic';
    /** Who renders the consent UI. */
    readonly prompt: 'os' | 'host' | 'game';
    /** Whether the client can read the current state without prompting. */
    readonly readable: boolean;
    /** Whether the backend can read the current state at send time (Devvit `isOptedIn`). */
    readonly serverReadable: boolean;
    /** 'per-send': one acceptance allows one delivery (WeChat one-time subscriptions). */
    readonly allowance: 'persistent' | 'per-send';
    readonly userGesture: boolean;
    readonly maxTopicsPerPrompt?: number;
    /** Whether `openSettings` can open the OS or host notification settings. */
    readonly settings: boolean;
  };
  readonly remote: {
    readonly supported: boolean;
    /** Purposes the host lets the server deliver. */
    readonly purposes: readonly NotificationPurpose[];
    readonly addressing: 'device' | 'platform-user' | 'none';
    readonly content: 'free-form' | 'host-template';
  };
  readonly local: {
    readonly supported: boolean;
    /** Pending-notification ceiling the provider must stay under (iOS: 64). */
    readonly maxPending?: number;
    readonly timing: 'exact' | 'inexact' | 'none';
  };
  /** How an open reaches the game. */
  readonly open: 'payload' | 'landing-url' | 'host-link' | 'none';
}
```

A provider returns a fresh object on every read. `availability` uses the
existing `PlatformProviderAvailability` values. Release gates such as Devvit's
`approval-required` stay in the target config's `integrations.notifications`
state, which decides whether the gateway exposes the provider at all.

## Client contract {#client-contract}

The types below are a sketch for N2. Names are proposed; field sets are the
substance of this RFC.

```ts
export type NotificationTopicId = string & Record<never, never>;
export type NotificationPurpose = 'service' | 'requested' | 'advertising';
/** Open provider id. Reference ids: 'fcm', 'apps-in-toss', 'devvit'. */
export type NotificationProviderId = string;

export type NotificationPermissionState =
  | 'granted'
  | 'prompt'
  /** Android after one denial: explain, then the dialog may show once more. */
  | 'prompt-with-rationale'
  /** Refused; this host lets the game ask again later. */
  | 'denied'
  /** Only OS or host settings can change it. */
  | 'blocked'
  /** The host gives no read; the server record decides. */
  | 'unknown'
  | 'unsupported';

export interface NotificationPermissionSnapshot {
  /** Present when `permission.scope` is 'app'. */
  readonly app?: NotificationPermissionState;
  readonly topics: Readonly<Record<NotificationTopicId, NotificationPermissionState>>;
}

/**
 * What one `requestPermission` call produced for a topic: the host's answer
 * when the prompt ran ('granted', 'already-granted', 'denied', 'dismissed'),
 * 'blocked' when the host refused for good or the call did not reach the
 * prompt because the state was already blocked, and 'unavailable' when the
 * provider is unsupported or the topic has no mapping for it. The snapshot
 * carries the resulting state, so a second Android denial reports outcome
 * 'denied' with snapshot 'blocked'.
 */
export type NotificationPermissionOutcome =
  | 'granted' | 'already-granted' | 'denied' | 'blocked' | 'dismissed' | 'unavailable';

export interface NotificationPermissionResult {
  readonly snapshot: NotificationPermissionSnapshot;
  readonly outcomes: Readonly<Record<NotificationTopicId, NotificationPermissionOutcome>>;
  /** Host decision for the server record, for example an Apps in Toss agreement event. */
  readonly evidence?: PlatformEvidenceEnvelope;
}

export interface NotificationEndpointRegistration {
  readonly provider: NotificationProviderId;
  readonly address:
    | { readonly kind: 'fcm-token' | 'fcm-installation'; readonly value: string; readonly environment?: 'production' | 'sandbox' }
    /** The server resolves the recipient from the authenticated player. */
    | { readonly kind: 'platform-user' };
  readonly locale?: string;
  /** IANA zone, used for quiet hours on non-advertising topics. */
  readonly timeZone?: string;
}

export interface LocalNotificationRequest {
  /** Stable logical key; the provider derives its native id from it. */
  readonly key: string;
  readonly topic: NotificationTopicId;
  readonly fireAt: string;
  readonly title: string;
  readonly body: string;
  readonly route?: string;
}

export type LocalScheduleResult =
  | { readonly status: 'scheduled' | 'replaced' }
  | { readonly status: 'permission-required' | 'capacity-exceeded' | 'unsupported' };

export type NotificationEvent =
  | {
      readonly type: 'opened';
      readonly channel: 'remote' | 'local';
      readonly source: 'cold' | 'warm';
      readonly topic?: NotificationTopicId;
      readonly route?: string;
      /** Untrusted routing data. Never a grant. */
      readonly data?: Readonly<Record<string, string>>;
      /** Host referrer when known, for example Apps in Toss 'push' or 'inbox'. */
      readonly referrer?: string;
    }
  | { readonly type: 'received'; readonly channel: 'remote' | 'local'; readonly topic?: NotificationTopicId }
  | { readonly type: 'endpoint-changed'; readonly registration: NotificationEndpointRegistration }
  | { readonly type: 'permission-changed'; readonly snapshot: NotificationPermissionSnapshot };

export interface NotificationProvider {
  readonly provider: NotificationProviderId;
  getCapabilities(): Promise<NotificationCapabilities>;
  getPermission(input: { readonly topics: readonly NotificationTopicId[] }): Promise<NotificationPermissionSnapshot>;
  requestPermission(input: { readonly topics: readonly NotificationTopicId[] }): Promise<NotificationPermissionResult>;
  /** Remote providers: the address the server should send to. */
  register?(): Promise<NotificationEndpointRegistration | null>;
  scheduleLocal?(input: LocalNotificationRequest): Promise<LocalScheduleResult>;
  cancelLocal?(input: { readonly keys: readonly string[] }): Promise<void>;
  listLocal?(): Promise<readonly { readonly key: string; readonly topic: NotificationTopicId; readonly fireAt: string }[]>;
  openSettings?(): Promise<'opened' | 'unavailable'>;
  subscribe(listener: (event: NotificationEvent) => void): () => void;
}
```

Rules every provider follows:

- **Fresh reads.** `getPermission` reads the host each time it can. A
  provider never caches a host answer it can read again.
- **Buffer before the first listener.** Events emitted before the first
  `subscribe` call, including a cold-start open, go to that first subscriber
  exactly once. Capacitor retains plugin events only until the first native
  listener, so the provider registers its native listeners before any `await`
  at startup and keeps them for the process lifetime.
- **No prompt without a request.** Only `requestPermission` may show a
  consent UI.
- **Unsupported is an answer, not an error.** A provider with
  `availability: 'unsupported'` answers reads with `unsupported` states and
  requests with `unavailable` outcomes, without reaching any prompt.
- **Stable local ids.** A provider maps `key` to a stable native id (Android
  needs a 32-bit integer) so a reminder can be replaced or cancelled.
- **Errors are normalized.** Failures use `PlatformOperationError` codes:
  `NOTIFICATIONS_UNSUPPORTED` (a method the provider does not implement),
  `NOTIFICATIONS_CONFIGURATION_REQUIRED`, `NOTIFICATIONS_USER_GESTURE_REQUIRED`,
  `NOTIFICATIONS_HOST_VERSION_UNSUPPORTED`, `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`,
  and `NOTIFICATIONS_V2_UNAVAILABLE` from a bridge without v2.

The gateway gains `notificationsV2?: NotificationProvider` next to the v1
`notifications` adapter, as `commerceV2` did.

### Runtime {#runtime}

Games do not call the provider directly. The game-services client composes
the provider with the backend in one notifications runtime, which the
conformance runner drives as the `game` actor:

```ts
export interface NotificationConsentRecord {
  readonly kind: 'delivery-permission' | 'host-agreement' | 'topic-preference' | 'advertising' | 'night';
  /** Absent for app-scope permission and for advertising and night consent. */
  readonly topic?: NotificationTopicId;
  /** Permission states for the first two kinds; 'granted' or 'withdrawn' for the rest. */
  readonly state: Exclude<NotificationPermissionState, 'prompt' | 'unknown' | 'unsupported'> | 'withdrawn';
  readonly source: 'client-report' | 'player';
  readonly at: string;
  readonly evidence?: PlatformEvidenceEnvelope;
  /** Consent text version for advertising and night consent. */
  readonly textVersion?: string;
}

export interface ReminderResult {
  readonly route: 'local' | 'remote' | 'none';
  readonly status:
    | 'scheduled' | 'replaced' | 'cancelled'
    | 'permission-required' | 'request-missing' | 'preference-off'
    | 'advertising-consent-missing' | 'capacity-exceeded' | 'unavailable';
}

export interface NotificationRuntime {
  getPermission(input: { readonly topics: readonly NotificationTopicId[] }):
    Promise<NotificationPermissionSnapshot & { readonly sources: Readonly<Record<NotificationTopicId, 'host' | 'record'>> }>;
  requestPermission(input: { readonly topics: readonly NotificationTopicId[]; readonly gesture: boolean }):
    Promise<NotificationPermissionResult>;
  register(): Promise<void>;
  setTopicPreference(input: { readonly topic: NotificationTopicId; readonly enabled: boolean }): Promise<void>;
  setAdvertisingConsent(input: {
    readonly advertising?: 'granted' | 'withdrawn';
    readonly night?: 'granted' | 'withdrawn';
    readonly textVersion: string;
  }): Promise<void>;
  readonly reminders: {
    set(input: { readonly key: string; readonly topic: NotificationTopicId; readonly fireAt: string; readonly templateData?: Readonly<Record<string, string | number>> }): Promise<ReminderResult>;
    cancel(input: { readonly key: string }): Promise<ReminderResult>;
  };
  openSettings(): Promise<'opened' | 'unavailable'>;
  subscribe(listener: (event: NotificationEvent) => void): () => void;
}
```

Runtime rules:

- **Reads.** `getPermission` returns the provider snapshot. A topic the host
  reports as `unknown` takes the latest backend record when one exists, and
  `sources` says which answered.
- **Requests.** With `permission.userGesture` and `gesture: false`, the call
  throws `NOTIFICATIONS_USER_GESTURE_REQUIRED` before reaching the host. A
  topic whose latest state is `blocked` answers `blocked` without reaching
  the host. Every other call reaches the host prompt, including one for a
  topic already recorded as granted; the host may answer `already-granted`.
- **Records.** Consent records are an append-only history per player, kind,
  and scope (the app, or one topic). The runtime appends a record only when a
  decided state differs from the latest record of that kind and scope: after
  `requestPermission`, and after a read that observes a changed decided state.
  `prompt`, `unknown`, and `unsupported` are never recorded. On a `per-send`
  provider every accepted prompt appends a `host-agreement` record even when
  the state is unchanged, because each acceptance allows one more delivery. App-scope
  providers write `delivery-permission` records without a topic; topic-scope
  providers write `host-agreement` records per topic with the host evidence.
  `setTopicPreference` writes `topic-preference` records (`granted` or
  `withdrawn`), and `setAdvertisingConsent` writes `advertising` and `night`
  records; both come from an authenticated player action (`source: 'player'`).
- **Registration.** After a grant on a provider with
  `remote.addressing: 'device'`, the runtime calls `register()` and sends the
  registration to the backend for the authenticated player. `register()`
  repeats that, for example after an account switch. Platform-user providers
  need no registration; the backend resolves them from the authenticated
  identity.
- **Restarts.** A restart drops runtime memory and listeners. Host state,
  backend records, and the backend authentication persist.

## Topic catalog {#topic-catalog}

Topics are declared by the game in a catalog file validated by
`pnpm validate:notifications`. The types live in `@mpgd/catalog`, next to
products and ad placements.

```jsonc
{
  "version": "2026-10-12",
  "defaultLocale": "ko",
  "topics": [
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
      "targets": {
        "ait": { "templateSetCode": "my-game-energy-full" },
        "android": { "channelId": "reminders" },
        "reddit": { "title": "Energy full", "body": "Your energy is full again." }
      }
    }
  ]
}
```

- `route` must be root-relative and pass the existing deep-link policy.
  An `advertising` topic also needs `optOutRoute`, the screen where the player
  withdraws advertising consent.
- Content comes from the target mapping when the provider's mapping carries
  its own copy (Devvit's pre-approved `title` and `body`), from the host
  template when `remote.content` is `host-template`, and otherwise from
  `copy[locale]`. The locale is the delivery's `locale`, else the endpoint's
  registered locale, else `defaultLocale`. Placeholders use `{{name}}` and are
  filled from the delivery's template data.
- `targets` keys are open target names. Each provider declares the mapping
  fields it needs, and the validator checks the catalog against the providers
  a target enables: Apps in Toss needs `templateSetCode`; Devvit needs
  `title` ≤ 60 and `body` ≤ 100 characters.
- An `advertising` topic must not map to a provider whose
  `remote.purposes` excludes it; the validator reports that before release.
- Optional `quietHours` (`{ "start": "22:00", "end": "08:00" }`) holds a
  non-advertising topic during those hours in the endpoint's `timeZone`, else
  the deployment's default zone, the same way the night window holds
  advertising.

## Reminders {#reminders}

Games set reminders as intents through the game-services client:

```ts
await notifications.reminders.set({ key: 'energy-full', topic: 'energy-full', fireAt });
await notifications.reminders.cancel({ key: 'energy-full' });
```

Routing is a pure decision in `@mpgd/platform`:

1. If the topic has the `local` channel and the provider's `local.supported`
   is true, schedule locally. A reminder never takes both routes, so a player
   never receives it twice.
2. Otherwise, if the topic has the `remote` channel and the provider's
   `remote.supported` is true, store a server reminder.
3. Otherwise answer `{ route: 'none', status: 'unavailable' }` and do
   nothing.

Before scheduling locally, the runtime applies, in this order, the parts of
the [policy gate](#policy-gate) it can evaluate on the client, with the same
reasons as statuses: delivery permission (`permission-required`), the topic
preference (`request-missing`, `preference-off`), and advertising consent
(`advertising-consent-missing`). A local `fireAt` inside the night window or
the topic's quiet hours moves to the window's end, as a server send would be
deferred. Server reminders are accepted without these checks, because the
gate runs again at send time.

Local reminders use inexact timing. Android 14 denies `SCHEDULE_EXACT_ALARM`
by default to new installs, Play restricts `USE_EXACT_ALARM` to alarm and
calendar apps, and a game reminder does not need minute precision. The
Capacitor template removes `SCHEDULE_EXACT_ALARM` from the merged manifest
and schedules with `isExactNotification: false`. The provider keeps at most
`local.maxPending` reminders, keeping the nearest ones.

Server reminders are keyed by player and `key`: setting the same key replaces
the pending reminder, and cancelling removes it. The scheduler re-runs the
[policy gate](#policy-gate) at send time, not at set time.

## Opens {#opens}

Every open becomes one `opened` event with a route:

| Open path | Source of the route |
| --- | --- |
| `payload` (Android, iOS) | The push data or local `extra`, delivered through the provider's buffered listener; cold starts are marked `source: 'cold'`. |
| `landing-url` (Apps in Toss) | The landing URL is set per template in the console. The provider reads `Environment.initialURL` and the `push` or `inbox` referrer at startup. |
| `host-link` (Devvit) | A notification links to a post or comment. The game routes from that post's data, so routing needs dedicated posts. |

The game routes the event like a launch intent. The data is untrusted: the
route only opens a screen, and anything worth claiming goes through the
server.

## Server {#server}

### Endpoint registry {#endpoint-registry}

The server records where a player can be reached, per provider. Registration
requires an authenticated request, because binding a device token to another
player's account would deliver that player's notifications to the device. A
device address is unique per provider: registering it for a new player moves
it. Platform-user providers (Apps in Toss, Devvit) register no address; the
backend resolves the recipient from the player's authenticated identity for
that provider, never from a key the client sends. A provider answer that the
address is dead (FCM `UNREGISTERED`) marks the endpoint invalid.

### Consent records {#consent-records}

The backend stores the [runtime's records](#runtime) as written:

| Record kind | Written by | Authority |
| --- | --- | --- |
| `delivery-permission` | Client report after a decided state changes | Hint; the host decides |
| `host-agreement` (per topic) | Client report with evidence, for example `apps-in-toss.notification-agreement.v1` | Hint; the host still enforces on send |
| `topic-preference` | Authenticated player action | Authoritative |
| `advertising`, `night` | Authenticated player action with the consent text version | Authoritative |

Each `advertising` or `night` record also yields the notices the law
requires. The due dates are pure functions over Korean calendar dates
(Asia/Seoul), and `dueBy` is the last day the notice may be given:

- Result notice: `dueBy` is 14 days after the record's date, counted from the
  next day, for every consent, refusal, or withdrawal.
- Re-confirmation notice: `dueBy` is the day before the same date two years
  after the latest consent of that kind, recomputed when consent is given
  again.

The game shows or sends the notice and records that it did.

### Policy gate {#policy-gate}

Every send passes one pure decision, `evaluateNotificationDelivery`, before
any provider call, including a scheduled reminder or a deferred send when it
comes due. The steps run in order and the first failure decides:

1. The topic exists and the provider's `remote.purposes` includes its
   purpose, or `suppressed: purpose-unsupported`.
2. The recipient resolves: a valid endpoint for `remote.addressing: 'device'`,
   or an authenticated platform identity for `'platform-user'`, or
   `unavailable: no-endpoint`.
3. Delivery permission allows it, or `suppressed: permission-denied`. When
   `permission.serverReadable` is true, the backend reads the host at send
   time and that answer decides (Devvit `isOptedIn`). Otherwise the latest
   `delivery-permission` record must not be `denied` or `blocked`, a
   `scope: 'topic'` provider needs a latest `host-agreement` of `granted` for
   the topic (or `suppressed: agreement-missing`), and a `per-send` provider
   needs an acceptance not yet used by a delivery (or
   `suppressed: allowance-exhausted`).
4. The topic preference allows it. A `requested` topic needs a latest
   `topic-preference` of `granted` (no record: `suppressed: request-missing`;
   latest `withdrawn`: `suppressed: preference-off`); on a `scope: 'topic'`
   provider a granted host agreement for the topic counts as that opt-in,
   because the player agreed to that topic's template. Other purposes are
   suppressed only by a latest `withdrawn` (`preference-off`).
5. An `advertising` topic needs a latest `advertising` record of `granted`, or
   `suppressed: advertising-consent-missing`.
6. Time windows. The night window runs from 21:00 inclusive to 08:00
   exclusive in Asia/Seoul, judged at the send time. An `advertising` send
   inside it without a latest `night` record of `granted` is
   `deferred` with `until` set to the next 08:00, or `suppressed:
   night-consent-missing` when the topic sets `"deferrable": false`. A topic's
   `quietHours` defer any purpose the same way.
7. Topic frequency caps and provider limits hold, or
   `suppressed: frequency-capped | provider-limit`. Provider limits come from
   the provider's registry entry (Devvit: 2 per user per day; Apps in Toss:
   10 per user per minute).
8. `advertising` content is labelled: the title and the body start with
   `(광고)`, followed by the deployment's configured sender name and contact
   when set, then one space and the text, and the payload carries the topic's
   `optOutRoute`. Host-template providers cannot carry advertising, so step 1
   already refused them.

Statuses are `delivered`, `suppressed`, `deferred`, and `unavailable`.
A deferred send is stored with its idempotency key and replayed through the
gate by the [scheduler](#scheduler) at `until`; asking again for the same key
while it waits answers `deferred` with the same `until`. Delivery then goes
through the claim/lease ledger and the provider's `deliverIdempotently`.
Unless a provider says otherwise, it accepts the send. An answer that the
address is dead returns `unavailable: endpoint-invalid` and invalidates the
endpoint; later sends find `no-endpoint`. The request and ledger keys move
from the closed `PlatformTarget`/`NotificationTopic` sets to open provider and
topic ids.

### Delivery providers {#remote-delivery}

- **FCM** (Android and iOS). HTTP v1 `messages:send` with an OAuth token from
  a service-account JWT signed through WebCrypto; it runs on Cloudflare
  Workers without HTTP/2. iOS devices register through Firebase Messaging so
  FCM relays to APNs; direct APNs needs HTTP/2, which Workers `fetch` does not
  document. Addresses are typed because FCM is moving from registration tokens
  to Firebase installation ids. `UNREGISTERED` invalidates the endpoint;
  `INVALID_ARGUMENT` does so only when the payload is known valid. Fan-out
  goes through a queue, since one Worker invocation has a subrequest limit.
- **Apps in Toss.** `sendFunctionalMessage` (and a bulk variant for 50+
  recipients) over mTLS with the template set code and context. Business
  errors arrive as HTTP 200 with `resultType: FAIL`: 4095 is retryable after
  `retryAfterSeconds`, 5004 means the template is not approved
  (configuration). Limits: 15,000 per minute per app, 10 per minute per user.
- **Devvit.** Runs inside the Devvit server, not the game-services Worker,
  because only that runtime can call the notifications API: `enqueue` with a
  title and body template and a post or comment link, up to 1,000 recipients
  per call, batched through the Devvit scheduler. The same delivery module and
  policy gate run there with a Redis-backed ledger.

### Reminder scheduler {#scheduler}

Server reminders and deferred sends are stored with a lease and processed
when due: a D1 table plus a Cron trigger on the game-services Worker, and the
Devvit scheduler in the Devvit server. A due item becomes a normal send
through the policy gate. A reminder's idempotency key is
`reminder:<player>:<key>:<fireAt as ISO 8601 with milliseconds>`; a deferred
send keeps its own key.

## Provider profiles {#profiles}

| Profile | `permission` | `remote` | `local` | `open` |
| --- | --- | --- | --- | --- |
| Capacitor + FCM (Android, iOS) | app, os, readable, persistent, gesture not required, settings | device, free-form, all three purposes | supported, inexact, iOS `maxPending` 64 | payload |
| Apps in Toss | topic, host, not readable, persistent, gesture required, no settings link | platform-user, host-template, `service` and `requested` | unsupported | landing-url |
| Devvit | app, game, readable through the server bridge and server-readable, persistent, gesture required | platform-user, free-form (approved copy), `service` and `requested` | unsupported | host-link |
| Web, Microsoft Store PWA, CrazyGames, OnePlay, Verse8 | `availability: 'unsupported'` | unsupported | unsupported | none |
| WeChat (not planned) | topic, host, partly readable, **per-send**, gesture required, at most 3 per prompt | platform-user, host-template | unsupported | landing-url |

### Capacitor {#profile-capacitor}

- Use `@capacitor-firebase/messaging` for remote and
  `@capacitor/local-notifications` for local. Do not also install
  `@capacitor/push-notifications`: on iOS both claim Capacitor's single push
  handler slot.
- The adapter defines injected `PushSdk` and `LocalNotificationSdk`
  interfaces, like the commerce `StoreSdk`; the template passes the plugin
  objects, so `@mpgd/adapter-capacitor` gains no plugin dependency.
- Permission mapping: Capacitor reports `prompt-with-rationale` after the
  first Android denial and `denied` after the second, which is permanent, so
  the provider maps that to `blocked`; iOS `denied` is `blocked`. Android 12
  and below have no runtime permission, and push plugins can report `granted`
  while the player has turned notifications off (`@capacitor/push-notifications`
  does); the provider reads `LocalNotifications.checkPermissions`, which
  reflects the system setting.
- Android channels come from the catalog (`targets.android.channelId`), with
  separate channels for advertising so a player can turn them off in system
  settings.
- Verify cold-start opens on a device: Capacitor 8.5 moved the iOS template to
  the UIScene lifecycle, which sets the notification delegate later than Apple
  recommends.

### Apps in Toss {#profile-ait}

- Agreement uses `Notification.requestAgreement({ options: { templateCode } })`
  (Toss app 5.255.0 or later; the provider checks `isSupported()` and answers
  `NOTIFICATIONS_HOST_VERSION_UNSUPPORTED` below it). `templateCode` is the
  same value as the send API's `templateSetCode`, so one catalog field serves
  both.
- Events: `newAgreement` and `alreadyAgreed` map to granted, and
  `agreementRejected` to denied. `TERMS_DISAGREED_MEMBER` (the user turned off
  Toss's personalization terms) maps to `blocked`, and
  `NOTIFICATION_AGREEMENT_FAILED` (bad code) to
  `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
- Neither the client nor the server can read the agreement, and revocation in
  Toss settings raises no event, so `readable` is false and the server record
  is what the gate uses. A send to a user who revoked fails at the host and is
  recorded like any provider failure.
- Only templates linked to an agreement statement need agreement; the console
  rejects opt-in style templates without one. Copy (title ≤ 7, body ≤ 25
  characters) and the landing URL live in the console template.
- Functional messages may not carry benefits or retention content, and
  promotional campaigns are console-only, so `remote.purposes` excludes
  `advertising`. Console recurring sends (daily or weekly, name variable only)
  are a host feature outside the kit.

### Devvit {#profile-devvit}

- Notifications are a gated beta. The target config keeps
  `approval-required` until Reddit approves the app; copy is pre-approved by
  Devvit admins.
- There is no Reddit consent screen. The game renders its own toggle, and the
  server bridge calls `optInCurrentUser` or `optOutCurrentUser` for the
  logged-in requester and reads `isOptedIn`. A logged-out player needs login
  first, which the provider reports as `action-required` availability.
- No opt-out event exists and opt-out may move into Reddit settings, so the
  gate reads `isOptedIn` at send time instead of copying it.

## Advertising rules {#advertising-rules}

Korean law (정보통신망법 §50) governs advertising sent by app push. The
current guide is KISA's 「불법 스팸 방지를 위한 정보통신망법 안내서」 7th revision
(KISA-GD-2025-0037, 2025-12, posted 2026-03-04). Page numbers below are its
printed pages.

What the kit enforces for `advertising` topics:

- Prior opt-in to advertising, separate from the OS permission: allowing push
  is not advertising consent (p.55, Q02-03). The consent must be explicit, not
  pre-checked, and not phrased as a benefit-alert agreement (p.12).
- Separate night consent for messages arriving between 21:00 and 08:00 KST
  (§50③, p.18).
- "(광고)" at the start, the sender name unless it equals the app name, and an
  opt-out path that opens the opt-out screen directly (pp.43–44).
- A result notice within 14 days of a consent, refusal, or withdrawal, and a
  re-confirmation notice every two years per medium (§50⑦–⑧; pp.23–26,
  65–70).

What the kit does not decide: whether a given topic is advertising. The guide
has no example about games, rewards, energy, or attendance; its only game
item is consent scope (p.55, Q02-02). Its general criteria are:

- Advertising is information sent for the sender's economic benefit,
  including image promotion; any advertising part makes the whole message
  advertising (p.11).
- Not advertising: information a contract or transaction obliges the sender
  to deliver, information the recipient requested, and issue or expiry
  notices for coupons the user earned by their own action (p.11). Repeated
  sends without a further request turn requested information into
  advertising (p.11, p.52 Q01-10).
- Advertising: coupons or points handed out unilaterally (p.11), periodic
  reminders that promote use (p.50 Q01-01), deadline nudges (p.50 Q01-02),
  and abandoned-cart reminders (p.51 Q01-07). KISA's FAQ treats a for-profit
  sender's messages as advertising unless an exception applies.

The purposes map onto these criteria: `service` is the transaction and
real-player-action case, `requested` is the request case with its
repeated-send caveat, and everything else is `advertising`. Each game decides
per topic, ideally with legal review before launch. The starter topics'
defaults are an [open question](#open-questions).

Other rules the profiles encode: App Review Guideline 4.5.4 (no required push;
explicit opt-in and in-app opt-out for marketing push), 5.1.2(i) (no reward
for enabling push), Google Play's notification policy (promotions for the app
itself are allowed; ads, promotion of other apps, and notifications that
imitate the system are not), the Apps in Toss functional-message rules, and
Devvit's content rules.

## Bridge and versioning {#bridge}

- Methods: `notifications.v2.getCapabilities`, `.getPermission`,
  `.requestPermission`, `.register`, `.scheduleLocal`, `.cancelLocal`,
  `.listLocal`, `.openSettings`. Transports without v2 answer
  `NOTIFICATIONS_V2_UNAVAILABLE`, which is not retryable.
- Events share the bridge event channel. `BridgeEvent` becomes a union
  discriminated by `protocol`: the existing `mpgd.commerce.v2` envelope and
  `{ protocol: 'mpgd.notifications.v2', sequence, event }`, with `sequence`
  per session starting at 0.
- typia validators and generated JSON Schemas cover every bridge payload, as
  for commerce.

## Conformance vectors {#vectors}

Vectors live in
[`docs/specs/notifications/vectors/`](https://github.com/imjlk/mpgd-kit/tree/main/docs/specs/notifications/vectors).
N2 adds the runner to `@mpgd/platform` with a reference runtime, a fake host,
a fake backend that applies the pure policy gate, and a clock. Each vector is
written for one fixture profile and declares in `appliesTo` the capability
fields its scenario depends on. A provider in P1–P3 runs, through a
`createProvider` hook as commerce providers do, every vector whose
`appliesTo` its own capabilities satisfy; the reference runtime runs all of
them with fixture providers.

### Vector format {#vector-format}

| Field | Meaning |
| --- | --- |
| `vector`, `protocol`, `summary` | Id, draft protocol version, and what the scenario proves |
| `appliesTo` | Predicates on capability paths that must all hold: `{ "path": "permission.prompt", "equals": "os" }`, `{ "path": "remote.purposes", "includes": "advertising" }`, or `"excludes"` |
| `profile` | `provider`, `capabilities`, and optional server-side `limits` (`perUserPerDay`) |
| `catalog` | Topic entries as in the [topic catalog](#topic-catalog), with the provider mapping for this one profile under `mapping` instead of `targets` |
| `context` | `player`, `now`, and the player's default `timeZone` |
| `host` | Fake host settings: `deniesBeforeBlocked`, the number of denials after which the OS reports `blocked` (absent: never) |
| `steps` | Actor actions in order; a step may carry `returns` (matched as a subset) or `throws` (`{ code }`) |
| `expect` | Final assertions; a key that is absent is not asserted |

Fake defaults: the host starts at `prompt` for `os` and `game` prompts,
`unknown` for unreadable `host` prompts, and `unsupported` for an unsupported
profile, and it issues no endpoint until `issueEndpoint`. The backend's
provider answers `accepted` unless `queueProviderResult` queued another
answer. A `tap` buffers until the first subscriber and is `cold` when it came
before `runtime.start`, `warm` after.

| Actor | Actions |
| --- | --- |
| `runtime` | `start`; `restart` (see [Runtime](#runtime)) |
| `clock` | `set` (`at`), `advance` (`seconds`) |
| `host` | `queuePrompt` (`result`: `granted`, `already-granted`, `denied`, `dismissed`, `host-terms-declined`); `setPermission` (`state`); `issueEndpoint` (`endpoint`: `{ kind, value }`); `tap` (`input`: `{ channel, topic?, route?, data? }`) |
| `game` | The [runtime](#runtime) methods: `getPermission`, `requestPermission` (`topics`, `gesture`), `register`, `setTopicPreference`, `setAdvertisingConsent`, `setReminder`, `cancelReminder`, `openSettings`, and `subscribe` (`listener` names the listener) |
| `backend` | `authenticate` (`player`); `deliver` (`input`: `topic`, `idempotencyKey`, optional `player` defaulting to `context.player`, `templateData`, `locale`); `queueProviderResult` (`result`: `accepted`, `unregistered`, `rate-limited`); `runScheduler` (process every due reminder and deferred send) |

`expect` keys, each a list matched exactly in length and order, with only the
listed fields of each item asserted:

| Key | Item |
| --- | --- |
| `prompts` | A number: calls that reached the host prompt API |
| `consent` | [Consent records](#runtime) without `at` |
| `endpoints` | Final endpoints: `provider`, `kind`, `value`, `player`, `status` (`valid` or `invalid`) |
| `deliveries` | Every gate or scheduler outcome: `idempotencyKey`, `topic`, `status`, `reason`, `until` |
| `providerCalls` | Every provider send: `topic`, `mapping`, `content` (`title`, `body`, `optOutRoute`) |
| `local` | `operations` (`op`: `schedule`, `replace`, `cancel`, with `key`, `topic`, `fireAt`, `exact`) and the final `pending` list |
| `reminders` | Pending server reminders |
| `events` | An object keyed by listener name, each a list of events |
| `notices` | `kind` (`consent-result`, `reconfirmation`), `record`, `dueBy` (an Asia/Seoul date) |

| Vector | Checks |
| --- | --- |
| `os-permission-granted` | One app-scope prompt grants every topic; endpoint registration; permission record |
| `os-permission-denied-twice` | `prompt-with-rationale` then `blocked`; no third dialog |
| `local-schedule-never-prompts` | Scheduling without permission returns `permission-required` and shows nothing |
| `host-agreement-recorded` | Unreadable host: agreement recorded with evidence, read back as granted after a restart; `already-granted` stays one record |
| `host-gesture-and-terms` | No gesture throws `NOTIFICATIONS_USER_GESTURE_REQUIRED`; host terms declined is `blocked` |
| `per-send-allowance` | One acceptance allows one delivery |
| `game-rendered-opt-in` | Game prompt, server opt-in, revocation read at send time |
| `requested-topic-needs-opt-in` | A `requested` topic is suppressed until the player turns it on |
| `advertising-needs-consent` | Suppressed without consent; labelled after consent; result and re-confirmation notices due |
| `advertising-night-window` | Deferred to 08:00 KST without night consent; immediate with it |
| `advertising-unsupported-by-host` | A host-template provider refuses an advertising topic |
| `reminder-local-route` | A `requested` topic without opt-in is refused; local route, replace by key, cancel; no server reminder |
| `reminder-server-route` | Server route, cancel, re-set, delivery at the due time through the gate |
| `open-before-listener` | A cold-start open reaches the first subscriber once |
| `endpoint-lifecycle` | A device address moves to the newly authenticated player; `UNREGISTERED` invalidates it |
| `provider-daily-limit` | A provider limit suppresses the third send of the day |
| `unsupported-target` | Reads answer `unsupported`, requests answer `unavailable` without a prompt, reminders are unavailable |

## Migration and PR plan {#pr-plan}

The v1 `NotificationSubscriptionAdapter` stays. N2 adds
`toNotificationSubscriptionAdapter(provider, catalog)` so a v2 provider serves
v1 callers. The v1 delivery request types stay as deprecated aliases. Every PR
that changes a publishable package carries a Sampo changeset.

| PR | Scope | Closes |
| --- | --- | --- |
| N1 | This RFC and the vectors | |
| N2 | `@mpgd/platform/notifications`: types, capabilities, permission mapping helpers, the pure policy gate, notice due dates, reminder routing, typia validators and JSON Schemas; `@mpgd/catalog` topic catalog and `validate:notifications`; conformance runner, reference runtime, and fakes passing every vector; v1 wrapper | Closed topics |
| N3 | Bridge `notifications.v2.*` methods, the event union, fail-closed answers in every transport; `gateway.notificationsV2` gating in the target-config runtime | |
| P1 | `@mpgd/adapter-ait`: provider over `Notification.requestAgreement`, agreement evidence, landing opens; `@mpgd/game-services`: Apps in Toss functional-message delivery provider with bulk send and `FAIL` code mapping | Session-only agreements, deprecated API |
| P2 | `@mpgd/adapter-capacitor`: provider over injected `PushSdk` and `LocalNotificationSdk`, channels, cold-start buffering, settings link | |
| P3 | `@mpgd/adapter-devvit`: game-rendered opt-in through the server bridge and a delivery provider over `enqueue` inside the Devvit server | |
| S1 | `@mpgd/game-services` and the Worker: endpoint registry, consent records, policy gate, FCM delivery provider, D1 migrations, authenticated routes, dead-endpoint handling | No endpoints, no consent records |
| S2 | Reminders: client intent API with routing, server scheduler (D1 and Cron), Devvit scheduler path | No reminders |
| C1 | CLI and templates: `--providers notifications`, plugin wiring, Firebase setup guide, a sample consent screen for advertising and night consent, docs | |

All of N1–C1 is the first release wave. Releases follow N3, S2, and C1. The
v1 adapter and the deprecated delivery aliases go away in the major release
that also removes commerce v1.

## Open questions {#open-questions}

1. **Starter topic purposes.** The v1 topics need declared purposes in the
   template. Measured against the guide's criteria, `friend-challenge`
   (relaying a real player's action) reads as `service`, a daily content
   release reads as `requested` once the player turns it on, and
   `streak-at-risk` resembles the deadline nudges the guide calls advertising.
   The project owner decides before C1.
2. **Night window scope.** Apply the 21:00–08:00 KST window to every recipient
   of a deployment that enables the Korean rules, or only to recipients known
   to be in Korea.
3. **Devvit ledger.** Confirm that a Redis-backed claim/lease ledger inside the
   Devvit server meets the delivery ledger's fencing contract.
4. **Scheduler backend.** D1 plus Cron is the default; Durable Object alarms
   would give per-player precision at higher cost.
5. **Remote copy on the server.** Whether the Worker reads localized copy from
   the catalog file or from a project-provided resolver.

## References {#references}

- KISA, 「불법 스팸 방지를 위한 정보통신망법 안내서」 7th revision (KISA-GD-2025-0037):
  <https://spam.kisa.or.kr/spam/na/ntt/selectNttInfo.do?mi=1020&bbsId=1002&nttSn=3001>
- 정보통신망법 and its decree: <https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=290001>,
  <https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=290483>
- Apps in Toss push notifications (console and SDK):
  <https://developers-apps-in-toss.toss.im/guide/marketing/smart-message.md>,
  <https://developers-apps-in-toss.toss.im/documentation/common/growth/smart-message.md>,
  <https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/notification/notification.requestagreement.md>,
  game checklist <https://developers-apps-in-toss.toss.im/checklist/app-game.md>
- Devvit notifications: <https://developers.reddit.com/docs/capabilities/notifications/notifications-overview>,
  <https://developers.reddit.com/docs/capabilities/notifications/pn-best-practices>
- Capacitor: <https://capacitorjs.com/docs/apis/push-notifications>,
  <https://github.com/ionic-team/capacitor-local-notifications>,
  <https://github.com/capawesome-team/capacitor-firebase/tree/main/packages/messaging>
- Android: <https://developer.android.com/develop/ui/views/notifications/notification-permission>,
  <https://developer.android.com/about/versions/14/changes/schedule-exact-alarms>
- Apple: <https://developer.apple.com/app-store/review/guidelines/>,
  <https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications>
- FCM HTTP v1: <https://firebase.google.com/docs/cloud-messaging/auth-server>,
  <https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode>
- WeChat subscribe messages:
  <https://developers.weixin.qq.com/minigame/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html>
