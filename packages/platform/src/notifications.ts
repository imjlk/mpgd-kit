import typia, { type tags } from 'typia';

import {
  PlatformOperationError,
  type NotificationSubscriptionAdapter,
  type NotificationSubscriptionResult,
  type NotificationSubscriptionStatus,
  type NotificationTopic,
} from './index.js';

import type {
  CancelLocalNotificationsInput,
  LocalNotificationEntry,
  LocalNotificationRequest,
  LocalScheduleResult,
  NotificationCapabilities,
  NotificationEndpointRegistration,
  NotificationEvent,
  NotificationPermissionOutcome,
  NotificationPermissionResult,
  NotificationPermissionSnapshot,
  NotificationPermissionState,
  NotificationProviderId,
  NotificationSettingsResult,
  NotificationTopicId,
  NotificationTopicsInput,
} from './notifications-contract.js';
import {
  isRootRelativeNotificationRoute,
  isValidNotificationTimeZone,
  notificationPermissionStateOf,
  notificationTopicDefinitionIssues,
  type NotificationConsentRecord,
  type NotificationDeliveryProviderEntry,
  type NotificationDeployment,
  type NotificationNotice,
  type NotificationNoticeKind,
  type NotificationTemplateData,
  type NotificationTopicDefinition,
  type ReminderResult,
} from './notifications-policy.js';

/**
 * Notifications v2 contract module (docs/specs/notifications/notifications-v2-rfc.md).
 * Pure types, validators, and helpers only: no provider lives here, and
 * nothing in this module sends a notification or grants anything. The
 * contract is a draft until the protocol version is released as 2.0.0.
 */
export const notificationsProtocolVersion = '2.0.0-draft.1' as const;
export const notificationsProtocol = 'mpgd.notifications.v2' as const;

// The client contract types live in the typia-free `./notifications-contract`
// so `./index` can reference `NotificationProvider` without loading typia;
// the pure policy lives in `./notifications-policy`. Both are re-exported so
// `@mpgd/platform/notifications` stays the one import site.
export type {
  CancelLocalNotificationsInput,
  LocalNotificationEntry,
  LocalNotificationRequest,
  LocalScheduleResult,
  NotificationCapabilities,
  NotificationChannel,
  NotificationEndpointAddress,
  NotificationEndpointRegistration,
  NotificationEvent,
  NotificationLocalCapabilities,
  NotificationOpenPath,
  NotificationPermissionAllowance,
  NotificationPermissionCapabilities,
  NotificationPermissionOutcome,
  NotificationPermissionPrompt,
  NotificationPermissionResult,
  NotificationPermissionScope,
  NotificationPermissionSnapshot,
  NotificationPermissionState,
  NotificationProvider,
  NotificationProviderId,
  NotificationPurpose,
  NotificationRemoteAddressing,
  NotificationRemoteCapabilities,
  NotificationRemoteContent,
  NotificationRequiredAction,
  NotificationSettingsResult,
  NotificationTopicId,
  NotificationTopicsInput,
} from './notifications-contract.js';
export {
  applyNotificationAdvertisingLabel,
  checkNotificationNightWindow,
  checkNotificationQuietHours,
  createNotificationNoticeIdempotencyKey,
  createNotificationReminderIdempotencyKey,
  evaluateLocalNotificationReminder,
  evaluateNotificationDelivery,
  evaluateNotificationReminderConsent,
  fillNotificationTemplate,
  findNotificationCopy,
  isRecordableNotificationPermissionState,
  isRootRelativeNotificationRoute,
  isValidNotificationTimeZone,
  latestNotificationConsent,
  listNotificationNotices,
  normalizeNotificationTimestamp,
  notificationAdvertisingOptOutActionId,
  notificationAdvertisingPrefix,
  notificationConsentResultDueBy,
  notificationDefaultDeploymentTimeZone,
  notificationDefaultOptOutLine,
  notificationInputBounds,
  notificationKeyIssue,
  notificationNightWindow,
  notificationNoticeLeadDays,
  notificationNoticeSendFrom,
  notificationPermissionConsentKind,
  notificationPermissionStateOf,
  notificationReconfirmationDueBy,
  notificationRegistryMismatch,
  notificationReservedKeyPrefix,
  notificationReservedKeyPrefixes,
  notificationSendFingerprint,
  notificationSuppressionReasons,
  notificationTemplateDataIssue,
  notificationTopicDefinitionIssues,
  notificationTopicNeedsNoAgreement,
  recordableNotificationPermissionStates,
  referenceNotificationProviders,
  referenceNotificationTargetProviders,
  renderNotificationAdvertisement,
  resolveNotificationContent,
  routeNotificationReminder,
  toSeoulCalendarDate,
  type EvaluateLocalNotificationReminderInput,
  type EvaluateNotificationDeliveryInput,
  type EvaluateNotificationReminderConsentInput,
  type LocalNotificationReminderDecision,
  type NotificationAction,
  type NotificationAdvertisingRules,
  type NotificationAdvertisingSender,
  type NotificationClockTime,
  type NotificationConsentKind,
  type NotificationConsentRecord,
  type NotificationConsentSource,
  type NotificationConsentState,
  type NotificationDeferralReason,
  type NotificationDeliveryContent,
  type NotificationDeliveryDecision,
  type NotificationDeliveryHistoryEntry,
  type NotificationDeliveryOutcome,
  type NotificationDeliveryProviderEntry,
  type NotificationDeliveryRefusal,
  type NotificationDeliveryStatus,
  type NotificationDeployment,
  type NotificationMappingField,
  type NotificationNotice,
  type NotificationNoticeGiven,
  type NotificationNoticeKind,
  type NotificationProviderLimit,
  type NotificationProviderRegistryEntry,
  type NotificationQuietHours,
  type NotificationRecordablePermissionState,
  type NotificationReminderRoute,
  type NotificationReminderStatus,
  type NotificationSendRequest,
  type NotificationSuppressionReason,
  type NotificationTemplateData,
  type NotificationTopicCopy,
  type NotificationTopicDeclaration,
  type NotificationTopicDefinition,
  type NotificationTopicFrequency,
  type NotificationTopicIssue,
  type NotificationTopicMapping,
  type NotificationUnavailableReason,
  type NotificationWindowCheck,
  type ReminderResult,
  type ResolveNotificationContentInput,
} from './notifications-policy.js';

type NonEmptyString = string & tags.MinLength<1>;
type NonNegativeInteger = number & tags.Type<'uint32'>;

// Errors.

export type NotificationErrorCode =
  /** A method the provider does not implement. */
  | 'NOTIFICATIONS_UNSUPPORTED'
  /** The host's own code is kept as `hostCode`. */
  | 'NOTIFICATIONS_CONFIGURATION_REQUIRED'
  | 'NOTIFICATIONS_USER_GESTURE_REQUIRED'
  | 'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED'
  /** Input outside the bounds, a reserved key prefix, or a timestamp without an offset. */
  | 'NOTIFICATIONS_INVALID_INPUT'
  /** A key stored for another request. */
  | 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT'
  | 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE'
  /** A bridge without the v2 methods; not retryable. */
  | 'NOTIFICATIONS_V2_UNAVAILABLE';

export const notificationErrorCodes = Object.freeze([
  'NOTIFICATIONS_UNSUPPORTED',
  'NOTIFICATIONS_CONFIGURATION_REQUIRED',
  'NOTIFICATIONS_USER_GESTURE_REQUIRED',
  'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED',
  'NOTIFICATIONS_INVALID_INPUT',
  'NOTIFICATIONS_IDEMPOTENCY_CONFLICT',
  'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
  'NOTIFICATIONS_V2_UNAVAILABLE',
] as const satisfies readonly NotificationErrorCode[]);

export function isNotificationErrorCode(value: unknown): value is NotificationErrorCode {
  return typeof value === 'string' && (notificationErrorCodes as readonly string[]).includes(value);
}

export interface NotificationErrorOptions {
  readonly message?: string;
  /** Only `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` is retryable unless a caller says otherwise. */
  readonly retryable?: boolean;
  /** The host's own code, kept verbatim with `NOTIFICATIONS_CONFIGURATION_REQUIRED`. */
  readonly hostCode?: string;
  readonly cause?: unknown;
}

/** Normalized notifications failure; only `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` is retryable by default. */
export class NotificationError extends PlatformOperationError {
  override readonly code: NotificationErrorCode;
  readonly hostCode: string | undefined;

  constructor(code: NotificationErrorCode, options: NotificationErrorOptions = {}) {
    super({
      code,
      message: options.message ?? `Notifications operation failed: ${code}.`,
      retryable: options.retryable ?? code === 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    });
    this.code = code;
    this.hostCode = options.hostCode;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// Runtime (RFC "Runtime").

export interface NotificationRuntimePermissionSnapshot extends NotificationPermissionSnapshot {
  /** Whether the host answered each topic, or the latest backend record did. */
  readonly sources: Readonly<Record<NotificationTopicId, 'host' | 'record'>>;
}

export interface NotificationRuntimeRequestPermissionInput extends NotificationTopicsInput {
  /** Whether the call runs inside a player gesture. */
  readonly gesture: boolean;
}

export interface NotificationTopicPreferenceInput {
  readonly topic: NotificationTopicId;
  readonly enabled: boolean;
}

export interface NotificationAdvertisingConsentInput {
  readonly advertising?: 'granted' | 'withdrawn';
  readonly night?: 'granted' | 'withdrawn';
  readonly textVersion: string;
}

export interface SetNotificationReminderInput {
  readonly key: string;
  readonly topic: NotificationTopicId;
  /** RFC 3339 with an explicit offset. */
  readonly fireAt: string;
  readonly templateData?: NotificationTemplateData;
  /** A post or comment id for providers whose sends need a link (Devvit). */
  readonly link?: string;
}

export interface CancelNotificationReminderInput {
  readonly key: string;
}

export interface RecordNotificationNoticeInput {
  readonly kind: NotificationNoticeKind;
  /** The time of the record the notice reported on. */
  readonly recordAt: string;
}

/**
 * The game-facing notifications surface: the provider composed with the
 * backend. Games call this, never the provider. Consent records are written
 * here (RFC "Runtime" rules); remote sends happen only on the server.
 */
export interface NotificationRuntime {
  getPermission(input: NotificationTopicsInput): Promise<NotificationRuntimePermissionSnapshot>;
  requestPermission(input: NotificationRuntimeRequestPermissionInput): Promise<NotificationPermissionResult>;
  /** Game-rendered consent only (`permission.prompt` is 'game'). */
  revokePermission(input: NotificationTopicsInput): Promise<NotificationPermissionResult>;
  register(): Promise<void>;
  /** Unbinds this installation's address from the player, for example at logout. */
  unregister(): Promise<void>;
  setTopicPreference(input: NotificationTopicPreferenceInput): Promise<void>;
  setAdvertisingConsent(input: NotificationAdvertisingConsentInput): Promise<void>;
  readonly reminders: {
    set(input: SetNotificationReminderInput): Promise<ReminderResult>;
    cancel(input: CancelNotificationReminderInput): Promise<ReminderResult>;
  };
  readonly notices: {
    list(): Promise<readonly NotificationNotice[]>;
    recordShown(input: RecordNotificationNoticeInput): Promise<void>;
  };
  openSettings(): Promise<NotificationSettingsResult>;
  subscribe(listener: (event: NotificationEvent) => void): () => void;
}

/** Bridge event envelope; `sequence` is per session and starts at 0. */
export interface NotificationEventEnvelope {
  readonly protocol: typeof notificationsProtocol;
  readonly sequence: NonNegativeInteger;
  readonly event: NotificationEvent;
}

// Bridge v2 method shapes (RFC "Bridge and versioning"). The bridge wiring is
// N3; N2 fixes and validates the payloads so both sides compile against the
// same schemas.

export interface NotificationBridgeProtocolPayload {
  readonly protocol: typeof notificationsProtocol;
}

export type NotificationBridgeGetCapabilitiesPayload = NotificationBridgeProtocolPayload;

export interface NotificationBridgeGetCapabilitiesResult {
  readonly protocolVersion: NonEmptyString;
  readonly provider: NotificationProviderId;
  readonly capabilities: NotificationCapabilities;
}

export type NotificationBridgeGetPermissionPayload = NotificationTopicsInput;

export type NotificationBridgeGetPermissionResult = NotificationPermissionSnapshot;

export interface NotificationBridgeRequestPermissionPayload {
  readonly topics: readonly NotificationTopicId[] & tags.MinItems<1>;
}

export type NotificationBridgeRequestPermissionResult = NotificationPermissionResult;

export type NotificationBridgeRevokePermissionPayload = NotificationBridgeRequestPermissionPayload;

export type NotificationBridgeRevokePermissionResult = NotificationPermissionResult;

export type NotificationBridgeRegisterPayload = NotificationBridgeProtocolPayload;

export interface NotificationBridgeRegisterResult {
  /** `null` when the provider has no address yet, or none to register. */
  readonly registration: NotificationEndpointRegistration | null;
}

export type NotificationBridgeScheduleLocalPayload = LocalNotificationRequest;

export type NotificationBridgeScheduleLocalResult = LocalScheduleResult;

export type NotificationBridgeCancelLocalPayload = CancelLocalNotificationsInput;

export interface NotificationBridgeCancelLocalResult {
  readonly cancelled: boolean;
}

export type NotificationBridgeListLocalPayload = NotificationBridgeProtocolPayload;

export interface NotificationBridgeListLocalResult {
  readonly pending: readonly LocalNotificationEntry[];
}

export type NotificationBridgeOpenSettingsPayload = NotificationBridgeProtocolPayload;

export interface NotificationBridgeOpenSettingsResult {
  readonly status: NotificationSettingsResult;
}

export interface NotificationBridgeMethods {
  readonly 'notifications.v2.getCapabilities': {
    readonly payload: NotificationBridgeGetCapabilitiesPayload;
    readonly result: NotificationBridgeGetCapabilitiesResult;
  };
  readonly 'notifications.v2.getPermission': {
    readonly payload: NotificationBridgeGetPermissionPayload;
    readonly result: NotificationBridgeGetPermissionResult;
  };
  readonly 'notifications.v2.requestPermission': {
    readonly payload: NotificationBridgeRequestPermissionPayload;
    readonly result: NotificationBridgeRequestPermissionResult;
  };
  readonly 'notifications.v2.revokePermission': {
    readonly payload: NotificationBridgeRevokePermissionPayload;
    readonly result: NotificationBridgeRevokePermissionResult;
  };
  readonly 'notifications.v2.register': {
    readonly payload: NotificationBridgeRegisterPayload;
    readonly result: NotificationBridgeRegisterResult;
  };
  readonly 'notifications.v2.scheduleLocal': {
    readonly payload: NotificationBridgeScheduleLocalPayload;
    readonly result: NotificationBridgeScheduleLocalResult;
  };
  readonly 'notifications.v2.cancelLocal': {
    readonly payload: NotificationBridgeCancelLocalPayload;
    readonly result: NotificationBridgeCancelLocalResult;
  };
  readonly 'notifications.v2.listLocal': {
    readonly payload: NotificationBridgeListLocalPayload;
    readonly result: NotificationBridgeListLocalResult;
  };
  readonly 'notifications.v2.openSettings': {
    readonly payload: NotificationBridgeOpenSettingsPayload;
    readonly result: NotificationBridgeOpenSettingsResult;
  };
}

export type NotificationBridgeMethod = keyof NotificationBridgeMethods;

export const notificationBridgeMethods = Object.freeze([
  'notifications.v2.getCapabilities',
  'notifications.v2.getPermission',
  'notifications.v2.requestPermission',
  'notifications.v2.revokePermission',
  'notifications.v2.register',
  'notifications.v2.scheduleLocal',
  'notifications.v2.cancelLocal',
  'notifications.v2.listLocal',
  'notifications.v2.openSettings',
] as const satisfies readonly NotificationBridgeMethod[]);

/** A fresh capability block for a provider that has no notification path; callers must not share it. */
export function createUnsupportedNotificationCapabilities(): NotificationCapabilities {
  return {
    availability: 'unsupported',
    permission: {
      scope: 'app',
      prompt: 'os',
      readable: true,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: false,
      settings: false,
    },
    remote: { supported: false, purposes: [], addressing: 'none', content: 'free-form' },
    local: { supported: false },
    open: 'none',
  };
}

// Validators. typia checks the shape and the tags and rejects unknown keys.

const assertNotificationCapabilitiesShape = typia.createAssertEquals<NotificationCapabilities>();
const isNotificationCapabilitiesShape = typia.createEquals<NotificationCapabilities>();

/** Validates a capability block, including `remote.addressing: 'none'` exactly when `remote.supported` is false. */
export function assertNotificationCapabilities(input: unknown): NotificationCapabilities {
  const capabilities = assertNotificationCapabilitiesShape(input);
  if (capabilities.remote.supported === (capabilities.remote.addressing === 'none')) {
    throw new TypeError(
      "Notification capabilities declare remote.addressing 'none' exactly when remote.supported is false.",
    );
  }
  return capabilities;
}

export function isNotificationCapabilities(input: unknown): input is NotificationCapabilities {
  return isNotificationCapabilitiesShape(input)
    && input.remote.supported !== (input.remote.addressing === 'none');
}

export const assertNotificationPermissionSnapshot =
  typia.createAssertEquals<NotificationPermissionSnapshot>();
export const assertNotificationPermissionResult =
  typia.createAssertEquals<NotificationPermissionResult>();
export const isNotificationPermissionResult = typia.createEquals<NotificationPermissionResult>();
const assertNotificationEndpointRegistrationShape =
  typia.createAssertEquals<NotificationEndpointRegistration>();

/** Validates a registration's shape and that `Intl` knows its `timeZone`, which quiet hours read. */
export function assertNotificationEndpointRegistration(
  input: unknown,
): NotificationEndpointRegistration {
  const registration = assertNotificationEndpointRegistrationShape(input);
  if (registration.timeZone !== undefined && !isValidNotificationTimeZone(registration.timeZone)) {
    throw new TypeError(`Unknown time zone in the registration: ${registration.timeZone}`);
  }
  return registration;
}
const assertLocalNotificationRequestShape = typia.createAssertEquals<LocalNotificationRequest>();

/** Validates a local reminder request, including a root-relative `route`. */
export function assertLocalNotificationRequest(input: unknown): LocalNotificationRequest {
  const request = assertLocalNotificationRequestShape(input);
  if (request.route !== undefined && !isRootRelativeNotificationRoute(request.route)) {
    throw new TypeError(
      `The local reminder route is not root-relative: ${JSON.stringify(request.route)}`,
    );
  }
  return request;
}
export const assertLocalScheduleResult = typia.createAssertEquals<LocalScheduleResult>();
export const assertLocalNotificationEntry = typia.createAssertEquals<LocalNotificationEntry>();
export const assertNotificationEvent = typia.createAssertEquals<NotificationEvent>();
export const isNotificationEvent = typia.createEquals<NotificationEvent>();
export const assertNotificationEventEnvelope = typia.createAssertEquals<NotificationEventEnvelope>();
export const isNotificationEventEnvelope = typia.createEquals<NotificationEventEnvelope>();
export const assertNotificationConsentRecord = typia.createAssertEquals<NotificationConsentRecord>();
export const assertNotificationNotice = typia.createAssertEquals<NotificationNotice>();
export const assertNotificationDeliveryProviderEntry =
  typia.createAssertEquals<NotificationDeliveryProviderEntry>();
export const assertNotificationDeployment = typia.createAssertEquals<NotificationDeployment>();
const assertNotificationTopicDefinitionShape =
  typia.createAssertEquals<NotificationTopicDefinition>();

/** Validates a topic definition's shape and the rules of `notificationTopicDefinitionIssues`. */
export function assertNotificationTopicDefinition(input: unknown): NotificationTopicDefinition {
  const topic = assertNotificationTopicDefinitionShape(input);
  const issues = notificationTopicDefinitionIssues(topic);
  if (issues.length > 0) {
    throw new TypeError(
      `Invalid notification topic ${topic.id}: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return topic;
}
export const assertNotificationBridgeGetCapabilitiesPayload =
  typia.createAssertEquals<NotificationBridgeGetCapabilitiesPayload>();
export const assertNotificationBridgeGetCapabilitiesResult =
  typia.createAssertEquals<NotificationBridgeGetCapabilitiesResult>();
export const assertNotificationBridgeGetPermissionPayload =
  typia.createAssertEquals<NotificationBridgeGetPermissionPayload>();
export const assertNotificationBridgeGetPermissionResult = assertNotificationPermissionSnapshot;
export const assertNotificationBridgeRequestPermissionPayload =
  typia.createAssertEquals<NotificationBridgeRequestPermissionPayload>();
export const assertNotificationBridgeRequestPermissionResult = assertNotificationPermissionResult;
export const assertNotificationBridgeRevokePermissionPayload =
  assertNotificationBridgeRequestPermissionPayload;
export const assertNotificationBridgeRevokePermissionResult = assertNotificationPermissionResult;
export const assertNotificationBridgeRegisterPayload =
  typia.createAssertEquals<NotificationBridgeRegisterPayload>();
export const assertNotificationBridgeRegisterResult =
  typia.createAssertEquals<NotificationBridgeRegisterResult>();
export const assertNotificationBridgeScheduleLocalPayload = assertLocalNotificationRequest;
export const assertNotificationBridgeScheduleLocalResult = assertLocalScheduleResult;
export const assertNotificationBridgeCancelLocalPayload =
  typia.createAssertEquals<NotificationBridgeCancelLocalPayload>();
export const assertNotificationBridgeCancelLocalResult =
  typia.createAssertEquals<NotificationBridgeCancelLocalResult>();
export const assertNotificationBridgeListLocalPayload =
  typia.createAssertEquals<NotificationBridgeListLocalPayload>();
export const assertNotificationBridgeListLocalResult =
  typia.createAssertEquals<NotificationBridgeListLocalResult>();
export const assertNotificationBridgeOpenSettingsPayload =
  typia.createAssertEquals<NotificationBridgeOpenSettingsPayload>();
export const assertNotificationBridgeOpenSettingsResult =
  typia.createAssertEquals<NotificationBridgeOpenSettingsResult>();

// v1 compatibility (RFC "Migration and PR plan").

/**
 * v1 status for a topic's v2 permission state. `unknown` reaches this only when
 * no granted record answered for it, so it is not subscribed.
 */
export function toNotificationSubscriptionStatus(
  state: NotificationPermissionState,
): NotificationSubscriptionStatus {
  switch (state) {
    case 'granted':
      return 'subscribed';
    case 'unsupported':
      return 'unsupported';
    case 'prompt':
    case 'prompt-with-rationale':
    case 'denied':
    case 'blocked':
    case 'unknown':
    case 'action-required':
      return 'not-subscribed';
  }
}

/** v1 result for a v2 permission outcome; a missing outcome is `unavailable`. */
export function toNotificationSubscriptionResult(
  outcome: NotificationPermissionOutcome | undefined,
): NotificationSubscriptionResult {
  switch (outcome) {
    case 'granted':
    case 'already-granted':
      return 'subscribed';
    case 'denied':
    case 'blocked':
      return 'rejected';
    case 'dismissed':
    case 'action-required':
    case 'unavailable':
    case undefined:
      return 'unavailable';
  }
}

/**
 * Serves v1 `NotificationSubscriptionAdapter` callers from the v2 runtime, so
 * reads see backend records (RFC "Migration and PR plan" table). A v1 topic the
 * catalog does not declare reads `configuration-required` and requests
 * `unavailable`. Reads map `NOTIFICATIONS_CONFIGURATION_REQUIRED` to
 * `configuration-required` and rethrow other failures; requests run with
 * `gesture: true`, as v1 callers ask from a player action, and any thrown error
 * answers `unavailable`.
 */
export function toNotificationSubscriptionAdapter(
  runtime: Pick<NotificationRuntime, 'getPermission' | 'requestPermission'>,
  catalog: readonly Pick<NotificationTopicDefinition, 'id'>[],
): NotificationSubscriptionAdapter {
  const declares = (topic: NotificationTopic): boolean =>
    catalog.some((entry) => entry.id === topic);
  return {
    async getStatus(topic) {
      if (!declares(topic)) {
        return 'configuration-required';
      }
      try {
        const snapshot = await runtime.getPermission({ topics: [topic] });
        return toNotificationSubscriptionStatus(notificationPermissionStateOf(snapshot, topic));
      } catch (error) {
        if (error instanceof NotificationError && error.code === 'NOTIFICATIONS_CONFIGURATION_REQUIRED') {
          return 'configuration-required';
        }
        throw error;
      }
    },
    async requestSubscription(topic) {
      if (!declares(topic)) {
        return 'unavailable';
      }
      try {
        const result = await runtime.requestPermission({ topics: [topic], gesture: true });
        return toNotificationSubscriptionResult(
          Object.prototype.hasOwnProperty.call(result.outcomes, topic)
            ? result.outcomes[topic]
            : undefined,
        );
      } catch {
        return 'unavailable';
      }
    },
  };
}
