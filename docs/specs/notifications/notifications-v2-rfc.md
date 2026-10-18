# Notifications v2 contract (RFC)

Status: **draft proposal (N1)**. This RFC describes a contract that does not
exist yet. It is not confirmed runtime behavior, and it is outside the
enforced [documentation evidence](../../DOCUMENTATION_EVIDENCE.md) scope until
N2 lands the types and a conformance runner that cite it. Baseline:
`main@2f70328e`, 2026-10-12, revised the same day after review. Draft
protocol: `mpgd.notifications.v2`, version `2.0.0-draft.1`.

Platform facts below were checked on 2026-10-12 against the sources listed in
[References](#references); P1 re-checked the Apps in Toss facts on
2026-10-19. Host policies change; re-check a fact before a provider pull
request depends on it.

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
A topic's purpose decides which consent it needs under host policy and, when
a deployment enables them, under the Korean advertising rules in
[Advertising rules](#advertising-rules). The client asks for permission and
reports what the user decided; the server keeps the consent records, applies
one policy gate, and sends. A reminder is expressed as an intent, and the kit
picks a local notification or a server-scheduled push from the target's
capabilities.

## Current state {#current-state}

The table records the baseline this RFC started from. P1 replaced the Apps in
Toss row (see [Apps in Toss](#profile-ait)) and added an Apps in Toss
functional-message delivery provider (see [Delivery providers](#remote-delivery)).

| Area | At the baseline |
| --- | --- |
| Client contract | `PlatformGateway.notifications` (`NotificationSubscriptionAdapter`): `getStatus(topic)` and `requestSubscription(topic)` over a closed `NotificationTopic` union of `daily-ready`, `streak-at-risk`, `friend-challenge`. It manages subscription state only and never sends. |
| Apps in Toss | The host bridge maps topics to template codes and calls the deprecated `requestNotificationAgreement`. Agreements live in a session-only `Set`, so after a restart a user who agreed reads as `not-subscribed`. `TERMS_DISAGREED_MEMBER` and any other error collapse into `unavailable`, and a request that gets no answer settles as `unavailable` after 120 seconds. |
| Android, iOS | `@mpgd/capacitor-game-services` answers `configuration-required` and `unavailable`. No push or local-notification plugin is installed. |
| Devvit | The server bridge answers `approval-required` and `unavailable`, which matches Devvit's gated beta. |
| Web targets, WeChat | `getStatus` answers `unsupported` and `requestSubscription` answers `unavailable` (browser, WeChat, and the Cloudflare Pages bridge). |
| Target config | `integrations.notifications` is `configuration-required` for `android`, `ios`, and `ait`, `approval-required` for `reddit`, and `unsupported` elsewhere. |
| Server | `@mpgd/game-services/notification-delivery` defines a claim/lease delivery ledger contract that binds each key to its full request, a deep-link policy (root-relative links that stay on the game origin, absolute links only on allowed origins), input bounds (identifiers up to 2,048 characters, at most 128 template entries), an in-memory test ledger, and an idempotent `NotificationDeliveryProvider`, keyed by the closed `PlatformTarget` and `NotificationTopic` sets. No durable ledger implementation ships. `apps-in-toss-partner-api` can send one functional message over mTLS but is not wired as a delivery provider. |

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
  preference, advertising consent, time windows, and provider limits before
  any send.
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
- Bulk sends in the first wave; see [Open questions](#open-questions).
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
   routing, notice due dates, and the conformance runner live in
   `@mpgd/platform` and stay free of Phaser, DOM, network, and SDK imports.
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
| `advertising` | Anything sent to promote use or sales: events, sales, new items, and the cases the Korean guide lists as advertising, such as benefits handed out unasked and deadline nudges | Advertising consent and an opt-out route; under the Korean rules also night consent for 21:00–08:00 KST and labelled content. See [Advertising rules](#advertising-rules). |

The purpose also selects the host path. On Apps in Toss, `service` and
`requested` topics are functional messages, and `advertising` topics are not
deliverable through the API; a `service` template without an agreement
statement needs no agreement at all (see [Apps in Toss](#profile-ait)). On
iOS, an `advertising` topic also needs the explicit opt-in and in-app opt-out
that App Review Guideline 4.5.4 requires.

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
- **Turn off where it was turned on.** A consent the game renders itself
  (Devvit) is withdrawn in the game too, through `revokePermission`.

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
    /**
     * How many denials the host accepts before only settings can change the
     * answer: iOS 1, Android 13+ 2. A dismissed dialog is not a denial.
     * Absent when the host can always ask again (Apps in Toss, Devvit, WeChat).
     */
    readonly promptLimit?: number;
    readonly maxTopicsPerPrompt?: number;
    /** Whether `openSettings` can open the OS or host notification settings; the runtime's `openSettings` answers 'unavailable' when it is false. */
    readonly settings: boolean;
  };
  readonly remote: {
    readonly supported: boolean;
    /** Purposes the host lets the server deliver. */
    readonly purposes: readonly NotificationPurpose[];
    /** `'none'` exactly when `supported` is false. */
    readonly addressing: 'device' | 'platform-user' | 'none';
    readonly content: 'free-form' | 'host-template';
  };
  readonly local: {
    readonly supported: boolean;
    /** Pending-notification ceiling the provider must stay under (iOS: 64). */
    readonly maxPending?: number;
  };
  /** How an open reaches the game. */
  readonly open: 'payload' | 'landing-url' | 'host-link' | 'none';
}
```

A provider returns a fresh object on every read. `availability` uses the
existing `PlatformProviderAvailability` values; while the host needs a player
action first, it is `action-required` (see the
[client contract](#client-contract)). Local reminders are always inexact (see
[Reminders](#reminders)), so the capability carries no timing. Release gates
such as Devvit's `approval-required` stay in the target config's
`integrations.notifications` state, which decides whether the gateway exposes
the provider at all.

The gateway's capability snapshot gains `PlatformCapabilities.notifications?:
NotificationCapabilities` under the capability-snapshot rules (a fresh object
with exact keys), as commerce added its block. Whenever `notificationsV2` is
exposed, `providerAvailability.pushNotifications` equals
`notifications.availability`, so the target config gates on the v2 state. An
adapter that exposes the v1 `notifications` adapter next to `notificationsV2`
serves v1 from the same provider, so the two report the same readiness. P2
does this for Capacitor, and P1 and P3 do the same where they keep v1. The
target config still takes the readiness from the v2 block, so the state
follows v2 even where an adapter's v1 disagrees.

The client declaration describes what the provider can do on the device. The
backend never trusts it for a send decision: the gate reads the server's own
[provider registry](#provider-registry) entry, and the runtime compares the
two at start.

## Client contract {#client-contract}

The types below are a sketch for N2. Names are proposed; field sets are the
substance of this RFC.

```ts
export type NotificationTopicId = string & Record<never, never>;
export type NotificationPurpose = 'service' | 'requested' | 'advertising';
/** Open provider id. Reference ids: 'fcm', 'apps-in-toss', 'devvit'. */
export type NotificationProviderId = string;
/** The player action a host needs before it can prompt. */
export type NotificationRequiredAction = 'login' | 'host-settings';

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
  /** The host needs a player action first: logging in on Devvit. */
  | 'action-required'
  | 'unsupported';

export interface NotificationPermissionSnapshot {
  /** Present when `permission.scope` is 'app'. */
  readonly app?: NotificationPermissionState;
  readonly topics: Readonly<Record<NotificationTopicId, NotificationPermissionState>>;
  /** Present with an `action-required` state. */
  readonly requiredAction?: NotificationRequiredAction;
}

/**
 * What one `requestPermission` call produced for a topic: the host's answer
 * when the prompt ran ('granted', 'already-granted', 'denied', and
 * 'dismissed' when it closed without an answer), 'blocked' when the host
 * refused for good or the call did not reach the prompt because the host
 * read was already blocked, 'action-required' when the host needs a player
 * action before it can prompt (`requiredAction` names it), and
 * 'unavailable' when the provider is unsupported or the topic has no mapping
 * for it. The snapshot carries the resulting state, so a second Android
 * denial reports outcome 'denied' with snapshot 'blocked'.
 */
export type NotificationPermissionOutcome =
  | 'granted' | 'already-granted' | 'denied' | 'blocked' | 'dismissed'
  | 'action-required' | 'unavailable';

export interface NotificationPermissionResult {
  readonly snapshot: NotificationPermissionSnapshot;
  readonly outcomes: Readonly<Record<NotificationTopicId, NotificationPermissionOutcome>>;
  readonly requiredAction?: NotificationRequiredAction;
  /** Host decision for the server record, for example an Apps in Toss agreement event. */
  readonly evidence?: PlatformEvidenceEnvelope;
}

export interface NotificationEndpointRegistration {
  readonly provider: NotificationProviderId;
  readonly address:
    | {
        readonly kind: 'fcm-token' | 'fcm-installation';
        readonly value: string;
        readonly environment?: 'production' | 'sandbox';
        /** The device's app-scope permission when this registration was sent. */
        readonly permission: NotificationPermissionState;
      }
    /** The server resolves the recipient from the authenticated player. */
    | { readonly kind: 'platform-user' };
  readonly locale?: string;
  /** IANA zone, used for a topic's quiet hours. */
  readonly timeZone?: string;
}

export interface LocalNotificationRequest {
  /** Stable logical key; the provider derives its native id from it. */
  readonly key: string;
  readonly topic: NotificationTopicId;
  /** RFC 3339 with an explicit offset. */
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
  /** Exists exactly when `permission.prompt` is 'game': withdraws the game-rendered consent. */
  revokePermission?(input: { readonly topics: readonly NotificationTopicId[] }): Promise<NotificationPermissionResult>;
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
  `NOTIFICATIONS_CONFIGURATION_REQUIRED` (keeping the host's own code as
  `hostCode`), `NOTIFICATIONS_USER_GESTURE_REQUIRED`,
  `NOTIFICATIONS_HOST_VERSION_UNSUPPORTED`, `NOTIFICATIONS_INVALID_INPUT`,
  `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`, and `NOTIFICATIONS_V2_UNAVAILABLE`
  from a bridge without v2. Only `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` is
  retryable.
- **A required player action is a state.** It reaches the game in one of two
  ways, and both carry `requiredAction`:
  - While the host needs a player action before it can prompt at all
    (`availability: 'action-required'`, for example a logged-out Devvit
    player), reads answer `action-required` and requests answer the
    `action-required` outcome without reaching a prompt. For `login` the game
    calls `identity.requestUpgrade({ reason: 'notifications' })` and reads
    again.
  - A host may also answer a prompt that way (Apps in Toss when the player has
    turned off Toss's personalization terms). For `host-settings` the game
    explains where the player changes the setting, because the kit can neither
    open nor observe it. The next request reaches the host again.

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
  readonly state: Exclude<NotificationPermissionState, 'prompt' | 'unknown' | 'action-required' | 'unsupported'> | 'withdrawn';
  readonly source: 'client-report' | 'player' | 'provider';
  /** Set by the backend's clock. */
  readonly at: string;
  readonly evidence?: PlatformEvidenceEnvelope;
  /** Consent text version for advertising and night consent. */
  readonly textVersion?: string;
}

export type NotificationNoticeVariant =
  | `consent-result.${'advertising' | 'night'}.${'granted' | 'withdrawn' | 'refused'}`
  | `reconfirmation.${'advertising' | 'night'}`;

export interface NotificationNotice {
  readonly kind: 'consent-result' | 'reconfirmation';
  /** The advertising or night record the notice reports on, with its date. */
  readonly record: Pick<NotificationConsentRecord, 'kind' | 'state' | 'at' | 'textVersion'>;
  /** The last Asia/Seoul calendar date the notice may be given, as YYYY-MM-DD. */
  readonly dueBy: string;
  /** The variant of the catalog's notices.copy it is given in, such as 'consent-result.night.refused'. */
  readonly variant: NotificationNoticeVariant;
}

export interface ReminderResult {
  readonly route: 'local' | 'remote' | 'none';
  readonly status:
    | 'scheduled' | 'replaced' | 'cancelled'
    | 'permission-required' | 'request-missing' | 'preference-off'
    | 'advertising-consent-missing' | 'frequency-capped' | 'quiet-hours'
    | 'capacity-exceeded' | 'action-required' | 'unavailable';
}

export interface NotificationRuntime {
  getPermission(input: { readonly topics: readonly NotificationTopicId[] }):
    Promise<NotificationPermissionSnapshot & { readonly sources: Readonly<Record<NotificationTopicId, 'host' | 'record'>> }>;
  requestPermission(input: { readonly topics: readonly NotificationTopicId[]; readonly gesture: boolean }):
    Promise<NotificationPermissionResult>;
  /** Game-rendered consent only (`permission.prompt` is 'game'). */
  revokePermission(input: { readonly topics: readonly NotificationTopicId[] }): Promise<NotificationPermissionResult>;
  register(): Promise<void>;
  /** Unbinds this installation's address from the player, for example at logout. */
  unregister(): Promise<void>;
  setTopicPreference(input: { readonly topic: NotificationTopicId; readonly enabled: boolean }): Promise<void>;
  setAdvertisingConsent(input: {
    readonly advertising?: 'granted' | 'withdrawn';
    readonly night?: 'granted' | 'withdrawn';
    readonly textVersion: string;
  }): Promise<void>;
  readonly reminders: {
    set(input: {
      readonly key: string;
      readonly topic: NotificationTopicId;
      readonly fireAt: string;
      readonly templateData?: Readonly<Record<string, string | number | boolean>>;
      /** A post or comment id for providers whose sends need a link (Devvit). */
      readonly link?: string;
    }): Promise<ReminderResult>;
    cancel(input: { readonly key: string }): Promise<ReminderResult>;
  };
  readonly notices: {
    list(): Promise<readonly NotificationNotice[]>;
    /** Records a listed notice, passed as is or by its name: its kind, its record's kind and time, and its `dueBy`. */
    recordShown(input: NotificationNotice | {
      readonly kind: NotificationNotice['kind'];
      readonly record: { readonly kind: 'advertising' | 'night'; readonly at: string };
      readonly dueBy: string;
    }): Promise<void>;
  };
  openSettings(): Promise<'opened' | 'unavailable'>;
  subscribe(listener: (event: NotificationEvent) => void): () => void;
}
```

Runtime rules:

- **Start.** The runtime subscribes to the provider before `start` resolves
  and buffers every provider event until the game's first `subscribe`. That
  subscriber receives them once, in order; later subscribers receive only
  later events. After `stop()`, the next `start` buffers again for its first
  subscriber. The runtime itself acts on `endpoint-changed` and
  `permission-changed` as they arrive.
- **Topics.** A read, request, or revocation takes each topic once, however
  often the call lists it, so one prompt never writes two acceptances.
- **Reads.** `getPermission` returns the provider snapshot. A topic the host
  reports as `unknown` takes the latest backend record when one exists, and
  `sources` says which answered. A game-rendered consent is one boolean at the
  host (Devvit `isOptedIn`). Opted in reads `granted`. Not opted in reads
  `prompt` until a decision is recorded, and `denied` after that, including
  after a revocation.
- **Requests.** With `permission.userGesture` and `gesture: false`, the call
  throws `NOTIFICATIONS_USER_GESTURE_REQUIRED` before reaching the host. A
  topic whose host read is `blocked` answers `blocked`, and a provider in
  `action-required` answers `action-required`, without reaching the host. A
  recorded `blocked` alone never stops a request to a host that cannot be
  read. A topic whose mapping needs no host agreement answers
  `already-granted` without reaching the host. Every other call reaches the
  host prompt, including one for a topic already recorded as granted; the
  host may answer `already-granted`. After
  a denial the host reports `prompt-with-rationale` while denials remain
  under `permission.promptLimit` and `blocked` once they are used up; a host
  without a limit reports `denied`. A `dismissed` answer leaves the state as
  it was and counts no denial.
- **Revocation.** `revokePermission` withdraws a game-rendered consent at the
  host (Devvit `optOutCurrentUser`), answers the `denied` outcome for each
  topic, reads again, and records the result as a player action
  (`source: 'player'`). Other providers do not offer it: their
  consent changes in OS or host settings.
- **Records.** Consent records are an append-only history per player, kind,
  and scope (the app, or one topic), dated by the backend's clock.
  - **When a record is appended.** Only when a decided state differs from the
    latest record of that kind and scope: after `requestPermission` or
    `revokePermission`, and after a read that observes a changed decided state.
  - **What is never recorded.** `prompt`, `unknown`, `action-required`, and
    `unsupported`. Nor is a `dismissed` outcome, or the state of a topic whose
    mapping needs no host agreement, because host policy, not a player
    decision, granted that.
  - **Per-send providers.** Every accepted prompt appends a `host-agreement`
    record even when the state is unchanged, because each acceptance allows
    one more delivery.
  - **Which kinds each provider writes.**
    - Device-addressed providers write no `delivery-permission` records: the
      [endpoint registry](#endpoint-registry) holds each installation's
      permission.
    - Other app-scope providers write `delivery-permission` records without a
      topic.
    - Topic-scope providers write `host-agreement` records per topic with the
      host evidence.
  - **Agreements for `requested` topics.** When the player accepts a host
    agreement for a `requested` topic (outcome `granted` or `already-granted`),
    the runtime also appends a `topic-preference` record of `granted` unless
    the latest one already is. Accepting that topic's sheet is the player's
    request.
  - **Player actions.** `setTopicPreference` writes `topic-preference` records
    (`granted` or `withdrawn`), and `setAdvertisingConsent` writes
    `advertising` and `night` records. Both come from an authenticated player
    action (`source: 'player'`).
  - **Before authentication.** A record observed before authentication is sent
    at authentication; only the latest per kind and scope is kept.
- **Backend calls.** A call that reaches the backend (a player action, a
  server reminder, `reminders.cancel`'s server part, and `notices`) belongs to
  the player signed in when it began.
  - Before sign-in it throws `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
  - It is refused the same way when another player signed in since it began,
    so it never reads or changes the next player's state.
- **Registration.** For `remote.addressing: 'device'`, the runtime sends the
  provider's registration, with the device's current permission, to the
  backend for the authenticated player.
  - **When it sends.** After a grant; whenever an `endpoint-changed` event
    arrives (a rotated FCM token replaces the old address for that
    installation); whenever a read, a request, or a revocation changes the
    device's decided permission; when a player authenticates (an account
    switch moves the installation to the new player); at start and on each
    read, once the registration the backend last acknowledged is older than
    7 days, so the endpoint of a device in use never goes stale; and on
    `register()`.
  - **Before authentication.** A registration needs an authenticated player;
    one that arrives earlier is sent at authentication.
  - **Skipping repeats.** The runtime persists the last registration the
    backend acknowledged, with its player and session. It skips an identical
    one for the same player and session unless it is older than 7 days. A new
    session, an account switch, and `register()` always send; refreshing the
    same session does not count as authentication.
  - **Platform-user providers.** They send a `{ kind: 'platform-user' }`
    registration carrying `locale` and `timeZone` at authentication and
    whenever either changes; the backend resolves the recipient itself.
  - **Unbinding.** `unregister()` sends an authenticated unbind for the
    installation. The game-services logout calls it before it closes the
    session. The backend also unbinds when the session that registered the
    installation is revoked, logged out, or expires, so a shared device stops
    receiving the previous player's notifications even when an unbind never
    arrives.
    - `unregister()` also cancels the device's pending local reminders, which
      belong to the player leaving. It cancels them even when the unbind
      fails, such as on an offline logout, and then throws the unbind's
      error.
    - The installation stays unbound, across restarts, until `register()` or
      the next authentication.
- **Local reminders.** On start, on authentication, and after each backend
  read, the runtime compares `listLocal()` with the latest backend preference
  and permission and cancels the reminders that no longer pass, because a
  preference changed on another device never reaches this one as an event.
  It also cancels, without waiting for the backend, every pending reminder
  whose topic no longer takes the local route: an app update removed the
  topic from the catalog or took away its `local` channel.
- **Restarts.** A restart drops runtime memory and listeners. Host state,
  backend records, the persisted registration, the unbound state after
  `unregister()`, and the backend authentication persist.

## Topic catalog {#topic-catalog}

Topics are declared by the game in a catalog file validated by
`pnpm validate:notifications`. The types live in `@mpgd/catalog`, next to
products and ad placements.

```jsonc
{
  "version": "2026-10-12",
  "defaultLocale": "ko",
  "notices": {
    "topic": "consent-notice",
    "copy": {
      "ko": {
        "consent-result.advertising.granted": {
          "title": "[My Game] 광고성 알림 수신 동의 결과",
          "body": "{{consentDate}}에 하신 광고성 알림 수신 동의가 처리됐어요. 알림 설정에서 언제든 철회할 수 있어요."
        },
        "consent-result.advertising.withdrawn": {
          "title": "[My Game] 광고성 알림 수신 거부 결과",
          "body": "{{consentDate}}에 하신 광고성 알림 수신 거부가 처리됐어요."
        },
        "reconfirmation.night": {
          "title": "[My Game] 야간 광고성 알림 수신 동의 확인",
          "body": "{{consentDate}}에 야간(21시~8시) 광고성 알림 수신에 동의하셨어요. 동의를 유지하려면 따로 하실 일은 없고, 철회하려면 알림 설정에서 야간 수신을 끄면 돼요."
        }
        // …and consent-result.night.granted, consent-result.night.withdrawn,
        // and reconfirmation.advertising; the refusal texts are optional
      }
    }
  },
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
      "quietHours": { "start": "22:00", "end": "08:00" },
      "targets": {
        "ait": { "templateSetCode": "my-game-energy-full", "agreement": "required" },
        "android": { "channelId": "reminders" },
        "reddit": { "title": "Energy full", "body": "Your energy is full again." }
      }
    },
    {
      "id": "consent-notice",
      "purpose": "service",
      "channels": ["remote"],
      "route": "/settings/notifications",
      "targets": { "android": { "channelId": "notices" } }
    }
  ]
}
```

- `route` must be root-relative, and so must an `advertising` topic's
  `optOutRoute`, the screen where the player withdraws advertising consent:
  at most 2,048 characters and already in the form `normalizeRootRelativeRoute`
  from `@mpgd/platform/routes` returns, the rule share links and v1 deep links
  follow. This way neither a URL parser nor a client that decodes the path once
  reads it as another host, such as `//evil.example/x`. A route with another
  normalized form (`/a/../b`, `/é`) is refused rather than rewritten, so the
  declared route is the one a player opens. This is stricter than the v1
  delivery policy, which sends the normalized form (see the
  [migration plan](#pr-plan)).
- **Content.**
  - **Source.** Content comes from the target mapping when the provider's
    mapping carries its own copy (Devvit's pre-approved `title` and `body`),
    from the host template when `remote.content` is `host-template`, and
    otherwise from `copy[locale]`.
  - **Locale.** The locale is the delivery's `locale`, else the recipient's
    registered locale, else `defaultLocale`. A locale the copy lacks falls back
    to its language (`en` for `en-US`), then to `defaultLocale`, which every
    `copy` must include. Each match ignores case.
  - **Placeholders.** They use `{{name}}` and are filled from the delivery's
    template data.
  - **Free-form providers.** A topic mapped to one needs that text, for a push
    and for a local notification alike: `copy`, or a `title` and a `body` in
    the mapping. The notice topic's text is `notices.copy`.
- `targets` keys are open target names. Each provider declares the mapping
  fields it needs, and the validator checks the catalog against the providers
  a target enables:
  - **Apps in Toss** needs `templateSetCode` and `agreement`. `agreement` is
    `required`, or `none` for a `service` topic whose console template has no
    agreement statement.
  - **Devvit** needs `title` ≤ 60 and `body` ≤ 100 characters and may carry a
    default `link`, a `t3_` or `t1_` id.
  - A field's `pattern` is read with the `u` flag. The validator reports a
    pattern that does not compile instead of throwing.
  - `agreement: 'none'` must not map to a `per-send` provider. Such a topic
    never prompts, so no send would have the acceptance gate step 3 needs.
- A topic with the `remote` channel must not map to a provider whose
  `remote.purposes` excludes its purpose, because gate step 1 would refuse
  every send (`purpose-unsupported`). An `advertising` topic also needs a
  provider that delivers it as free-form content and, under the Korean rules,
  can carry an expiry and the opt-out action. It may not declare the `local`
  channel: a device-scheduled advertisement could not be withdrawn,
  labelled, or held for the night window by the server. The validator
  reports each of these before release.
- Optional `frequency` (`{ "maxPerDay": n }`), `quietHours`
  (`{ "start": "22:00", "end": "08:00" }`), and `deferrable` (default
  `true`) are applied by the [policy gate](#policy-gate), steps 6 and 7, and
  by the local route in [Reminders](#reminders).
- `notices` declares the consent notices the server sends when the
  deployment enables the Korean rules (see
  [Consent records](#consent-records)):
  - **`notices.topic`** names a `service` topic with the `remote` channel,
    which keeps only the delivery settings. It declares no `copy` and no
    `local` channel, and its mappings carry no `title` or `body`, not even one
    alone. It maps to no provider that sends a host template or its mapping's
    own text, which could not state the record.
  - **`notices.copy`** maps each locale to one `{ title, body }` per notice
    variant: `consent-result.advertising.granted`,
    `consent-result.advertising.withdrawn`, `consent-result.night.granted`,
    `consent-result.night.withdrawn`, `reconfirmation.advertising`, and
    `reconfirmation.night`. One notice topic can then say whether the player
    consented, refused, or withdrew, and to advertising or to night sending.
  - **Contents.** The copy must carry what the decree requires; the server
    fills only the date.
    - A result notice (§50⑦, decree art. 62-2) gives the sender's name, the
      act (a consent, a refusal, or a withdrawal) and its date, and the
      processing result.
    - A re-confirmation (§50⑧, decree art. 62-3(2)) gives the sender's name,
      the consent and its date, and how to keep or withdraw it.
  - **Refusals.** A refusal is recorded as `withdrawn`: it is a `withdrawn`
    record whose latest earlier record of its kind is not a consent. The
    optional `consent-result.advertising.refused` and
    `consent-result.night.refused` give its text. Without one, a refusal is
    given in the withdrawal's text, which must then read for a refusal too.
  - **Night re-confirmation.** A night consent stands, and is re-confirmed,
    after the player withdraws advertising consent, so the
    `reconfirmation.night` text must not say the player still receives night
    advertising.
  - **One setting.** The backend takes the whole `notices` block as is: the
    topic the scheduler sends through, and the copy. No deployment setting
    names the notice topic.
  - **Placeholders.** A notice's title and body may use only
    `{{consentDate}}`, and each variant uses it in its title or its body,
    because a notice states the date of the act it reports on. A brace left
    outside a `{{name}}` placeholder, as in `{consentDate}`,
    `{{consent.date}}`, or full-width braces, would reach the player as
    written.
  - **Validation.** The validator reports a notice topic that breaks these
    rules, a missing `notices.copy`, one without `defaultLocale` (matched
    without regard to case), a locale without one of the six required
    variants, an unknown variant, a blank title or body, a variant without
    `{{consentDate}}`, any other placeholder, and a stray brace. The backend
    and the vector loader check `notices.copy` by the same rules
    (`notificationNoticeCopyIssues`). Issue paths spell locale and variant
    keys in brackets, as in
    `notices.copy["ko-KR"]["reconfirmation.night"].title`.
  - **Korean rules.** Given the deployment settings, under the Korean rules
    with an `advertising` topic, the validator reports a missing notice topic
    and a target that maps an advertising topic but not the notice topic. A
    provider that sends its mapping's own text can carry advertising but not
    the notice topic, so the validator reports an advertising topic mapped to
    it, once, at that mapping.

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
3. Otherwise, or when the topic is not in the catalog, answer
   `{ route: 'none', status: 'unavailable' }` and do nothing.

A reminder `key` names one reminder per player across both routes:

- `set` removes the key from the other route before it schedules.
- `cancel` removes the key from each route that has it and answers the route
  where it was found, or `{ route: 'none', status: 'cancelled' }` when neither
  had it.
  - Both routes have it only when a local reminder was set while signed out,
    which cannot remove the server one. `cancel` then removes both and answers
    `local`, the route of the latest `set`.
  - Signed out, `cancel` still removes a local reminder, then throws
    `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` for the server part.
- While the provider is `action-required`, `set` answers the route it would
  take with `status: 'action-required'` and stores nothing. `cancel` still
  removes a local reminder and answers `action-required` for the server part.

Inputs follow the v1 bounds:

- `key` is at most 2,048 characters, with no control characters;
- `fireAt` is RFC 3339 with an explicit offset;
- `templateData` holds at most 128 entries of strings, numbers, or booleans,
  and each string is at most 16,384 characters.

On a host-template provider `set` rejects `templateData`, because template
context stays on the server as in v1. Invalid input throws
`NOTIFICATIONS_INVALID_INPUT`.

Before scheduling locally, the runtime applies, in this order, the parts of
the [policy gate](#policy-gate) it can evaluate on the client:

1. delivery permission, whose `permission-denied` the local route reports as
   `permission-required`;
2. the topic preference (`request-missing`, `preference-off`);
3. the topic's `quietHours`, as gate step 6 applies them:
   - a `fireAt` inside them moves to their end, as a server send would be
     deferred;
   - a clock change can make that end fall inside the next window, so the
     move repeats; after six windows the reminder answers `quiet-hours`;
   - a topic with `deferrable: false` is not scheduled inside them
     (`quiet-hours`), as the gate would suppress its send;
4. `frequency.maxPerDay`, counted over the topic's pending local reminders
   whose `fireAt` falls within any 24 hours (`frequency-capped`).

Advertising topics never take the local route (see the
[topic catalog](#topic-catalog)), so the night window does not apply to it.

Server reminders apply gate steps 3 to 5 at set time against the backend's
records (or the host read for a server-readable provider). They answer
`permission-required`, `request-missing`, `preference-off`, or
`advertising-consent-missing`, and store nothing on failure. The scheduler
runs the whole gate again at send time.

Pending local reminders follow later changes. When a topic's preference
becomes `withdrawn`, or the device's delivery permission stops being
`granted`, the runtime cancels that topic's (or every) pending local
reminder, because the device would otherwise still show them. The
[runtime's reconciliation](#runtime) catches changes made on another device,
and topics an app update took off the local route.

Local reminders use inexact timing:

- Android 14 denies `SCHEDULE_EXACT_ALARM` by default to new installs, Play
  restricts `USE_EXACT_ALARM` to alarm and calendar apps, and a game reminder
  does not need minute precision.
- The Capacitor template removes `SCHEDULE_EXACT_ALARM` from the merged
  manifest and schedules with `isExactNotification: false`.
- The provider keeps at most `local.maxPending` reminders, keeping the
  nearest ones.

Server reminders are keyed by player and `key`: setting the same key replaces
the pending reminder, and cancelling removes it.

- Replacing or cancelling also stops a send of the reminder that waits
  (`deferred`) or whose provider answer was `ambiguous` (`in-flight`); the
  scheduler replays neither, and `cancel` answers `remote`.
- A send the provider may already have accepted cannot be recalled.

## Opens {#opens}

Every open becomes one `opened` event with a route:

| Open path | Source of the route |
| --- | --- |
| `payload` (Android, iOS) | The push data or local `extra`, delivered through the provider's buffered listener; cold starts are marked `source: 'cold'`. |
| `landing-url` (Apps in Toss) | The landing URL is set per template in the console. The host bridge reads the launch URL once when it is installed (`Environment.initialURL`, or the page URL where the host gives none) with its `push` or `inbox` referrer. |
| `host-link` (Devvit) | A notification links to the send's post or comment (`link`). The game routes from that post's data, so routing needs dedicated posts. |

On `landing-url` hosts, a launch whose referrer is `push` or `inbox` is
routed exactly once, by whichever reader comes first:

- When the game's notifications runtime's subscription reaches the host
  first, the cold `opened` event carries the route, and
  `presentation.getLaunchIntent()` answers `home` for that launch. On Apps
  in Toss the game side attaches once its notifications client has loaded
  (it starts loading when the gateway is created), so a game that wants the
  event starts its runtime and lets it subscribe before it reads the
  launch intent.
- When the game asks for the launch intent first (before its runtime
  starts, or because it exposes no `notificationsV2`), the intent routes the
  launch from the landing route's parameters (the page URL need not carry
  them), and no `opened` event is emitted for it.

Both come from one parser over one read of the launch URL per host bridge
(the adapter's internal `readAitNotificationLanding`), so a page URL change
between the two reads cannot split them, and the landing is never lost. The route is the launch
URL's path, query, and fragment without the `referrer` parameter, normalized
by `normalizeRootRelativeRoute`; a route it refuses, or one longer than
2,048 characters, is left out of the event, which still counts as an open.
While the host bridge maps no v2 topic (`notificationTopics`), the provider
emits no open and the launch intent routes such a launch like any other, so a
game without notifications, or one that maps only v1 template codes and never
subscribes to v2 events, keeps its launch routes.

The game routes the event like a launch intent. The data is untrusted. The
route only opens a screen, and only when it passes the same root-relative
check as a catalog route. Anything worth claiming goes through the server.

## Server {#server}

### Provider registry {#provider-registry}

Each delivery provider has a server-side registry entry, which is the
[policy gate's](#policy-gate) only capability input:

```ts
export interface NotificationDeliveryProviderEntry {
  readonly provider: NotificationProviderId;
  readonly purposes: readonly NotificationPurpose[];
  readonly addressing: 'device' | 'platform-user';
  readonly content: 'free-form' | 'host-template';
  readonly permission: {
    readonly scope: 'app' | 'topic';
    readonly serverReadable: boolean;
    readonly allowance: 'persistent' | 'per-send';
  };
  /** Per-recipient limits; a window of a day or longer suppresses, a shorter one defers. */
  readonly limits?: readonly { readonly count: number; readonly windowSeconds: number }[];
  /** App-wide dispatch rate the scheduler keeps to. */
  readonly rate?: { readonly count: number; readonly windowSeconds: number };
  /** Whether a send can carry an expiry, which advertising needs under the Korean rules. */
  readonly expiry: boolean;
  /** Whether a send can carry the advertising opt-out action. */
  readonly actions: boolean;
  /** Whether each send needs a post or comment link (Devvit). */
  readonly link: boolean;
  /** The mapping fields this provider needs in each catalog topic. */
  readonly mappingFields: readonly string[];
}
```

The backend publishes its entries. At start the runtime compares its
provider's capabilities with the entry for that provider, and a mismatch
makes the provider `configuration-required`, as commerce does with
`CommerceServiceCapabilities`.

- **Targets.** Each entry serves one or more catalog targets, and a target
  maps to one provider. Two targets may share a provider, as `android` and
  `ios` share FCM. The gate reads the topic as the recipient's target
  declares it, with that target's mapping (see the
  [endpoint registry](#endpoint-registry)). The backend publishes the
  served targets next to the entries.
- **Per-send providers.** The S1 backend refuses a `per-send` entry: it
  does not yet reserve an acceptance in the same atomic step that claims
  the delivery (see [Deferred sends](#policy-gate)).

### Endpoint registry {#endpoint-registry}

The server records where a player can be reached, per provider. Registration
requires an authenticated request, because binding a device token to another
player's account would deliver that player's notifications to the device.

- **Device endpoints.** One is keyed by provider and installation id. The
  installation id is the authenticated game-services session's (the guest
  session's) installation id, never a value from the request body. The
  identity service must vouch for it (issue it, or bind it to the session
  it issued): a client that could pick another installation's id could
  move that installation's endpoint to itself. An endpoint
  holds the current address, the device's permission, and `lastRegisteredAt`.
  - A new address for the same installation replaces the old one.
  - An address is unique per provider.
  - Registering an installation for a new player moves it.
  - **Target.** A registration on a provider that serves several targets
    names the catalog target of the device (`android` or `ios` for FCM), and
    the gate reads that target's mapping for the endpoint, such as its
    Android `channelId`. The backend refuses a device registration on such
    a provider without one; the game-services client, which knows its
    target, adds it to the request (a later PR). A topic the target does not
    map is `topic-unknown` for that endpoint.
- **Unbinding.** An authenticated unbind, or the end of the session that
  registered the installation, removes the endpoint from the player.
  - The identity service ends a session by calling the backend at logout or
    revocation.
  - A session that ends on its own carries its `expiresAt`, and its
    endpoints count as unbound from then. The session id is the session's
    whole life (its refresh family), not one access token.
  - Every authenticated call reports the session's current `expiresAt`.
    When it is later than an endpoint's stored end, the backend moves the
    end of every endpoint the session registered to it, or clears it when
    the session no longer ends on its own; a cleared end stays cleared. The
    extension never moves an end earlier, so a session the identity service
    extends keeps its devices without a new registration (a registration
    writes its own request's end). An extension is not a registration for
    the 60-day stale rule.
- **Platform-user providers (Apps in Toss, Devvit).** They register no
  address. The backend resolves the recipient from the player's authenticated
  identity for that provider, never from a key the client sends. It keeps the
  player's `locale` and `timeZone` from the `platform-user` registration.
- **Dead and stale endpoints.** A provider answer that the address is dead
  (FCM `UNREGISTERED`) marks the endpoint invalid. An endpoint not refreshed
  for 60 days counts as missing at gate step 2. Invalid or stale endpoints are
  deleted 30 days later.

### Consent records {#consent-records}

The backend stores the [runtime's records](#runtime), dated by
its own clock, so notices and the latest record never depend on a client
clock:

| Record kind | Written by | Authority |
| --- | --- | --- |
| `delivery-permission` | Client report after a decided state changes (not by device providers), or a player revocation | Hint; the host decides |
| `host-agreement` (per topic) | Client report with evidence, for example `apps-in-toss.notification-agreement.v1`; or a provider answer that the recipient has not agreed (`source: 'provider'`) | Hint; the host still enforces on send |
| `topic-preference` | Authenticated player action, including accepting a host agreement for a `requested` topic | Authoritative |
| `advertising`, `night` | Authenticated player action with the consent text version | Authoritative |

Every send reads the player's whole history, so client writes are bounded:

- **Repeats.** A `delivery-permission`, `host-agreement`, or
  `topic-preference` record whose state and source match the player's latest
  record of the same kind and topic is not written. The backend answers that
  latest record, which keeps its own date and evidence. An `advertising` or
  `night` record is always written, since each one is a player's act that
  may owe a notice: a second refusal, or a consent that
  restarts the re-confirmation count. A client therefore writes these kinds
  only on a player's act, never as a re-report of the current state.
- **Daily cap.** A player may add at most 200 client records in any rolling
  24 hours. Records from a provider answer do not count. Past the cap the
  backend answers `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` (retryable; HTTP
  429 on the Worker route) with `Retry-After` set to when the oldest counted
  record leaves the window. A
  repeat is still answered, since it writes nothing.
- **Concurrency.** Both rules read the history before the write, so writes
  that race may store a repeat or pass the cap by a few records.
- **Compaction.** Pruning old records is left to S2.

When the deployment enables the Korean rules, each `advertising` or `night`
record also yields the notices the law requires. The due dates are pure
functions over Korean calendar dates (Asia/Seoul), and `dueBy` is the last
day the notice may be given:

- **Result notice.** `dueBy` is 14 days after the record's date, counted from
  the next day, for every consent, refusal, or withdrawal. It is listed as
  soon as its record exists.
- **Re-confirmation notice.** It is due every two years, counted from the date
  of the latest consent of that kind:
  - The n-th notice is due by the day before the date 2n years after the
    consent date; a 29 February consent date uses 28 February.
  - The first is listed from 60 days before its `dueBy`, and each later one
    from 60 days before its own `dueBy` once the one before it is recorded.
    Silence after a notice keeps the consent, and the series continues.
  - A new consent restarts the count, and a withdrawal ends it.

A listed notice stays listed after its `dueBy` until it is recorded.

A notice is named by its kind, the record it reports on (the record's kind
and time), and its `dueBy`.

- **Record times.** The backend dates each of a player's records at least
  1 ms after the previous one, so a record's kind and time name it.
- **Precision.** A name reads its record's time to the millisecond. Digits
  past the millisecond are dropped, as in the
  [canonical form](#timestamps).
- **Distinct names.** Every re-confirmation of one consent has its own name,
  and so do the notices of the `advertising` and `night` records that one
  `setAdvertisingConsent` call writes.

The backend lists notices with the record they report on, including its
date, because the notice must state it (decree arts. 62-2 and 62-3(2)). Each
listed notice carries `variant`, the variant of `notices.copy` it is given
in, so the game shows the text the scheduler would push:

- **Result notice.** `consent-result.<record kind>.<act>`, where the act is
  `granted`, `withdrawn`, or `refused` for a `withdrawn` record whose latest
  earlier record of its kind is not a consent.
- **Re-confirmation.** `reconfirmation.<record kind>`; it always reports on a
  consent.

It also records each notice given: the notice's name, the channel
(`in-game`, `push`, or `other`), and the time. Only the backend records
`push`, once it delivered the push; a game records a notice it showed as
`in-game` or `other`.

The game shows a notice in the game and records it through
`notices.recordShown` with the notice as `list()` gave it, or with its name:
its `kind`, its record's `kind` and `at`, and its `dueBy`. The runtime sends
the backend only the name, with the record's time in the
[canonical form](#timestamps).

- **Retries.** The backend records a notice only while that notice is listed.
  Recording a notice that is not listed (already recorded, not yet listed, or
  unknown) changes nothing, so a retried call is safe. Record times compare
  as instants to the millisecond, so another spelling of the same instant
  matches, but a name that names another instant or date records nothing:
  for example, a record time cut to seconds. A game passes the listed notice
  or its fields unchanged.
- **Malformed input.** A missing field, an unknown key, or a time or date
  that does not parse throws `NOTIFICATIONS_INVALID_INPUT`.

If a notice is not recorded by the start of the day seven days before
`dueBy`, the scheduler sends it through the catalog's `notices.topic`.

- **Key.** `notice:<player>:<kind>:<record kind>:<record at>:<dueBy>`, with
  the player percent-encoded, the record's time in the
  [canonical form](#timestamps), and `dueBy` as `YYYY-MM-DD`.
- **Copy.** The notice is given in the variant it is listed with. A locale
  without a refusal's text gives the withdrawal's
  (`notificationNoticeVariantCopy`).
- **Template data.** `consentDate`, the record's Asia/Seoul date, is the only
  value the server fills.
- **Gate.** The send is a `service` notification through the policy gate,
  never combined with advertising. The scheduler gives the gate the notice
  topic with the variant's copy in place of the topic's own, which it does
  not declare. The gate then resolves the locale by the **Locale** rule of
  the [topic catalog's content](#topic-catalog), as for any topic, and so
  falls back to the default locale.
- **Content.** A notice says only its variant of `notices.copy`.
  - The scheduler drops any `title` or `body` in the notice topic's mapping.
  - It sends a notice only through a provider that can carry it
    (`notificationProviderCarriesNotices`): free-form content, and no `title`
    or `body` the provider needs in the mapping, which it would send instead.
    Through any other provider it sends nothing and records nothing, so the
    game still owes the notice. `notificationNoticeTopic` gives the notice
    topic as the gate renders one notice from it.
- **Reserved topic.** The notice topic is the scheduler's. A send or a server
  reminder that a game asks for through it throws
  `NOTIFICATIONS_INVALID_INPUT`. The player's topic preference still applies
  to it, as to any `service` topic.
- **Failed renders.** A push that cannot render fails once, whether it is
  the first send or a replay, and is not tried again. The game still owes
  the notice.
- **Recording.** Once delivered, the backend records the notice with channel
  `push`.
- **A waiting push.** A push that waits, deferred or in flight, is dropped
  once the game records the notice. The player is not told twice.

### Policy gate {#policy-gate}

Every send carries an idempotency key and a request: the player, an optional
provider, the topic, template data, routing `data`, the locale, and a `link`
for Devvit.

- **Bounds and reserved prefixes.** Inputs follow the v1 bounds (see
  [Reminders](#reminders)). Keys that start with `reminder:` or `notice:` are
  reserved for the scheduler and throw `NOTIFICATIONS_INVALID_INPUT`, and so
  do the routing `data` keys `topic` and `route`, which an open carries for
  itself.
- **Binding.** The backend binds each stored key to a fingerprint of the
  request. The resolved address is left out, so a replay after a token
  rotation still matches.
- **Conflicts.** A send whose key is stored with another fingerprint throws
  `NOTIFICATIONS_IDEMPOTENCY_CONFLICT` before any stored answer.
- **Key states.** A key's [state](#key-states) decides what a send with that
  key answers. A key with no entry is evaluated.

Evaluation is one pure decision, `evaluateNotificationDelivery`, per
recipient, made immediately before the provider call. That holds after any
queue, and for a scheduled reminder or a deferred send when it comes due. The
gate reads the provider's [registry entry](#provider-registry), never the
client's declaration. The steps run in order and the first failure decides:

1. **The topic and its purpose.** The topic exists (or `suppressed:
   topic-unknown`), and its `channels` include `remote` (or `suppressed:
   channel-unsupported`). The provider's `purposes` include its purpose (or
   `suppressed: purpose-unsupported`). An `advertising` topic also needs
   free-form content and, under the Korean rules, a provider that can carry
   an expiry and the opt-out action (or `suppressed: purpose-unsupported`).
2. **Recipients.** They resolve to every valid endpoint of the player on a
   device provider (see [Device fan-out](#fan-out)), or to the authenticated
   platform identity on a platform-user provider; otherwise `unavailable:
   no-endpoint`. On a provider whose registry entry sets `link` (Devvit), a
   send also needs a `link` from the send or the mapping, or it is
   `unavailable: link-missing`.
3. **Delivery permission.** It must be positively `granted`, or the send is
   `suppressed: permission-denied`; `prompt-with-rationale` and every other
   state do not deliver.
   - **Server-readable host.** When `permission.serverReadable` is true, the
     backend reads the host at send time, and that answer decides (Devvit
     `isOptedIn`).
   - **Device endpoint.** It needs the permission its latest registration
     reported.
   - **App-scope platform-user provider that is not server-readable.** It needs
     a latest `delivery-permission` record of `granted`.
   - **`scope: 'topic'` provider.** It needs a latest `host-agreement` of
     `granted` for the topic (or `suppressed: agreement-missing`), unless the
     topic's mapping declares that the host needs no agreement.
     - For such a topic, a provider answer that the recipient has not agreed
       is recorded but does not stop sends. The host decides on each send.
     - The rule that sends stop until the player agrees again applies only
       to topics that need an agreement. Nothing could ask the player again
       for a topic that needs none: it reads `granted` and never prompts.
   - **`per-send` provider.** It needs an acceptance that no delivery has
     reserved (or `suppressed: allowance-exhausted`).
4. **Topic preference.** A `requested` topic needs a latest `topic-preference`
   of `granted` (no record: `suppressed: request-missing`; latest `withdrawn`:
   `suppressed: preference-off`). Accepting a host agreement writes that
   record (see the [runtime records](#runtime)), so the latest record of one
   kind decides. Other purposes are suppressed only by a latest `withdrawn`
   (`preference-off`).
5. **Advertising consent.** An `advertising` topic needs a latest
   `advertising` record of `granted`, or `suppressed:
   advertising-consent-missing`.
6. **Time windows.**
   - **Night window (Korean rules).** It runs from 21:00 inclusive to 08:00
     exclusive in Asia/Seoul, judged when the provider call is made.
     - An `advertising` send inside it without a latest `night` record of
       `granted` is `deferred: night-window` with `until` set to the next
       08:00. When the topic sets `deferrable: false` it is `suppressed:
       night-consent-missing` instead.
     - Outside the window, such a send carries an expiry at the next 21:00
       (FCM `android.ttl` and `apns-expiration`). A message that cannot arrive
       before the window opens is then dropped rather than shown at night.
   - **Quiet hours.** A topic's `quietHours` hold any purpose in the
     recipient's time zone (the registered zone, else the deployment's zone),
     from `start` inclusive to `end` exclusive.
     - A send inside them is `deferred: quiet-hours` until they end, or
       `suppressed: quiet-hours` when the topic sets `deferrable: false`.
     - A `night` record does not bypass them.
   - **No time left.** A send whose windows leave no time to send, such as
     quiet hours that close where the night window opens, is `suppressed:
     night-consent-missing` instead of being deferred forever.
7. **Frequency and provider limits.** They count the recipient's other
   delivered sends in the rolling window before the send: a send at `s`
   counts for a send at `t` when `t − window < s ≤ t`. A send's earlier
   delivery to another endpoint is the same send and does not count. The
   history comes oldest first; the gate sorts a copy of one that does not,
   so the order never changes the answer.
   - A topic `frequency` cap or a provider limit whose window is a day or
     longer answers `suppressed: frequency-capped` or `suppressed:
     provider-limit`.
   - A provider limit with a shorter window answers `deferred:
     provider-limit`, with `until` when the oldest counted send leaves the
     window.
   - The limits come from the [registry entry](#provider-registry): Devvit
     allows 2 per user per day, and Apps in Toss 10 per user per minute.
8. **Advertising content (Korean rules).** An `advertising` send needs the
   deployment's advertising sender, `{ name?, contact }`, or it is
   `suppressed: advertising-sender-missing`. `name` may be omitted only when it
   equals the app's name, and `contact` is the phone number or address the law
   requires. The gate trims these texts and the opt-out line: a blank
   `contact` counts as missing, a blank `name` as omitted, and a blank opt-out
   line as absent. The rendered content is:
   - the title starts with `(광고) `;
   - the body starts with `(광고) ` and the sender line (`name`, a space, and
     `contact`, or `contact` alone when `name` is omitted), then the copy on
     the next line, then the deployment's free-of-charge
     opt-out line (`advertisingOptOutLine`, default `무료 수신거부: 수신거부
     버튼`) on the last line;
   - the message carries the action `{ id: 'advertising-opt-out', title:
     '수신거부', route: optOutRoute }`, which opens the opt-out screen directly.

   Providers render exactly this content. Host-template providers cannot carry
   advertising, so step 1 already refused them.

Statuses are `delivered`, `suppressed`, `deferred`, `unavailable`, and
`in-flight`.

**Deferred sends.**

- **Storage and replay.** A deferred send is stored with its key (see
  [Key states](#key-states)). When it comes due, the [scheduler](#scheduler)
  takes the stored row (a lease on the row, so one worker replays it), runs
  the gate again without the key lookup, and replaces the row with the new
  outcome.
- **Delivery.** It goes through the claim/lease ledger and the provider's
  `deliverIdempotently`, one ledger delivery per recipient.
- **Per-send providers.** The backend reserves the acceptance in the same
  atomic step that claims the delivery key: a compare-and-set on the
  acceptance, so two concurrent deliveries cannot spend one acceptance. The
  pure gate only reports whether an unreserved acceptance exists, and a
  released claim releases its reservation.

#### Key states {#key-states}

| Key state | A send with the key answers | The state ends when |
| --- | --- | --- |
| No entry | The gate's evaluation | A `delivered`, `deferred`, or `in-flight` outcome is stored |
| `in-flight` | `in-flight` | The provider answers, or the claim's lease expires and the next claimer replays it |
| `deferred` (`until`) | The stored `deferred` result, also after `until`, until the scheduler takes the row | The scheduler replays it |
| `delivered` | `delivered` with `alreadyProcessed: true` | The retention horizon passes |

`suppressed` and `unavailable` answers are not stored, so a retry after the
player's state changes is evaluated again. A replay that ends `suppressed` or
`unavailable` deletes the row and leaves no entry, exactly like a first
evaluation. Entries are kept for 30 days after their last change. Callers
must not retry an older key, and both D1 and the Devvit Redis ledger purge on
a schedule.

#### Device fan-out {#fan-out}

A send for a device provider goes to every valid endpoint of the player on
that provider whose latest registration reported `granted`.

- **Per-endpoint deliveries.** Each endpoint is its own ledger delivery under
  the derived key `<key>:<encodeURIComponent(installationId)>`, and provider
  answers apply per endpoint.
- **The send's result.** It is `delivered` as soon as any endpoint accepted.
  Before that, while an endpoint's delivery is in flight, it is `in-flight`.
  Otherwise it is the most specific per-endpoint answer, such as
  `unavailable: endpoint-invalid` when every endpoint was dead.
- **Retries.** A retry of the send key answers its stored result and sends
  nothing. An endpoint whose delivery is still in flight or deferred (rate
  limited) is replayed by the scheduler under its derived key, whatever the
  send's result.
- **Several providers.** A send names an optional `provider`. Without one it
  goes to every provider the player has a recipient on, each evaluated on its
  own.
- **Queued fan-out.** The backend checks the gate once per recipient when
  the send arrives and stores a row for each recipient it allows or defers.
  Each allowed row is then one dispatch job, run inline or through a queue,
  and the gate runs again when the job makes the provider call. A send
  dispatched through the queue answers `in-flight` until a row settles.
- **Limits.** Each other send counts once for the topic's cap, on the gate's
  provider when it reached it there. An in-flight send counts once a holder
  claimed it for a provider call. Of two sends claimed at the same moment,
  the earlier one (then the lower key) is the one the other counts, so a cap
  of one lets one through.

#### Provider answers {#provider-answers}

Every provider answer maps to one of five kinds:

- **`accepted`** becomes `delivered`.
- **`unregistered`**, a dead address, becomes `unavailable: endpoint-invalid`
  for that endpoint, which is invalidated; later sends find `no-endpoint`.
- **`rate-limited`**: the provider proves nothing was sent (the
  `NotificationDeliveryNotSentError` contract), with an optional
  `retryAfterSeconds`. The claim and any reservation are released, and the
  send becomes `deferred: provider-rate-limited` (see
  [Key states](#key-states)).
  - The first deferral runs until now plus `retryAfterSeconds` (60 seconds
    when absent).
  - Later ones back off exponentially from that delay, with jitter.
  - After 24 hours the send ends `unavailable: provider-rate-limited`.
- **`rejected`**: the provider proves nothing was sent, and the same send
  would fail again. Its `reason` is `configuration` (the project's setup, such
  as an unapproved template or bad credentials), `recipient` (this recipient
  cannot receive it, such as a deleted account), or `agreement` (the recipient
  has not agreed to the template).
  - The claim and any reservation are released, and the send answers
    `unavailable: provider-rejected`, which is not stored.
  - A `configuration` rejection fails every send the same way, so the
    backend reports it to the operator; a `recipient` or `agreement`
    refusal is the player's and is not an alert, and neither is a message
    FCM would have received too late (`MESSAGE_EXPIRED`).
  - `agreement`, when the host says the recipient has not agreed to the
    template, also appends a `host-agreement` record of `denied` with
    `source: 'provider'`. For a topic that needs an agreement, the gate then
    stops sending until the player agrees again. For a topic whose mapping
    needs no agreement, the record does not stop sends, and the host decides
    on each send.
- **`ambiguous`**: the provider cannot say whether it sent (a timeout, a 5xx
  answer, a crash after the claim).
  - The claim is kept, as the delivery ledger requires, and the send answers
    `in-flight`.
  - A direct caller retries after the lease.
  - A scheduled or deferred row is `in-flight` too. The scheduler, which owns
    it, replays it through `deliverIdempotently` once the lease expires.
  - The scheduler also replays a direct send's row once its lease expired,
    so a send whose caller never retries still settles, and so does a row
    whose holder failed before the provider call.
  - Each ambiguous answer doubles the lease before the next replay (from
    the claim lease up to an hour), and so does a replay of a row whose
    holder never answered, because a provider without an idempotency key
    may show every replay. Replays stop a day after the
    first attempt: the row stays `in-flight` until its key's retention
    ends, and the backend reports it.
  - One rule covers every claimer. `deferred` would also claim that nothing
    was sent, which an `ambiguous` answer cannot prove.

A response that covers several recipients maps per recipient onto each
recipient's key. Examples are Apps in Toss per-channel `fail` lists and Devvit
`failureCount` and `errors`. The request and ledger keys move from the closed
`PlatformTarget`/`NotificationTopic` sets to open provider and topic ids.

### Delivery providers {#remote-delivery}

- **FCM** (Android and iOS).
  - **Transport.** HTTP v1 `messages:send`, with an OAuth token from a
    service-account JWT signed through WebCrypto; it runs on Cloudflare Workers
    without HTTP/2. iOS devices register through Firebase Messaging so FCM
    relays to APNs; direct APNs needs HTTP/2, which Workers `fetch` does not
    document.
  - **Addresses.** They are typed because FCM is moving from registration
    tokens to Firebase installation ids (FIDs). The provider sends to
    registration tokens (`fcm-token`) only. The `fcm-installation` kind is
    reserved: HTTP v1 has no FID send target, so the backend refuses an FID
    registration (`NOTIFICATIONS_INVALID_INPUT`, with a message saying the
    kind is reserved) and the provider refuses an FID send (`rejected`,
    provider code `INSTALLATION_ID_RESERVED`), until FCM supports FIDs.
  - **Errors.**
    - `UNREGISTERED` is `unregistered`. `INVALID_ARGUMENT` is too, but only
      when the payload is known valid: the provider checks the message
      against the FCM rules it can check before it sends (title and body,
      data keys and values, expiry, size), and FCM's answer names the token
      (a `message.token` field violation) and no other field. Any other
      `INVALID_ARGUMENT` is `rejected` with reason `configuration`, so a
      payload bug never prunes live tokens.
    - `QUOTA_EXCEEDED` is `rate-limited`.
    - `UNAVAILABLE` and `INTERNAL` are `ambiguous`, and so are a timeout and
      a dropped connection.
    - `SENDER_ID_MISMATCH` and `THIRD_PARTY_AUTH_ERROR` are `rejected` with
      reason `configuration`.
    - **Access tokens.** A key that cannot sign or a refused grant is
      `rejected` with reason `configuration`; a token endpoint that is down
      sent nothing and is `rate-limited`.
  - **Expiry and actions.** The expiry is `android.ttl` and the
    `apns-expiration` header. A message that would expire within a second
    is not sent (`rejected`, provider code `MESSAGE_EXPIRED`), because FCM
    reads a time to live of 0 as "deliver now if the device is reachable".
  - **Payload.** The gate's title and body are the FCM `notification`, and
    `data` carries the send's routing data with the topic id in `topic` and
    its root-relative route in `route`, as the
    [Capacitor provider](#profile-capacitor) reads them. Android posts to
    the mapping's `channelId`, else to `mpgd-service`, `mpgd-requested`, or
    `mpgd-advertising` by purpose. An advertising send names the iOS
    category `mpgd-advertising` in `apns.payload.aps.category`, whose
    opt-out action the app registers. An Android FCM notification message
    cannot carry actions; the shell renders advertising natively (C1). FCM's
    reserved data keys are refused before the send.
- **Apps in Toss.**
  `createAitFunctionalMessageDeliveryProvider` in
  `@mpgd/game-services/notifications/ait-functional-delivery`.
  - **Transport.** `send-message` (`sendFunctionalMessage`) over the
    partner API's mTLS client certificate, injected as a fetcher (a Workers
    mTLS binding), with the template set code and context, one recipient per
    call in the first wave. The recipient is the platform user the backend
    resolved from the player's authenticated identity; the deployment's
    `recipientKey` says whether that id is a Toss login user key
    (`x-toss-user-key`) or an anonymous key (`x-anon-key`).
  - **Business errors.** They arrive as HTTP 200 with `resultType: FAIL`:
    - 4095 is `rate-limited` with `retryAfterSeconds` from
      `error.data.retryAfterSeconds`;
    - 5004 (template not approved), 4034 (no workspace, or no access to
      it), and 4010 (credentials not found) are `rejected` with reason
      `configuration`;
    - the partner API documents no recipient-level code, including none for
      a missing agreement (checked 2026-10-19). A deployment names the codes
      it observes (`agreementErrorCodes`, then `recipientErrorCodes`,
      checked before every built-in code, 4095 included, on any status
      except HTTP 429, which is `rate-limited`, and 5xx, 408, and 425, which
      are `ambiguous`, whatever the body says); any other code is `rejected` with reason
      `recipient` on HTTP 200 (not `ambiguous`: an `ambiguous` row is
      replayed after every lease with no attempt cap, so a code that fails
      the same way would be sent again for as long as the key is kept), `configuration` on HTTP 400, 401, 403, 404,
      405, 413, 415, and 422, where the request itself was refused, and
      `ambiguous` on any other status. A `FAIL` without a code is
      `ambiguous`;
    - `HTTP_TIMEOUT`, `NETWORK_ERROR`, `EXECUTION_FAIL`, `INTERRUPTED`, and
      `INTERNAL_ERROR` are `ambiguous`, and so are HTTP 5xx, 408, and 425
      answers, transport failures, timeouts, and answers that cannot be
      read.
  - **HTTP errors without a business answer.** HTTP 429 is `rate-limited`
    whatever the body says, with the body's delay or else `Retry-After`;
    the refusing statuses above are `rejected` with reason `configuration`.
    A delay is capped at a day.
  - **Partial success.** A `SUCCESS` response maps per channel (push, inbox,
    SMS, Alimtalk, Friendtalk). With one recipient per call, the send is
    `accepted` when `msgCount` is above 0 or any channel sent it. Otherwise
    it is `rejected`: reason `agreement` when a `fail` entry's
    `reachedFailReason` is one the deployment names
    (`agreementFailReasons`), otherwise `recipient`, also when the `fail`
    lists are empty.
  - **Limits.** 15,000 per minute per app (the registry's `rate`), and 10 per
    minute per user (a provider limit).
- **Devvit.** It runs inside the Devvit server, not the game-services Worker,
  because only that runtime can call the notifications API.
  - **Transport.** `enqueue` with a title, a body, and the send's `link`, one
    recipient per call in the first wave. `failureCount` and `errors` map per
    recipient.
  - **Limits.** 2 per user per day (a provider limit), and 25,000 per app per
    day (the registry's `rate`).
  - The same delivery module and policy gate run there with a Redis-backed
    ledger.

### Reminder scheduler {#scheduler}

Server reminders, deferred sends (night window, quiet hours, provider limits,
rate limits), sends in flight after an ambiguous answer, and overdue consent
notices are stored with a lease and processed when due. The default is a D1
table plus a Cron trigger on the game-services Worker; the Devvit server uses
the Devvit scheduler.

- **Each due item** becomes a normal send through the policy gate, and its
  key moves through the [key states](#key-states).
- **Pacing.** The scheduler dispatches due rows per provider at no more than
  the registry entry's `rate`, oldest first. A backlog that comes due at 08:00
  therefore drains at the provider's pace, while `until` stays the earliest
  send time.
- **Reminder keys.** A reminder's idempotency key is
  `reminder:<player>:<key>:<fireAt>`, with the player and the key
  percent-encoded (`encodeURIComponent`) so ids that contain `:` cannot
  collide, and `fireAt` in the [canonical form](#timestamps). A deferred send
  keeps its own key.

### Timestamps {#timestamps}

Every timestamp in the contract and in the vectors is RFC 3339 with an
explicit offset, and input without one is rejected
(`NOTIFICATIONS_INVALID_INPUT`). The canonical form is UTC with `Z`, with
milliseconds only when they are not zero, as `@mpgd/platform` already
normalizes commerce timestamps. Keys use it, and runners compare timestamps
as instants. A notice's `dueBy` is an Asia/Seoul calendar date
(`YYYY-MM-DD`).

- **Strict reading.** Every validator reads each timestamp and date after
  the shape check. A date that does not exist, such as 31 April, and a space
  instead of `T` are refused, never rolled over.
- **Runners.** Two timestamps that read strictly compare as instants. Any
  other text compares as written.
- **Provider answers.** When a topic's daily cap reads the provider's pending
  local reminders, one listed with a `fireAt` that does not read strictly
  throws `NOTIFICATIONS_CONFIGURATION_REQUIRED`: the provider broke the
  contract.

## Provider profiles {#profiles}

| Profile | `permission` | `remote` | `local` | `open` |
| --- | --- | --- | --- | --- |
| Capacitor + FCM (Android, iOS) | app, os, readable, persistent, gesture not required, settings, `promptLimit` 2 on Android 13+ and 1 on iOS | device, free-form, all three purposes | supported, iOS `maxPending` 64 | payload |
| Apps in Toss | topic, host, not readable, persistent, gesture required, no settings link; per-topic `agreement` | platform-user, host-template, `service` and `requested` | unsupported | landing-url |
| Devvit | app, game, readable through the server bridge and server-readable, persistent, gesture required, revocable in the game | platform-user, free-form (approved copy), `service` and `requested` | unsupported | host-link |
| Web, Microsoft Store PWA, CrazyGames, OnePlay, Verse8 | `availability: 'unsupported'` | unsupported | unsupported | none |
| WeChat (not planned) | topic, host, partly readable, **per-send**, gesture required, at most 3 per prompt | platform-user, host-template | unsupported | landing-url |

### Capacitor {#profile-capacitor}

- **Plugins.** Use `@capacitor-firebase/messaging` for remote and
  `@capacitor/local-notifications` for local. Do not also install
  `@capacitor/push-notifications`: on iOS both claim Capacitor's single push
  handler slot.
- **Packaging.** The adapter defines `PushSdk` and `LocalNotificationSdk`
  interfaces, like the commerce `StoreSdk`. Their implementations over the two
  plugins live in `@mpgd/adapter-capacitor/notifications`, with the plugins as
  optional peer dependencies, as `./admob` does. The template imports only
  `@mpgd/*` packages and keeps platform SDK imports out of game code.
- **Permission mapping.**
  - **Android.** Capacitor reports `prompt-with-rationale` after the first
    denial and `denied` after the second, which is permanent. The provider maps
    that to `blocked` and declares `promptLimit: 2`.
    - The value assumes a target SDK of 33 or later, which Capacitor 8 projects
      use (36). An app targeting 32 or lower gets the system prompt once, so
      its provider must declare `promptLimit: 1`.
    - A dialog the player swipes away leaves the permission unchanged and is
      `dismissed`.
    - Android 12 and below have no runtime permission, and push plugins can
      report `granted` while the player has turned notifications off
      (`@capacitor/push-notifications` does). The provider therefore reads
      `LocalNotifications.checkPermissions`, which reflects the system setting.
  - **iOS.** `denied` is `blocked`, and the iOS provider declares
    `promptLimit: 1`.
- **Channels.** Android channels come from the catalog
  (`targets.android.channelId`), with separate channels for advertising so a
  player can turn them off in system settings.
- **Opt-out action.** The provider registers the advertising opt-out action
  natively: an Android notification action, and an iOS notification category
  set through Firebase Messaging.
- **Bridge.**
  - The Capacitor bridge adds `notifications.v2.requestPermission` and
    `.openSettings` to its external-activity methods, as v1
    `notifications.requestSubscription` and `commerce.v2.requestPurchase` are,
    so the game pauses under the permission UI.
  - Its provider registry passes `notifications.v2.*` through
    `assertMethodReady`, as it passes `commerce.v2.*`, so states stay answers.
- **Cold starts.** Verify cold-start opens on a device: Capacitor 8.5 moved the
  iOS template to the UIScene lifecycle, which sets the notification delegate
  later than Apple recommends.

### Apps in Toss {#profile-ait}

- **API.** Agreement uses `Notification.requestAgreement({ options: {
  templateCode } })` (Toss app 5.255.0 or later; the provider checks
  `isSupported()` and answers `NOTIFICATIONS_HOST_VERSION_UNSUPPORTED` below
  it, by throwing for the whole request whenever it names a topic that
  needs an agreement, even next to agreement-free topics; the game asks for
  those separately). `templateCode` is the same value as the send API's `templateSetCode`,
  so one catalog field serves both.
- **Event mapping.**
  - `newAgreement` maps to the `granted` outcome, `alreadyAgreed` to
    `already-granted`, and `agreementRejected` to `denied`; the snapshot
    carries the decided state. Each topic that needs an agreement gets its
    own sheet, one sheet at a time.
  - `TERMS_DISAGREED_MEMBER` (the user turned off Toss's personalization
    terms) maps to the `action-required` outcome with `requiredAction:
    'host-settings'`. It is not recorded, and the next request reaches the
    host again.
  - `NOTIFICATION_AGREEMENT_FAILED` (a bad code) maps to
    `NOTIFICATIONS_CONFIGURATION_REQUIRED` with that `hostCode`.
  - A request with no event within 120 seconds answers `dismissed`. v1
    settled the same timeout as `unavailable`, which the v1 wrapper keeps.
    The provider then calls the SDK's cleanup, which removes the callbacks
    and tells the host to drop the subscription. If the host keeps the sheet
    open, an answer the player gives afterwards is lost; when Toss recorded
    it, the next request answers `alreadyAgreed` and records it then.
  - Any other host error throws `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
  - After a `dismissed` sheet or `TERMS_DISAGREED_MEMBER`, the remaining
    topics of the request answer the same outcome without a sheet, so a
    request never stacks a sheet over an unanswered one.
  - A `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` failure after an earlier sheet
    of the same request was answered does not throw: the answered topics and
    their evidence are returned, and the failed and remaining topics answer
    `dismissed`. Any other failure throws, whatever was answered before.
  - The provider always calls the cleanup function the SDK returns.
- **Evidence.** A request with a decided answer carries
  `{ schema: 'apps-in-toss.notification-agreement.v1', payload }`, whose
  payload names the provider and, per answered topic, `templateSetCode:<topic>`
  and `result:<topic>` (the SDK event). It is the only proof the host offers,
  so the backend keeps it on the `host-agreement` record.
- **Reads.** A topic that needs an agreement reads `unknown`, or
  `unsupported` on a Toss app older than 5.255.0. A topic mapped with
  `agreement: 'none'` reads `granted`, and an unmapped topic `unsupported`.
  Without any mapped topic the provider is `configuration-required` and
  `register()` answers `null`; the host bridge then offers no notifications
  event channel, so the gateway exposes no `notificationsV2`, carries no
  `PlatformCapabilities.notifications` block, and the target config's
  `integrations.notifications` state alone decides the readiness. On a Toss app older than 5.255.0 it stays
  `available`, because topics mapped with `agreement: 'none'` are still
  delivered; only the agreement reads and requests answer for the version.
- **v1.** The host bridge serves the v1 methods from this provider. A topic
  the player agreed to during the bridge's lifetime (`granted` or
  `already-granted` from a v1 `requestSubscription` or a v2
  `requestPermission`) reads `subscribed` for v1 from a v1-only session
  cache, which a `denied` or `blocked` answer clears; otherwise a topic that
  needs an agreement reads `not-subscribed`. v2 `getPermission` keeps
  reading `unknown`, so the runtime takes the backend record, which also
  serves v1 callers through `toNotificationSubscriptionAdapter` across
  restarts.
- **Templates without agreement.** Only templates linked to an agreement
  statement need agreement; the console rejects opt-in style templates without
  one. Messages a player needs to use the service (payment, refund, and
  similar) are sent without agreement. Their mapping declares `agreement:
  'none'`, reads `granted`, and never prompts. A `rejected` answer with reason
  `agreement` still records the denial, but later sends go on and the host
  decides each one.
- **No read.** Neither the client nor the server can read the agreement, and
  revocation in Toss settings raises no event. So `readable` is false, and the
  server record is what the gate uses. A send to a user who revoked comes back
  as a `rejected` answer with reason `agreement`, which records the denial.
- **Copy and landing.** Copy (title ≤ 7, body ≤ 25 characters) and the landing
  URL live in the console template.
- **No advertising.** Functional messages may not carry benefits or retention
  content, and promotional campaigns are console-only, so `remote.purposes`
  excludes `advertising`. Console recurring sends (daily or weekly, name
  variable only) are a host feature outside the kit.

### Devvit {#profile-devvit}

- **Gated beta.** Notifications are a gated beta. The target config keeps
  `approval-required` until Reddit approves the app, and Devvit admins
  pre-approve the copy.
- **Consent.** There is no Reddit consent screen.
  - The game renders its own on/off toggle. The server bridge calls
    `optInCurrentUser` from `requestPermission` and `optOutCurrentUser` from
    `revokePermission` for the logged-in requester, and reads `isOptedIn`.
  - Devvit's guidance requires the game to offer both directions.
- **Login.** A logged-out player needs login first: the provider reports
  `action-required` availability and state with `requiredAction: 'login'`.
  P3 adds a client-side Devvit `identity.requestUpgrade` that calls
  `showLoginPrompt()` from `@devvit/web/client` and answers `reloadExpected:
  true`, and it enables the reddit `identityUpgrade` integration. Today's
  server bridge answers `unavailable` for that player.
- **Opt-out read at send time.** No opt-out event exists, and opt-out may move
  into Reddit settings, so the gate reads `isOptedIn` at send time instead of
  copying it.
- **Links.** `enqueue` needs a post or comment for each recipient. The send's
  `link`, or the mapping's default `link`, supplies it, and the linked post's
  data supplies the route for the open.

## Advertising rules {#advertising-rules}

Korean law (정보통신망법 §50) governs advertising sent by app push. The
current guide is KISA's 「불법 스팸 방지를 위한 정보통신망법 안내서」 7th revision
(KISA-GD-2025-0037, 2025-12, posted 2026-03-04). Page numbers below are its
printed pages.

A deployment sets `advertisingRules`:

- **`kr`** applies the rules below to every recipient of the deployment. Any
  deployment that may reach recipients in Korea must enable it.
- **`none`** keeps advertising consent and the opt-out route, which App Review
  Guideline 4.5.4 also requires. It applies no night window, label, sender
  line, expiry, or notices.

Given the deployment settings, `validate:notifications` requires this setting
when the catalog has an `advertising` topic. Under `kr` it also requires the
notice topic with its `notices.copy` and the advertising sender, and it
reports a blank sender contact, sender name, or opt-out line, which
[gate step 8](#policy-gate) would read as missing or absent.

What the kit enforces for `advertising` topics under `kr`:

- **Prior opt-in, separate from OS permission.** Allowing push is not
  advertising consent (p.55, Q02-03). The consent must be explicit, not
  pre-checked, and not phrased as a benefit-alert agreement (p.12).
- **Night consent.** Messages that arrive between 21:00 and 08:00 KST need a
  separate night consent (§50③, p.18). Arrival, not sending, decides, so a
  message without night consent expires before the window opens (FAQ 05-01,
  p.60).
- **The label, sender, and opt-out.**
  - "(광고)" comes at the start, followed by the sender name (unless it equals
    the app name) and a phone number or address (pp.43–44).
  - At the end comes a statement that opting out is free (p.19).
  - The message carries an opt-out action that opens the opt-out screen
    directly; describing a settings path is not enough (p.44).
- **Notices.**
  - A result notice is due within 14 days of a consent, refusal, or
    withdrawal. It gives the sender's name, the act and its date, and the
    processing result (§50⑦, decree art. 62-2; pp.23–24).
  - A re-confirmation notice is due every two years per medium, counted from
    the consent date. It gives the sender's name, the consent and its date,
    and how to keep or withdraw it (§50⑧, decree art. 62-3; pp.25–26,
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

Other rules the profiles encode:

- App Review Guideline 4.5.4: no required push, and explicit opt-in and
  in-app opt-out for marketing push.
- App Review Guideline 5.1.2(i): no reward for enabling push.
- Google Play's notification policy: promotions for the app itself are
  allowed; ads, promotion of other apps, and notifications that imitate the
  system are not.
- The Apps in Toss functional-message rules.
- Devvit's content rules.

## Bridge and versioning {#bridge}

- **Methods.** `notifications.v2.getCapabilities`, `.getPermission`,
  `.requestPermission`, `.revokePermission`, `.register`, `.scheduleLocal`,
  `.cancelLocal`, `.listLocal`, and `.openSettings`. Transports without v2
  answer `NOTIFICATIONS_V2_UNAVAILABLE`, which is not retryable.
- **Events.** They share the bridge event channel. `BridgeEvent` becomes a
  union discriminated by `protocol`: the existing `mpgd.commerce.v2` envelope,
  and `{ protocol: 'mpgd.notifications.v2', sequence, event }` with
  `sequence` per session starting at 0.
- **Validation and alignment.**
  - typia validators and generated JSON Schemas cover every bridge payload, as
    for commerce.
  - N2 exports `notificationsProtocolVersion` and generates JSON Schemas for the
    bridge payloads, events, consent records, notices, and the vector format
    into
    [`docs/specs/notifications/schemas/`](https://github.com/imjlk/mpgd-kit/tree/main/docs/specs/notifications/schemas).
  - `validate:notifications-alignment`, run in `pnpm check`, keeps the
    constant, the vectors, and the schemas aligned.
- **What N3 landed.** When N3 landed no transport served v2; P1–P3 add the
  providers.
  P1 serves it on the Apps in Toss host bridge, and the Apps in Toss gateway
  exposes `notificationsV2` over a host that offers the notifications event
  channel, which the host does while a topic is mapped; the game side loads
  its bridge client and validators on first use. The sandbox bridges still
  answer `NOTIFICATIONS_V2_UNAVAILABLE`.
  - `@mpgd/bridge` adds the nine methods to `BridgeMethod`
    (`bridgeNotificationsV2Methods`, kept equal to `notificationBridgeMethods`
    by a type check and a test). `@mpgd/bridge/notifications` validates each
    method's payload and answer with the N2 validators
    (`assertBridgeNotificationsV2Payload`, `assertBridgeNotificationsV2Result`);
    the main entry loads no notifications code.
  - `BridgeEvent` is the union above. `createBridgeEventSource` numbers one
    protocol's events from 0 for each session and attaches to the provider only
    for the first listener, so events the provider buffered reach it.
  - The Cloudflare Pages host, the Apps in Toss host and sandbox bridges, and
    the Devvit sandbox and server bridges (the kit's and the CLI template's)
    answer every method with `NOTIFICATIONS_V2_UNAVAILABLE`
    (`createNotificationsV2UnavailableBridgeError`).
  - The Capacitor gateway answers the same code for a method no registered
    provider serves, before it pauses the game or reaches the base plugin, and
    its registry refuses the methods as methods a v1 provider declares. For the
    provider P2 adds, `requestPermission` and `openSettings` pause the game,
    and the registry passes the methods through `assertMethodReady`.
  - `withTargetAvailability` exposes `notificationsV2` only while
    `integrations.notifications` lets the game call notifications, as it does
    the v1 adapter. It then adds `PlatformCapabilities.notifications` from one
    bounded read of the provider, copied fresh with exact keys, and sets
    `providerAvailability.pushNotifications` to its availability. A read that
    fails, stalls, or breaks the contract yields a block that offers nothing.

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

How a real provider is judged:

- **Skipped vectors.** A provider whose capabilities fail a predicate skips
  the vector, with that predicate as the reason.
- **Fixture identifiers.** Through `createProvider`, an expectation naming the
  fixture provider id (`profile.provider`) or the fixture agreement evidence
  schema (`fixture.host-agreement.v1`) matches the provider's own id and the
  evidence schema its harness declares. This applies in both `returns` and
  `expect`, as commerce substitutes store ids.
  - Only a `provider` field and an evidence `schema` change. An address or a
    topic that happens to hold the same text stays as written.
- **Host observations.** Only a host actor in the harness counts prompts and
  local operations. Without one, a vector that expects `prompts` or
  `local.operations` fails rather than reading zero, and so does one that
  expects `local.pending` from a provider without `listLocal`.
- **Local `permission-required`.** A `setReminder` step that expects it also
  calls the provider's `scheduleLocal` directly. That call must answer
  `permission-required` without prompting or scheduling, because the runtime
  answers before it reaches the provider.
- **Backends under test.** `createBackend` replaces the fake backend with
  another one, such as the production service over an in-memory store. It
  receives the fake's inputs: the derived registry entry, the vector's
  catalog, deployment, and notices, the clock, and the host's send-time
  permission read. The S1 service passes every vector except those that
  need S2's server reminders or notice pushes, and the per-send vector.

### Vector format {#vector-format}

| Field | Meaning |
| --- | --- |
| `vector`, `protocol`, `summary` | Id, draft protocol version, and what the scenario proves |
| `appliesTo` | Predicates on capability paths that must all hold: `{ "path": "permission.prompt", "equals": "os" }`, `{ "path": "remote.purposes", "includes": "advertising" }`, or `"excludes"` |
| `profile` | `provider`, `capabilities`, and optional server-side `limits` (`perUserPerDay`, `perUserPerMinute`). The fake backend derives the provider's registry entry from them: purposes, addressing, content, and permission fields from the capabilities; `expiry` and `actions` true for a free-form device provider; `link` true for `host-link` opens; no `rate` |
| `catalog` | Topic entries as in the [topic catalog](#topic-catalog), with the provider mapping for this one profile under `mapping` instead of `targets`. Vector catalogs list only the topics a scenario needs and are not validated: `advertising-unsupported-by-host` maps an advertising topic the validator would reject, to prove the gate refuses it too |
| `notices` | The catalog's `notices` block: `topic`, the notice topic, which `catalog` declares without copy, and `copy`, a title and a body per locale and notice variant, checked by the catalog's rules in the default locale `ko`. Without it the scheduler sends no notice. A `topic` that `catalog` declares as anything but a remote `service` topic, or leaves out while it declares an advertising topic under `kr`, fails the vector at `backend` |
| `context` | `player`, `now`, and the device's `timeZone`, which the runtime registers |
| `host` | Fake host settings: with `actionRequired: true`, the fixture provider reports `availability: 'action-required'` and `requiredAction: 'login'` until `completeAction`; `profile.capabilities` is its declaration afterwards |
| `deployment` | Backend deployment settings: `advertisingRules` (`kr` or `none`), `advertisingSender` (`{ name?, contact }`), `advertisingOptOutLine`, and `timeZone` (Asia/Seoul when absent) |
| `steps` | Actor actions in order; a step may carry `returns` or `throws` (`{ code }`). `returns` is matched as a subset: objects by their listed keys, and arrays item by item with the same length |
| `expect` | Final assertions; a key that is absent is not asserted, and a field set to `null` asserts that the field is absent |

Fake defaults:

- **Prompts and states.**
  - The host starts at `prompt` for `os` and `game` prompts, `unknown` for
    unreadable `host` prompts, and `unsupported` for an unsupported profile. A
    topic whose mapping needs no agreement starts at `granted`.
  - A `denied` prompt answer follows the profile's `permission.promptLimit`, as
    the [runtime rules](#runtime) describe. `dismissed` leaves the state
    unchanged and counts no denial.
  - `host-terms-declined` reaches the host API and answers the
    `action-required` outcome with `requiredAction: 'host-settings'`.
- **Evidence.** The fake host's agreement evidence uses the schema
  `fixture.host-agreement.v1`.
- **Endpoints and sessions.** The host issues no endpoint until
  `issueEndpoint`, and `issueEndpoint` after `runtime.start` also emits
  `endpoint-changed`. The fake session's installation id is `installation-1`.
- **Copy.** It resolves with `defaultLocale: 'ko'`.
- **Provider answers.** The backend's provider answers from a first-in,
  first-out queue that `queueProviderResult` fills, and `accepted` when the
  queue is empty.
- **Ledger and fan-out.** The fake ledger's claim lease is 300 seconds. Device
  fan-out calls endpoints in installation-id order.
- **Taps.** A `tap` before the game's first subscriber is buffered and
  observed once by that subscriber; a later `tap` reaches every current
  subscriber. It is `cold` when it came before `runtime.start` and `warm`
  after.

| Actor | Actions |
| --- | --- |
| `runtime` | `start`; `restart` (see [Runtime](#runtime)) |
| `clock` | `set` (`at`), `advance` (`seconds`) |
| `host` | `queuePrompt` (`result`: `granted`, `already-granted`, `denied`, `dismissed`, `host-terms-declined`); `setPermission` (`state`); `issueEndpoint` (`endpoint`: `{ kind, value }`); `completeAction`; `tap` (`input`: `{ channel, topic?, route?, data? }`) |
| `game` | The [runtime](#runtime) methods: `getPermission`, `requestPermission` (`topics`, `gesture`), `revokePermission` (`topics`), `register`, `unregister`, `setTopicPreference`, `setAdvertisingConsent`, `setReminder`, `cancelReminder`, `listNotices`, `recordNotice` (a listed notice, or its `kind`, `record` with its `kind` and `at`, and `dueBy`), `openSettings`, and `subscribe` (`listener` names the listener) |
| `backend` | `authenticate` (`player`); `deliver` (`input`: `topic`, `idempotencyKey`, optional `player` defaulting to `context.player`, `provider`, `templateData`, `data`, `locale`, `link`); `queueProviderResult` (`result`: `accepted`, `unregistered`, `rate-limited` with optional `retryAfterSeconds`, `rejected` with `reason`, or `ambiguous`); `registerEndpoint` (`input`: `installationId`, `kind`, `value`, `permission`; another installation of the same player); `revokeSession` (ends the session that registered the installation); `runScheduler` (process every due reminder, deferred send, and notice) |

`expect` keys; a list is matched exactly in length and order, with only the
listed fields of each item asserted:

| Key | Item |
| --- | --- |
| `prompts` | A number: calls that reached the host prompt API |
| `consent` | [Consent records](#runtime) without `at` |
| `endpoints` | Final endpoints: `provider`, `kind`, `value`, `installationId`, `permission`, `player`, `status` (`valid` or `invalid`) |
| `deliveries` | Every outcome answered or stored for a send key, in order; per-endpoint deliveries under derived keys appear only in `providerCalls`: `idempotencyKey`, `topic`, `status`, `reason`, `until`, `alreadyProcessed` |
| `providerCalls` | Every provider attempt, including one answered `rate-limited`: `topic`, `address` (the device address value), `mapping`, `link`, `content` (`title`, `body`, `actions`), `expiresAt` |
| `local` | `operations` (`op`: `schedule`, `replace`, `cancel`, with `key`, `topic`, `fireAt`, `exact`) and the final `pending` list |
| `reminders` | Pending server reminders |
| `events` | An object keyed by listener name, each a list of events |
| `notices` | The backend's listed notices at the end, ordered by `dueBy` and then `kind`: `kind` (`consent-result`, `reconfirmation`), `record` (its `kind` and `state`), `dueBy` (an Asia/Seoul date), `variant` |

| Vector | Checks |
| --- | --- |
| `os-permission-granted` | One app-scope prompt grants every topic; endpoint registration with the device permission; no consent record |
| `os-permission-denied-twice` | `promptLimit` 2 on a device-addressed provider: `prompt-with-rationale` then `blocked`; no third dialog; the endpoint holds `blocked`; no consent record |
| `os-permission-denied-once` | `promptLimit` 1 on a device-addressed provider: the first denial is `blocked`; no second dialog; no consent record |
| `os-permission-dismissed` | On a device-addressed provider, a dismissed dialog leaves the state and counts no denial; no consent record |
| `local-schedule-never-prompts` | Scheduling without permission returns `permission-required` and shows nothing |
| `host-agreement-recorded` | Unreadable host: agreement recorded with its evidence and the implied topic preference, read back as granted after a restart; `already-granted` adds no record |
| `host-agreement-dismissed` | A per-template sheet that closes without an answer is `dismissed`: nothing is recorded, the topic reads `unknown`, and the next request reaches the host again |
| `host-agreement-rejected` | A rejected sheet records a denied host agreement with its evidence and no topic preference; sends stop until the player accepts again |
| `host-agreement-then-withdrawn` | A withdrawn preference suppresses despite the agreement; accepting the sheet again re-enables the topic |
| `host-service-topic-without-agreement` | A service template without an agreement statement reads granted and delivers with no prompt or record |
| `host-gesture-and-terms` | No gesture throws `NOTIFICATIONS_USER_GESTURE_REQUIRED`; a host-terms decline is `action-required` (`host-settings`), unrecorded, and asked again |
| `per-send-allowance` | One acceptance allows one delivery; retrying the delivered key answers the stored result, not `allowance-exhausted` |
| `game-rendered-opt-in` | Game prompt, server opt-in, revocation read at send time |
| `game-rendered-opt-out` | `revokePermission` opts out at the host; the next send is suppressed |
| `requested-topic-needs-opt-in` | A `requested` topic is suppressed until the player turns it on |
| `advertising-needs-consent` | Suppressed without consent; rendered with label, sender line, free opt-out line, opt-out action, and expiry; the result notice is listed, the first re-confirmation not yet |
| `advertising-notices` | An unrecorded result notice is sent through the notice topic; a re-confirmation is listed 60 days before its `dueBy`; recording it before then, recording a name that matches nothing, and recording it again after its `dueBy` change nothing; the next one is listed two years later |
| `advertising-notice-variants` | Through one notice topic, each in its own variant of `notices.copy`, the scheduler pushes the results of an advertising and a night consent, both re-confirmations two years later, the withdrawal of each, and a second withdrawal of each, which is a refusal; the game lists each notice with its variant, and the advertising refusal, which the copy leaves out, is given in the withdrawal's text |
| `advertising-night-window` | Deferred to 08:00 KST without night consent and sent with an expiry; immediate without expiry with it |
| `advertising-rules-none` | Without the Korean rules: a send before consent is `suppressed: advertising-consent-missing`; after consent, no window, label, or expiry |
| `advertising-unsupported-by-host` | A host-template provider refuses an advertising topic |
| `advertising-sender-required` | Advertising consent without a configured advertising sender is suppressed |
| `reminder-local-route` | A `requested` topic without opt-in is refused; local route, replace by key, cancel; no server reminder |
| `local-reminder-cancelled-on-withdrawal` | Turning a topic off cancels its pending local reminder |
| `reminder-server-route` | Server route after the agreement, cancel, re-set, delivery at the due time through the gate |
| `reminder-cancel-across-routes` | A key names one reminder across routes; cancel after a restart finds the server reminder |
| `landing-open-before-listener` | On a `landing-url` host the cold open reaches the first subscriber once with the landing route; a later subscriber receives nothing |
| `open-before-listener` | A cold-start open reaches the game's first subscriber once |
| `endpoint-lifecycle` | Authentication alone moves a device address to the newly authenticated player; `UNREGISTERED` invalidates it |
| `endpoint-fan-out` | Every granted installation receives the send; a dead one is invalidated alone; a retry sends nothing |
| `endpoint-rotation` | A rotated device address replaces the old one without an explicit `register()` |
| `endpoint-unbind-on-logout` | `unregister()` removes the installation from the player; later sends find no endpoint |
| `endpoint-unbind-on-session-end` | The end of the registering session unbinds the endpoint without `unregister()` |
| `provider-daily-limit` | A daily provider limit suppresses the third send of the day |
| `provider-minute-limit` | A per-minute provider limit defers the send to the end of the window |
| `provider-rate-limited` | A `rate-limited` answer defers the send by `retryAfterSeconds`; the scheduler delivers it |
| `provider-rejected` | An `agreement` rejection is not stored and records a provider denial; later sends stop |
| `provider-ambiguous-replay` | An ambiguous answer keeps the claim; the scheduler replays the reminder after the lease |
| `idempotency-key-reuse` | A key is bound to its request; reuse is a conflict; reserved prefixes are refused |
| `quiet-hours-player-zone` | Quiet hours use the player's registered zone, not the deployment's |
| `local-only-topic` | A topic without the `remote` channel is never sent remotely |
| `action-required-login` | A host that needs login answers `action-required` (`login`) without prompting until the action completes |
| `unsupported-target` | Reads answer `unsupported`, requests answer `unavailable` without a prompt, reminders are unavailable |

## Migration and PR plan {#pr-plan}

The v1 `NotificationSubscriptionAdapter` stays. N2 adds
`toNotificationSubscriptionAdapter(runtime, catalog)` over the runtime, so
reads see backend records. Until a game reads through it, an adapter whose
host cannot read a decision back may serve its raw v1 `getStatus` from a
v1-only cache of the decisions of the session (Apps in Toss does; see
[Apps in Toss](#profile-ait)); its v2 reads never use that cache. v1 callers request with `gesture: true`, and
`approval-required` stays with the target config, which keeps the v1 adapter
when v2 is not exposed.

- `catalog` holds the topics resolved for the runtime's target
  (`resolveNotificationTopicsForTarget`), as the runtime reads them.
- A topic outside them reads `configuration-required` and requests
  `unavailable`: the catalog does not declare it, or the target does not map
  it. An entry that still carries `targets` names no single target, so it
  counts as outside.
- Any failure with the `NOTIFICATIONS_CONFIGURATION_REQUIRED` code maps to
  `configuration-required`, including a bridge error that kept only its
  `code`.

| v2 answer | v1 `getStatus` | v1 `requestSubscription` |
| --- | --- | --- |
| `granted` state | `subscribed` | |
| `prompt`, `prompt-with-rationale`, `denied`, `blocked`, `action-required`, or `unknown` without a granted record | `not-subscribed` | |
| `unsupported` state | `unsupported` | |
| `NOTIFICATIONS_CONFIGURATION_REQUIRED` | `configuration-required` | |
| `granted` or `already-granted` outcome | | `subscribed` |
| `denied` or `blocked` outcome | | `rejected` |
| `dismissed`, `action-required`, or `unavailable` outcome, or a thrown error | | `unavailable` |

The v1 delivery service in `@mpgd/game-services/notification-delivery` stays,
deprecated, with its own deep-link policy until the major: root-relative links
that stay on the game origin, and absolute links only on allowed origins. v2
sends carry no per-send deep link: routes are per topic, and per-send routing
context goes in `data`, validated like template data. Devvit's per-send
`link` names the post a notification opens, not a route. Every PR that changes a
publishable package carries a Sampo changeset.

| PR | Scope | Closes |
| --- | --- | --- |
| N1 | This RFC and the vectors | |
| N2 | `@mpgd/platform/notifications`: types, capabilities, the provider registry entry, permission mapping helpers, the pure policy gate, notice due dates, reminder routing, typia validators, JSON Schemas, and `notificationsProtocolVersion`; `@mpgd/catalog` topic catalog and `validate:notifications`; conformance runner with fixture-identifier substitution, reference runtime, and fakes passing every vector; `validate:notifications-alignment`; v1 wrapper over the runtime | Closed topics |
| N2b | `notices.copy` with one title and body per notice variant (`NotificationNoticeVariant`, optional refusal texts), its validator rules, each listed notice's `variant`, which the scheduler pushes, and the `advertising-notice-variants` vector | One notice text for every record |
| N3 | Bridge `notifications.v2.*` methods (including `revokePermission`), the event union, fail-closed answers in every transport; `PlatformCapabilities.notifications` and `gateway.notificationsV2` gating in the target-config runtime; the Capacitor external-activity and registry pass-through for v2 methods | |
| P1 | `@mpgd/adapter-ait`: provider over `Notification.requestAgreement` with the agreement mapping, the 120-second settle, agreement evidence, and landing opens that `getLaunchIntent` does not route again; `@mpgd/game-services`: Apps in Toss functional-message delivery provider with `FAIL` code mapping | Session-only agreements, deprecated API |
| P2 | `@mpgd/adapter-capacitor/notifications`: `PushSdk` and `LocalNotificationSdk` over the plugins as optional peers, the provider, channels, the native opt-out action, cold-start buffering, settings link | |
| P3 | `@mpgd/adapter-devvit`: game-rendered opt-in and opt-out through the server bridge, a client-side `identity.requestUpgrade` over `showLoginPrompt()`, and a delivery provider over `enqueue` with per-send links inside the Devvit server | |
| S1 | `@mpgd/game-services` and the Worker: provider registry, endpoint registry bound to the game-services session, consent records and the notices API, policy gate, FCM delivery provider with expiry, D1 migrations, retention purges, authenticated routes, dead and stale endpoint handling | No endpoints, no consent records |
| S2 | Reminders: client intent API with routing and set-time checks, server scheduler (D1 and Cron) with pacing and backoff, notice sending, Devvit scheduler path | No reminders |
| C1 | CLI and templates: `--providers notifications`, plugin wiring through `@mpgd/*` packages only, Firebase setup guide, the `advertisingRules` setting, a notice topic, a sample consent screen for advertising and night consent, docs | |

**What S1 landed.**

- `@mpgd/game-services/notifications`: the provider registry with served
  targets, the remote delivery provider contract (`{ id, send }`, built
  from platform types only), the endpoint registry, consent records and the
  notices API, sends through the key states, the gate, queued fan-out, and
  the five answers, due-row replays (deferred rows and expired leases),
  retention purges, the FCM provider, and a reference in-memory store.
  `./notifications/store-conformance` pins the store contract.
- The game-services Worker: migration `0007_notifications.sql` and the D1
  store, the session-bound client routes (a session already past its
  `expiresAt` is refused), the `deliverNotification` and
  `endNotificationSession` service-binding methods, which answer
  `{ ok, value }` or `{ ok: false, error: { code, message, retryable } }`
  because an error's fields do not cross RPC, the dispatch queue consumer,
  and a cron that purges and replays due rows. The Worker refuses a queue
  next to its memory store, whose state the consumer's isolate cannot see.
  It serves FCM for `android` and `ios`, and the Apps in Toss provider for
  `ait` behind its mTLS binding (`AIT_PARTNER_MTLS`), its settings
  (`MPGD_AIT_NOTIFICATIONS`), and the identity binding that resolves its
  recipients; half that configuration fails the Worker's notifications.
- Left to S2: server reminders, notice pushes, and pacing by the
  registry's `rate`; the replay of deferred rows is in S1 so that rate
  limits and windows settle.

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
2. **Devvit ledger.** Confirm that a Redis-backed claim/lease ledger inside the
   Devvit server meets the delivery ledger's fencing contract.
3. **Scheduler backend.** D1 plus Cron is the default; Durable Object alarms
   would give per-player precision at higher cost.
4. **Remote copy on the server.** Whether the Worker reads localized copy from
   the catalog file or from a project-provided resolver.
5. **Bulk sends.** The first wave sends one recipient per call. Bulk paths
   are a follow-up: the Apps in Toss bulk API for 50 or more recipients, and
   Devvit `enqueue` with up to 1,000 recipients, with opt-in read from
   `listOptedInUsers` pages. They need per-recipient keys and outcomes in one
   provider call.
6. **Notices for players without push.** A player who never grants delivery
   permission and does not open the game cannot receive a re-confirmation
   notice through the kit, which has no other medium. Decide whether games
   must collect another contact or accept the in-game notice at the next
   launch.

## References {#references}

- KISA, 「불법 스팸 방지를 위한 정보통신망법 안내서」 7th revision (KISA-GD-2025-0037):
  <https://spam.kisa.or.kr/spam/na/ntt/selectNttInfo.do?mi=1020&bbsId=1002&nttSn=3001>
- 정보통신망법 and its decree: <https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=290001>,
  <https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=290483>
- Apps in Toss push notifications (console and SDK):
  <https://developers-apps-in-toss.toss.im/guide/marketing/smart-message.md>,
  <https://developers-apps-in-toss.toss.im/documentation/common/growth/smart-message.md>,
  <https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/notification/notification.requestagreement.md>,
  partner API <https://developers-apps-in-toss.toss.im/api/push.md>,
  launch referrers <https://developers-apps-in-toss.toss.im/documentation/common/growth/analytics/referrer.md>,
  `Environment.initialURL` <https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/environment/environment.initialurl.md>,
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
  <https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode>,
  message lifespan <https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan>
- WeChat subscribe messages:
  <https://developers.weixin.qq.com/minigame/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html>
