import type { tags } from 'typia';

import type { PlatformEvidenceEnvelope } from './index.js';
import type {
  NotificationCapabilities,
  NotificationChannel,
  NotificationPermissionAllowance,
  NotificationPermissionScope,
  NotificationPermissionSnapshot,
  NotificationPermissionState,
  NotificationProviderId,
  NotificationPurpose,
  NotificationRemoteContent,
  NotificationTopicId,
} from './notifications-contract.js';

/**
 * Notifications v2 pure policy (RFC "Topic catalog", "Reminders", "Server",
 * and "Advertising rules"): topic declarations and their rules, consent
 * records, deployment settings, provider registry entries, the delivery gate
 * `evaluateNotificationDelivery` with the advertising rendering, input bounds
 * and idempotency fingerprints, reminder routing and the client-evaluable
 * reminder checks, the Asia/Seoul night window and quiet hours, and the
 * consent notices. No Phaser, DOM, network, or SDK imports, and no state
 * beyond a bounded cache of `Intl` formatters: every function decides from its
 * arguments. `./notifications` re-exports it.
 */

type NonEmptyString = string & tags.MinLength<1>;
type PositiveInteger = number & tags.Type<'uint32'> & tags.Minimum<1>;
type IsoDateTime = string & tags.Format<'date-time'>;

// Topics.

export interface NotificationTopicCopy {
  readonly title: NonEmptyString;
  readonly body: NonEmptyString;
}

export interface NotificationTopicFrequency {
  /** Deliveries of the topic to one player within any 24 hours. */
  readonly maxPerDay: PositiveInteger;
}

/** A wall-clock time `HH:MM`, 00:00 to 23:59. */
export type NotificationClockTime = string & tags.Pattern<'^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'>;

/** Holds sends from `start` (inclusive) to `end` (exclusive); `start` after `end` spans midnight. */
export interface NotificationQuietHours {
  readonly start: NotificationClockTime;
  readonly end: NotificationClockTime;
}

/** One target's mapping fields, for example `templateSetCode` or approved `title` and `body`. */
export type NotificationTopicMapping = Readonly<Record<string, string | number | boolean>>;

/** A topic as the catalog declares it, independent of any target. */
export interface NotificationTopicDefinition {
  readonly id: NonEmptyString;
  readonly purpose: NotificationPurpose;
  readonly channels: readonly NotificationChannel[] & tags.MinItems<1>;
  /** The route the open leads to; it must pass `isRootRelativeNotificationRoute`. */
  readonly route: NonEmptyString;
  /** Required for `advertising`: the screen where the player withdraws advertising consent. */
  readonly optOutRoute?: NonEmptyString;
  /** Copy per locale; placeholders use `{{name}}`. */
  readonly copy?: Readonly<Record<string, NotificationTopicCopy>>;
  readonly frequency?: NotificationTopicFrequency;
  readonly quietHours?: NotificationQuietHours;
  /**
   * `false`: a send held by the night window or the topic's quiet hours is
   * suppressed instead of deferred. Default `true`.
   */
  readonly deferrable?: boolean;
}

/** A topic resolved for one provider: the definition plus that target's mapping. */
export interface NotificationTopicDeclaration extends NotificationTopicDefinition {
  readonly mapping?: NotificationTopicMapping;
}

/** Template data and routing context of a send or reminder (RFC input bounds). */
export type NotificationTemplateData = Readonly<Record<string, string | number | boolean>>;

/** A broken topic rule, for example `{ path: 'topics[2].optOutRoute', message: '…' }`. */
export interface NotificationTopicIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Whether a topic's mapping declares that the host needs no agreement for it
 * (an Apps in Toss `service` template without an agreement statement): it
 * reads `granted`, never prompts, is never recorded, and passes gate step 3.
 * A provider's answer that the recipient has not agreed is still recorded,
 * but it does not stop sends, because nothing could ask the player again:
 * the host decides each send.
 */
export function notificationTopicNeedsNoAgreement(
  topic: Pick<NotificationTopicDeclaration, 'mapping'>,
): boolean {
  return topic.mapping?.['agreement'] === 'none';
}

/**
 * Whether `route` is a root-relative path that stays on the game's origin: at
 * most 2048 characters, no surrounding whitespace, no backslash or control
 * character anywhere, and a path (before `?` or `#`) that resolves to itself
 * both as written and once percent-decoded: one leading `/` and no backslash,
 * control character, or dot segment (`.` or `..`, percent-encoded dots
 * included). A URL parser treats `\` as `/`, drops tabs and newlines, and
 * resolves dot segments, so any of them could make the path protocol-relative:
 * `/%2e//evil.example/x` resolves to `//evil.example/x`, which a client opens
 * as a link to another host. The decoded check covers a client that decodes
 * the path before routing (`/%2F%2Fevil.example`). A path that cannot be
 * decoded is refused.
 */
export function isRootRelativeNotificationRoute(route: string): boolean {
  if (
    route.length === 0
    || route.length > 2048
    || route.trim() !== route
    || route.includes('\\')
    || hasControlCharacter(route)
  ) {
    return false;
  }
  const path = route.split(/[?#]/u, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return resolvesToItself(path) && resolvesToItself(decoded);
}

/** One leading `/`, then no backslash, control character, or dot segment. */
function resolvesToItself(path: string): boolean {
  return path.startsWith('/')
    && !path.startsWith('//')
    && !path.includes('\\')
    && !hasControlCharacter(path)
    && path.split('/').every((segment) => !isDotSegment(segment));
}

/** `.` or `..`, with any dot percent-encoded, as a URL parser decodes it for dot segments. */
function isDotSegment(segment: string): boolean {
  const decoded = segment.replace(/%2e/giu, '.');
  return decoded === '.' || decoded === '..';
}

/**
 * The rules a topic definition must meet on its own (RFC "Topic catalog"):
 * a trimmed id that is not `__proto__`, channels that do not repeat, no
 * `local` channel for advertising, root-relative `route` and `optOutRoute`, an
 * `optOutRoute` for advertising, and quiet hours that do not start and end at
 * the same time. `path` prefixes each issue's path.
 */
export function notificationTopicDefinitionIssues(
  topic: NotificationTopicDefinition,
  path = 'topic',
): NotificationTopicIssue[] {
  const issues: NotificationTopicIssue[] = [];
  if (topic.id.trim() !== topic.id || hasControlCharacter(topic.id)) {
    issues.push({
      path: `${path}.id`,
      message: 'topic ids must be trimmed, without control characters',
    });
  }
  if (topic.id === '__proto__') {
    // Topic ids key plain objects (snapshots, outcomes), where this one cannot be an own key.
    issues.push({ path: `${path}.id`, message: 'the topic id __proto__ is reserved' });
  }
  if (new Set(topic.channels).size !== topic.channels.length) {
    issues.push({ path: `${path}.channels`, message: 'channels must not repeat' });
  }
  if (topic.purpose === 'advertising' && topic.channels.includes('local')) {
    issues.push({
      path: `${path}.channels`,
      message:
        'advertising topics may not use the local channel: the server could not withdraw, label, or hold a device-scheduled advertisement',
    });
  }
  if (!isRootRelativeNotificationRoute(topic.route)) {
    issues.push({ path: `${path}.route`, message: rootRelativeMessage(topic.route) });
  }
  if (topic.optOutRoute !== undefined && !isRootRelativeNotificationRoute(topic.optOutRoute)) {
    issues.push({ path: `${path}.optOutRoute`, message: rootRelativeMessage(topic.optOutRoute) });
  }
  if (topic.purpose === 'advertising' && topic.optOutRoute === undefined) {
    issues.push({
      path: `${path}.optOutRoute`,
      message:
        'advertising topics need an optOutRoute, the screen where the player withdraws advertising consent',
    });
  }
  if (topic.quietHours !== undefined && topic.quietHours.start === topic.quietHours.end) {
    issues.push({
      path: `${path}.quietHours`,
      message: 'quiet hours must not start and end at the same time',
    });
  }
  return issues;
}

function rootRelativeMessage(route: string): string {
  return `${JSON.stringify(route)} must be a root-relative path on the game's origin, such as /?entry=continue`;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

// Consent records (RFC "Runtime" and "Consent records").

export type NotificationConsentKind =
  | 'delivery-permission'
  | 'host-agreement'
  | 'topic-preference'
  | 'advertising'
  | 'night';

/** Permission states the runtime records: decided ones, never `prompt`, `unknown`, `action-required`, or `unsupported`. */
export type NotificationRecordablePermissionState = Exclude<
  NotificationPermissionState,
  'prompt' | 'unknown' | 'action-required' | 'unsupported'
>;

export type NotificationConsentState = NotificationRecordablePermissionState | 'withdrawn';

/** `provider`: a delivery provider's answer that the recipient has not agreed. */
export type NotificationConsentSource = 'client-report' | 'player' | 'provider';

/**
 * One consent record. The per-kind shapes encode the RFC rules: permission
 * kinds carry a permission state, a `delivery-permission` record comes from a
 * client report or a player revocation, a `host-agreement` record from a
 * client report or a provider answer, `host-agreement` and `topic-preference`
 * name their topic, the player-authored kinds carry `granted` or `withdrawn`,
 * and advertising and night consent carry the consent text version. The
 * backend stamps `at` with its own clock.
 */
export type NotificationConsentRecord =
  | {
      readonly kind: 'delivery-permission';
      readonly topic?: never;
      readonly state: NotificationRecordablePermissionState;
      readonly source: 'client-report' | 'player';
      readonly at: IsoDateTime;
      readonly evidence?: PlatformEvidenceEnvelope;
      readonly textVersion?: never;
    }
  | {
      readonly kind: 'host-agreement';
      readonly topic: NonEmptyString;
      readonly state: NotificationRecordablePermissionState;
      readonly source: 'client-report' | 'provider';
      readonly at: IsoDateTime;
      readonly evidence?: PlatformEvidenceEnvelope;
      readonly textVersion?: never;
    }
  | {
      readonly kind: 'topic-preference';
      readonly topic: NonEmptyString;
      readonly state: 'granted' | 'withdrawn';
      readonly source: 'player';
      readonly at: IsoDateTime;
      readonly evidence?: never;
      readonly textVersion?: never;
    }
  | {
      readonly kind: 'advertising' | 'night';
      readonly topic?: never;
      readonly state: 'granted' | 'withdrawn';
      readonly source: 'player';
      readonly at: IsoDateTime;
      readonly evidence?: never;
      /** Consent text version the player agreed to or withdrew from. */
      readonly textVersion: NonEmptyString;
    };

export const recordableNotificationPermissionStates = Object.freeze([
  'granted',
  'prompt-with-rationale',
  'denied',
  'blocked',
] as const satisfies readonly NotificationRecordablePermissionState[]);

/** Whether the runtime records this state: a decided state, never prompt, unknown, action-required, or unsupported. */
export function isRecordableNotificationPermissionState(
  state: NotificationPermissionState,
): state is NotificationRecordablePermissionState {
  return (recordableNotificationPermissionStates as readonly string[]).includes(state);
}

/** The consent kind that holds delivery permission for a permission scope. */
export function notificationPermissionConsentKind(
  scope: NotificationPermissionScope,
): 'delivery-permission' | 'host-agreement' {
  return scope === 'app' ? 'delivery-permission' : 'host-agreement';
}

/** A topic's state in a snapshot: its own entry, else the app state, else `unknown`. */
export function notificationPermissionStateOf(
  snapshot: NotificationPermissionSnapshot,
  topic: NotificationTopicId,
): NotificationPermissionState {
  return Object.prototype.hasOwnProperty.call(snapshot.topics, topic)
    ? (snapshot.topics[topic] ?? snapshot.app ?? 'unknown')
    : (snapshot.app ?? 'unknown');
}

/**
 * The latest record of `kind` for exactly `topic` in `records` (oldest first):
 * with `topic`, only records naming that topic match; without it, only
 * records without a topic (app-scope permission, advertising, night) match.
 */
export function latestNotificationConsent(
  records: readonly NotificationConsentRecord[],
  kind: NotificationConsentKind,
  topic?: NotificationTopicId,
): NotificationConsentRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record !== undefined && record.kind === kind && record.topic === topic) {
      return record;
    }
  }
  return undefined;
}

// Deployment settings (RFC "Advertising rules" and "Vector format").

/** `kr` applies the Korean advertising rules to every recipient; `none` keeps consent and the opt-out route only. */
export type NotificationAdvertisingRules = 'kr' | 'none';

/** The deployment's advertising sender, which every advertising send carries under `kr`. */
export interface NotificationAdvertisingSender {
  /** The sender's name; leave it out only when it equals the app's name. */
  readonly name?: NonEmptyString;
  /** The phone number or address the law requires. */
  readonly contact: NonEmptyString;
}

export interface NotificationDeployment {
  /**
   * Required when the catalog has an `advertising` topic: the gate refuses to
   * evaluate an advertising send without it.
   */
  readonly advertisingRules?: NotificationAdvertisingRules;
  readonly advertisingSender?: NotificationAdvertisingSender;
  /** The free-of-charge opt-out line; `무료 수신거부: 수신거부 버튼` when absent or blank. */
  readonly advertisingOptOutLine?: NonEmptyString;
  /** The catalog's `notices.topic`, which overdue consent notices are sent through under `kr`. */
  readonly noticeTopic?: NonEmptyString;
  /** IANA zone for recipients that registered none; Asia/Seoul when absent. */
  readonly timeZone?: NonEmptyString;
}

export const notificationDefaultOptOutLine = '무료 수신거부: 수신거부 버튼';
export const notificationDefaultDeploymentTimeZone = 'Asia/Seoul';

/** The deployment's advertising settings as gate step 8 reads them under `kr`. */
export interface NotificationAdvertisingSettings {
  /** The sender, trimmed, without a blank name; absent when there is no contact to send. */
  readonly sender?: NotificationAdvertisingSender;
  /** The opt-out line, trimmed; the default when it is absent or blank. */
  readonly optOutLine: string;
  /** Each field the gate cannot use as written. */
  readonly issues: readonly NotificationTopicIssue[];
}

/**
 * How gate step 8 reads the deployment under `kr`; the catalog validator
 * reports its `issues`, so both read the settings the same way. The sender's
 * contact and name and the opt-out line are trimmed. A missing sender or a
 * blank contact leaves `sender` absent, which suppresses every advertisement
 * as `advertising-sender-missing`; a blank name is left out of the sender
 * line, and a blank opt-out line gives way to the default. `path` prefixes
 * each issue's path.
 */
export function resolveNotificationAdvertisingSettings(
  deployment: NotificationDeployment | undefined,
  path = 'deployment',
): NotificationAdvertisingSettings {
  const issues: NotificationTopicIssue[] = [];
  const declared = deployment?.advertisingSender;
  const contact = deploymentText(declared?.contact);
  const name = deploymentText(declared?.name);
  const optOutLine = deploymentText(deployment?.advertisingOptOutLine);
  if (declared === undefined) {
    issues.push({
      path: `${path}.advertisingSender`,
      message: 'the Korean advertising rules need the advertising sender; without it every advertising send is suppressed',
    });
  } else if (contact === undefined) {
    issues.push({
      path: `${path}.advertisingSender.contact`,
      message: 'the advertising sender contact is blank, so every advertising send is suppressed',
    });
  }
  if (declared?.name !== undefined && name === undefined) {
    issues.push({
      path: `${path}.advertisingSender.name`,
      message: 'the advertising sender name is blank, so the sender line leaves it out; omit name only when the sender is the app',
    });
  }
  if (deployment?.advertisingOptOutLine !== undefined && optOutLine === undefined) {
    issues.push({
      path: `${path}.advertisingOptOutLine`,
      message: 'the opt-out line is blank, so advertising carries the default line; leave it out to use the default',
    });
  }
  return {
    ...(contact === undefined ? {} : { sender: name === undefined ? { contact } : { name, contact } }),
    optOutLine: optOutLine ?? notificationDefaultOptOutLine,
    issues,
  };
}

/** A deployment text trimmed, or `undefined` when it is absent or blank. */
function deploymentText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

// Provider registry (RFC "Provider registry").

/** A per-recipient or app-wide count within a rolling window. */
export interface NotificationProviderLimit {
  readonly count: PositiveInteger;
  readonly windowSeconds: PositiveInteger;
}

/**
 * A delivery provider's server-side registry entry, the gate's only
 * capability input. The runtime compares its provider's capabilities with it
 * at start.
 */
export interface NotificationDeliveryProviderEntry {
  readonly provider: NotificationProviderId;
  readonly purposes: readonly NotificationPurpose[];
  readonly addressing: 'device' | 'platform-user';
  readonly content: NotificationRemoteContent;
  readonly permission: {
    readonly scope: NotificationPermissionScope;
    readonly serverReadable: boolean;
    readonly allowance: NotificationPermissionAllowance;
  };
  /** Per-recipient limits; a window of a day or longer suppresses, a shorter one defers. */
  readonly limits?: readonly NotificationProviderLimit[];
  /** App-wide dispatch rate the scheduler keeps to. */
  readonly rate?: NotificationProviderLimit;
  /** Whether a send can carry an expiry, which advertising needs under the Korean rules. */
  readonly expiry: boolean;
  /** Whether a send can carry the advertising opt-out action. */
  readonly actions: boolean;
  /** Whether each send needs a post or comment link (Devvit). */
  readonly link: boolean;
  /** The mapping fields this provider needs in each catalog topic. */
  readonly mappingFields: readonly string[];
}

/** How the catalog validator checks one mapping field of a provider. */
export interface NotificationMappingField {
  readonly required: boolean;
  /** Longest accepted string in Unicode code points. */
  readonly maxLength?: PositiveInteger;
  /** The accepted string values, when the field is an enumeration. */
  readonly values?: readonly string[];
  /** A pattern every string value must match, such as Devvit's `t3_`/`t1_` ids. */
  readonly pattern?: string;
}

/** A registry entry with the mapping-field rules the catalog validator applies. */
export interface NotificationProviderRegistryEntry extends NotificationDeliveryProviderEntry {
  readonly mapping: Readonly<Record<string, NotificationMappingField>>;
}

/**
 * Reference registry entries for the RFC provider profiles. They are reference
 * values: a project registers its own entries under its own provider ids, and
 * the P-phase providers own the final values.
 */
export const referenceNotificationProviders: Readonly<Record<
  'fcm' | 'apps-in-toss' | 'devvit',
  NotificationProviderRegistryEntry
>> = deepFreeze({
  fcm: {
    provider: 'fcm',
    purposes: ['service', 'requested', 'advertising'],
    addressing: 'device',
    content: 'free-form',
    permission: { scope: 'app', serverReadable: false, allowance: 'persistent' },
    expiry: true,
    actions: true,
    link: false,
    mappingFields: [],
    mapping: { channelId: { required: false } },
  },
  'apps-in-toss': {
    provider: 'apps-in-toss',
    purposes: ['service', 'requested'],
    addressing: 'platform-user',
    content: 'host-template',
    permission: { scope: 'topic', serverReadable: false, allowance: 'persistent' },
    limits: [{ count: 10, windowSeconds: 60 }],
    rate: { count: 15_000, windowSeconds: 60 },
    expiry: false,
    actions: false,
    link: false,
    mappingFields: ['templateSetCode', 'agreement'],
    mapping: {
      templateSetCode: { required: true },
      agreement: { required: true, values: ['required', 'none'] },
    },
  },
  devvit: {
    provider: 'devvit',
    purposes: ['service', 'requested'],
    addressing: 'platform-user',
    content: 'free-form',
    permission: { scope: 'app', serverReadable: true, allowance: 'persistent' },
    limits: [{ count: 2, windowSeconds: 86_400 }],
    rate: { count: 25_000, windowSeconds: 86_400 },
    expiry: false,
    actions: false,
    link: true,
    mappingFields: ['title', 'body'],
    mapping: {
      title: { required: true, maxLength: 60 },
      body: { required: true, maxLength: 100 },
      link: { required: false, pattern: '^t[13]_[A-Za-z0-9]+$' },
    },
  },
});

/** Reference target names and the provider each one enables. */
export const referenceNotificationTargetProviders: Readonly<Record<
  string,
  keyof typeof referenceNotificationProviders
>> = Object.freeze({
  android: 'fcm',
  ios: 'fcm',
  ait: 'apps-in-toss',
  reddit: 'devvit',
});

/**
 * Where a client provider's capabilities disagree with the provider's registry
 * entry, or `undefined` when they agree. The runtime compares them at start,
 * and a mismatch makes the provider `configuration-required`.
 */
export function notificationRegistryMismatch(
  capabilities: NotificationCapabilities,
  entry: NotificationDeliveryProviderEntry,
): string | undefined {
  const remote = capabilities.remote;
  if (!remote.supported) {
    return 'the provider declares no remote delivery';
  }
  if (remote.addressing !== entry.addressing) {
    return `addressing ${remote.addressing} differs from the registry's ${entry.addressing}`;
  }
  if (remote.content !== entry.content) {
    return `content ${remote.content} differs from the registry's ${entry.content}`;
  }
  const purposes = [...remote.purposes].sort().join(',');
  if (purposes !== [...entry.purposes].sort().join(',')) {
    return `purposes ${purposes} differ from the registry's ${[...entry.purposes].sort().join(',')}`;
  }
  const { permission } = capabilities;
  if (
    permission.scope !== entry.permission.scope
    || permission.serverReadable !== entry.permission.serverReadable
    || permission.allowance !== entry.permission.allowance
  ) {
    return 'permission scope, server readability, or allowance differs from the registry';
  }
  return undefined;
}

// Delivery decisions (RFC "Policy gate").

export type NotificationDeliveryStatus =
  | 'delivered'
  | 'suppressed'
  | 'deferred'
  | 'unavailable'
  | 'in-flight';

export type NotificationSuppressionReason =
  | 'topic-unknown'
  | 'channel-unsupported'
  | 'purpose-unsupported'
  | 'permission-denied'
  | 'agreement-missing'
  | 'allowance-exhausted'
  | 'request-missing'
  | 'preference-off'
  | 'advertising-consent-missing'
  | 'night-consent-missing'
  | 'quiet-hours'
  | 'frequency-capped'
  | 'provider-limit'
  | 'advertising-sender-missing';

/** Why a send waits: a time window, a short provider limit, or a provider's rate-limit answer. */
export type NotificationDeferralReason =
  | 'night-window'
  | 'quiet-hours'
  | 'provider-limit'
  | 'provider-rate-limited';

export type NotificationUnavailableReason =
  | 'no-endpoint'
  | 'link-missing'
  | 'endpoint-invalid'
  | 'provider-rejected'
  | 'provider-rate-limited';

export const notificationSuppressionReasons = Object.freeze([
  'topic-unknown',
  'channel-unsupported',
  'purpose-unsupported',
  'permission-denied',
  'agreement-missing',
  'allowance-exhausted',
  'request-missing',
  'preference-off',
  'advertising-consent-missing',
  'night-consent-missing',
  'quiet-hours',
  'frequency-capped',
  'provider-limit',
  'advertising-sender-missing',
] as const satisfies readonly NotificationSuppressionReason[]);

export type NotificationDeliveryRefusal =
  | { readonly status: 'suppressed'; readonly reason: NotificationSuppressionReason }
  | {
      readonly status: 'deferred';
      readonly reason: NotificationDeferralReason;
      readonly until: IsoDateTime;
    }
  | { readonly status: 'unavailable'; readonly reason: NotificationUnavailableReason };

/**
 * The recorded result of one send. `alreadyProcessed` marks a key that had
 * already delivered; `in-flight` answers a key whose delivery a claim holds.
 */
export type NotificationDeliveryOutcome =
  | { readonly status: 'delivered'; readonly alreadyProcessed: boolean }
  | { readonly status: 'in-flight' }
  | NotificationDeliveryRefusal;

/** An action a notification carries; under `kr`, advertising carries the opt-out action. */
export interface NotificationAction {
  readonly id: NonEmptyString;
  readonly title: NonEmptyString;
  /** A root-relative route the action opens. */
  readonly route: NonEmptyString;
}

/** The advertising opt-out action under the Korean rules. */
export const notificationAdvertisingOptOutActionId = 'advertising-opt-out';

/** What a provider sends; `title` and `body` are absent when the host template carries the copy. */
export interface NotificationDeliveryContent {
  readonly title?: string;
  readonly body?: string;
  readonly route: string;
  /** Under `kr`, advertising carries the opt-out action. */
  readonly actions?: readonly NotificationAction[];
  readonly source: 'mapping' | 'host-template' | 'catalog';
}

/**
 * The gate's answer: `allowed` with the content to send and, for advertising
 * without night consent under `kr`, the expiry at the next 21:00 KST; or the
 * refusal to record.
 */
export type NotificationDeliveryDecision =
  | {
      readonly status: 'allowed';
      readonly content: NotificationDeliveryContent;
      readonly expiresAt?: IsoDateTime;
    }
  | NotificationDeliveryRefusal;

/** A send already delivered to the recipient. */
export interface NotificationDeliveryHistoryEntry {
  readonly provider: NotificationProviderId;
  readonly topic: NotificationTopicId;
  readonly at: string;
}

export interface EvaluateNotificationDeliveryInput {
  /** The provider's registry entry; the gate never reads the client's declaration. */
  readonly entry: NotificationDeliveryProviderEntry;
  readonly deployment?: NotificationDeployment;
  /** The send's topic as declared for this provider; absent when the catalog does not declare it. */
  readonly topic: NotificationTopicDeclaration | undefined;
  /**
   * Gate step 2: this recipient resolved, a valid endpoint for
   * `addressing: 'device'` or an authenticated platform identity for
   * `'platform-user'`.
   */
  readonly recipientResolved: boolean;
  /** The send's post or comment link, for providers whose entry sets `link`. */
  readonly link?: string;
  /** The recipient's consent records, oldest first. */
  readonly consent: readonly NotificationConsentRecord[];
  /** The host's answer at send time; required when the entry is server-readable. */
  readonly serverPermission?: NotificationPermissionState;
  /**
   * For `addressing: 'device'`: the permission this endpoint's latest
   * registration reported. Anything but `granted`, or none, does not deliver.
   */
  readonly endpointPermission?: NotificationPermissionState;
  /**
   * Sends delivered to the recipient, oldest first (the gate sorts a copy of
   * a history out of order, so the order never changes the answer): at least
   * those within the longest limit window and, for a per-send provider, every
   * send of the topic since the first recorded acceptance. A backend that
   * reserves acceptances atomically with the delivery claim also passes its
   * in-flight sends.
   */
  readonly history: readonly NotificationDeliveryHistoryEntry[];
  /** The time of the provider call, RFC 3339 with an offset. */
  readonly at: string;
  /** The recipient's registered zone; the deployment's zone when absent. */
  readonly timeZone?: string;
  /** The delivery's locale, else the recipient's registered locale. */
  readonly locale?: string;
  readonly defaultLocale: string;
  readonly templateData?: NotificationTemplateData;
}

/**
 * The policy gate, evaluated per recipient immediately before the provider
 * call: after any queue, and for a scheduled reminder or a deferred send when
 * it comes due (the caller looks up the idempotency key first). The steps run
 * in order and the first failure decides:
 *
 * 1. the topic is declared (`topic-unknown`), has the `remote` channel
 *    (`channel-unsupported`), and the entry delivers its purpose, advertising
 *    only as free-form content and, under `kr`, with an expiry and the opt-out
 *    action (`purpose-unsupported`);
 * 2. the recipient resolves (`unavailable: no-endpoint`), with a link where
 *    the entry needs one (`unavailable: link-missing`);
 * 3. delivery permission is positively `granted`: the send-time host answer on
 *    a server-readable provider, the endpoint's registered permission for
 *    device addressing, or a latest `delivery-permission` record of `granted`
 *    for an app-scope platform-user provider; a topic-scope provider also
 *    needs a latest `host-agreement` of `granted` unless the topic needs no
 *    agreement (then the host decides each send, after a provider's denial
 *    too), and a per-send provider an unreserved acceptance
 *    (`permission-denied`, `agreement-missing`, `allowance-exhausted`);
 * 4. the topic preference, only `topic-preference` records, the latest winning
 *    (`request-missing`, `preference-off`);
 * 5. advertising consent (`advertising-consent-missing`);
 * 6. the night window under `kr` and the topic's quiet hours in the
 *    recipient's zone (`deferred` until the holding window ends, `suppressed`
 *    for a topic that is not deferrable, or `night-consent-missing` when the
 *    windows leave no time to send);
 * 7. the topic frequency cap and the entry's limits over rolling windows
 *    (`frequency-capped`, `provider-limit`; a limit window shorter than a day
 *    defers instead);
 * 8. under `kr`, advertising needs the deployment's sender with a contact
 *    that is not blank (`advertising-sender-missing`) and is rendered with the
 *    label, the sender line, the opt-out line, and the opt-out action, the
 *    settings read by `resolveNotificationAdvertisingSettings`.
 *
 * Caller errors throw a `TypeError` instead of deciding: a missing
 * `serverPermission`, an advertising topic without the deployment's
 * `advertisingRules` (the gate fails closed rather than guess them), an
 * unknown time zone, missing copy or template data, an advertising topic
 * without `optOutRoute`, and a route or opt-out route that is not
 * root-relative.
 */
export function evaluateNotificationDelivery(
  input: EvaluateNotificationDeliveryInput,
): NotificationDeliveryDecision {
  const { entry, topic } = input;
  if (topic === undefined) {
    return { status: 'suppressed', reason: 'topic-unknown' };
  }
  if (!topic.channels.includes('remote')) {
    return { status: 'suppressed', reason: 'channel-unsupported' };
  }
  const rules = input.deployment?.advertisingRules;
  if (topic.purpose === 'advertising' && rules === undefined) {
    // The Korean rules must be chosen on purpose: a deployment that forgot them fails closed.
    throw new TypeError(
      `Advertising topic ${topic.id} needs the deployment's advertisingRules ('kr' or 'none').`,
    );
  }
  if (
    !entry.purposes.includes(topic.purpose)
    || (
      topic.purpose === 'advertising'
      && (entry.content !== 'free-form' || (rules === 'kr' && (!entry.expiry || !entry.actions)))
    )
  ) {
    return { status: 'suppressed', reason: 'purpose-unsupported' };
  }
  if (!input.recipientResolved) {
    return { status: 'unavailable', reason: 'no-endpoint' };
  }
  if (entry.link && input.link === undefined && typeof topic.mapping?.['link'] !== 'string') {
    return { status: 'unavailable', reason: 'link-missing' };
  }
  const permission = deliveryPermissionRefusal(input, topic);
  if (permission !== undefined) {
    return { status: 'suppressed', reason: permission };
  }
  const preference = topicPreferenceRefusal(topic, input.consent);
  if (preference !== undefined) {
    return { status: 'suppressed', reason: preference };
  }
  if (
    topic.purpose === 'advertising'
    && latestNotificationConsent(input.consent, 'advertising')?.state !== 'granted'
  ) {
    return { status: 'suppressed', reason: 'advertising-consent-missing' };
  }
  const timeZone = input.timeZone
    ?? input.deployment?.timeZone
    ?? notificationDefaultDeploymentTimeZone;
  const windows = resolveTimeWindows(topic, input.consent, input.at, timeZone, rules ?? 'none');
  if (windows.status === 'suppressed') {
    return { status: 'suppressed', reason: windows.reason };
  }
  if (windows.status === 'held') {
    return { status: 'deferred', reason: windows.reason, until: windows.until };
  }
  const limit = limitDecision(input, topic);
  if (limit !== undefined) {
    return limit;
  }
  const advertising = topic.purpose === 'advertising' && rules === 'kr'
    ? resolveNotificationAdvertisingSettings(input.deployment)
    : undefined;
  if (advertising !== undefined && advertising.sender === undefined) {
    return { status: 'suppressed', reason: 'advertising-sender-missing' };
  }
  const content = resolveNotificationContent({
    topic,
    content: entry.content,
    defaultLocale: input.defaultLocale,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.templateData === undefined ? {} : { templateData: input.templateData }),
  });
  if (advertising?.sender === undefined) {
    return { status: 'allowed', content };
  }
  const nightConsent = latestNotificationConsent(input.consent, 'night')?.state === 'granted';
  return {
    status: 'allowed',
    content: renderNotificationAdvertisement(
      topic,
      content,
      advertising.sender,
      advertising.optOutLine,
    ),
    ...(nightConsent ? {} : { expiresAt: nextNightWindowStart(input.at) }),
  };
}

function deliveryPermissionRefusal(
  input: EvaluateNotificationDeliveryInput,
  topic: NotificationTopicDeclaration,
): 'permission-denied' | 'agreement-missing' | 'allowance-exhausted' | undefined {
  const { entry } = input;
  if (entry.permission.serverReadable) {
    if (input.serverPermission === undefined) {
      throw new TypeError(
        `Provider ${entry.provider} is server-readable; the gate needs the host answer at send time.`,
      );
    }
    if (input.serverPermission !== 'granted') {
      return 'permission-denied';
    }
  } else if (entry.addressing === 'device') {
    if (input.endpointPermission !== 'granted') {
      return 'permission-denied';
    }
  } else if (
    entry.permission.scope === 'app'
    && latestNotificationConsent(input.consent, 'delivery-permission')?.state !== 'granted'
  ) {
    return 'permission-denied';
  }
  // A topic that needs no agreement goes on even after a provider's denial:
  // nothing could ask the player again, and the host decides each send.
  if (entry.permission.scope === 'topic' && !notificationTopicNeedsNoAgreement(topic)) {
    if (latestNotificationConsent(input.consent, 'host-agreement', topic.id)?.state !== 'granted') {
      return 'agreement-missing';
    }
  }
  if (entry.permission.allowance === 'per-send') {
    const acceptanceKind = notificationPermissionConsentKind(entry.permission.scope);
    const accepted = input.consent.filter((record) =>
      record.kind === acceptanceKind
      && record.state === 'granted'
      && (entry.permission.scope === 'app' ? record.topic === undefined : record.topic === topic.id))
      .length;
    const used = input.history.filter((sent) =>
      sent.provider === entry.provider
      && (entry.permission.scope === 'app' || sent.topic === topic.id)).length;
    if (accepted <= used) {
      return 'allowance-exhausted';
    }
  }
  return undefined;
}

/** Gate step 4: only `topic-preference` records decide, and the latest one wins. */
function topicPreferenceRefusal(
  topic: NotificationTopicDefinition,
  consent: readonly NotificationConsentRecord[],
): 'request-missing' | 'preference-off' | undefined {
  const latest = latestNotificationConsent(consent, 'topic-preference', topic.id);
  if (topic.purpose === 'requested') {
    if (latest === undefined) {
      return 'request-missing';
    }
    return latest.state === 'granted' ? undefined : 'preference-off';
  }
  return latest?.state === 'withdrawn' ? 'preference-off' : undefined;
}

type WindowHold = { readonly reason: 'night-window' | 'quiet-hours'; readonly until: string };

/** The window holding a send at `at`: the night window for advertising without night consent under `kr`, then quiet hours. */
function windowHold(
  topic: NotificationTopicDefinition,
  consent: readonly NotificationConsentRecord[],
  at: string,
  timeZone: string,
  rules: NotificationAdvertisingRules,
): WindowHold | undefined {
  if (
    rules === 'kr'
    && topic.purpose === 'advertising'
    && latestNotificationConsent(consent, 'night')?.state !== 'granted'
  ) {
    const night = checkNotificationNightWindow(at);
    if (night.inside) {
      return { reason: 'night-window', until: night.until };
    }
  }
  if (topic.quietHours !== undefined) {
    const quiet = checkNotificationQuietHours(at, topic.quietHours, timeZone);
    if (quiet.inside) {
      return { reason: 'quiet-hours', until: quiet.until };
    }
  }
  return undefined;
}

/** Window hops before the windows count as covering every hour (two windows settle in far fewer). */
const maxWindowHops = 6;

type TimeWindows =
  | { readonly status: 'clear' }
  | {
      readonly status: 'held';
      readonly reason: WindowHold['reason'];
      /** End of the window holding `at`; the scheduler replays the send then. */
      readonly until: string;
    }
  | {
      readonly status: 'suppressed';
      readonly reason: 'night-consent-missing' | 'quiet-hours';
    };

/**
 * Gate step 6. A topic that is not deferrable is suppressed by the window
 * holding it, and a send whose windows together leave no time to send (quiet
 * hours that close exactly where the night window opens and the reverse) is
 * `night-consent-missing`, so the scheduler can never defer it forever.
 */
function resolveTimeWindows(
  topic: NotificationTopicDefinition,
  consent: readonly NotificationConsentRecord[],
  at: string,
  timeZone: string,
  rules: NotificationAdvertisingRules,
): TimeWindows {
  const first = windowHold(topic, consent, at, timeZone, rules);
  if (first === undefined) {
    return { status: 'clear' };
  }
  if (topic.deferrable === false) {
    return {
      status: 'suppressed',
      reason: first.reason === 'night-window' ? 'night-consent-missing' : 'quiet-hours',
    };
  }
  // Follow each window's end until a time no window holds.
  let current = first.until;
  for (let hop = 1; hop < maxWindowHops; hop += 1) {
    const hold = windowHold(topic, consent, current, timeZone, rules);
    if (hold === undefined) {
      return { status: 'held', reason: first.reason, until: first.until };
    }
    current = hold.until;
  }
  return { status: 'suppressed', reason: 'night-consent-missing' };
}

/**
 * Gate step 7. A send at `s` counts for a send at `t` when `t − window < s ≤
 * t`. The topic's daily cap and limits of a day or longer suppress; a shorter
 * provider limit defers until the oldest counted send leaves the window.
 * `at` reads strictly even when nothing is counted. Each counted send is read
 * once, and the count walks from the newest one to the longest window.
 */
function limitDecision(
  input: EvaluateNotificationDeliveryInput,
  topic: NotificationTopicDefinition,
): NotificationDeliveryRefusal | undefined {
  const at = parseInstant(input.at);
  const limits = input.entry.limits ?? [];
  const capped = topic.frequency !== undefined;
  if (!capped && limits.length === 0) {
    return undefined;
  }
  const longest = Math.max(
    capped ? dayMs : 0,
    ...limits.map((limit) => limit.windowSeconds * 1000),
  );
  const sends = countedSends(input.history, {
    topic: capped ? topic.id : undefined,
    provider: limits.length > 0 ? input.entry.provider : undefined,
  });
  // The topic's and the provider's sends inside the longest window.
  const topicSends: number[] = [];
  const providerSends: number[] = [];
  for (let index = sends.length - 1; index >= 0; index -= 1) {
    const sent = sends[index];
    if (sent === undefined) {
      continue;
    }
    if (sent.at <= at - longest) {
      break;
    }
    if (sent.at > at) {
      continue;
    }
    if (sent.topic) {
      topicSends.push(sent.at);
    }
    if (sent.provider) {
      providerSends.push(sent.at);
    }
  }
  // Oldest first again, as the deferral below reads them.
  topicSends.reverse();
  providerSends.reverse();
  const counted = (sends: readonly number[], windowMs: number): number[] =>
    sends.filter((sentAt) => sentAt > at - windowMs);
  if (topic.frequency !== undefined) {
    const sends = counted(topicSends, dayMs);
    if (sends.length >= topic.frequency.maxPerDay) {
      return { status: 'suppressed', reason: 'frequency-capped' };
    }
  }
  // Every limit that is full: one of a day or longer suppresses, whatever the
  // order of the entry's limits; shorter ones defer until all have room.
  let until: number | undefined;
  for (const limit of limits) {
    const windowMs = limit.windowSeconds * 1000;
    const sends = counted(providerSends, windowMs);
    if (sends.length < limit.count) {
      continue;
    }
    if (windowMs >= dayMs) {
      return { status: 'suppressed', reason: 'provider-limit' };
    }
    // Room opens when enough of the oldest counted sends have left the window.
    const leaving = (sends[sends.length - limit.count] ?? sends[0] ?? at) + windowMs;
    until = until === undefined ? leaving : Math.max(until, leaving);
  }
  return until === undefined
    ? undefined
    : { status: 'deferred', reason: 'provider-limit', until: formatNotificationTimestamp(until) };
}

interface CountedSend {
  readonly at: number;
  /** Counts toward the topic's daily cap. */
  readonly topic: boolean;
  /** Counts toward the provider's limits. */
  readonly provider: boolean;
}

/**
 * The sends step 7 counts, oldest first: the topic's when it has a daily cap,
 * and the provider's when it has limits, each read once. The history comes
 * oldest first; the same pass finds one that does not, and its copy is sorted.
 */
function countedSends(
  history: readonly NotificationDeliveryHistoryEntry[],
  counted: { readonly topic: string | undefined; readonly provider: string | undefined },
): readonly CountedSend[] {
  const sends: CountedSend[] = [];
  let ordered = true;
  for (const sent of history) {
    const topic = counted.topic !== undefined && sent.topic === counted.topic;
    const provider = counted.provider !== undefined && sent.provider === counted.provider;
    if (!topic && !provider) {
      continue;
    }
    const at = parseInstant(sent.at);
    const previous = sends[sends.length - 1];
    if (previous !== undefined && at < previous.at) {
      ordered = false;
    }
    sends.push({ at, topic, provider });
  }
  // `sends` is a copy already, so it sorts in place.
  return ordered ? sends : sends.sort((left, right) => left.at - right.at);
}

/** The next start of the night window (21:00 Asia/Seoul) after `at`. */
function nextNightWindowStart(at: string): string {
  const millis = parseInstant(at);
  const wall = seoulZone.wall(millis);
  const start = parseClockTime(notificationNightWindow.start);
  const day = wall.minute < start ? wall.day : wall.day + 1;
  return formatNotificationTimestamp(
    Date.UTC(wall.year, wall.month - 1, day, 0, start) - seoulOffsetMs,
  );
}

// Content (RFC "Topic catalog" and gate step 8).

const placeholderPattern = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/gu;

/** Fills `{{name}}` placeholders from `data`; a placeholder without a value is a caller error. */
export function fillNotificationTemplate(text: string, data: NotificationTemplateData = {}): string {
  return text.replace(placeholderPattern, (_match, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(data, name) ? data[name] : undefined;
    if (value === undefined) {
      throw new TypeError(`Template data has no value for {{${name}}}.`);
    }
    return String(value);
  });
}

/**
 * The topic's copy for `locale`: that locale, then its language (`en` for
 * `en-US` or `en_US`), then `defaultLocale`, each matched without regard to
 * case as locale tags are; `undefined` when the topic has none of them.
 */
export function findNotificationCopy(
  topic: Pick<NotificationTopicDefinition, 'copy'>,
  locale: string | undefined,
  defaultLocale: string,
): NotificationTopicCopy | undefined {
  const copy = topic.copy;
  if (copy === undefined) {
    return undefined;
  }
  const keys = Object.keys(copy);
  const candidates = locale === undefined
    ? [defaultLocale]
    : [locale, locale.split(/[-_]/u, 1)[0] ?? locale, defaultLocale];
  for (const candidate of candidates) {
    const key = Object.prototype.hasOwnProperty.call(copy, candidate)
      ? candidate
      : keys.find((name) => name.toLowerCase() === candidate.toLowerCase());
    if (key !== undefined) {
      return copy[key];
    }
  }
  return undefined;
}

export interface ResolveNotificationContentInput {
  readonly topic: NotificationTopicDeclaration;
  readonly content: NotificationRemoteContent;
  /** The delivery's locale, else the recipient's registered locale. */
  readonly locale?: string;
  readonly defaultLocale: string;
  readonly templateData?: NotificationTemplateData;
}

/**
 * Content precedence (RFC "Topic catalog"): the target mapping when it
 * carries its own `title` and `body`, the host template when
 * `remote.content` is `host-template`, and otherwise the catalog copy for the
 * locale (`findNotificationCopy`). No copy, a missing template value, and a
 * route that `isRootRelativeNotificationRoute` refuses are caller errors, so
 * a catalog that skipped validation still never sends another host's link.
 */
export function resolveNotificationContent(
  input: ResolveNotificationContentInput,
): NotificationDeliveryContent {
  const { topic, templateData } = input;
  assertRootRelativeRoute(topic.id, 'route', topic.route);
  const mappedTitle = topic.mapping?.['title'];
  const mappedBody = topic.mapping?.['body'];
  if (typeof mappedTitle === 'string' && typeof mappedBody === 'string') {
    return {
      title: fillNotificationTemplate(mappedTitle, templateData),
      body: fillNotificationTemplate(mappedBody, templateData),
      route: topic.route,
      source: 'mapping',
    };
  }
  if (input.content === 'host-template') {
    return { route: topic.route, source: 'host-template' };
  }
  const copy = findNotificationCopy(topic, input.locale, input.defaultLocale);
  if (copy === undefined) {
    throw new TypeError(
      `Topic ${topic.id} has no copy for ${input.locale ?? input.defaultLocale} `
        + `or the default locale ${input.defaultLocale}.`,
    );
  }
  return {
    title: fillNotificationTemplate(copy.title, templateData),
    body: fillNotificationTemplate(copy.body, templateData),
    route: topic.route,
    source: 'catalog',
  };
}

/** The advertising label every advertising title and body starts with under `kr`. */
export const notificationAdvertisingPrefix = '(광고)';

/**
 * `(광고)`, one space, and the text without leading whitespace. Text that
 * already starts with the label keeps it once, followed by one space.
 */
export function applyNotificationAdvertisingLabel(text: string): string {
  const trimmed = text.trimStart();
  const rest = trimmed.startsWith(notificationAdvertisingPrefix)
    ? trimmed.slice(notificationAdvertisingPrefix.length).trimStart()
    : trimmed;
  return `${notificationAdvertisingPrefix} ${rest}`;
}

/**
 * Gate step 8 under `kr`: the title starts with `(광고) `; the body starts with
 * `(광고) ` and the sender line (`name contact`, or `contact` alone), then the
 * copy on the next line, then the opt-out line on the last line; and the
 * message carries the opt-out action that opens the topic's `optOutRoute`.
 * The sender and the opt-out line are read as
 * `resolveNotificationAdvertisingSettings` reads them; a blank contact is a
 * caller error.
 */
export function renderNotificationAdvertisement(
  topic: NotificationTopicDefinition,
  content: NotificationDeliveryContent,
  sender: NotificationAdvertisingSender,
  optOutLine: string = notificationDefaultOptOutLine,
): NotificationDeliveryContent {
  if (topic.optOutRoute === undefined) {
    throw new TypeError(`Advertising topic ${topic.id} declares no optOutRoute.`);
  }
  assertRootRelativeRoute(topic.id, 'optOutRoute', topic.optOutRoute);
  const settings = resolveNotificationAdvertisingSettings({
    advertisingSender: sender,
    advertisingOptOutLine: optOutLine,
  });
  if (settings.sender === undefined) {
    throw new TypeError(`Advertising topic ${topic.id} needs a sender contact that is not blank.`);
  }
  const { name, contact } = settings.sender;
  const senderLine = name === undefined ? contact : `${name} ${contact}`;
  return {
    ...content,
    ...(content.title === undefined
      ? {}
      : { title: applyNotificationAdvertisingLabel(content.title) }),
    ...(content.body === undefined
      ? {}
      : {
          body: `${notificationAdvertisingPrefix} ${senderLine}\n${content.body}\n${settings.optOutLine}`,
        }),
    actions: [
      {
        id: notificationAdvertisingOptOutActionId,
        title: '수신거부',
        route: topic.optOutRoute,
      },
    ],
  };
}

function assertRootRelativeRoute(topic: string, field: 'route' | 'optOutRoute', route: string): void {
  if (!isRootRelativeNotificationRoute(route)) {
    throw new TypeError(
      `Topic ${topic} has a ${field} that is not root-relative: ${JSON.stringify(route)}`,
    );
  }
}

// Inputs and idempotency (RFC "Reminders" input bounds and "Policy gate").

/** v1's input bounds, which v2 keeps. */
export const notificationInputBounds = Object.freeze({
  keyLength: 2048,
  entries: 128,
  stringLength: 16_384,
} as const);

/** Key prefixes the scheduler reserves; a caller's send key may not start with one. */
export const notificationReservedKeyPrefixes = Object.freeze(['reminder:', 'notice:'] as const);

/** Why `key` is not a valid send or reminder key, or `undefined`. */
export function notificationKeyIssue(key: string): string | undefined {
  if (key.length === 0 || key.length > notificationInputBounds.keyLength) {
    return `keys hold 1 to ${notificationInputBounds.keyLength} characters`;
  }
  if (hasControlCharacter(key) || /[\uD800-\uDFFF]/u.test(key)) {
    return 'keys hold no control characters or lone surrogates';
  }
  return undefined;
}

/** The reserved prefix `key` starts with, if any. */
export function notificationReservedKeyPrefix(key: string): string | undefined {
  return notificationReservedKeyPrefixes.find((prefix) => key.startsWith(prefix));
}

/**
 * Why `data` is not valid template data or routing data, or `undefined`: at
 * most 128 entries of strings, finite numbers, or booleans, each string at most
 * 16,384 characters. With `stringsOnly`, every value must be a string (routing
 * `data`).
 */
export function notificationTemplateDataIssue(
  data: unknown,
  options: { readonly stringsOnly?: boolean } = {},
): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'expected an object of entries';
  }
  const entries = Object.entries(data);
  if (entries.length > notificationInputBounds.entries) {
    return `at most ${notificationInputBounds.entries} entries`;
  }
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > notificationInputBounds.keyLength || hasControlCharacter(name)) {
      return `entry name ${JSON.stringify(name)} is not valid`;
    }
    if (typeof value === 'string') {
      if (value.length > notificationInputBounds.stringLength) {
        return `entry ${name} is longer than ${notificationInputBounds.stringLength} characters`;
      }
      continue;
    }
    if (options.stringsOnly) {
      return `entry ${name} must be a string`;
    }
    if (!(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
      return `entry ${name} must be a string, a finite number, or a boolean`;
    }
  }
  return undefined;
}

/** The request a send key is bound to (RFC "Policy gate", binding). */
export interface NotificationSendRequest {
  readonly player: string;
  readonly provider?: string;
  readonly topic: string;
  readonly templateData?: NotificationTemplateData;
  readonly data?: Readonly<Record<string, string>>;
  readonly locale?: string;
  readonly link?: string;
}

/**
 * The fingerprint a stored key is bound to: the player, provider, topic,
 * template data, routing data, locale, and link, in a canonical JSON form. The
 * resolved address is left out, so a replay after a token rotation still
 * matches.
 */
export function notificationSendFingerprint(request: NotificationSendRequest): string {
  return canonicalJson({
    player: request.player,
    provider: request.provider ?? null,
    topic: request.topic,
    templateData: request.templateData ?? null,
    data: request.data ?? null,
    locale: request.locale ?? null,
    link: request.link ?? null,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// Reminders (RFC "Reminders").

export type NotificationReminderRoute = 'local' | 'remote' | 'none';

/**
 * A reminder's answer (RFC `ReminderResult`). The local route reports the
 * gate's `permission-denied` as `permission-required`.
 */
export type NotificationReminderStatus =
  | 'scheduled'
  | 'replaced'
  | 'cancelled'
  | 'permission-required'
  | 'request-missing'
  | 'preference-off'
  | 'advertising-consent-missing'
  | 'frequency-capped'
  | 'quiet-hours'
  | 'capacity-exceeded'
  | 'action-required'
  | 'unavailable';

export interface ReminderResult {
  readonly route: NotificationReminderRoute;
  readonly status: NotificationReminderStatus;
}

/**
 * Reminder routing: local when the topic has the `local` channel, is not
 * `advertising`, and the provider supports local notifications; else remote
 * when the topic has the `remote` channel and the provider supports remote
 * delivery; else none. A reminder never takes both routes, and an advertising
 * topic never takes the local route even when a catalog that skipped
 * validation declares it.
 */
export function routeNotificationReminder(
  topic: Pick<NotificationTopicDefinition, 'channels' | 'purpose'>,
  capabilities: Pick<NotificationCapabilities, 'local' | 'remote'>,
): NotificationReminderRoute {
  if (
    topic.channels.includes('local')
    && topic.purpose !== 'advertising'
    && capabilities.local.supported
  ) {
    return 'local';
  }
  if (topic.channels.includes('remote') && capabilities.remote.supported) {
    return 'remote';
  }
  return 'none';
}

export interface EvaluateLocalNotificationReminderInput {
  readonly topic: NotificationTopicDefinition;
  /** The topic's effective permission: the host read, or the latest record when the host answers `unknown`. */
  readonly permission: NotificationPermissionState;
  /** The player's consent records, oldest first. */
  readonly consent: readonly NotificationConsentRecord[];
  readonly fireAt: string;
  /** Quiet-hours zone: the registered zone, else the deployment's zone. */
  readonly timeZone: string;
  /** The topic's other pending local reminders, for `frequency.maxPerDay`. */
  readonly pending?: readonly { readonly fireAt: string }[];
}

export type LocalNotificationReminderDecision =
  | { readonly status: 'schedule'; readonly fireAt: string }
  | {
      readonly status:
        | 'permission-required'
        | 'request-missing'
        | 'preference-off'
        | 'quiet-hours'
        | 'frequency-capped';
    };

/**
 * The gate steps a client can evaluate before scheduling a local reminder, in
 * order: delivery permission (`permission-required`), the topic preference,
 * the topic's quiet hours, and `frequency.maxPerDay` over the topic's pending
 * local reminders within any 24 hours (`frequency-capped`). As at gate step
 * 6, a `fireAt` inside the quiet hours moves to the first time outside them,
 * hopping over a window that a clock change makes end inside another, and a
 * topic with `deferrable: false` is not scheduled there (`quiet-hours`).
 * Without quiet hours `fireAt` is kept. The night window does not apply,
 * because advertising never takes the local route.
 */
export function evaluateLocalNotificationReminder(
  input: EvaluateLocalNotificationReminderInput,
): LocalNotificationReminderDecision {
  if (input.permission !== 'granted') {
    return { status: 'permission-required' };
  }
  const preference = topicPreferenceRefusal(input.topic, input.consent);
  if (preference !== undefined) {
    return { status: preference };
  }
  let fireAt = normalizeNotificationTimestamp(input.fireAt);
  const { quietHours } = input.topic;
  if (quietHours !== undefined) {
    let quiet = checkNotificationQuietHours(fireAt, quietHours, input.timeZone);
    if (quiet.inside && input.topic.deferrable === false) {
      return { status: 'quiet-hours' };
    }
    // As at gate step 6: follow each window's end until a time outside them.
    for (let hop = 1; quiet.inside; hop += 1) {
      if (hop >= maxWindowHops) {
        // No time outside the windows: the gate would never send it either.
        return { status: 'quiet-hours' };
      }
      fireAt = quiet.until;
      quiet = checkNotificationQuietHours(fireAt, quietHours, input.timeZone);
    }
  }
  const maxPerDay = input.topic.frequency?.maxPerDay;
  if (maxPerDay !== undefined && exceedsDailyCount(fireAt, input.pending ?? [], maxPerDay)) {
    return { status: 'frequency-capped' };
  }
  return { status: 'schedule', fireAt };
}

/** Whether some 24-hour window around `fireAt` would hold more than `max` reminders with it. */
function exceedsDailyCount(
  fireAt: string,
  pending: readonly { readonly fireAt: string }[],
  max: number,
): boolean {
  const at = parseInstant(fireAt);
  const times = pending.map((entry) => parseInstant(entry.fireAt));
  // Windows [start, start + 24h) that contain `at` start at `at` or at an earlier reminder.
  const starts = [at, ...times.filter((time) => time <= at && time > at - dayMs)];
  return starts.some((start) =>
    times.filter((time) => time >= start && time < start + dayMs).length + 1 > max);
}

export interface EvaluateNotificationReminderConsentInput {
  readonly entry: NotificationDeliveryProviderEntry;
  readonly topic: NotificationTopicDeclaration;
  readonly consent: readonly NotificationConsentRecord[];
  /** The host's answer for a server-readable provider. */
  readonly serverPermission?: NotificationPermissionState;
  /** For device addressing: `granted` when any of the player's endpoints reported it. */
  readonly endpointPermission?: NotificationPermissionState;
  readonly history: readonly NotificationDeliveryHistoryEntry[];
}

/**
 * Gate steps 3 to 5 at the time a server reminder is set, against the
 * backend's records or the host read: `undefined` when they pass, else the
 * reminder status to answer (`permission-required` for a permission, agreement,
 * or allowance refusal). The scheduler runs the whole gate again at send time.
 */
export function evaluateNotificationReminderConsent(
  input: EvaluateNotificationReminderConsentInput,
): 'permission-required' | 'request-missing' | 'preference-off' | 'advertising-consent-missing' | undefined {
  const gateInput: EvaluateNotificationDeliveryInput = {
    entry: input.entry,
    topic: input.topic,
    recipientResolved: true,
    consent: input.consent,
    ...(input.serverPermission === undefined ? {} : { serverPermission: input.serverPermission }),
    ...(input.endpointPermission === undefined
      ? {}
      : { endpointPermission: input.endpointPermission }),
    history: input.history,
    at: '1970-01-01T00:00:00Z',
    defaultLocale: 'und',
  };
  if (deliveryPermissionRefusal(gateInput, input.topic) !== undefined) {
    return 'permission-required';
  }
  const preference = topicPreferenceRefusal(input.topic, input.consent);
  if (preference !== undefined) {
    return preference;
  }
  if (
    input.topic.purpose === 'advertising'
    && latestNotificationConsent(input.consent, 'advertising')?.state !== 'granted'
  ) {
    return 'advertising-consent-missing';
  }
  return undefined;
}

/**
 * Idempotency key of a server reminder's send:
 * `reminder:<player>:<key>:<fireAt>`, with the player and key percent-encoded
 * (`encodeURIComponent`) so ids containing `:` cannot collide, and `fireAt` in
 * the canonical timestamp form.
 */
export function createNotificationReminderIdempotencyKey(input: {
  readonly player: string;
  readonly key: string;
  readonly fireAt: string;
}): string {
  for (const [name, value] of [
    ['player', input.player],
    ['key', input.key],
  ] as const) {
    if (value.length === 0 || /[\uD800-\uDFFF]/u.test(value)) {
      throw new TypeError(`Reminder idempotency keys need a well-formed, non-empty ${name}.`);
    }
  }
  return `reminder:${encodeURIComponent(input.player)}:${encodeURIComponent(input.key)}:`
    + normalizeNotificationTimestamp(input.fireAt);
}

// Time windows.

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

/** Korea has kept UTC+9 without daylight saving time since 1988. */
const seoulOffsetMs = 9 * hourMs;

/** The Korean advertising night window: 21:00 inclusive to 08:00 exclusive, Asia/Seoul. */
export const notificationNightWindow = Object.freeze({
  timeZone: 'Asia/Seoul',
  start: '21:00',
  end: '08:00',
} as const);

export type NotificationWindowCheck =
  | { readonly inside: false }
  | { readonly inside: true; readonly until: string };

/** Whether `at` falls in the night window, and the next 08:00 Asia/Seoul when it does. */
export function checkNotificationNightWindow(at: string): NotificationWindowCheck {
  return checkWindow(
    parseInstant(at),
    parseClockTime(notificationNightWindow.start),
    parseClockTime(notificationNightWindow.end),
    seoulZone,
  );
}

/**
 * Whether `at` falls in the quiet hours in `timeZone`, and the window's next
 * end when it does. An unknown zone throws a `TypeError`.
 */
export function checkNotificationQuietHours(
  at: string,
  quietHours: NotificationQuietHours,
  timeZone: string,
): NotificationWindowCheck {
  return checkWindow(
    parseInstant(at),
    parseClockTime(quietHours.start),
    parseClockTime(quietHours.end),
    timeZone === notificationNightWindow.timeZone ? seoulZone : intlZone(timeZone),
  );
}

/** Whether `Intl` knows `timeZone`, so quiet hours can be read in it. */
export function isValidNotificationTimeZone(timeZone: string): boolean {
  try {
    intlZone(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The Asia/Seoul calendar date of an instant, `YYYY-MM-DD`. */
export function toSeoulCalendarDate(at: string): string {
  const wall = seoulZone.wall(parseInstant(at));
  return formatCalendarDate(Date.UTC(wall.year, wall.month - 1, wall.day));
}

/**
 * ISO 8601 UTC without a `.000` millisecond part, as the vectors write
 * timestamps. The input needs a date, a time with seconds, and an offset (`Z`
 * or `±HH:MM`): a zone-less time would depend on the process's time zone.
 */
export function normalizeNotificationTimestamp(at: string): string {
  return formatNotificationTimestamp(parseInstant(at));
}

function formatNotificationTimestamp(millis: number): string {
  const iso = new Date(millis).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

const isoInstantPattern =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/u;

/**
 * An RFC 3339 instant with an explicit offset (`T` and `Z` in either case).
 * A calendar field out of range, such as 31 February or a leap second, is
 * refused rather than rolled over into the next day.
 */
function parseInstant(at: string): number {
  const millis = instantOrNaN(at);
  if (Number.isNaN(millis)) {
    throw new TypeError(`Invalid ISO-8601 timestamp (a date, a time, and an offset): ${at}`);
  }
  return millis;
}

function instantOrNaN(at: string): number {
  const match = isoInstantPattern.exec(at);
  return match === null ? Number.NaN : instantOf(match);
}

/**
 * Whether `at` is an RFC 3339 instant as every notifications timestamp must
 * be: a date that exists, `T` (not a space), a time, and an offset. Fractions
 * past milliseconds are dropped when it is read.
 */
export function isNotificationTimestamp(at: string): boolean {
  return !Number.isNaN(instantOrNaN(at));
}

// Strict time fields (RFC "Timestamps").

/** How a validated string field is read: an instant (`date-time`) or a calendar date (`date`). */
export type NotificationTimeFormat = 'date-time' | 'date';

/**
 * The `date-time` and `date` fields of a validated type, by key. A nested
 * spec applies to an object, and to each item of an array.
 */
export interface NotificationTimeFields {
  readonly [key: string]: NotificationTimeFormat | NotificationTimeFields;
}

/**
 * The check every notifications validator runs after typia's, whose formats
 * accept a day the month does not have (31 April) and a space for `T`: each
 * `date-time` field `fields` names must pass `isNotificationTimestamp`, and
 * each `date` field `isNotificationCalendarDate`. Answers the first field
 * that does not, or `undefined`.
 */
export function notificationTimeFieldIssue(
  value: unknown,
  fields: NotificationTimeFields,
  path = '',
): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = notificationTimeFieldIssue(item, fields, `${path}[${index}]`);
      if (issue !== undefined) {
        return issue;
      }
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  for (const [key, format] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const field: unknown = (value as Readonly<Record<string, unknown>>)[key];
    const at = path === '' ? key : `${path}.${key}`;
    if (typeof format !== 'string') {
      const issue = notificationTimeFieldIssue(field, format, at);
      if (issue !== undefined) {
        return issue;
      }
    } else if (
      typeof field === 'string'
      && !(format === 'date' ? isNotificationCalendarDate(field) : isNotificationTimestamp(field))
    ) {
      return format === 'date'
        ? `${at} must be a date that exists, YYYY-MM-DD; got ${JSON.stringify(field)}`
        : `${at} must be RFC 3339 with a date that exists, T, and an offset; got ${JSON.stringify(field)}`;
    }
  }
  return undefined;
}

const noticeTimeFields = { record: { at: 'date-time' }, dueBy: 'date' } as const;

/**
 * The time fields of each validated type with any, for
 * `notificationTimeFieldIssue`. A test keeps them equal to the formats in the
 * published JSON Schemas.
 */
export const notificationTimeFields = {
  LocalNotificationRequest: { fireAt: 'date-time' },
  LocalNotificationEntry: { fireAt: 'date-time' },
  NotificationBridgeListLocalResult: { pending: { fireAt: 'date-time' } },
  NotificationConsentRecord: { at: 'date-time' },
  NotificationNotice: noticeTimeFields,
  RecordNotificationNoticeInput: noticeTimeFields,
  NotificationConformanceVector: {
    context: { now: 'date-time' },
    steps: {
      at: 'date-time',
      input: { fireAt: 'date-time', ...noticeTimeFields },
      returns: { until: 'date-time', ...noticeTimeFields },
    },
    expect: {
      deliveries: { until: 'date-time' },
      providerCalls: { expiresAt: 'date-time' },
      local: { operations: { fireAt: 'date-time' }, pending: { fireAt: 'date-time' } },
      reminders: { fireAt: 'date-time' },
      notices: noticeTimeFields,
    },
  },
} as const satisfies Readonly<Record<string, NotificationTimeFields>>;

function instantOf(match: RegExpExecArray): number {
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (
    year === undefined
    || month === undefined
    || day === undefined
    || hour === undefined
    || minute === undefined
    || second === undefined
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHours > 23
    || offsetMinutes > 59
  ) {
    return Number.NaN;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number((match[7] ?? '0').slice(0, 3).padEnd(3, '0')));
  const offsetMs = (offsetHours * 60 + offsetMinutes) * minuteMs;
  return date.getTime() - (match[8] === '-' ? -offsetMs : offsetMs);
}

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function parseClockTime(value: string): number {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(value);
  if (match === null) {
    throw new TypeError(`Invalid clock time ${value}; expected HH:MM.`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatCalendarDate(utcMidnight: number): string {
  return new Date(utcMidnight).toISOString().slice(0, 10);
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** Minutes since local midnight. */
  readonly minute: number;
}

interface WallZone {
  wall(millis: number): WallTime;
  /** Every instant with this local date and minute: one, two in a repeated hour, none in a skipped one. */
  instants(year: number, month: number, day: number, minute: number): readonly number[];
  /**
   * A skipped local time moved forward by the gap's length (Temporal's
   * 'compatible' disambiguation): the time read with the offset before the gap.
   */
  shiftedInstant(year: number, month: number, day: number, minute: number): number;
}

function fixedOffsetZone(offsetMs: number): WallZone {
  return {
    wall(millis) {
      const local = new Date(millis + offsetMs);
      return {
        year: local.getUTCFullYear(),
        month: local.getUTCMonth() + 1,
        day: local.getUTCDate(),
        minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
      };
    },
    instants(year, month, day, minute) {
      return [Date.UTC(year, month - 1, day, 0, minute) - offsetMs];
    },
    shiftedInstant(year, month, day, minute) {
      return Date.UTC(year, month - 1, day, 0, minute) - offsetMs;
    },
  };
}

const seoulZone = fixedOffsetZone(seoulOffsetMs);

interface DateTimeFormatter {
  formatToParts(date: Date): readonly { readonly type: string; readonly value: string }[];
}

/** Formatters by zone, least recently used first. */
const intlFormatters = new Map<string, DateTimeFormatter>();
/** Zone names come from clients; past this many the least recently used zone goes. */
const intlFormatterLimit = 64;

/** A zone read through `Intl`, which every supported runtime ships with time zone data. */
function intlZone(timeZone: string): WallZone {
  let formatter = intlFormatters.get(timeZone);
  if (formatter !== undefined) {
    // Most recently used last.
    intlFormatters.delete(timeZone);
    intlFormatters.set(timeZone, formatter);
  } else {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      throw new TypeError(`Unknown time zone: ${timeZone}`);
    }
    if (intlFormatters.size >= intlFormatterLimit) {
      const oldest = intlFormatters.keys().next();
      if (oldest.done !== true) {
        intlFormatters.delete(oldest.value);
      }
    }
    intlFormatters.set(timeZone, formatter);
  }
  const zoneFormatter = formatter;
  const read = (millis: number): WallTime & { readonly second: number } => {
    const fields: Record<string, number> = {};
    for (const part of zoneFormatter.formatToParts(new Date(millis))) {
      fields[part.type] = Number(part.value);
    }
    const hour = (fields.hour ?? 0) % 24;
    return {
      year: fields.year ?? 1970,
      month: fields.month ?? 1,
      day: fields.day ?? 1,
      minute: hour * 60 + (fields.minute ?? 0),
      second: fields.second ?? 0,
    };
  };
  const offsetAt = (millis: number): number => {
    const wall = read(millis);
    const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, 0, wall.minute, wall.second);
    return wallAsUtc - Math.floor(millis / 1000) * 1000;
  };
  return {
    wall: read,
    instants(year, month, day, minute) {
      const wallAsUtc = Date.UTC(year, month - 1, day, 0, minute);
      // The offsets a day either side cover any change on this date.
      const offsets = new Set([
        offsetAt(wallAsUtc - dayMs),
        offsetAt(wallAsUtc),
        offsetAt(wallAsUtc + dayMs),
      ]);
      const matching = [...offsets]
        .map((offset) => wallAsUtc - offset)
        .filter((instant) => {
          const wall = read(instant);
          return wall.year === year && wall.month === month && wall.day === day
            && wall.minute === minute;
        });
      return [...new Set(matching)].sort((left, right) => left - right);
    },
    shiftedInstant(year, month, day, minute) {
      const wallAsUtc = Date.UTC(year, month - 1, day, 0, minute);
      return wallAsUtc - offsetAt(wallAsUtc - dayMs);
    },
  };
}

function checkWindow(
  millis: number,
  start: number,
  end: number,
  zone: WallZone,
): NotificationWindowCheck {
  if (start === end) {
    return { inside: false };
  }
  const wall = zone.wall(millis);
  const overnight = start > end;
  const inside = overnight
    ? wall.minute >= start || wall.minute < end
    : wall.minute >= start && wall.minute < end;
  if (!inside) {
    return { inside: false };
  }
  const endDate = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day + (overnight && wall.minute >= start ? 1 : 0)),
  );
  const year = endDate.getUTCFullYear();
  const month = endDate.getUTCMonth() + 1;
  const day = endDate.getUTCDate();
  // The earliest end after `at`: in a repeated hour the end can occur twice,
  // and the first occurrence may already be behind a send inside the window.
  const until = zone.instants(year, month, day, end).find((instant) => instant > millis)
    ?? zone.shiftedInstant(year, month, day, end);
  // A window always ends after a time inside it; the guard keeps a scheduler
  // from replaying a send at the same instant should a zone disagree.
  return {
    inside: true,
    until: formatNotificationTimestamp(until > millis ? until : millis + minuteMs),
  };
}

// Consent notices (RFC "Consent records"), under the Korean rules.

export type NotificationNoticeKind = 'consent-result' | 'reconfirmation';

export interface NotificationNotice {
  readonly kind: NotificationNoticeKind;
  /** The advertising or night record the notice reports on, with its date. */
  readonly record: {
    readonly kind: 'advertising' | 'night';
    readonly state: 'granted' | 'withdrawn';
    readonly at: IsoDateTime;
    readonly textVersion?: NonEmptyString;
  };
  /** The last Asia/Seoul calendar date the notice may be given, `YYYY-MM-DD`. */
  readonly dueBy: string & tags.Format<'date'>;
}

/**
 * What names one notice: its kind, the record it reports on (that record's
 * kind and time), and its `dueBy`. A listed notice carries these fields, and
 * `notices.recordShown` takes the listed notice as is or exactly them.
 */
export interface NotificationNoticeIdentity {
  readonly kind: NotificationNoticeKind;
  readonly record: {
    readonly kind: 'advertising' | 'night';
    /** RFC 3339 with an explicit offset; compared as an instant. */
    readonly at: IsoDateTime;
  };
  /** The notice's last Asia/Seoul calendar date, `YYYY-MM-DD`. */
  readonly dueBy: string & tags.Format<'date'>;
}

/** Whether two notices are one: the same kind, record kind, record instant, and `dueBy`. */
export function isSameNotificationNotice(
  left: NotificationNoticeIdentity,
  right: NotificationNoticeIdentity,
): boolean {
  return left.kind === right.kind
    && left.record.kind === right.record.kind
    && left.dueBy === right.dueBy
    && parseInstant(left.record.at) === parseInstant(right.record.at);
}

/**
 * The copy a notice is given in: its kind, its record's kind, and for a
 * result notice the record's state, so the text can say what the player did
 * (decree art. 62-3). A refusal is recorded as `withdrawn`, so a `withdrawn`
 * text reads for a refusal too; a re-confirmation always reports on a
 * consent. A named union keeps the JSON Schema names readable.
 */
export type NotificationNoticeVariant =
  | 'consent-result.advertising.granted'
  | 'consent-result.advertising.withdrawn'
  | 'consent-result.night.granted'
  | 'consent-result.night.withdrawn'
  | 'reconfirmation.advertising'
  | 'reconfirmation.night';

/** Every `NotificationNoticeVariant`, in this order; a test keeps the two equal. */
export const notificationNoticeVariants = Object.freeze([
  'consent-result.advertising.granted',
  'consent-result.advertising.withdrawn',
  'consent-result.night.granted',
  'consent-result.night.withdrawn',
  'reconfirmation.advertising',
  'reconfirmation.night',
] as const satisfies readonly NotificationNoticeVariant[]);

/**
 * The catalog's `notices.copy`: per locale, a title and a body for every
 * notice variant. `{{consentDate}}`, the record's Asia/Seoul date, is the
 * only placeholder the server fills.
 */
export type NotificationNoticeCopy = Readonly<
  Record<string, Readonly<Record<NotificationNoticeVariant, NotificationTopicCopy>>>
>;

/** The variant a notice is given in, from its kind, its record's kind, and the record's state. */
export function notificationNoticeVariant(notice: {
  readonly kind: NotificationNoticeKind;
  readonly record: {
    readonly kind: 'advertising' | 'night';
    readonly state: 'granted' | 'withdrawn';
  };
}): NotificationNoticeVariant {
  return notice.kind === 'reconfirmation'
    ? `reconfirmation.${notice.record.kind}`
    : `consent-result.${notice.record.kind}.${notice.record.state}`;
}

/**
 * One variant's copy per locale, shaped as a topic's `copy`, so the notice
 * topic sends it with the lookup and default-locale fallback of any topic
 * (`findNotificationCopy`). A locale without the variant, which a validated
 * catalog never has, is left out rather than found empty.
 */
export function notificationNoticeVariantCopy(
  copy: NotificationNoticeCopy,
  variant: NotificationNoticeVariant,
): Readonly<Record<string, NotificationTopicCopy>> {
  return Object.fromEntries(
    Object.entries(copy).flatMap(([locale, variants]) => {
      const text: NotificationTopicCopy | undefined = variants[variant];
      return text === undefined ? [] : [[locale, text] as const];
    }),
  );
}

/** Result notice: 14 days after the record's Asia/Seoul date, counted from the next day. */
export function notificationConsentResultDueBy(at: string): string {
  return consentResultDueByOf(parseInstant(at));
}

function consentResultDueByOf(instant: number): string {
  const wall = seoulZone.wall(instant);
  return formatCalendarDate(Date.UTC(wall.year, wall.month - 1, wall.day + 14));
}

/**
 * The `ordinal`-th re-confirmation notice of a consent: the day before the
 * Asia/Seoul date `2 × ordinal` years after the consent date. A 29 February
 * consent date counts as 28 February.
 */
export function notificationReconfirmationDueBy(at: string, ordinal = 1): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new TypeError('A re-confirmation ordinal is a whole number from 1.');
  }
  return reconfirmationDueByOf(parseInstant(at), ordinal);
}

function reconfirmationDueByOf(instant: number, ordinal: number): string {
  const wall = seoulZone.wall(instant);
  const day = wall.month === 2 && wall.day === 29 ? 28 : wall.day;
  return formatCalendarDate(Date.UTC(wall.year + 2 * ordinal, wall.month - 1, day - 1));
}

/** Days before its `dueBy` from which a re-confirmation is listed. */
export const notificationReconfirmationListDays = 60;

type NoticeRecord = Extract<NotificationConsentRecord, { readonly kind: 'advertising' | 'night' }>;

/** A notice's name as one string, with the record time as an instant in milliseconds. */
function noticeNameOf(
  kind: NotificationNoticeKind,
  recordKind: NoticeRecord['kind'],
  instant: number,
  dueBy: string,
): string {
  return JSON.stringify([kind, recordKind, instant, dueBy]);
}

/**
 * The notices a player's advertising and night records owe at `at`, ordered
 * by `dueBy` and then `kind`. A notice that `given` names is not listed:
 *
 * - a `consent-result` notice for every record;
 * - per kind whose latest record is a consent, the first re-confirmation of
 *   that consent not given yet, from `notificationReconfirmationListDays`
 *   days before its `dueBy`. Each one follows the one before it, so silence
 *   keeps the series going, a new consent restarts it, and a withdrawal ends
 *   it.
 *
 * A listed notice stays listed after its `dueBy` until it is given.
 */
export function listNotificationNotices(
  records: readonly NotificationConsentRecord[],
  given: readonly NotificationNoticeIdentity[],
  at: string,
): readonly NotificationNotice[] {
  const today = toSeoulCalendarDate(at);
  // Given notices by name, each record time parsed once.
  const givenNames = new Set(
    given.map(({ kind, record, dueBy }) =>
      noticeNameOf(kind, record.kind, parseInstant(record.at), dueBy),
    ),
  );
  // Each advertising or night record parsed once.
  const parsed = new Map<NotificationConsentRecord, {
    readonly instant: number;
    readonly record: NotificationNotice['record'];
  }>();
  const notices: NotificationNotice[] = [];
  for (const record of records) {
    if (record.kind !== 'advertising' && record.kind !== 'night') {
      continue;
    }
    const instant = parseInstant(record.at);
    const noticeRecord: NotificationNotice['record'] = {
      kind: record.kind,
      state: record.state,
      at: formatNotificationTimestamp(instant),
      textVersion: record.textVersion,
    };
    parsed.set(record, { instant, record: noticeRecord });
    const dueBy = consentResultDueByOf(instant);
    if (!givenNames.has(noticeNameOf('consent-result', record.kind, instant, dueBy))) {
      // Each notice gets its own copy, so changing one never changes another.
      notices.push({ kind: 'consent-result', record: { ...noticeRecord }, dueBy });
    }
  }
  for (const kind of ['advertising', 'night'] as const) {
    const latest = latestNotificationConsent(records, kind);
    const consent = latest === undefined ? undefined : parsed.get(latest);
    if (consent === undefined || consent.record.state !== 'granted') {
      continue;
    }
    // Each given notice has its own due date, so this ends after the last one given.
    let ordinal = 1;
    let dueBy = reconfirmationDueByOf(consent.instant, ordinal);
    while (givenNames.has(noticeNameOf('reconfirmation', kind, consent.instant, dueBy))) {
      ordinal += 1;
      dueBy = reconfirmationDueByOf(consent.instant, ordinal);
    }
    if (calendarDaysBefore(dueBy, notificationReconfirmationListDays) <= today) {
      notices.push({ kind: 'reconfirmation', record: { ...consent.record }, dueBy });
    }
  }
  return notices.sort((left, right) =>
    left.dueBy.localeCompare(right.dueBy) || left.kind.localeCompare(right.kind));
}

/** Days before `dueBy` from which the scheduler sends a notice nobody recorded. */
export const notificationNoticeLeadDays = 7;

/**
 * The first Asia/Seoul calendar date the scheduler sends an unrecorded notice:
 * `notificationNoticeLeadDays` days before `dueBy`.
 */
export function notificationNoticeSendFrom(dueBy: string): string {
  return calendarDaysBefore(dueBy, notificationNoticeLeadDays);
}

/** Whether `date` is a calendar date `YYYY-MM-DD` that exists, such as a notice's `dueBy`. */
export function isNotificationCalendarDate(date: string): boolean {
  return !Number.isNaN(calendarDateMillis(date));
}

/** UTC midnight of a `YYYY-MM-DD` date; `NaN` when it does not match or does not exist. */
function calendarDateMillis(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (match === null) {
    return Number.NaN;
  }
  const [year, month, day] = match.slice(1, 4).map(Number);
  if (
    year === undefined
    || month === undefined
    || day === undefined
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
  ) {
    return Number.NaN;
  }
  const midnight = new Date(0);
  midnight.setUTCFullYear(year, month - 1, day);
  return midnight.getTime();
}

/** The calendar date `days` days before `date`; a date that does not exist is a caller error. */
function calendarDaysBefore(date: string, days: number): string {
  const millis = calendarDateMillis(date);
  if (Number.isNaN(millis)) {
    throw new TypeError(`Invalid calendar date ${date}; expected YYYY-MM-DD.`);
  }
  return formatCalendarDate(millis - days * dayMs);
}

/**
 * Idempotency key of a scheduled notice:
 * `notice:<player>:<kind>:<record kind>:<record at>:<dueBy>`, with the player
 * percent-encoded, the record's time in the canonical form, and `dueBy` as
 * `YYYY-MM-DD`. Each notice has its own key: every re-confirmation of one
 * consent, and the notices of an advertising and a night record written at
 * one instant.
 */
export function createNotificationNoticeIdempotencyKey(
  input: NotificationNoticeIdentity & { readonly player: string },
): string {
  if (input.player.length === 0 || /[\uD800-\uDFFF]/u.test(input.player)) {
    throw new TypeError('Notice idempotency keys need a well-formed, non-empty player.');
  }
  if (
    (input.kind !== 'consent-result' && input.kind !== 'reconfirmation')
    || (input.record.kind !== 'advertising' && input.record.kind !== 'night')
    || !isNotificationCalendarDate(input.dueBy)
  ) {
    throw new TypeError(
      'Notice idempotency keys need a notice kind, an advertising or night record, and a dueBy date.',
    );
  }
  return `notice:${encodeURIComponent(input.player)}:${input.kind}:${input.record.kind}:`
    + `${normalizeNotificationTimestamp(input.record.at)}:${input.dueBy}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
