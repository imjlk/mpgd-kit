import type { IsoTimestamp, NonEmptyString, PositiveQuantity } from './commerce-contract.js';
import type { PlatformEvidenceEnvelope, PlatformProviderAvailability } from './index.js';

// Notifications v2 client contract types (RFC "Capabilities" and "Client
// contract", docs/specs/notifications/notifications-v2-rfc.md). This module is
// typia-free on purpose, like `./commerce-contract`: `./index` references
// `NotificationProvider` for `PlatformGateway.notificationsV2`, and headless
// consumers type-check `@mpgd/platform` with `skipLibCheck: false` and no DOM
// lib, where typia's root declarations do not compile. `./notifications`
// re-exports everything here and builds the validators and JSON Schemas from
// these same types. The validation tags are the structural forms that
// `./commerce-contract` declares and proves equal to typia's own aliases. (A
// line comment, so the generated schemas do not take it as a description.)

/** Open topic id declared by the game's topic catalog. */
export type NotificationTopicId = string & Record<never, never>;

/** What a topic is for; it decides the consent a send needs (RFC "Topics and purposes"). */
export type NotificationPurpose = 'service' | 'requested' | 'advertising';

/** `remote` is a server-sent push, `local` a device-scheduled notification. */
export type NotificationChannel = 'remote' | 'local';

/** Open provider id. Reference ids: 'fcm', 'apps-in-toss', 'devvit'. */
export type NotificationProviderId = NonEmptyString;

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
 * refused for good or the call did not reach the prompt because the host read
 * was already blocked, 'action-required' when the host needs a player action
 * before it can prompt (`requiredAction` names it), and 'unavailable' when the
 * provider is unsupported or the topic has no mapping for it. The snapshot
 * carries the resulting state, so a second Android denial reports outcome
 * 'denied' with snapshot 'blocked'.
 */
export type NotificationPermissionOutcome =
  | 'granted'
  | 'already-granted'
  | 'denied'
  | 'blocked'
  | 'dismissed'
  | 'action-required'
  | 'unavailable';

export interface NotificationPermissionResult {
  readonly snapshot: NotificationPermissionSnapshot;
  readonly outcomes: Readonly<Record<NotificationTopicId, NotificationPermissionOutcome>>;
  readonly requiredAction?: NotificationRequiredAction;
  /** Host decision for the server record, for example an Apps in Toss agreement event. */
  readonly evidence?: PlatformEvidenceEnvelope;
}

export type NotificationPermissionScope = 'app' | 'topic';
export type NotificationPermissionPrompt = 'os' | 'host' | 'game';
export type NotificationPermissionAllowance = 'persistent' | 'per-send';
export type NotificationRemoteAddressing = 'device' | 'platform-user' | 'none';
export type NotificationRemoteContent = 'free-form' | 'host-template';
export type NotificationOpenPath = 'payload' | 'landing-url' | 'host-link' | 'none';

export interface NotificationPermissionCapabilities {
  /** Where delivery permission lives: one for the app, or one per topic. */
  readonly scope: NotificationPermissionScope;
  /** Who renders the consent UI. */
  readonly prompt: NotificationPermissionPrompt;
  /** Whether the client can read the current state without prompting. */
  readonly readable: boolean;
  /** Whether the backend can read the current state at send time (Devvit `isOptedIn`). */
  readonly serverReadable: boolean;
  /** 'per-send': one acceptance allows one delivery (WeChat one-time subscriptions). */
  readonly allowance: NotificationPermissionAllowance;
  readonly userGesture: boolean;
  /**
   * How many denials the host accepts before only settings can change the
   * answer: iOS 1, Android 13+ 2. A dismissed dialog is not a denial. Absent
   * when the host can always ask again (Apps in Toss, Devvit, WeChat).
   */
  readonly promptLimit?: PositiveQuantity;
  readonly maxTopicsPerPrompt?: PositiveQuantity;
  /** Whether `openSettings` can open the OS or host notification settings. */
  readonly settings: boolean;
}

export interface NotificationRemoteCapabilities {
  readonly supported: boolean;
  /** Purposes the host lets the server deliver. */
  readonly purposes: readonly NotificationPurpose[];
  /** `'none'` exactly when `supported` is false. */
  readonly addressing: NotificationRemoteAddressing;
  readonly content: NotificationRemoteContent;
}

/** Local reminders are always inexact, so the capability carries no timing. */
export interface NotificationLocalCapabilities {
  readonly supported: boolean;
  /** Pending-notification ceiling the provider must stay under (iOS: 64). */
  readonly maxPending?: PositiveQuantity;
}

/**
 * Notifications v2 capability declaration. A provider returns a fresh object
 * on every read; code branches on these declarations, never on a provider id
 * or target name. Release gates such as Devvit's `approval-required` stay in
 * the target config's `integrations.notifications` state.
 */
export interface NotificationCapabilities {
  readonly availability: PlatformProviderAvailability;
  readonly permission: NotificationPermissionCapabilities;
  readonly remote: NotificationRemoteCapabilities;
  readonly local: NotificationLocalCapabilities;
  /** How an open reaches the game. */
  readonly open: NotificationOpenPath;
}

export type NotificationEndpointAddress =
  | {
      readonly kind: 'fcm-token' | 'fcm-installation';
      readonly value: NonEmptyString;
      readonly environment?: 'production' | 'sandbox';
      /** The device's app-scope permission when this registration was sent. */
      readonly permission: NotificationPermissionState;
    }
  /** The server resolves the recipient from the authenticated player. */
  | { readonly kind: 'platform-user' };

/**
 * Where the server reaches this installation or player. The installation id
 * is the authenticated session's, never a field of the registration.
 */
export interface NotificationEndpointRegistration {
  readonly provider: NotificationProviderId;
  readonly address: NotificationEndpointAddress;
  readonly locale?: NonEmptyString;
  /** IANA zone, used for a topic's quiet hours. */
  readonly timeZone?: NonEmptyString;
}

export interface LocalNotificationRequest {
  /** Stable logical key; the provider derives its native id from it. */
  readonly key: NonEmptyString;
  readonly topic: NotificationTopicId;
  /** RFC 3339 with an explicit offset. */
  readonly fireAt: IsoTimestamp;
  readonly title: string;
  readonly body: string;
  /** The topic's root-relative route. Advertising topics never schedule locally. */
  readonly route?: string;
}

/** A pending local notification as `listLocal` reports it. */
export interface LocalNotificationEntry {
  readonly key: NonEmptyString;
  readonly topic: NotificationTopicId;
  readonly fireAt: IsoTimestamp;
}

export type LocalScheduleResult =
  | { readonly status: 'scheduled' | 'replaced' }
  | { readonly status: 'permission-required' | 'capacity-exceeded' | 'unsupported' };

export type NotificationEvent =
  | {
      readonly type: 'opened';
      readonly channel: NotificationChannel;
      readonly source: 'cold' | 'warm';
      readonly topic?: NotificationTopicId;
      /**
       * Untrusted, like `data`: the router opens it only when
       * `isRootRelativeNotificationRoute` accepts it.
       */
      readonly route?: string;
      /** Untrusted routing data. Never a grant. */
      readonly data?: Readonly<Record<string, string>>;
      /** Host referrer when known, for example Apps in Toss 'push' or 'inbox'. */
      readonly referrer?: string;
    }
  | {
      readonly type: 'received';
      readonly channel: NotificationChannel;
      readonly topic?: NotificationTopicId;
    }
  | { readonly type: 'endpoint-changed'; readonly registration: NotificationEndpointRegistration }
  | { readonly type: 'permission-changed'; readonly snapshot: NotificationPermissionSnapshot };

export interface NotificationTopicsInput {
  readonly topics: readonly NotificationTopicId[];
}

export interface CancelLocalNotificationsInput {
  readonly keys: readonly NonEmptyString[];
}

export type NotificationSettingsResult = 'opened' | 'unavailable';

/**
 * A target's notifications provider. Rules every provider follows (RFC
 * "Client contract"): reads are fresh, events emitted before the first
 * `subscribe` go to that first subscriber exactly once, only
 * `requestPermission` may show a consent UI, an unsupported provider answers
 * instead of throwing, local keys map to stable native ids, and failures use
 * the `NOTIFICATIONS_*` `PlatformOperationError` codes.
 */
export interface NotificationProvider {
  readonly provider: NotificationProviderId;
  getCapabilities(): Promise<NotificationCapabilities>;
  getPermission(input: NotificationTopicsInput): Promise<NotificationPermissionSnapshot>;
  requestPermission(input: NotificationTopicsInput): Promise<NotificationPermissionResult>;
  /** Exists exactly when `permission.prompt` is 'game': withdraws the game-rendered consent. */
  revokePermission?(input: NotificationTopicsInput): Promise<NotificationPermissionResult>;
  /** Remote providers: the address the server should send to. */
  register?(): Promise<NotificationEndpointRegistration | null>;
  scheduleLocal?(input: LocalNotificationRequest): Promise<LocalScheduleResult>;
  cancelLocal?(input: CancelLocalNotificationsInput): Promise<void>;
  listLocal?(): Promise<readonly LocalNotificationEntry[]>;
  openSettings?(): Promise<NotificationSettingsResult>;
  subscribe(listener: (event: NotificationEvent) => void): () => void;
}
