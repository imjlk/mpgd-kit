import typia, { type tags } from 'typia';

import {
  notificationTopicDefinitionIssues,
  type NotificationCapabilities,
  type NotificationChannel,
  type NotificationConsentKind,
  type NotificationConsentSource,
  type NotificationConsentState,
  type NotificationDeferralReason,
  type NotificationDeliveryStatus,
  type NotificationDeployment,
  type NotificationNoticeKind,
  type NotificationPermissionOutcome,
  type NotificationPermissionState,
  type NotificationReminderRoute,
  type NotificationReminderStatus,
  type NotificationRequiredAction,
  type NotificationSuppressionReason,
  type NotificationTopicDeclaration,
  type NotificationUnavailableReason,
} from './notifications.js';

/**
 * Conformance vector format for docs/specs/notifications/vectors/*.json (RFC
 * "Vector format"). Every expectation item is partial: only the listed fields
 * are asserted, while each list is matched exactly in length and order, and a
 * field set to `null` asserts that the field is absent.
 */

type NonEmptyString = string & tags.MinLength<1>;
type IsoTimestamp = string & tags.Format<'date-time'>;
type NonNegativeInteger = number & tags.Type<'uint32'>;
type PositiveInteger = number & tags.Type<'uint32'> & tags.Minimum<1>;
type TemplateData = Readonly<Record<string, string | number | boolean>>;
type CalendarDate = string & tags.Format<'date'>;

/** A capability path such as `permission.prompt` or `remote.purposes`. */
type CapabilityPath = string & tags.Pattern<'^[a-zA-Z]+(?:\\.[a-zA-Z]+)*$'>;

/** A predicate on the provider's capabilities; every predicate must hold for the vector to run. */
export type NotificationConformancePredicate =
  | { readonly path: CapabilityPath; readonly equals: string | number | boolean }
  | { readonly path: CapabilityPath; readonly includes: string }
  | { readonly path: CapabilityPath; readonly excludes: string };

/** Per-recipient limits of the provider's registry entry. */
export interface NotificationConformanceProfileLimits {
  /** Deliveries to one player within any 24 hours. */
  readonly perUserPerDay?: PositiveInteger;
  /** Deliveries to one player within any 60 seconds. */
  readonly perUserPerMinute?: PositiveInteger;
}

export interface NotificationConformanceProfile {
  readonly provider: NonEmptyString;
  readonly capabilities: NotificationCapabilities;
  /** Server-side limits of the provider's registry entry. */
  readonly limits?: NotificationConformanceProfileLimits;
}

export interface NotificationConformanceContextFixture {
  readonly player: NonEmptyString;
  /** The fake clock's start. */
  readonly now: IsoTimestamp;
  /** The device's zone, which the runtime registers. */
  readonly timeZone: NonEmptyString;
}

export interface NotificationConformanceHostFixture {
  /**
   * Starts the fixture provider in `availability: 'action-required'` with
   * `requiredAction: 'login'` (a logged-out Devvit player) until `completeAction`.
   */
  readonly actionRequired?: boolean;
}

export type NotificationConformancePromptResult =
  | 'granted'
  | 'already-granted'
  | 'denied'
  | 'dismissed'
  | 'host-terms-declined';

export type NotificationConformanceProviderAnswer =
  | 'accepted'
  | 'unregistered'
  | 'rate-limited'
  | 'rejected'
  | 'ambiguous';

/** Why a provider rejected a send: the project's setup, the recipient, or a missing agreement. */
export type NotificationConformanceRejectionReason = 'configuration' | 'recipient' | 'agreement';

export interface NotificationConformanceEndpointFixture {
  readonly kind: 'fcm-token' | 'fcm-installation';
  readonly value: NonEmptyString;
  readonly environment?: 'production' | 'sandbox';
}

/** Another installation of the same player, registered directly with the backend. */
export interface NotificationConformanceInstallationFixture {
  readonly installationId: NonEmptyString;
  readonly kind: 'fcm-token' | 'fcm-installation';
  readonly value: NonEmptyString;
  readonly permission: NotificationPermissionState;
}

export interface NotificationConformanceTapInput {
  readonly channel: NotificationChannel;
  readonly topic?: NonEmptyString;
  readonly route?: string;
  readonly data?: Readonly<Record<string, string>>;
}

export interface NotificationConformanceThrows {
  readonly code: NonEmptyString;
}

export interface NotificationConformanceDeliverInput {
  readonly topic: NonEmptyString;
  readonly idempotencyKey: NonEmptyString;
  /** Defaults to `context.player`. */
  readonly player?: NonEmptyString;
  readonly provider?: NonEmptyString;
  readonly templateData?: TemplateData;
  /** Per-send routing context; strings only. */
  readonly data?: Readonly<Record<string, string>>;
  readonly locale?: NonEmptyString;
  /** A post or comment id for providers whose sends need a link. */
  readonly link?: NonEmptyString;
}

// Step return expectations (partial).

export interface NotificationConformanceSnapshotExpectation {
  readonly app?: NotificationPermissionState;
  readonly topics?: Readonly<Record<string, NotificationPermissionState>>;
  readonly requiredAction?: NotificationRequiredAction;
}

export interface NotificationConformancePermissionExpectation
  extends NotificationConformanceSnapshotExpectation {
  readonly sources?: Readonly<Record<string, 'host' | 'record'>>;
}

export interface NotificationConformanceEvidenceExpectation {
  readonly schema?: NonEmptyString;
  readonly payload?: Readonly<Record<string, string | number | boolean>>;
}

export interface NotificationConformanceRequestExpectation {
  readonly outcomes?: Readonly<Record<string, NotificationPermissionOutcome>>;
  readonly snapshot?: NotificationConformanceSnapshotExpectation;
  readonly requiredAction?: NotificationRequiredAction;
  readonly evidence?: NotificationConformanceEvidenceExpectation;
}

export interface NotificationConformanceReminderExpectation {
  readonly route?: NotificationReminderRoute;
  readonly status?: NotificationReminderStatus;
}

export interface NotificationConformanceOutcomeExpectation {
  readonly status?: NotificationDeliveryStatus;
  readonly alreadyProcessed?: boolean;
  readonly reason?:
    | NotificationSuppressionReason
    | NotificationDeferralReason
    | NotificationUnavailableReason;
  readonly until?: IsoTimestamp;
}

export interface NotificationConformanceNoticeRecordExpectation {
  readonly kind?: 'advertising' | 'night';
  readonly state?: 'granted' | 'withdrawn';
  readonly at?: IsoTimestamp;
  readonly textVersion?: NonEmptyString;
}

export interface NotificationConformanceNoticeExpectation {
  readonly kind?: NotificationNoticeKind;
  readonly record?: NotificationConformanceNoticeRecordExpectation;
  /** Asia/Seoul calendar date `YYYY-MM-DD`. */
  readonly dueBy?: CalendarDate;
}

export type NotificationConformanceStep =
  | { readonly actor: 'runtime'; readonly action: 'start' | 'restart' }
  | { readonly actor: 'clock'; readonly action: 'set'; readonly at: IsoTimestamp }
  | { readonly actor: 'clock'; readonly action: 'advance'; readonly seconds: NonNegativeInteger }
  | {
      readonly actor: 'host';
      readonly action: 'queuePrompt';
      readonly result: NotificationConformancePromptResult;
    }
  | {
      readonly actor: 'host';
      readonly action: 'setPermission';
      readonly state: NotificationPermissionState;
    }
  | {
      readonly actor: 'host';
      readonly action: 'issueEndpoint';
      readonly endpoint: NotificationConformanceEndpointFixture;
    }
  | { readonly actor: 'host'; readonly action: 'tap'; readonly input: NotificationConformanceTapInput }
  | { readonly actor: 'host'; readonly action: 'completeAction' }
  | {
      readonly actor: 'game';
      readonly action: 'getPermission';
      readonly input: { readonly topics: readonly NonEmptyString[] };
      readonly returns?: NotificationConformancePermissionExpectation;
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'requestPermission';
      readonly input: { readonly topics: readonly NonEmptyString[]; readonly gesture: boolean };
      readonly returns?: NotificationConformanceRequestExpectation;
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'revokePermission';
      readonly input: { readonly topics: readonly NonEmptyString[] };
      readonly returns?: NotificationConformanceRequestExpectation;
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'register' | 'unregister';
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'setTopicPreference';
      readonly input: { readonly topic: NonEmptyString; readonly enabled: boolean };
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'setAdvertisingConsent';
      readonly input: {
        readonly advertising?: 'granted' | 'withdrawn';
        readonly night?: 'granted' | 'withdrawn';
        readonly textVersion: NonEmptyString;
      };
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'setReminder';
      readonly input: {
        readonly key: NonEmptyString;
        readonly topic: NonEmptyString;
        readonly fireAt: IsoTimestamp;
        readonly templateData?: TemplateData;
        readonly link?: NonEmptyString;
      };
      readonly returns?: NotificationConformanceReminderExpectation;
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'cancelReminder';
      readonly input: { readonly key: NonEmptyString };
      readonly returns?: NotificationConformanceReminderExpectation;
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'listNotices';
      readonly returns?: readonly NotificationConformanceNoticeExpectation[];
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'recordNotice';
      readonly input: { readonly kind: NotificationNoticeKind; readonly recordAt: IsoTimestamp };
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'game';
      readonly action: 'openSettings';
      readonly returns?: 'opened' | 'unavailable';
      readonly throws?: NotificationConformanceThrows;
    }
  | { readonly actor: 'game'; readonly action: 'subscribe'; readonly listener: NonEmptyString }
  | { readonly actor: 'backend'; readonly action: 'authenticate'; readonly player: NonEmptyString }
  | {
      readonly actor: 'backend';
      readonly action: 'deliver';
      readonly input: NotificationConformanceDeliverInput;
      readonly returns?: NotificationConformanceOutcomeExpectation;
      readonly throws?: NotificationConformanceThrows;
    }
  | {
      readonly actor: 'backend';
      readonly action: 'queueProviderResult';
      readonly result: NotificationConformanceProviderAnswer;
      /** With `rate-limited`: the provider's retry delay (60 seconds when absent). */
      readonly retryAfterSeconds?: PositiveInteger;
      /** With `rejected`: why the provider rejected the send. */
      readonly reason?: NotificationConformanceRejectionReason;
    }
  | {
      readonly actor: 'backend';
      readonly action: 'registerEndpoint';
      readonly input: NotificationConformanceInstallationFixture;
    }
  | { readonly actor: 'backend'; readonly action: 'revokeSession' }
  | { readonly actor: 'backend'; readonly action: 'runScheduler' };

export type NotificationConformanceActor = NotificationConformanceStep['actor'];
export type NotificationConformanceAction = NotificationConformanceStep['action'];

// Final expectations (partial items, exact lists).

export interface NotificationConformanceConsentExpectation {
  readonly kind?: NotificationConsentKind;
  readonly topic?: NonEmptyString;
  readonly state?: NotificationConsentState;
  readonly source?: NotificationConsentSource;
  readonly player?: NonEmptyString;
  readonly evidence?: NotificationConformanceEvidenceExpectation;
  readonly textVersion?: NonEmptyString;
}

export interface NotificationConformanceEndpointExpectation {
  readonly provider?: NonEmptyString;
  readonly kind?: 'fcm-token' | 'fcm-installation';
  readonly value?: NonEmptyString;
  readonly installationId?: NonEmptyString;
  readonly permission?: NotificationPermissionState;
  readonly player?: NonEmptyString;
  readonly status?: 'valid' | 'invalid';
}

export interface NotificationConformanceDeliveryExpectation
  extends NotificationConformanceOutcomeExpectation {
  readonly idempotencyKey?: NonEmptyString;
  readonly topic?: NonEmptyString;
  readonly player?: NonEmptyString;
}

export interface NotificationConformanceActionExpectation {
  readonly id?: NonEmptyString;
  readonly title?: NonEmptyString;
  readonly route?: NonEmptyString;
}

export interface NotificationConformanceContentExpectation {
  readonly title?: string;
  readonly body?: string;
  readonly route?: string;
  readonly actions?: readonly NotificationConformanceActionExpectation[];
}

export interface NotificationConformanceProviderCallExpectation {
  readonly topic?: NonEmptyString;
  /** The device address value the attempt went to. */
  readonly address?: NonEmptyString;
  readonly player?: NonEmptyString;
  readonly idempotencyKey?: NonEmptyString;
  readonly mapping?: Readonly<Record<string, string | number | boolean>>;
  /** The send's link; `null` asserts that the call carried none. */
  readonly link?: NonEmptyString | null;
  readonly content?: NotificationConformanceContentExpectation;
  /** The expiry the call carried; `null` asserts that it carried none. */
  readonly expiresAt?: IsoTimestamp | null;
}

export interface NotificationConformanceLocalOperationExpectation {
  readonly op?: 'schedule' | 'replace' | 'cancel';
  readonly key?: NonEmptyString;
  readonly topic?: NonEmptyString;
  readonly fireAt?: IsoTimestamp;
  readonly exact?: boolean;
}

export interface NotificationConformanceLocalEntryExpectation {
  readonly key?: NonEmptyString;
  readonly topic?: NonEmptyString;
  readonly fireAt?: IsoTimestamp;
}

export interface NotificationConformanceLocalExpectation {
  readonly operations?: readonly NotificationConformanceLocalOperationExpectation[];
  readonly pending?: readonly NotificationConformanceLocalEntryExpectation[];
}

export interface NotificationConformanceReminderEntryExpectation {
  readonly key?: NonEmptyString;
  readonly topic?: NonEmptyString;
  readonly fireAt?: IsoTimestamp;
  readonly player?: NonEmptyString;
}

export interface NotificationConformanceEventExpectation {
  readonly type?: 'opened' | 'received' | 'endpoint-changed' | 'permission-changed';
  readonly channel?: NotificationChannel;
  readonly source?: 'cold' | 'warm';
  readonly topic?: NonEmptyString;
  readonly route?: string;
  readonly data?: Readonly<Record<string, string>>;
  readonly referrer?: string;
}

export interface NotificationConformanceExpectation {
  /** Calls that reached the host prompt API. */
  readonly prompts?: NonNegativeInteger;
  /** Consent records, without `at`. */
  readonly consent?: readonly NotificationConformanceConsentExpectation[];
  /** Final endpoints. */
  readonly endpoints?: readonly NotificationConformanceEndpointExpectation[];
  /** Every outcome answered or stored for a send key, in order. */
  readonly deliveries?: readonly NotificationConformanceDeliveryExpectation[];
  /** Every provider attempt, including one answered `rate-limited`. */
  readonly providerCalls?: readonly NotificationConformanceProviderCallExpectation[];
  readonly local?: NotificationConformanceLocalExpectation;
  /** Pending server reminders. */
  readonly reminders?: readonly NotificationConformanceReminderEntryExpectation[];
  /** Events per listener name. */
  readonly events?: Readonly<Record<string, readonly NotificationConformanceEventExpectation[]>>;
  /** The backend's due notices at the end, ordered by `dueBy` and then `kind`. */
  readonly notices?: readonly NotificationConformanceNoticeExpectation[];
}

export interface NotificationConformanceVector {
  /** Equals the file name without `.json`. */
  readonly vector: string & tags.Pattern<'^[a-z0-9]+(?:-[a-z0-9]+)*$'>;
  readonly protocol: NonEmptyString;
  readonly summary: NonEmptyString;
  /** The capability fields the scenario depends on; a provider runs the vector only when all hold. */
  readonly appliesTo: readonly NotificationConformancePredicate[];
  readonly profile: NotificationConformanceProfile;
  /**
   * Topic entries with this profile's mapping under `mapping`. Only the topics
   * the scenario needs; the catalog validator does not check them.
   */
  readonly catalog: readonly NotificationTopicDeclaration[];
  readonly context: NotificationConformanceContextFixture;
  readonly host?: NotificationConformanceHostFixture;
  /** Backend deployment settings; Asia/Seoul is the zone when `timeZone` is absent. */
  readonly deployment?: NotificationDeployment;
  readonly steps: readonly NotificationConformanceStep[] & tags.MinItems<1>;
  readonly expect: NotificationConformanceExpectation;
}

const assertNotificationConformanceVectorShape =
  typia.createAssertEquals<NotificationConformanceVector>();

/**
 * Validates one vector file: the shape, steps that expect either an answer or
 * an error, provider answers whose fields fit them (`retryAfterSeconds` only
 * with `rate-limited`, a `reason` exactly with `rejected`), unique catalog
 * topic ids that meet the topic definition rules, and that the vector's own
 * fixture profile satisfies its `appliesTo` predicates.
 */
export function assertNotificationConformanceVector(input: unknown): NotificationConformanceVector {
  const vector = assertNotificationConformanceVectorShape(input);
  for (const [index, step] of vector.steps.entries()) {
    const issue = stepIssue(step);
    if (issue !== undefined) {
      throw new TypeError(`Vector ${vector.vector}: steps[${index}] ${issue}`);
    }
  }
  const ids = new Set<string>();
  for (const [index, topic] of vector.catalog.entries()) {
    if (ids.has(topic.id)) {
      throw new TypeError(`Vector ${vector.vector} declares topic ${topic.id} twice.`);
    }
    ids.add(topic.id);
    const issues = notificationTopicDefinitionIssues(topic, `catalog[${index}]`);
    if (issues.length > 0) {
      throw new TypeError(
        `Vector ${vector.vector}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      );
    }
  }
  const reason = notificationConformanceAppliesToReason(
    vector.appliesTo,
    vector.profile.capabilities,
  );
  if (reason !== undefined) {
    throw new TypeError(`Vector ${vector.vector} does not fit its own profile: ${reason}`);
  }
  return vector;
}

export function isNotificationConformanceVector(
  input: unknown,
): input is NotificationConformanceVector {
  try {
    assertNotificationConformanceVector(input);
    return true;
  } catch {
    return false;
  }
}

/** The vector name a file at `path` must declare. */
export function notificationConformanceVectorNameOf(path: string): string {
  const fileName = path.split(/[\\/]/u).pop() ?? path;
  return fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : fileName;
}

/**
 * Why `capabilities` do not satisfy `appliesTo`, or `undefined` when every
 * predicate holds. A path that does not resolve to a declared value fails.
 */
export function notificationConformanceAppliesToReason(
  appliesTo: readonly NotificationConformancePredicate[],
  capabilities: NotificationCapabilities,
): string | undefined {
  for (const predicate of appliesTo) {
    const actual = readCapabilityPath(capabilities, predicate.path);
    if (actual === undefined) {
      return `appliesTo ${predicate.path} names no declared capability`;
    }
    if ('equals' in predicate) {
      if (actual !== predicate.equals) {
        return `appliesTo ${predicate.path} equals ${JSON.stringify(predicate.equals)}; `
          + `the provider declares ${JSON.stringify(actual)}`;
      }
      continue;
    }
    if (!Array.isArray(actual)) {
      return `appliesTo ${predicate.path} needs a list; the provider declares ${JSON.stringify(actual)}`;
    }
    const values = actual as readonly unknown[];
    if ('includes' in predicate && !values.includes(predicate.includes)) {
      return `appliesTo ${predicate.path} includes ${JSON.stringify(predicate.includes)}; `
        + `the provider declares ${JSON.stringify(actual)}`;
    }
    if ('excludes' in predicate && values.includes(predicate.excludes)) {
      return `appliesTo ${predicate.path} excludes ${JSON.stringify(predicate.excludes)}; `
        + `the provider declares ${JSON.stringify(actual)}`;
    }
  }
  return undefined;
}

function stepIssue(step: NotificationConformanceStep): string | undefined {
  if ('returns' in step && step.returns !== undefined && 'throws' in step && step.throws !== undefined) {
    return 'expects both an answer and an error';
  }
  if (step.actor === 'backend' && step.action === 'queueProviderResult') {
    if (step.retryAfterSeconds !== undefined && step.result !== 'rate-limited') {
      return 'sets retryAfterSeconds on a provider answer other than rate-limited';
    }
    if ((step.reason !== undefined) !== (step.result === 'rejected')) {
      return 'needs a reason exactly when the provider answer is rejected';
    }
  }
  return undefined;
}

function readCapabilityPath(capabilities: NotificationCapabilities, path: string): unknown {
  let current: unknown = capabilities;
  for (const segment of path.split('.')) {
    if (
      typeof current !== 'object'
      || current === null
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}
