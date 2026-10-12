import {
  assertNotificationConsentRecord,
  assertNotificationDeployment,
  assertRecordNotificationNoticeInput,
  createNotificationNoticeIdempotencyKey,
  createNotificationReminderIdempotencyKey,
  evaluateLocalNotificationReminder,
  evaluateNotificationDelivery,
  evaluateNotificationReminderConsent,
  findNotificationCopy,
  isNotificationTimestamp,
  isRecordableNotificationPermissionState,
  isSameNotificationNotice,
  isValidNotificationTimeZone,
  latestNotificationConsent,
  listNotificationNotices,
  normalizeNotificationTimestamp,
  notificationDefaultDeploymentTimeZone,
  NotificationError,
  notificationKeyIssue,
  notificationNoticeSendFrom,
  notificationNoticeVariant,
  notificationNoticeVariantCopy,
  notificationPermissionConsentKind,
  notificationPermissionStateOf,
  notificationRegistryMismatch,
  notificationReservedKeyPrefix,
  notificationSendFingerprint,
  notificationTemplateDataIssue,
  notificationTopicNeedsNoAgreement,
  resolveNotificationContent,
  routeNotificationReminder,
  toSeoulCalendarDate,
  type CancelNotificationReminderInput,
  type EvaluateNotificationDeliveryInput,
  type LocalNotificationEntry,
  type LocalNotificationRequest,
  type NotificationCapabilities,
  type NotificationConsentKind,
  type NotificationConsentRecord,
  type NotificationDeferralReason,
  type NotificationDeliveryContent,
  type NotificationDeliveryDecision,
  type NotificationDeliveryHistoryEntry,
  type NotificationDeliveryOutcome,
  type NotificationDeliveryProviderEntry,
  type NotificationDeliveryRefusal,
  type NotificationDeployment,
  type NotificationEndpointRegistration,
  type NotificationEvent,
  type NotificationNotice,
  type NotificationNoticeCopy,
  type NotificationNoticeIdentity,
  type NotificationNoticeVariant,
  type NotificationPermissionOutcome,
  type NotificationPermissionResult,
  type NotificationPermissionSnapshot,
  type NotificationPermissionState,
  type NotificationProvider,
  type NotificationProviderLimit,
  type NotificationRecordablePermissionState,
  type NotificationRequiredAction,
  type NotificationRuntime,
  type NotificationRuntimePermissionSnapshot,
  type NotificationTemplateData,
  type NotificationTopicDeclaration,
  type NotificationTopicMapping,
  type RecordNotificationNoticeInput,
  type ReminderResult,
  type SetNotificationReminderInput,
} from './notifications.js';
import {
  notificationConformanceAppliesToReason,
  type NotificationConformanceDeliverInput,
  type NotificationConformanceEndpointFixture,
  type NotificationConformanceExpectation,
  type NotificationConformanceHostFixture,
  type NotificationConformanceInstallationFixture,
  type NotificationConformanceProfile,
  type NotificationConformanceProfileLimits,
  type NotificationConformancePromptResult,
  type NotificationConformanceRejectionReason,
  type NotificationConformanceStep,
  type NotificationConformanceTapInput,
  type NotificationConformanceVector,
} from './notifications-vectors.js';

/**
 * Notifications v2 conformance runner (RFC "Conformance vectors") with the
 * in-memory reference pieces every vector needs: a fake clock; a fake host
 * with its fixture `NotificationProvider`; a fake backend that keeps sessions,
 * consent records, endpoints, server reminders, notices, and an idempotency
 * ledger, and applies the pure policy gate before every provider call; and the
 * reference notifications runtime the runner drives as the `game` actor. Pure
 * in-process code: no Phaser, DOM, network, or SDK imports. Nothing here sends
 * a real notification or grants anything.
 *
 * A P-phase provider runs the same vectors by supplying `createProvider`; the
 * runner reads the provider's capabilities and skips, with a reason, every
 * vector whose `appliesTo` they do not satisfy.
 */

export const notificationConformanceDefaultLocale = 'ko';

/** The evidence schema the fake host attaches to a host-rendered agreement. */
export const notificationConformanceAgreementSchema = 'fixture.host-agreement.v1';

/** The fake session's installation id. */
export const notificationConformanceInstallationId = 'installation-1';

/** Seconds a first `rate-limited` provider answer defers the send by when it names no delay. */
export const notificationConformanceRetryAfterSeconds = 60;

/** Seconds the fake ledger's claim lease lasts; an `ambiguous` answer keeps the claim this long. */
export const notificationConformanceLeaseSeconds = 300;

const secondMs = 1000;
const dayMs = 24 * 60 * 60 * secondMs;
/** A registration identical to the last acknowledged one is skipped for this long. */
const registrationRefreshMs = 7 * dayMs;
/** An endpoint not refreshed for this long counts as missing at gate step 2. */
const endpointStaleMs = 60 * dayMs;
/** A send still rate-limited this long after its first deferral ends `unavailable`. */
const rateLimitGiveUpMs = dayMs;
/** Ledger keys are kept this long after their last change. */
const keyRetentionMs = 30 * dayMs;

/** An operation the vector did not script; it fails the vector with its message. */
export class NotificationConformanceScriptError extends Error {
  override readonly name = 'NotificationConformanceScriptError';
}

/**
 * A send the gate cannot evaluate as asked, such as one without the template
 * data or copy it needs. A direct send answers `NOTIFICATIONS_INVALID_INPUT`,
 * and the scheduler drops the item after one failure; any other failure is
 * retried.
 */
class NotificationSendInputError extends Error {
  override readonly name = 'NotificationSendInputError';
}

// Clock.

export interface NotificationConformanceClock {
  /** RFC 3339 timestamp of the fake "now", in the canonical form. */
  now(): string;
  set(at: string): void;
  advance(seconds: number): void;
}

export function createNotificationConformanceClock(initial: string): NotificationConformanceClock {
  let current = normalizeNotificationTimestamp(initial);
  return {
    now: () => current,
    set(at) {
      current = normalizeNotificationTimestamp(at);
    },
    advance(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError(
          'The conformance clock only advances by a non-negative number of seconds.',
        );
      }
      current = normalizeNotificationTimestamp(
        new Date(Date.parse(current) + seconds * secondMs).toISOString(),
      );
    },
  };
}

// Host.

export interface NotificationConformanceLocalOperation {
  readonly op: 'schedule' | 'replace' | 'cancel';
  readonly key: string;
  readonly topic: string;
  readonly fireAt?: string;
  /** Local reminders are always inexact. */
  readonly exact?: boolean;
}

/** The `host` actor: what the vector scripts on the device or host side. */
export interface NotificationConformanceHostActor {
  queuePrompt(result: NotificationConformancePromptResult): void;
  setPermission(state: NotificationPermissionState): void;
  issueEndpoint(endpoint: NotificationConformanceEndpointFixture): void;
  /** The player completes the action the host waited for, such as logging in. */
  completeAction(): void;
  tap(input: NotificationConformanceTapInput): void;
  /** A process restart: provider listeners and buffered events go, host state stays. */
  restart?(): void;
  /** Calls that reached the host prompt API. */
  readonly prompts: number;
  /** Native local-notification calls, in order. */
  readonly localOperations: readonly NotificationConformanceLocalOperation[];
  /** Pending local notifications, read when the provider has no `listLocal`. */
  readonly localPending?: readonly LocalNotificationEntry[];
  /** The backend's send-time read for a `permission.serverReadable` provider (Devvit `isOptedIn`). */
  readServerPermission?(input: {
    readonly player: string;
    readonly topic: string;
  }): NotificationPermissionState | Promise<NotificationPermissionState>;
}

export interface NotificationConformanceHost extends NotificationConformanceHostActor {
  readonly provider: NotificationProvider;
  readonly localPending: readonly LocalNotificationEntry[];
  /** Every `scheduleLocal` request the provider received, in order. */
  readonly localRequests: readonly LocalNotificationRequest[];
  restart(): void;
  readServerPermission(input: {
    readonly player: string;
    readonly topic: string;
  }): NotificationPermissionState;
}

export interface CreateNotificationConformanceHostInput {
  readonly profile: NotificationConformanceProfile;
  readonly catalog: readonly NotificationTopicDeclaration[];
  readonly host?: NotificationConformanceHostFixture;
  /** The device zone a registration reports. */
  readonly timeZone?: string;
}

const eventBufferLimit = 64;
const appKey = '\u0000app';

/**
 * The fake host and its fixture provider (RFC "Vector format", fake defaults).
 *
 * - States start at `prompt` for `os` and `game` prompts, unreadable `host`
 *   prompts read `unknown`, an unsupported profile answers `unsupported`, and a
 *   topic whose mapping needs no agreement reads `granted` and never prompts. A
 *   game-rendered consent is one boolean, as Devvit's `isOptedIn`: opted in
 *   reads `granted`, otherwise `prompt`.
 * - `actionRequired` holds the provider in `availability: 'action-required'`
 *   with `requiredAction: 'login'` until `completeAction`.
 * - A prompt consumes the next `queuePrompt` result and fails the vector when
 *   none is queued. A `denied` answer reports `prompt-with-rationale` while
 *   denials remain under `permission.promptLimit`, `blocked` once they are used
 *   up, and `denied` without a limit; `dismissed` leaves the state and counts
 *   no denial; `host-terms-declined` reaches the prompt and answers
 *   `action-required` with `requiredAction: 'host-settings'`. An unreadable
 *   host still reports the state its prompt just decided.
 * - Registrations carry the device permission and zone, never an installation
 *   id; `issueEndpoint` after the provider's first subscriber emits
 *   `endpoint-changed`. Events before the first subscriber are buffered for
 *   it, and a tap is `cold` before that subscriber and `warm` after. A
 *   listener's error fails the host call that delivered the event, after every
 *   listener ran.
 */
export function createNotificationConformanceHost(
  input: CreateNotificationConformanceHostInput,
): NotificationConformanceHost {
  const { profile } = input;
  const capabilities = profile.capabilities;
  const unsupported = capabilities.availability === 'unsupported';
  const { scope, readable, promptLimit } = capabilities.permission;
  const gamePrompt = capabilities.permission.prompt === 'game';
  const initialState: NotificationPermissionState = unsupported ? 'unsupported' : 'prompt';
  const topics = new Map(input.catalog.map((topic) => [topic.id, topic]));
  let appState: NotificationPermissionState = initialState;
  let optedIn = false;
  const topicStates = new Map<string, NotificationPermissionState>();
  const denials = new Map<string, number>();
  let actionRequired = input.host?.actionRequired === true;
  const promptQueue: NotificationConformancePromptResult[] = [];
  let prompts = 0;
  let endpoint: NotificationConformanceEndpointFixture | undefined;
  const pending = new Map<string, LocalNotificationEntry>();
  const localOperations: NotificationConformanceLocalOperation[] = [];
  const localRequests: LocalNotificationRequest[] = [];
  const listeners = new Set<(event: NotificationEvent) => void>();
  let buffer: NotificationEvent[] = [];
  let subscribed = false;

  const needsNoAgreement = (topic: string): boolean => {
    const declared = topics.get(topic);
    return scope === 'topic' && declared !== undefined && notificationTopicNeedsNoAgreement(declared);
  };
  const keyOf = (topic: string): string => (scope === 'app' ? appKey : topic);
  /** The state the host holds, whether or not the game can read it. */
  const trueState = (key: string): NotificationPermissionState => {
    if (unsupported) {
      return 'unsupported';
    }
    if (gamePrompt) {
      return optedIn ? 'granted' : 'prompt';
    }
    if (key !== appKey && needsNoAgreement(key)) {
      return 'granted';
    }
    return key === appKey ? appState : (topicStates.get(key) ?? initialState);
  };
  /** What a read reports. */
  const readState = (key: string): NotificationPermissionState => {
    if (unsupported) {
      return 'unsupported';
    }
    if (actionRequired) {
      return 'action-required';
    }
    if (key !== appKey && needsNoAgreement(key)) {
      return 'granted';
    }
    return readable ? trueState(key) : 'unknown';
  };
  const snapshotOf = (
    requested: readonly string[],
    decided: ReadonlyMap<string, NotificationPermissionState> = new Map(),
  ): NotificationPermissionSnapshot => {
    const stateOf = (key: string): NotificationPermissionState => decided.get(key) ?? readState(key);
    return {
      ...(scope === 'app' ? { app: stateOf(appKey) } : {}),
      topics: Object.fromEntries(
        requested.map((topic) => [topic, scope === 'app' ? stateOf(appKey) : stateOf(topic)]),
      ),
      ...(actionRequired && !unsupported ? { requiredAction: 'login' as const } : {}),
    };
  };
  const dispatch = (event: NotificationEvent): void => {
    if (!subscribed) {
      bufferEvent(buffer, event);
      return;
    }
    throwFirst(deliverEach([...listeners], [event]));
  };
  const registrationOf = (
    address: NotificationConformanceEndpointFixture,
  ): NotificationEndpointRegistration => ({
    provider: profile.provider,
    address: {
      kind: address.kind,
      value: address.value,
      ...(address.environment === undefined ? {} : { environment: address.environment }),
      permission: readState(appKey),
    },
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
  });
  /** Applies one prompt answer to a scope key: the new state and the outcome. */
  const applyPrompt = (
    key: string,
    result: NotificationConformancePromptResult,
  ): {
    readonly state: NotificationPermissionState;
    readonly outcome: NotificationPermissionOutcome;
    readonly requiredAction?: NotificationRequiredAction;
  } => {
    const current = trueState(key);
    switch (result) {
      case 'granted':
        return { state: 'granted', outcome: 'granted' };
      case 'already-granted':
        return { state: 'granted', outcome: 'already-granted' };
      case 'dismissed':
        return { state: current, outcome: 'dismissed' };
      case 'host-terms-declined':
        return { state: current, outcome: 'action-required', requiredAction: 'host-settings' };
      case 'denied': {
        if (gamePrompt) {
          return { state: 'prompt', outcome: 'denied' };
        }
        const count = (denials.get(key) ?? 0) + 1;
        denials.set(key, count);
        if (promptLimit === undefined) {
          return { state: 'denied', outcome: 'denied' };
        }
        return {
          state: count < promptLimit ? 'prompt-with-rationale' : 'blocked',
          outcome: 'denied',
        };
      }
    }
  };
  const setTrueState = (key: string, state: NotificationPermissionState): void => {
    if (gamePrompt) {
      optedIn = state === 'granted';
    } else if (key === appKey) {
      appState = state;
    } else {
      topicStates.set(key, state);
    }
  };

  const provider: NotificationProvider = {
    provider: profile.provider,
    async getCapabilities() {
      const clone = cloneCapabilities(capabilities);
      return actionRequired && !unsupported ? { ...clone, availability: 'action-required' } : clone;
    },
    async getPermission(request) {
      return snapshotOf(request.topics);
    },
    async requestPermission(request) {
      const outcomes: Record<string, NotificationPermissionOutcome> = {};
      if (unsupported || actionRequired) {
        // Unsupported is an answer, and a required player action is a state:
        // neither reaches a prompt.
        for (const topic of request.topics) {
          outcomes[topic] = unsupported ? 'unavailable' : 'action-required';
        }
        return {
          snapshot: snapshotOf(request.topics),
          outcomes,
          ...(unsupported ? {} : { requiredAction: 'login' as const }),
        };
      }
      const askable: string[] = [];
      for (const topic of request.topics) {
        if (topics.get(topic)?.mapping === undefined) {
          outcomes[topic] = 'unavailable';
        } else if (needsNoAgreement(topic)) {
          outcomes[topic] = 'already-granted';
        } else {
          askable.push(topic);
        }
      }
      if (askable.length === 0) {
        return { snapshot: snapshotOf(request.topics), outcomes };
      }
      prompts += 1;
      const result = promptQueue.shift();
      if (result === undefined) {
        throw new NotificationConformanceScriptError(
          `Unscripted prompt for ${askable.join(', ')}: queue a host.queuePrompt result first.`,
        );
      }
      const decided = new Map<string, NotificationPermissionState>();
      let requiredAction: NotificationRequiredAction | undefined;
      let decidedAnswer = false;
      for (const key of scope === 'app' ? [appKey] : askable) {
        const applied = applyPrompt(key, result);
        setTrueState(key, applied.state);
        requiredAction = applied.requiredAction ?? requiredAction;
        decidedAnswer = isDecidedAnswer(applied.outcome);
        if (!readable && decidedAnswer) {
          // An unreadable host still tells the game the answer its prompt just gave.
          decided.set(key, applied.state);
        }
        for (const topic of key === appKey ? askable : [key]) {
          outcomes[topic] = applied.outcome;
        }
      }
      return {
        snapshot: snapshotOf(request.topics, decided),
        outcomes,
        ...(requiredAction === undefined ? {} : { requiredAction }),
        ...(capabilities.permission.prompt === 'host' && decidedAnswer
          ? {
              evidence: {
                schema: notificationConformanceAgreementSchema,
                payload: { provider: profile.provider, topics: askable.join(','), result },
              },
            }
          : {}),
      };
    },
    ...(!gamePrompt
      ? {}
      : {
          async revokePermission(request: { readonly topics: readonly string[] }) {
            optedIn = false;
            return {
              snapshot: snapshotOf(request.topics),
              outcomes: Object.fromEntries(request.topics.map((topic) => [topic, 'denied' as const])),
            };
          },
        }),
    ...(capabilities.remote.addressing === 'none'
      ? {}
      : {
          async register(): Promise<NotificationEndpointRegistration | null> {
            if (capabilities.remote.addressing === 'platform-user') {
              return {
                provider: profile.provider,
                address: { kind: 'platform-user' },
                ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
              };
            }
            return endpoint === undefined ? null : registrationOf(endpoint);
          },
        }),
    ...(!capabilities.local.supported
      ? {}
      : {
          async scheduleLocal(request: LocalNotificationRequest) {
            localRequests.push(request);
            if (actionRequired || trueState(keyOf(request.topic)) !== 'granted') {
              return { status: 'permission-required' } as const;
            }
            const entry: LocalNotificationEntry = {
              key: request.key,
              topic: request.topic,
              fireAt: normalizeNotificationTimestamp(request.fireAt),
            };
            if (pending.has(entry.key)) {
              pending.set(entry.key, entry);
              localOperations.push({ op: 'replace', ...entry, exact: false });
              return { status: 'replaced' } as const;
            }
            const maxPending = capabilities.local.maxPending;
            if (maxPending !== undefined && pending.size >= maxPending) {
              // Keep the nearest reminders: the farthest one gives way, or the new one is refused.
              const farthest = sortLocalEntries([...pending.values()]).at(-1);
              if (farthest === undefined || Date.parse(entry.fireAt) >= Date.parse(farthest.fireAt)) {
                return { status: 'capacity-exceeded' } as const;
              }
              pending.delete(farthest.key);
              localOperations.push({ op: 'cancel', key: farthest.key, topic: farthest.topic });
            }
            pending.set(entry.key, entry);
            localOperations.push({ op: 'schedule', ...entry, exact: false });
            return { status: 'scheduled' } as const;
          },
          async cancelLocal(request: { readonly keys: readonly string[] }) {
            for (const key of request.keys) {
              const entry = pending.get(key);
              if (entry !== undefined) {
                pending.delete(key);
                localOperations.push({ op: 'cancel', key, topic: entry.topic });
              }
            }
          },
          async listLocal() {
            return sortLocalEntries([...pending.values()]);
          },
        }),
    async openSettings() {
      return !unsupported && !actionRequired && capabilities.permission.settings
        ? 'opened'
        : 'unavailable';
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!subscribed) {
        subscribed = true;
        const drained = buffer;
        buffer = [];
        // Every buffered event reaches the first listener once, even if it throws on one.
        throwFirst(deliverEach([listener], drained));
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    provider,
    get prompts() {
      return prompts;
    },
    get localOperations() {
      return localOperations;
    },
    get localPending() {
      return sortLocalEntries([...pending.values()]);
    },
    get localRequests() {
      return localRequests;
    },
    queuePrompt(result) {
      promptQueue.push(result);
    },
    setPermission(state) {
      if (gamePrompt || scope === 'app') {
        setTrueState(appKey, state);
        return;
      }
      for (const topic of new Set([...topics.keys(), ...topicStates.keys()])) {
        topicStates.set(topic, state);
      }
    },
    issueEndpoint(next) {
      endpoint = next;
      // An address issued while the app runs is announced, as an FCM token refresh is.
      if (subscribed) {
        dispatch({ type: 'endpoint-changed', registration: registrationOf(next) });
      }
    },
    completeAction() {
      actionRequired = false;
    },
    tap(tap) {
      dispatch({
        type: 'opened',
        channel: tap.channel,
        source: subscribed ? 'warm' : 'cold',
        ...(tap.topic === undefined ? {} : { topic: tap.topic }),
        ...(tap.route === undefined ? {} : { route: tap.route }),
        ...(tap.data === undefined ? {} : { data: { ...tap.data } }),
      });
    },
    restart() {
      listeners.clear();
      buffer = [];
      subscribed = false;
    },
    readServerPermission(request) {
      if (actionRequired && !unsupported) {
        return 'action-required';
      }
      return trueState(keyOf(request.topic));
    },
  };
}

/**
 * Buffers an event for the first listener, keeping at most
 * `eventBufferLimit`: past it the oldest event that is not an open goes first,
 * so a cold-start open is not lost to later events.
 */
function bufferEvent(buffer: NotificationEvent[], event: NotificationEvent): void {
  buffer.push(event);
  if (buffer.length > eventBufferLimit) {
    const evicted = buffer.findIndex((buffered) => buffered.type !== 'opened');
    buffer.splice(evicted === -1 ? 0 : evicted, 1);
  }
}

function isDecidedAnswer(outcome: NotificationPermissionOutcome | undefined): boolean {
  return outcome === 'granted' || outcome === 'already-granted' || outcome === 'denied';
}

/** Calls every listener with every event, in order; returns the errors they threw. */
function deliverEach(
  listeners: readonly ((event: NotificationEvent) => void)[],
  events: readonly NotificationEvent[],
): unknown[] {
  const errors: unknown[] = [];
  for (const event of events) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  return errors;
}

function throwFirst(errors: readonly unknown[]): void {
  if (errors.length > 0) {
    throw errors[0];
  }
}

function sortLocalEntries(entries: readonly LocalNotificationEntry[]): LocalNotificationEntry[] {
  return [...entries].sort((left, right) =>
    Date.parse(left.fireAt) - Date.parse(right.fireAt) || left.key.localeCompare(right.key));
}

function cloneCapabilities(capabilities: NotificationCapabilities): NotificationCapabilities {
  return JSON.parse(JSON.stringify(capabilities)) as NotificationCapabilities;
}

// Registry entry.

/**
 * The registry entry the fake backend derives for a provider (RFC "Vector
 * format"): purposes, addressing, content, and permission fields from its
 * capabilities; `expiry` and `actions` for a free-form device provider; `link`
 * for `host-link` opens; per-recipient limits from `perUserPerDay` and
 * `perUserPerMinute`, the daily one first; and no `rate`. `undefined` for a
 * provider without remote delivery.
 */
export function notificationConformanceRegistryEntry(input: {
  readonly provider: string;
  readonly capabilities: NotificationCapabilities;
  readonly limits?: NotificationConformanceProfileLimits;
}): NotificationDeliveryProviderEntry | undefined {
  const { remote, permission } = input.capabilities;
  if (!remote.supported || remote.addressing === 'none') {
    return undefined;
  }
  const limits: NotificationProviderLimit[] = [];
  if (input.limits?.perUserPerDay !== undefined) {
    limits.push({ count: input.limits.perUserPerDay, windowSeconds: 86_400 });
  }
  if (input.limits?.perUserPerMinute !== undefined) {
    limits.push({ count: input.limits.perUserPerMinute, windowSeconds: 60 });
  }
  const freeFormDevice = remote.addressing === 'device' && remote.content === 'free-form';
  return {
    provider: input.provider,
    purposes: [...remote.purposes],
    addressing: remote.addressing,
    content: remote.content,
    permission: {
      scope: permission.scope,
      serverReadable: permission.serverReadable,
      allowance: permission.allowance,
    },
    ...(limits.length === 0 ? {} : { limits }),
    expiry: freeFormDevice,
    actions: freeFormDevice,
    link: input.capabilities.open === 'host-link',
    mappingFields: [],
  };
}

// Backend.

/** An authenticated game-services session; its installation id is the session's, never a request's. */
export interface NotificationConformanceSession {
  readonly id: string;
  readonly player: string;
  readonly installationId: string;
}

/** What setting a server reminder answers: stored, or the gate step 3 to 5 refusal. */
export type NotificationConformanceReminderSetStatus =
  | 'scheduled'
  | 'replaced'
  | 'permission-required'
  | 'request-missing'
  | 'preference-off'
  | 'advertising-consent-missing';

export type NotificationConformanceNoticeChannel = 'in-game' | 'push' | 'other';

/** The backend surface the runtime calls for the authenticated session. */
export interface NotificationConformanceBackendClient {
  /** The authenticated session; `undefined` before authentication and after the session ends. */
  session(): NotificationConformanceSession | undefined;
  /** Calls `listener` whenever a session starts; returns the unsubscribe. */
  onAuthenticated(listener: (session: NotificationConformanceSession) => void): () => void;
  /** Appends a record for the session's player; the backend stamps `at` with its own clock. */
  recordConsent(record: NotificationConsentRecord): Promise<void>;
  /** The session player's consent records, oldest first. */
  listConsent(): Promise<readonly NotificationConsentRecord[]>;
  /**
   * Binds a device registration to the session's installation and player, or
   * keeps a platform-user registration's locale and zone for the player.
   */
  registerEndpoint(registration: NotificationEndpointRegistration): Promise<void>;
  /**
   * Unbinds the session's installation from `player`, the player whose
   * session sent the unbind; an installation another player took over since
   * stays bound.
   */
  unregisterEndpoint(input: { readonly provider: string; readonly player: string }): Promise<void>;
  /** Checks gate steps 3 to 5, then stores or replaces the session player's reminder with this key. */
  setReminder(input: SetNotificationReminderInput): Promise<NotificationConformanceReminderSetStatus>;
  /** Whether a pending reminder with this key, or a waiting send of one, existed. */
  cancelReminder(input: CancelNotificationReminderInput): Promise<boolean>;
  /** The session player's listed notices; none unless the deployment applies the Korean rules. */
  listNotices(): Promise<readonly NotificationNotice[]>;
  /**
   * Records a notice given to the session's player, named by its identity
   * fields, while that notice is listed; recording one that is not listed
   * changes nothing.
   */
  recordNotice(
    input: NotificationNoticeIdentity & { readonly channel: NotificationConformanceNoticeChannel },
  ): Promise<void>;
}

export type NotificationConformanceStoredConsent = NotificationConsentRecord & {
  readonly player: string;
};

export interface NotificationConformanceEndpoint {
  readonly provider: string;
  readonly kind: 'fcm-token' | 'fcm-installation';
  readonly value: string;
  readonly environment?: 'production' | 'sandbox';
  readonly installationId: string;
  /** The device permission the latest registration reported. */
  readonly permission: NotificationPermissionState;
  readonly player: string;
  readonly status: 'valid' | 'invalid';
  readonly locale?: string;
  readonly timeZone?: string;
  readonly lastRegisteredAt: string;
  /** The session that registered the endpoint; its end unbinds it. */
  readonly session?: string;
}

/** One outcome answered or stored for a send key, in order. */
export type NotificationConformanceDelivery = NotificationDeliveryOutcome & {
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly player: string;
  readonly at: string;
};

export interface NotificationConformanceProviderCall {
  /** The ledger key: the send key, or `<key>:<installation id>` for a device endpoint. */
  readonly idempotencyKey: string;
  readonly sendKey: string;
  readonly provider: string;
  readonly topic: string;
  readonly player: string;
  /** The device address value, for device addressing. */
  readonly address?: string;
  readonly mapping?: NotificationTopicMapping;
  /** The send's link, else the mapping's. */
  readonly link?: string;
  readonly content: NotificationDeliveryContent;
  readonly expiresAt?: string;
  readonly templateData?: NotificationTemplateData;
  readonly data?: Readonly<Record<string, string>>;
  readonly at: string;
}

export interface NotificationConformanceServerReminder {
  readonly player: string;
  readonly key: string;
  readonly topic: string;
  readonly fireAt: string;
  readonly templateData?: NotificationTemplateData;
  readonly link?: string;
}

/** A notice given to a player: which notice, how, and when. */
export interface NotificationConformanceNoticeRecord extends NotificationNoticeIdentity {
  readonly player: string;
  readonly channel: NotificationConformanceNoticeChannel;
  /** When it was given. */
  readonly at: string;
}

/** A queued answer of the server-side delivery provider (RFC "Provider answers"). */
export type NotificationConformanceProviderResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'unregistered' }
  | { readonly status: 'rate-limited'; readonly retryAfterSeconds?: number }
  | { readonly status: 'rejected'; readonly reason: NotificationConformanceRejectionReason }
  | { readonly status: 'ambiguous' };

export interface NotificationConformanceBackend extends NotificationConformanceBackendClient {
  /** Starts a new session for `player` on the fake installation and tells the listeners. */
  authenticate(player: string): NotificationConformanceSession;
  /** Ends the current session; the endpoints it registered are unbound. */
  revokeSession(): void;
  /** Binds another installation of the default player (the `backend.registerEndpoint` action). */
  registerInstallation(input: NotificationConformanceInstallationFixture): void;
  /** One send through the idempotency ledger, the policy gate, and the delivery provider. */
  deliver(input: NotificationConformanceDeliverInput): Promise<NotificationDeliveryOutcome>;
  queueProviderResult(result: NotificationConformanceProviderResult): void;
  /** Processes every due server reminder, stored send, and notice, earliest first. */
  runScheduler(): Promise<void>;
  /** The provider's registry entry; `undefined` when the provider has no remote delivery. */
  readonly entry: NotificationDeliveryProviderEntry | undefined;
  readonly consent: readonly NotificationConformanceStoredConsent[];
  readonly endpoints: readonly NotificationConformanceEndpoint[];
  readonly deliveries: readonly NotificationConformanceDelivery[];
  readonly providerCalls: readonly NotificationConformanceProviderCall[];
  readonly reminders: readonly NotificationConformanceServerReminder[];
  /** Every player's listed notices, ordered by `dueBy` and then `kind`. */
  readonly notices: readonly (NotificationNotice & { readonly player: string })[];
  readonly noticesGiven: readonly NotificationConformanceNoticeRecord[];
}

export interface CreateNotificationConformanceBackendInput {
  /** The delivery provider's registry entry; `undefined` for a provider without remote delivery. */
  readonly entry: NotificationDeliveryProviderEntry | undefined;
  readonly catalog: readonly NotificationTopicDeclaration[];
  readonly clock: Pick<NotificationConformanceClock, 'now'>;
  readonly deployment?: NotificationDeployment;
  /**
   * The catalog's `notices.copy`, which consent notice pushes are given in;
   * required where the deployment's notice topic is declared under the
   * Korean rules.
   */
  readonly noticeCopy?: NotificationNoticeCopy;
  readonly defaultLocale: string;
  /** The recipient of a `deliver` without a `player`, and the owner of `registerInstallation`. */
  readonly defaultPlayer: string;
  /** The host's answer at send time; required for a server-readable provider. */
  readonly readServerPermission?: (input: {
    readonly player: string;
    readonly topic: string;
  }) => NotificationPermissionState | Promise<NotificationPermissionState>;
}

interface SendRequest {
  readonly idempotencyKey: string;
  readonly player: string;
  readonly provider?: string;
  readonly topic: string;
  readonly templateData?: NotificationTemplateData;
  readonly data?: Readonly<Record<string, string>>;
  readonly locale?: string;
  readonly link?: string;
}

type SendOrigin =
  | { readonly kind: 'send' }
  | { readonly kind: 'reminder'; readonly key: string }
  /** The notice the send gives, which names its place in the series, and its copy variant. */
  | {
      readonly kind: 'notice';
      readonly notice: NotificationNoticeIdentity;
      readonly variant: NotificationNoticeVariant;
    };

type RowState =
  | { readonly status: 'delivered' }
  | {
      readonly status: 'deferred';
      readonly reason: NotificationDeferralReason;
      readonly until: string;
    }
  | { readonly status: 'in-flight'; readonly leaseUntil: number };

/** Rate-limit backoff of one recipient, from its first `rate-limited` answer. */
interface RateLimitState {
  readonly since: number;
  readonly delaySeconds: number;
  readonly attempts: number;
}

/** One recipient's ledger delivery of a send. */
interface LedgerRow {
  readonly key: string;
  /** The endpoint's installation, for device addressing. */
  readonly installationId?: string;
  readonly state: RowState;
  readonly rateLimit?: RateLimitState;
}

type StoredOutcome = Extract<
  NotificationDeliveryOutcome,
  { readonly status: 'delivered' | 'deferred' | 'in-flight' }
>;

/** A send key's stored state: its request, its recipients' rows, and what a send with the key answers. */
interface LedgerEntry {
  readonly request: SendRequest;
  readonly fingerprint: string;
  readonly origin: SendOrigin;
  /** Whether the scheduler replays its in-flight rows after the lease; a direct caller does otherwise. */
  scheduled: boolean;
  rows: LedgerRow[];
  outcome: StoredOutcome;
  changedAt: number;
}

interface Recipient {
  readonly key: string;
  readonly installationId?: string;
  readonly endpoint?: NotificationConformanceEndpoint;
  readonly resolved: boolean;
  readonly locale?: string;
  readonly timeZone?: string;
}

/** A fresh `unavailable: no-endpoint` answer: callers may keep or change what they get. */
function noEndpoint(): NotificationDeliveryRefusal {
  return { status: 'unavailable', reason: 'no-endpoint' };
}

/**
 * The fake backend (RFC "Server").
 *
 * - Sessions: each `authenticate` starts a new session on the fake
 *   installation, and `revokeSession` ends it and unbinds the endpoints it
 *   registered. Consent records, registrations, reminders, and notices belong
 *   to the session's player. The backend stamps each record's `at` with its
 *   own clock, strictly after the player's previous record, so a record's
 *   kind and time name it, and so does each notice that reports on it. It
 *   records a notice only while that notice is listed, so a retried or early
 *   call changes nothing, and a pushed notice the game gave while the push
 *   waited is not sent again. Notices go out through the deployment's notice
 *   topic only on a target that declares it; a target that delivers
 *   advertising under the Korean rules must declare it, as the catalog
 *   validator requires.
 * - Endpoints: a device endpoint is keyed by provider and installation, keeps
 *   the latest address, permission, and `lastRegisteredAt`, and moves with the
 *   installation to a newly authenticated player. An address is unique per
 *   provider, a dead address stays dead until the installation reports a new
 *   one, and an endpoint not refreshed for 60 days counts as missing. A
 *   platform-user provider resolves the authenticated identity and keeps the
 *   player's locale and zone.
 * - Sends: a send is validated (input bounds, reserved prefixes), bound to
 *   its fingerprint (`NOTIFICATIONS_IDEMPOTENCY_CONFLICT` for another request),
 *   and answered from its key state: `delivered` with `alreadyProcessed`, the
 *   stored `deferred` result, or `in-flight`. A new key runs the gate for each
 *   recipient (every valid endpoint in installation-id order, each under
 *   `<key>:<installation id>`, or the platform identity) and calls the
 *   provider for the allowed ones. The send is `delivered` when any recipient
 *   accepted, else `in-flight`, `deferred` (the earliest), a provider's
 *   refusal, a policy refusal, and last an unresolved recipient. Only
 *   delivered, deferred, and in-flight rows are stored.
 * - Provider answers come from `queueProviderResult`, `accepted` when none is
 *   queued: `unregistered` invalidates the endpoint; `rate-limited` defers by
 *   `retryAfterSeconds` (60 when absent), then by doubling delays without
 *   jitter, never past 24 hours after the first, and then gives up;
 *   `rejected` is not stored, and with
 *   `agreement` appends a `host-agreement` record of `denied` from the
 *   provider; `ambiguous` keeps the claim for the 300-second lease.
 * - The scheduler processes due server reminders (as `reminder:` sends), due
 *   stored rows (deferred ones, and in-flight ones of scheduled sends or
 *   device endpoints after the lease, replayed through the gate without the
 *   key lookup), and, under the Korean rules, every unrecorded notice from the
 *   Asia/Seoul date seven days before it is due (as a `notice:` send of the
 *   notice topic in the notice's variant of `noticeCopy`, filled with
 *   `{{consentDate}}`, and recorded with channel `push` once delivered),
 *   earliest first and within the registry entry's `rate`. A direct caller
 *   replays its own in-flight platform send after the lease. Keys are kept for
 *   30 days after their last change.
 * - Setting or cancelling a reminder drops its sends' rows that still wait
 *   (deferred) or are in flight, so neither is replayed; a send the provider
 *   may already have accepted cannot be recalled. A send's limits count the
 *   player's other sends, never an earlier delivery of the same send to
 *   another endpoint. A send the gate cannot evaluate as asked (such as missing
 *   template data) answers `NOTIFICATIONS_INVALID_INPUT` directly and fails
 *   once when scheduled; any other failure, such as a host read that throws,
 *   is retried on the next run, and one failing item never stops the others.
 */
export function createNotificationConformanceBackend(
  input: CreateNotificationConformanceBackendInput,
): NotificationConformanceBackend {
  const { entry, clock } = input;
  const rules = input.deployment?.advertisingRules ?? 'none';
  const topicOf = (id: string): NotificationTopicDeclaration | undefined =>
    input.catalog.find((topic) => topic.id === id);
  /**
   * The topic a send is rendered from. A consent notice goes out through the
   * notice topic with its variant's `notices.copy` in place of the topic's
   * own copy, so the gate resolves the locale as for any topic. Notices are
   * sent only where `noticeCopy` is required, so it is there.
   */
  const topicFor = (
    request: SendRequest,
    origin: SendOrigin,
  ): NotificationTopicDeclaration | undefined => {
    const topic = topicOf(request.topic);
    return topic === undefined || origin.kind !== 'notice'
      ? topic
      : {
          ...topic,
          copy: notificationNoticeVariantCopy(input.noticeCopy ?? {}, origin.variant),
        };
  };
  if (input.deployment !== undefined) {
    assertNotificationDeployment(input.deployment);
  }
  const noticeTopic = input.deployment?.noticeTopic;
  // Required only where the catalog validator requires it: declared, it is a
  // remote service topic; a target that delivers advertising under the Korean
  // rules must declare it. Another target sends no notice pushes.
  const noticeTopicHere = noticeTopic === undefined ? undefined : topicOf(noticeTopic);
  if (
    noticeTopicHere !== undefined
    && (noticeTopicHere.purpose !== 'service' || !noticeTopicHere.channels.includes('remote'))
  ) {
    throw new TypeError(
      `The deployment's notice topic ${noticeTopic} is not a declared service topic.`,
    );
  }
  if (
    noticeTopic !== undefined
    && noticeTopicHere === undefined
    && rules === 'kr'
    && input.catalog.some((topic) => topic.purpose === 'advertising')
  ) {
    throw new TypeError(
      `The deployment's notice topic ${noticeTopic} is not declared for a target that delivers advertising.`,
    );
  }
  // The notice topic sends only `notices.copy`: its own copy cannot say what
  // the player did.
  if (rules === 'kr' && noticeTopicHere !== undefined && input.noticeCopy === undefined) {
    throw new TypeError(
      `The deployment's notice topic ${noticeTopicHere.id} needs the catalog's notices.copy to send notices.`,
    );
  }
  let current: NotificationConformanceSession | undefined;
  let sessionCount = 0;
  const sessionListeners = new Set<(session: NotificationConformanceSession) => void>();
  const identities = new Set<string>();
  const platformRegistrations = new Map<
    string,
    { readonly locale?: string; readonly timeZone?: string }
  >();
  const consentRows: { readonly player: string; readonly record: NotificationConsentRecord }[] = [];
  const endpoints: NotificationConformanceEndpoint[] = [];
  const deliveries: NotificationConformanceDelivery[] = [];
  const providerCalls: NotificationConformanceProviderCall[] = [];
  const reminders: NotificationConformanceServerReminder[] = [];
  const noticesGiven: NotificationConformanceNoticeRecord[] = [];
  /** Delivered sends, oldest first, with the send key each delivery belongs to. */
  const history: (NotificationDeliveryHistoryEntry & {
    readonly player: string;
    readonly sendKey: string;
  })[] = [];
  const ledger = new Map<string, LedgerEntry>();
  /** Send keys being evaluated, with their fingerprint: a concurrent send of the key answers `in-flight`. */
  const claims = new Map<string, string>();
  /** Notice sends that could not be made: they fail once, not on every run. */
  const failedNotices = new Set<string>();
  const providerResults: NotificationConformanceProviderResult[] = [];

  const now = (): number => Date.parse(clock.now());
  const requireSession = (operation: string): NotificationConformanceSession => {
    if (current === undefined) {
      throw new NotificationConformanceScriptError(
        `${operation} needs an authenticated player: script backend.authenticate first.`,
      );
    }
    return current;
  };
  const requireEntry = (operation: string): NotificationDeliveryProviderEntry => {
    if (entry === undefined) {
      throw new NotificationConformanceScriptError(
        `${operation} needs a provider with remote delivery.`,
      );
    }
    return entry;
  };
  const recordsOf = (player: string): NotificationConsentRecord[] =>
    consentRows.filter((row) => row.player === player).map((row) => row.record);
  const appendConsent = (player: string, record: NotificationConsentRecord): void => {
    // The backend's clock dates the record, strictly after the player's
    // previous one: a notice names its record by kind and time, so two records
    // of one kind written while the clock stands still keep their notices apart.
    let at = now();
    for (let index = consentRows.length - 1; index >= 0; index -= 1) {
      const row = consentRows[index];
      if (row !== undefined && row.player === player) {
        at = Math.max(at, Date.parse(row.record.at) + 1);
        break;
      }
    }
    consentRows.push({
      player,
      record: assertNotificationConsentRecord({ ...record, at: formatInstant(at) }),
    });
  };
  const noticesOf = (player: string): readonly NotificationNotice[] =>
    rules === 'kr'
      ? listNotificationNotices(
          recordsOf(player),
          noticesGiven.filter((given) => given.player === player),
          clock.now(),
        )
      : [];
  /** Whether `notice` is listed for `player` now; only a listed notice is recorded or sent. */
  const noticeListed = (player: string, notice: NotificationNoticeIdentity): boolean =>
    noticesOf(player).some((listed) => isSameNotificationNotice(listed, notice));
  const isFresh = (endpoint: NotificationConformanceEndpoint): boolean =>
    now() - Date.parse(endpoint.lastRegisteredAt) < endpointStaleMs;
  const validEndpointsOf = (player: string): NotificationConformanceEndpoint[] =>
    endpoints
      .filter((endpoint) =>
        endpoint.provider === entry?.provider
        && endpoint.player === player
        && endpoint.status === 'valid'
        && isFresh(endpoint))
      .sort((left, right) => compareText(left.installationId, right.installationId));
  const bindEndpoint = (
    next: Omit<NotificationConformanceEndpoint, 'status' | 'lastRegisteredAt'>,
  ): void => {
    // An address belongs to one installation per provider.
    for (let index = endpoints.length - 1; index >= 0; index -= 1) {
      const other = endpoints[index];
      if (
        other !== undefined
        && other.provider === next.provider
        && other.value === next.value
        && other.installationId !== next.installationId
      ) {
        endpoints.splice(index, 1);
      }
    }
    const index = endpoints.findIndex((endpoint) =>
      endpoint.provider === next.provider && endpoint.installationId === next.installationId);
    const existing = index === -1 ? undefined : endpoints[index];
    const stored: NotificationConformanceEndpoint = {
      ...next,
      // A dead address stays dead until the installation reports a new one.
      status: existing?.status === 'invalid' && existing.value === next.value ? 'invalid' : 'valid',
      lastRegisteredAt: clock.now(),
    };
    if (index === -1) {
      endpoints.push(stored);
    } else {
      endpoints[index] = stored;
    }
  };
  const invalidate = (endpoint: NotificationConformanceEndpoint | undefined): void => {
    const index = endpoint === undefined
      ? -1
      : endpoints.findIndex((candidate) =>
        candidate.provider === endpoint.provider
        && candidate.installationId === endpoint.installationId
        && candidate.value === endpoint.value);
    const stored = endpoints[index];
    if (stored !== undefined) {
      endpoints[index] = { ...stored, status: 'invalid' };
    }
  };

  // Recipients (gate step 2).

  const deviceRecipient = (
    request: SendRequest,
    endpoint: NotificationConformanceEndpoint,
  ): Recipient => ({
    key: `${request.idempotencyKey}:${encodeURIComponent(endpoint.installationId)}`,
    installationId: endpoint.installationId,
    endpoint,
    resolved: true,
    ...(endpoint.locale === undefined ? {} : { locale: endpoint.locale }),
    ...(endpoint.timeZone === undefined ? {} : { timeZone: endpoint.timeZone }),
  });
  const platformRecipient = (request: SendRequest): Recipient => {
    const registration = platformRegistrations.get(request.player);
    return {
      key: request.idempotencyKey,
      resolved: identities.has(request.player),
      ...(registration?.locale === undefined ? {} : { locale: registration.locale }),
      ...(registration?.timeZone === undefined ? {} : { timeZone: registration.timeZone }),
    };
  };
  const recipientsOf = (request: SendRequest): Recipient[] => {
    if (entry?.addressing !== 'device') {
      return [platformRecipient(request)];
    }
    const valid = validEndpointsOf(request.player);
    return valid.length === 0
      ? [{ key: request.idempotencyKey, resolved: false }]
      : valid.map((endpoint) => deviceRecipient(request, endpoint));
  };
  /** A stored row's recipient on replay: its endpoint now, unresolved once it is gone. */
  const recipientOfRow = (request: SendRequest, row: LedgerRow): Recipient => {
    if (row.installationId === undefined) {
      return platformRecipient(request);
    }
    const endpoint = validEndpointsOf(request.player)
      .find((candidate) => candidate.installationId === row.installationId);
    return endpoint === undefined
      ? { key: row.key, installationId: row.installationId, resolved: false }
      : deviceRecipient(request, endpoint);
  };

  /**
   * Delivered sends, and in-flight ones holding their reservation, oldest
   * first: the gate reads them from the newest. The send being made is left
   * out, including its earlier delivery to another endpoint.
   */
  const historyFor = (player: string, excluding?: string): NotificationDeliveryHistoryEntry[] =>
    [
      ...history.filter((sent) => sent.player === player && sent.sendKey !== excluding),
      ...[...ledger]
        .filter(([key, held]) =>
          key !== excluding && held.request.player === player && held.outcome.status === 'in-flight')
        .map(([, held]) => ({
          provider: entry?.provider ?? '',
          topic: held.request.topic,
          at: formatInstant(held.changedAt),
        })),
    ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const readServerPermission = async (
    request: SendRequest,
  ): Promise<NotificationPermissionState | undefined> => {
    if (entry?.permission.serverReadable !== true) {
      return undefined;
    }
    if (input.readServerPermission === undefined) {
      throw new NotificationConformanceScriptError(
        `Provider ${entry.provider} is server-readable but the harness has no readServerPermission.`,
      );
    }
    try {
      return await input.readServerPermission({ player: request.player, topic: request.topic });
    } catch (error) {
      // A host that cannot answer now is retried, whatever the error's class.
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `The host could not answer the send-time permission read for ${request.player}.`,
        cause: error,
      });
    }
  };
  /**
   * The first `rate-limited` answer defers by `retryAfterSeconds` (60 when
   * absent or not positive); later ones double that delay, without jitter so vectors stay
   * deterministic. No deferral runs past 24 hours after the first, and an
   * answer at or after that point gives the send up.
   */
  const nextRateLimit = (
    prior: RateLimitState | undefined,
    retryAfterSeconds: number | undefined,
  ): { readonly until: string; readonly state: RateLimitState } | undefined => {
    const at = now();
    const since = prior?.since ?? at;
    const deadline = since + rateLimitGiveUpMs;
    if (at >= deadline) {
      return undefined;
    }
    const delaySeconds = prior?.delaySeconds
      ?? (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds
        : notificationConformanceRetryAfterSeconds);
    const attempts = prior?.attempts ?? 0;
    return {
      until: formatInstant(Math.min(at + delaySeconds * 2 ** attempts * secondMs, deadline)),
      state: { since, delaySeconds, attempts: attempts + 1 },
    };
  };

  /**
   * The gate and the provider for each recipient. Every decision is made
   * before the first provider call, so a caller error throws before any state
   * changes, and nothing here waits, so it sees one consistent state.
   */
  const processRecipients = (
    request: SendRequest,
    origin: SendOrigin,
    recipients: readonly Recipient[],
    serverPermission: NotificationPermissionState | undefined,
    previous: ReadonlyMap<string, LedgerRow>,
  ): { readonly rows: LedgerRow[]; readonly refusals: NotificationDeliveryRefusal[] } => {
    const provider = requireEntry('A send');
    const topic = topicFor(request, origin);
    const at = clock.now();
    const consent = recordsOf(request.player);
    const sent = historyFor(request.player, request.idempotencyKey);
    const evaluated = recipients.map((recipient) => {
      const locale = request.locale ?? recipient.locale;
      const decision = decide({
        entry: provider,
        ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
        topic,
        recipientResolved: recipient.resolved,
        ...(request.link === undefined ? {} : { link: request.link }),
        consent,
        ...(serverPermission === undefined ? {} : { serverPermission }),
        ...(recipient.endpoint === undefined
          ? {}
          : { endpointPermission: recipient.endpoint.permission }),
        history: sent,
        at,
        ...(recipient.timeZone === undefined ? {} : { timeZone: recipient.timeZone }),
        ...(locale === undefined ? {} : { locale }),
        defaultLocale: input.defaultLocale,
        ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
      });
      return { recipient, decision };
    });
    // The gate allows only a declared topic, so an allowed send reads its mapping.
    const mapping = topic?.mapping;
    const mappedLink = mapping?.['link'];
    const link = request.link ?? (typeof mappedLink === 'string' ? mappedLink : undefined);
    const rows: LedgerRow[] = [];
    const refusals: NotificationDeliveryRefusal[] = [];
    for (const { recipient, decision } of evaluated) {
      const prior = previous.get(recipient.key);
      const row = {
        key: recipient.key,
        ...(recipient.installationId === undefined ? {} : { installationId: recipient.installationId }),
      };
      const backoff = prior?.rateLimit === undefined ? {} : { rateLimit: prior.rateLimit };
      if (decision.status === 'deferred') {
        rows.push({
          ...row,
          ...backoff,
          state: { status: 'deferred', reason: decision.reason, until: decision.until },
        });
        continue;
      }
      if (decision.status !== 'allowed') {
        refusals.push(decision);
        continue;
      }
      providerCalls.push({
        idempotencyKey: recipient.key,
        sendKey: request.idempotencyKey,
        provider: provider.provider,
        topic: request.topic,
        player: request.player,
        ...(recipient.endpoint === undefined ? {} : { address: recipient.endpoint.value }),
        ...(mapping === undefined ? {} : { mapping }),
        ...(link === undefined ? {} : { link }),
        content: decision.content,
        ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
        ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
        ...(request.data === undefined ? {} : { data: request.data }),
        at,
      });
      const answer = providerResults.shift() ?? { status: 'accepted' };
      switch (answer.status) {
        case 'accepted':
          rows.push({ ...row, state: { status: 'delivered' } });
          break;
        case 'ambiguous':
          // The provider may have sent it: the claim is kept for the lease.
          rows.push({
            ...row,
            ...backoff,
            state: {
              status: 'in-flight',
              leaseUntil: now() + notificationConformanceLeaseSeconds * secondMs,
            },
          });
          break;
        case 'unregistered':
          invalidate(recipient.endpoint);
          refusals.push({ status: 'unavailable', reason: 'endpoint-invalid' });
          break;
        case 'rejected':
          if (answer.reason === 'agreement') {
            // The host says the recipient has not agreed: the gate stops until they agree again.
            appendConsent(request.player, {
              kind: 'host-agreement',
              topic: request.topic,
              state: 'denied',
              source: 'provider',
              at,
            });
          }
          refusals.push({ status: 'unavailable', reason: 'provider-rejected' });
          break;
        case 'rate-limited': {
          // Nothing was sent: the claim, and any reservation, is released.
          const next = nextRateLimit(prior?.rateLimit, answer.retryAfterSeconds);
          if (next === undefined) {
            refusals.push({ status: 'unavailable', reason: 'provider-rate-limited' });
          } else {
            rows.push({
              ...row,
              rateLimit: next.state,
              state: { status: 'deferred', reason: 'provider-rate-limited', until: next.until },
            });
          }
        }
      }
    }
    return { rows, refusals };
  };

  const record = (outcome: NotificationDeliveryOutcome, request: SendRequest): void => {
    deliveries.push({
      ...outcome,
      idempotencyKey: request.idempotencyKey,
      topic: request.topic,
      player: request.player,
      at: clock.now(),
    });
  };
  const onDelivered = (request: SendRequest, origin: SendOrigin): void => {
    history.push({
      player: request.player,
      provider: entry?.provider ?? '',
      topic: request.topic,
      at: clock.now(),
      sendKey: request.idempotencyKey,
    });
    if (origin.kind === 'notice' && noticeListed(request.player, origin.notice)) {
      // A notice the scheduler sent is recorded once it is delivered.
      noticesGiven.push({
        ...origin.notice,
        player: request.player,
        channel: 'push',
        at: clock.now(),
      });
    }
  };

  /**
   * Evaluates a send with no stored entry and records its outcome. Answers
   * `undefined`, recording nothing, when `stillWanted` turned false during the
   * send's only wait (the server-readable permission read).
   */
  const sendNew = async (
    request: SendRequest,
    fingerprint: string,
    origin: SendOrigin,
    scheduled: boolean,
    stillWanted: () => boolean = () => true,
  ): Promise<NotificationDeliveryOutcome | undefined> => {
    const key = request.idempotencyKey;
    // The claim is taken before the first wait, so a concurrent send of the key sees it.
    claims.set(key, fingerprint);
    try {
      const serverPermission = await readServerPermission(request);
      if (!stillWanted()) {
        return undefined;
      }
      // No recipient on a provider the backend does not have.
      const reaches = entry !== undefined
        && (request.provider === undefined || request.provider === entry.provider);
      const { rows, refusals } = reaches
        ? processRecipients(request, origin, recipientsOf(request), serverPermission, new Map())
        : { rows: [], refusals: [noEndpoint()] };
      const stored = bestOutcome(rows.map(rowOutcome));
      if (stored !== undefined) {
        ledger.set(key, {
          request,
          fingerprint,
          origin,
          scheduled,
          rows,
          outcome: stored,
          changedAt: now(),
        });
        if (stored.status === 'delivered') {
          onDelivered(request, origin);
        }
      }
      const outcome = stored ?? bestOutcome(refusals) ?? noEndpoint();
      record(outcome, request);
      return outcome;
    } finally {
      claims.delete(key);
    }
  };

  /**
   * Replays `due` rows of a stored send through the gate and the provider,
   * without the key lookup, and replaces them with the new answers; a replay
   * that leaves no row deletes the entry. Answers the send's result, or
   * `undefined` when `stillWanted` turned false during the wait.
   */
  const replay = async (
    key: string,
    held: LedgerEntry,
    due: readonly LedgerRow[],
    stillWanted: () => boolean,
  ): Promise<NotificationDeliveryOutcome | undefined> => {
    claims.set(key, held.fingerprint);
    try {
      const serverPermission = await readServerPermission(held.request);
      if (!stillWanted()) {
        return undefined;
      }
      const { rows, refusals } = processRecipients(
        held.request,
        held.origin,
        due.map((row) => recipientOfRow(held.request, row)),
        serverPermission,
        new Map(due.map((row) => [row.key, row])),
      );
      const wasDelivered = held.outcome.status === 'delivered';
      held.rows = [...held.rows.filter((row) => !due.includes(row)), ...rows];
      const stored = bestOutcome(held.rows.map(rowOutcome));
      if (stored === undefined) {
        // A replay that ends suppressed or unavailable leaves no entry.
        ledger.delete(key);
        return bestOutcome(refusals) ?? noEndpoint();
      }
      held.outcome = stored;
      held.changedAt = now();
      if (!wasDelivered && stored.status === 'delivered') {
        onDelivered(held.request, held.origin);
      }
      return stored;
    } finally {
      claims.delete(key);
    }
  };
  /** Removes rows from a stored send; an entry without rows is deleted. */
  const dropRows = (key: string, held: LedgerEntry, drop: (row: LedgerRow) => boolean): boolean => {
    const kept = held.rows.filter((row) => !drop(row));
    if (kept.length === held.rows.length) {
      return false;
    }
    held.rows = kept;
    const stored = bestOutcome(kept.map(rowOutcome));
    if (stored === undefined) {
      ledger.delete(key);
    } else {
      held.outcome = stored;
      held.changedAt = now();
    }
    return true;
  };
  /** Rows the scheduler takes: due deferred ones, and in-flight ones it owns once the lease expired. */
  const dueRows = (held: LedgerEntry, at: number): LedgerRow[] =>
    held.rows.filter((row) =>
      (row.state.status === 'deferred' && Date.parse(row.state.until) <= at)
      || (row.state.status === 'in-flight'
        && row.state.leaseUntil <= at
        && (held.scheduled || row.installationId !== undefined)));
  /** A stored entry, unless its retention ended. */
  const lookup = (key: string): LedgerEntry | undefined => {
    const held = ledger.get(key);
    if (held !== undefined && now() - held.changedAt >= keyRetentionMs) {
      ledger.delete(key);
      return undefined;
    }
    return held;
  };
  /**
   * Drops the rows of a reminder's sends that wait (deferred) or are in
   * flight, so the scheduler replays none of them: whether there were any. A
   * send the provider may already have accepted cannot be recalled.
   */
  const dropReminderSends = (player: string, key: string): boolean => {
    let dropped = false;
    for (const [sendKey, held] of [...ledger]) {
      if (held.origin.kind === 'reminder' && held.origin.key === key && held.request.player === player) {
        dropped = dropRows(sendKey, held, (row) => row.state.status !== 'delivered') || dropped;
      }
    }
    return dropped;
  };
  const removeReminder = (reminder: NotificationConformanceServerReminder): void => {
    const index = reminders.indexOf(reminder);
    if (index !== -1) {
      reminders.splice(index, 1);
    }
  };
  const rateReached = (): boolean => {
    const rate = entry?.rate;
    if (rate === undefined) {
      return false;
    }
    const since = now() - rate.windowSeconds * secondMs;
    return providerCalls.filter((call) => Date.parse(call.at) > since).length >= rate.count;
  };

  // Scheduler items.

  const sendReminder = async (reminder: NotificationConformanceServerReminder): Promise<void> => {
    // A cancel or replace since the snapshot wins.
    if (!reminders.includes(reminder)) {
      return;
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = createNotificationReminderIdempotencyKey(reminder);
    } catch (error) {
      removeReminder(reminder);
      throw new NotificationSendInputError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    const request: SendRequest = {
      idempotencyKey,
      player: reminder.player,
      topic: reminder.topic,
      ...(reminder.templateData === undefined ? {} : { templateData: reminder.templateData }),
      ...(reminder.link === undefined ? {} : { link: reminder.link }),
    };
    if (claims.has(request.idempotencyKey)) {
      // Another worker holds the send and settles the reminder.
      return;
    }
    if (lookup(request.idempotencyKey) !== undefined) {
      // Its send was already made; the stored rows carry it from here.
      removeReminder(reminder);
      return;
    }
    let settled = true;
    try {
      await sendNew(
        request,
        notificationSendFingerprint(request),
        { kind: 'reminder', key: reminder.key },
        true,
        () => reminders.includes(reminder),
      );
    } catch (error) {
      // A send that cannot be made (a caller error) fails once; any other failure is retried.
      settled = error instanceof NotificationSendInputError;
      throw error;
    } finally {
      if (settled) {
        removeReminder(reminder);
      }
    }
  };
  const replayStored = async (key: string, held: LedgerEntry): Promise<void> => {
    // The lease: only the stored entry, while no other worker holds its key.
    if (ledger.get(key) !== held || claims.has(key)) {
      return;
    }
    const due = dueRows(held, now());
    if (due.length === 0) {
      return;
    }
    if (held.origin.kind === 'notice' && !noticeListed(held.request.player, held.origin.notice)) {
      // The game gave the notice while the push waited: it is not sent again.
      dropRows(key, held, (row) => due.includes(row));
      return;
    }
    const previous = held.outcome;
    // From here the scheduler owns the send: an ambiguous answer waits out the lease.
    held.scheduled = true;
    let outcome: NotificationDeliveryOutcome | undefined;
    try {
      outcome = await replay(
        key,
        held,
        due,
        () => ledger.get(key) === held && due.every((row) => held.rows.includes(row)),
      );
    } catch (error) {
      if (error instanceof NotificationSendInputError && ledger.get(key) === held) {
        // A replay that cannot be made fails once instead of on every run.
        dropRows(key, held, (row) => due.includes(row));
      }
      throw error;
    }
    if (outcome !== undefined && !sameOutcome(previous, outcome)) {
      record(outcome, held.request);
    }
  };
  const sendNotice = async (
    player: string,
    listed: NotificationNotice,
    topic: string,
  ): Promise<void> => {
    const notice = noticeIdentityOf(listed);
    const variant = notificationNoticeVariant(listed);
    const request: SendRequest = {
      idempotencyKey: createNotificationNoticeIdempotencyKey({ ...notice, player }),
      player,
      topic,
      templateData: { consentDate: toSeoulCalendarDate(notice.record.at) },
    };
    if (
      !noticeListed(player, notice)
      || failedNotices.has(request.idempotencyKey)
      || lookup(request.idempotencyKey) !== undefined
      || claims.has(request.idempotencyKey)
    ) {
      return;
    }
    try {
      await sendNew(
        request,
        notificationSendFingerprint(request),
        { kind: 'notice', notice, variant },
        true,
      );
    } catch (error) {
      if (error instanceof NotificationSendInputError) {
        // The notice topic cannot render it (a catalog error): the game still owes it in the game.
        failedNotices.add(request.idempotencyKey);
      }
      throw error;
    }
  };

  return {
    entry,
    get consent() {
      return consentRows.map((row) => ({ ...row.record, player: row.player }));
    },
    get endpoints() {
      return endpoints;
    },
    get deliveries() {
      return deliveries;
    },
    get providerCalls() {
      return providerCalls;
    },
    get reminders() {
      return reminders;
    },
    get notices() {
      return [...new Set(consentRows.map((row) => row.player))]
        .flatMap((player) => noticesOf(player).map((notice) => ({ ...notice, player })))
        .sort((left, right) =>
          compareText(left.dueBy, right.dueBy) || compareText(left.kind, right.kind));
    },
    get noticesGiven() {
      return noticesGiven;
    },
    session() {
      return current;
    },
    onAuthenticated(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },
    authenticate(player) {
      sessionCount += 1;
      const started: NotificationConformanceSession = {
        id: `session-${sessionCount}`,
        player,
        installationId: notificationConformanceInstallationId,
      };
      current = started;
      identities.add(player);
      for (const listener of [...sessionListeners]) {
        listener(started);
      }
      return started;
    },
    revokeSession() {
      const ended = requireSession('revokeSession');
      current = undefined;
      // The end of the session that registered an installation unbinds it.
      for (let index = endpoints.length - 1; index >= 0; index -= 1) {
        if (endpoints[index]?.session === ended.id) {
          endpoints.splice(index, 1);
        }
      }
    },
    registerInstallation(installation) {
      const provider = requireEntry('backend.registerEndpoint');
      if (provider.addressing !== 'device') {
        throw new NotificationConformanceScriptError(
          'backend.registerEndpoint needs a device-addressed provider.',
        );
      }
      if (notificationKeyIssue(installation.installationId) !== undefined) {
        throw new NotificationConformanceScriptError(
          `Invalid installation id ${JSON.stringify(installation.installationId)}.`,
        );
      }
      bindEndpoint({
        provider: provider.provider,
        kind: installation.kind,
        value: installation.value,
        installationId: installation.installationId,
        permission: installation.permission,
        player: input.defaultPlayer,
      });
    },
    async recordConsent(entryRecord) {
      appendConsent(requireSession('recordConsent').player, entryRecord);
    },
    async listConsent() {
      return recordsOf(requireSession('listConsent').player);
    },
    async registerEndpoint(registration) {
      const session = requireSession('registerEndpoint');
      const provider = requireEntry('registerEndpoint');
      if (registration.provider !== provider.provider) {
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
          message: `The backend has no provider ${registration.provider}.`,
        });
      }
      // An unknown zone is dropped, so quiet hours fall back to the deployment's zone.
      const timeZone = registration.timeZone !== undefined && isValidNotificationTimeZone(registration.timeZone)
        ? registration.timeZone
        : undefined;
      const { address } = registration;
      if (address.kind === 'platform-user') {
        // The recipient resolves from the authenticated identity; only locale and zone are kept.
        platformRegistrations.set(session.player, {
          ...(registration.locale === undefined ? {} : { locale: registration.locale }),
          ...(timeZone === undefined ? {} : { timeZone }),
        });
        return;
      }
      if (provider.addressing !== 'device') {
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
          message: `Provider ${provider.provider} resolves platform users; it takes no device address.`,
        });
      }
      bindEndpoint({
        provider: provider.provider,
        kind: address.kind,
        value: address.value,
        ...(address.environment === undefined ? {} : { environment: address.environment }),
        installationId: session.installationId,
        permission: address.permission,
        player: session.player,
        ...(registration.locale === undefined ? {} : { locale: registration.locale }),
        ...(timeZone === undefined ? {} : { timeZone }),
        session: session.id,
      });
    },
    async unregisterEndpoint(request) {
      const session = current;
      if (session === undefined) {
        // The end of the session already unbound what it registered.
        return;
      }
      const index = endpoints.findIndex((endpoint) =>
        endpoint.provider === request.provider
        && endpoint.installationId === session.installationId
        && endpoint.player === request.player);
      if (index !== -1) {
        endpoints.splice(index, 1);
      }
    },
    async setReminder(reminder) {
      const session = requireSession('setReminder');
      const provider = requireEntry('setReminder');
      const issue = reminderInputIssue(reminder)
        ?? (provider.content === 'host-template' && reminder.templateData !== undefined
          ? 'templateData: a host-template provider keeps template context on the server'
          : undefined);
      const topic = topicOf(reminder.topic);
      if (issue !== undefined || topic === undefined || !topic.channels.includes('remote')) {
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
          message: `Invalid server reminder: ${issue ?? `topic ${reminder.topic} has no remote channel`}.`,
        });
      }
      if (topic.purpose === 'advertising' && input.deployment?.advertisingRules === undefined) {
        // The gate would refuse every send of it, so it is refused now.
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
          message: `Advertising topic ${topic.id} needs the deployment's advertisingRules.`,
        });
      }
      const stored: NotificationConformanceServerReminder = {
        player: session.player,
        key: reminder.key,
        topic: topic.id,
        fireAt: normalizeNotificationTimestamp(reminder.fireAt),
        ...(reminder.templateData === undefined ? {} : { templateData: reminder.templateData }),
        ...(reminder.link === undefined ? {} : { link: reminder.link }),
      };
      try {
        // A reminder whose send could not be keyed is refused now, not at every scheduler run.
        createNotificationReminderIdempotencyKey(stored);
      } catch (error) {
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        });
      }
      const endpointPermissions = provider.addressing === 'device'
        ? validEndpointsOf(session.player).map((endpoint) => endpoint.permission)
        : [];
      const serverPermission = await readServerPermission({
        idempotencyKey: reminder.key,
        player: session.player,
        topic: topic.id,
      });
      const refusal = evaluateNotificationReminderConsent({
        entry: provider,
        topic,
        consent: recordsOf(session.player),
        ...(serverPermission === undefined ? {} : { serverPermission }),
        ...(endpointPermissions.length === 0
          ? {}
          : {
              endpointPermission: endpointPermissions.includes('granted')
                ? 'granted'
                : (endpointPermissions[0] ?? 'unknown'),
            }),
        history: historyFor(session.player),
      });
      if (refusal !== undefined) {
        return refusal;
      }
      // One reminder per key: setting it replaces the pending one and its sends still waiting.
      const waited = dropReminderSends(session.player, reminder.key);
      const index = reminders.findIndex((pending) =>
        pending.player === session.player && pending.key === reminder.key);
      if (index === -1) {
        reminders.push(stored);
        return waited ? 'replaced' : 'scheduled';
      }
      reminders[index] = stored;
      return 'replaced';
    },
    async cancelReminder(request) {
      const session = requireSession('cancelReminder');
      const issue = notificationKeyIssue(request.key);
      if (issue !== undefined) {
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', { message: `Invalid key: ${issue}.` });
      }
      const waited = dropReminderSends(session.player, request.key);
      const index = reminders.findIndex((pending) =>
        pending.player === session.player && pending.key === request.key);
      if (index === -1) {
        return waited;
      }
      reminders.splice(index, 1);
      return true;
    },
    async listNotices() {
      return noticesOf(requireSession('listNotices').player);
    },
    async recordNotice(input) {
      const session = requireSession('recordNotice');
      const { channel, ...named } = input;
      const notice = noticeIdentityOf(recordNoticeInputOf(named));
      // Only a listed notice is recorded: one already recorded, not listed
      // yet, or unknown changes nothing, so a retried call is safe.
      if (!noticeListed(session.player, notice)) {
        return;
      }
      noticesGiven.push({ ...notice, player: session.player, channel, at: clock.now() });
    },
    async deliver(request) {
      const send = sendRequestOf(request, input.defaultPlayer);
      const key = send.idempotencyKey;
      const fingerprint = notificationSendFingerprint(send);
      const held = lookup(key);
      if (held !== undefined) {
        if (held.fingerprint !== fingerprint) {
          throw conflictError(key);
        }
        const expired = held.rows.filter((row) =>
          row.state.status === 'in-flight' && row.state.leaseUntil <= now() && row.installationId === undefined);
        if (held.outcome.status === 'in-flight' && !held.scheduled && !claims.has(key) && expired.length > 0) {
          // The claim's lease expired: this caller is the next claimer and replays it.
          const outcome = (await asInvalidInput(() =>
            replay(key, held, expired, () => ledger.get(key) === held))) ?? { status: 'in-flight' };
          record(outcome, send);
          return outcome;
        }
        const answer: NotificationDeliveryOutcome = held.outcome.status === 'delivered'
          ? { status: 'delivered', alreadyProcessed: true }
          : held.outcome;
        record(answer, send);
        return answer;
      }
      const claimed = claims.get(key);
      if (claimed !== undefined) {
        if (claimed !== fingerprint) {
          throw conflictError(key);
        }
        const answer: NotificationDeliveryOutcome = { status: 'in-flight' };
        record(answer, send);
        return answer;
      }
      // Without a `stillWanted` predicate a send is never abandoned.
      return (await asInvalidInput(() => sendNew(send, fingerprint, { kind: 'send' }, false)))
        ?? { status: 'in-flight' };
    },
    queueProviderResult(result) {
      providerResults.push(result);
    },
    async runScheduler() {
      const at = now();
      for (const [key, held] of [...ledger]) {
        if (at - held.changedAt >= keyRetentionMs) {
          ledger.delete(key);
        }
      }
      const due: { readonly at: number; readonly run: () => Promise<void> }[] = [];
      for (const reminder of [...reminders]) {
        const fireAt = Date.parse(reminder.fireAt);
        if (fireAt <= at) {
          due.push({ at: fireAt, run: () => sendReminder(reminder) });
        }
      }
      for (const [key, held] of [...ledger]) {
        const first = Math.min(...dueRows(held, at).map((row) =>
          row.state.status === 'deferred'
            ? Date.parse(row.state.until)
            : row.state.status === 'in-flight' ? row.state.leaseUntil : at));
        if (Number.isFinite(first)) {
          due.push({ at: first, run: () => replayStored(key, held) });
        }
      }
      if (rules === 'kr' && noticeTopic !== undefined && noticeTopicHere !== undefined) {
        const today = toSeoulCalendarDate(clock.now());
        for (const player of [...new Set(consentRows.map((row) => row.player))]) {
          for (const notice of noticesOf(player)) {
            const from = notificationNoticeSendFrom(notice.dueBy);
            if (from <= today) {
              due.push({
                at: Date.parse(`${from}T00:00:00+09:00`),
                run: () => sendNotice(player, notice, noticeTopic),
              });
            }
          }
        }
      }
      due.sort((left, right) => left.at - right.at);
      const failures: unknown[] = [];
      for (const item of due) {
        // Pacing: the rest stays due for the next run.
        if (rateReached()) {
          break;
        }
        try {
          await item.run();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `The scheduler could not process ${failures.length} item(s); the others ran. First: `
            + describeError(failures[0]),
        );
      }
    },
  };
}

/** A well-formed `notices.recordShown` input, or `NOTIFICATIONS_INVALID_INPUT`. */
function recordNoticeInputOf(input: unknown): RecordNotificationNoticeInput {
  try {
    return assertRecordNotificationNoticeInput(input);
  } catch (error) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'A notice is a listed notice, or its kind, the kind and time of the record it reports '
        + `on, and its dueBy: ${describeError(error)}`,
      cause: error,
    });
  }
}

/**
 * Only the fields that name a notice, with the record time in the canonical
 * form; a listed notice's `record.state` and `textVersion` are left out.
 */
function noticeIdentityOf(notice: NotificationNoticeIdentity): NotificationNoticeIdentity {
  return {
    kind: notice.kind,
    record: { kind: notice.record.kind, at: normalizeNotificationTimestamp(notice.record.at) },
    dueBy: notice.dueBy,
  };
}

/** Why a reminder's input breaks the RFC bounds, or `undefined`. */
function reminderInputIssue(input: SetNotificationReminderInput): string | undefined {
  const keyIssue = notificationKeyIssue(input.key);
  if (keyIssue !== undefined) {
    return `key: ${keyIssue}`;
  }
  if (timestampOrUndefined(input.fireAt) === undefined) {
    return 'fireAt: expected RFC 3339 with an explicit offset';
  }
  if (input.templateData !== undefined) {
    const issue = notificationTemplateDataIssue(input.templateData);
    if (issue !== undefined) {
      return `templateData: ${issue}`;
    }
  }
  if (input.link !== undefined && !isBoundedText(input.link)) {
    return 'link: expected a non-empty string';
  }
  return undefined;
}

function sendRequestOf(request: NotificationConformanceDeliverInput, defaultPlayer: string): SendRequest {
  const issue = sendInputIssue(request);
  if (issue !== undefined) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: `Invalid send: ${issue}.`,
    });
  }
  return {
    idempotencyKey: request.idempotencyKey,
    player: request.player ?? defaultPlayer,
    topic: request.topic,
    ...(request.provider === undefined ? {} : { provider: request.provider }),
    ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
    ...(request.data === undefined ? {} : { data: request.data }),
    ...(request.locale === undefined ? {} : { locale: request.locale }),
    ...(request.link === undefined ? {} : { link: request.link }),
  };
}

function sendInputIssue(request: NotificationConformanceDeliverInput): string | undefined {
  const keyIssue = notificationKeyIssue(request.idempotencyKey);
  if (keyIssue !== undefined) {
    return `idempotencyKey: ${keyIssue}`;
  }
  const reserved = notificationReservedKeyPrefix(request.idempotencyKey);
  if (reserved !== undefined) {
    return `idempotencyKey: the ${reserved} prefix is reserved for the scheduler`;
  }
  if (request.templateData !== undefined) {
    const issue = notificationTemplateDataIssue(request.templateData);
    if (issue !== undefined) {
      return `templateData: ${issue}`;
    }
  }
  if (request.data !== undefined) {
    const issue = notificationTemplateDataIssue(request.data, { stringsOnly: true });
    if (issue !== undefined) {
      return `data: ${issue}`;
    }
  }
  for (const [name, value] of [
    ['topic', request.topic],
    ['player', request.player],
    ['provider', request.provider],
    ['locale', request.locale],
    ['link', request.link],
  ] as const) {
    if (value !== undefined && !isBoundedText(value)) {
      return `${name}: expected a non-empty string`;
    }
  }
  return undefined;
}

function isBoundedText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384;
}

function timestampOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    return normalizeNotificationTimestamp(value);
  } catch {
    return undefined;
  }
}

function conflictError(key: string): NotificationError {
  return new NotificationError('NOTIFICATIONS_IDEMPOTENCY_CONFLICT', {
    message: `Key ${key} is stored for another request.`,
  });
}

/** Runs a send; a caller error from the gate (such as missing template data) becomes `NOTIFICATIONS_INVALID_INPUT`. */
async function asInvalidInput<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NotificationSendInputError) {
      throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

/** The policy gate, with its caller errors as `NotificationSendInputError`. */
function decide(input: EvaluateNotificationDeliveryInput): NotificationDeliveryDecision {
  try {
    return evaluateNotificationDelivery(input);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new NotificationSendInputError(error.message, { cause: error });
    }
    throw error;
  }
}

function rowOutcome(row: LedgerRow): StoredOutcome {
  switch (row.state.status) {
    case 'delivered':
      return { status: 'delivered', alreadyProcessed: false };
    case 'in-flight':
      return { status: 'in-flight' };
    case 'deferred':
      return { status: 'deferred', reason: row.state.reason, until: row.state.until };
  }
}

/**
 * How far a recipient's answer got, for a send's result across recipients:
 * delivered, in flight, waiting, a provider's refusal, a policy refusal, and
 * last a recipient that did not resolve.
 */
function outcomeRank(outcome: NotificationDeliveryOutcome): number {
  switch (outcome.status) {
    case 'delivered':
      return 5;
    case 'in-flight':
      return 4;
    case 'deferred':
      return 3;
    case 'unavailable':
      return outcome.reason === 'no-endpoint' || outcome.reason === 'link-missing' ? 0 : 2;
    case 'suppressed':
      return 1;
  }
}

/** The highest-ranked outcome, the earliest among deferred ones, the first among equals. */
function bestOutcome<Outcome extends NotificationDeliveryOutcome>(
  outcomes: readonly Outcome[],
): Outcome | undefined {
  let best: Outcome | undefined;
  for (const outcome of outcomes) {
    if (
      best === undefined
      || outcomeRank(outcome) > outcomeRank(best)
      || (outcome.status === 'deferred'
        && best.status === 'deferred'
        && Date.parse(outcome.until) < Date.parse(best.until))
    ) {
      best = outcome;
    }
  }
  return best;
}

function sameOutcome(left: NotificationDeliveryOutcome, right: NotificationDeliveryOutcome): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatInstant(millis: number): string {
  return normalizeNotificationTimestamp(new Date(millis).toISOString());
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Runtime.

export interface NotificationConformanceRuntime extends NotificationRuntime {
  /**
   * Subscribes to the provider and to authentication, compares the provider
   * with its registry entry, and reconciles pending local reminders. Provider
   * events are buffered for the game's first listener.
   */
  start(): Promise<void>;
  /** Drops listeners, buffered events, and both subscriptions. */
  stop(): void;
  /** Waits for event-driven work (records, registrations, local reminders) and rethrows its first failure. */
  runUntilIdle(): Promise<void>;
}

/** What the runtime keeps across restarts. */
export interface NotificationConformanceRuntimeStorage {
  /** The last registration the backend acknowledged. */
  registration?: NotificationConformancePersistedRegistration;
  /** Set by `unregister()`; `register()` or the next authentication clears it. */
  unbound?: boolean;
}

export interface NotificationConformancePersistedRegistration {
  readonly registration: NotificationEndpointRegistration;
  readonly player: string;
  readonly session: string;
  readonly at: string;
}

export interface CreateNotificationConformanceRuntimeInput {
  readonly provider: NotificationProvider;
  readonly backend: NotificationConformanceBackendClient;
  /** The provider's topics, each with this target's mapping. */
  readonly catalog: readonly NotificationTopicDeclaration[];
  readonly clock: Pick<NotificationConformanceClock, 'now'>;
  /** The deployment's zone, for local quiet hours while the device has registered none. */
  readonly timeZone: string;
  readonly defaultLocale: string;
  /** The device locale for local reminder copy; defaults to `defaultLocale`. */
  readonly locale?: string;
  /** Survives restarts; a fresh object when absent. */
  readonly storage?: NotificationConformanceRuntimeStorage;
  /**
   * The backend's registry entry for this provider. When the provider's
   * capabilities disagree with it at start, every call throws
   * `NOTIFICATIONS_CONFIGURATION_REQUIRED`.
   */
  readonly registryEntry?: NotificationDeliveryProviderEntry;
}

/**
 * When a pending record is appended: `changed` when its state differs from
 * the latest record of its kind and scope; `always` every time (player
 * consent, which carries its text version); `each` every time and never
 * collapsed before authentication (a per-send acceptance allows one delivery).
 */
type RecordMode = 'changed' | 'always' | 'each';

interface PendingRecord {
  readonly record: NotificationConsentRecord;
  readonly mode: RecordMode;
  /** The player authenticated when it was observed; `undefined` before authentication. */
  readonly player: string | undefined;
}

/** A decided state the host reported for the app (no topic) or one topic. */
interface Observation {
  readonly topic?: string;
  readonly state: NotificationPermissionState;
  readonly accepted?: boolean;
}

interface ResolvedStates {
  readonly app?: NotificationPermissionState;
  readonly appSource?: 'host' | 'record';
  readonly topics: Readonly<Record<string, NotificationPermissionState>>;
  readonly sources: Readonly<Record<string, 'host' | 'record'>>;
}

interface LocalEntry {
  readonly key: string;
  readonly topic: string;
  readonly fireAt?: string;
}

type RuntimeQueue = 'record' | 'register' | 'local';

/**
 * The reference notifications runtime (RFC "Runtime"): the provider composed
 * with the backend for the authenticated session.
 *
 * - Reads return the provider snapshot. A topic the host reads `unknown`
 *   takes the latest record, `sources` says which answered, and a
 *   game-rendered consent that is not opted in reads `prompt` until a
 *   decision is recorded and `denied` after it. A topic whose mapping needs no
 *   agreement reads `granted`. A read that observes a changed decided state
 *   records it, and every read still answers when the backend cannot.
 * - Reads, requests, and revocations take each topic once, however often it
 *   is listed.
 * - Requests throw `NOTIFICATIONS_USER_GESTURE_REQUIRED` without a gesture on
 *   a gesture-only provider. An unsupported provider answers `unavailable`, a
 *   provider in `action-required` answers that with its `requiredAction`, an
 *   undeclared or unmapped topic answers `unavailable`, a topic that needs no
 *   agreement answers `already-granted`, and a topic the host reads `blocked`
 *   answers `blocked`, all without reaching the host; every other topic
 *   reaches the prompt.
 * - Records: decided states that differ from the latest record of their kind
 *   and scope, never `dismissed` or `action-required` answers. Device
 *   providers write none (the endpoint holds the permission), other app-scope
 *   providers write `delivery-permission`, and topic-scope providers write
 *   `host-agreement` with the host evidence, plus a `topic-preference` of
 *   `granted` when the player accepts a `requested` topic's agreement.
 *   Per-send acceptances are appended every time. A record belongs to the
 *   player signed in when the call or event began: one observed before
 *   authentication waits for it (only the latest per kind and scope), and one
 *   observed for a player waits for that player's session. A player action
 *   (`setTopicPreference`, `setAdvertisingConsent`) needs an authenticated
 *   player and throws `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE` without one, as
 *   does every other backend call (a server reminder, `reminders.cancel`'s
 *   server part, and `notices`). A backend call belongs to the player signed
 *   in when it began and is refused when another player signed in since. A
 *   record the backend would refuse is dropped and its error surfaces.
 * - Registrations: the provider's registration goes to the backend at
 *   authentication, on `register()`, on `endpoint-changed` (a rotated device
 *   address, or a platform user's changed locale or zone), and when a read
 *   or request, or a revocation, changes the device's decided permission; and
 *   at start and on reads once the last one the backend acknowledged is older
 *   than 7 days. An identical one for the same player and session is skipped
 *   for 7 days, except on `register()`. `unregister()` unbinds the
 *   installation from the player signed in when it was called and cancels the
 *   pending local reminders, even when the unbind fails, and nothing binds it
 *   again, across restarts, until `register()` or the next authentication.
 * - Reminders: one key across both routes, and `cancel` removes it from each
 *   route that has it. Local ones pass the client gate steps (permission,
 *   then the topic preference from the backend, then quiet hours, which move
 *   them or refuse a topic that is not deferrable, then the topic's daily
 *   cap); server ones are checked and stored by the backend. Turning a topic off cancels its local
 *   reminders, a known permission other than granted cancels them, and start,
 *   authentication, and every backend read reconcile them with the catalog
 *   (a topic that no longer takes the local route loses its reminders), the
 *   latest preference, and permission.
 * - Game listeners run after the runtime's own handling of an event; a
 *   listener that throws stops neither the others nor the runtime, and its
 *   error surfaces from `runUntilIdle`, as do failures of background work:
 *   the first one, or an `AggregateError` that counts them all. `stop()` and
 *   a later `start()` buffer events for the next first subscriber again.
 */
export function createNotificationConformanceRuntime(
  input: CreateNotificationConformanceRuntimeInput,
): NotificationConformanceRuntime {
  const { provider, backend, clock } = input;
  const storage = input.storage ?? {};
  const listeners = new Set<(event: NotificationEvent) => void>();
  let buffer: NotificationEvent[] = [];
  let gameSubscribed = false;
  let unsubscribeProvider: (() => void) | undefined;
  let unsubscribeAuthentication: (() => void) | undefined;
  let configurationIssue: string | undefined;
  /** The provider's latest registration, from `register()` or `endpoint-changed`. */
  let latestRegistration: NotificationEndpointRegistration | undefined;
  const background = new Set<Promise<void>>();
  /** The first background failure since the last `runUntilIdle`, and how many there were. */
  let failure: { readonly error: unknown; count: number } | undefined;
  const fail = (error: unknown): void => {
    if (failure === undefined) {
      failure = { error, count: 1 };
    } else {
      failure.count += 1;
    }
  };
  const waitingRecords: PendingRecord[] = [];
  /** One promise chain per queue: records, registrations, and local reminder changes. */
  const queues: Record<RuntimeQueue, Promise<unknown>> = {
    record: Promise.resolve(),
    register: Promise.resolve(),
    local: Promise.resolve(),
  };
  /** Local reminders this runtime scheduled: the fallback for a provider without `listLocal`. */
  const scheduledLocal = new Map<string, LocalEntry>();

  const emit = (event: NotificationEvent): void => {
    if (!gameSubscribed) {
      bufferEvent(buffer, event);
      return;
    }
    for (const error of deliverEach([...listeners], [event])) {
      fail(error);
    }
  };
  const track = (work: Promise<void>): void => {
    const tracked: Promise<void> = work
      .catch((error: unknown) => {
        fail(error);
      })
      .finally(() => {
        background.delete(tracked);
      });
    background.add(tracked);
  };
  /** Awaits follow-up work of a call that has already answered; a failure surfaces from `runUntilIdle`. */
  const settle = async (work: Promise<void>): Promise<void> => {
    try {
      await work;
    } catch (error) {
      fail(error);
    }
  };
  /**
   * Runs `work` after every earlier job of the same queue, in call order. A job
   * never enqueues onto its own queue and waits for it, which would deadlock.
   */
  const enqueue = <Result>(queue: RuntimeQueue, work: () => Promise<Result>): Promise<Result> => {
    const run = queues[queue].then(work);
    queues[queue] = run.catch(() => undefined);
    return run;
  };
  const topicOf = (topic: string): NotificationTopicDeclaration | undefined =>
    input.catalog.find((entry) => entry.id === topic);
  const capabilitiesOf = async (): Promise<NotificationCapabilities> => {
    const capabilities = await provider.getCapabilities();
    if (configurationIssue !== undefined) {
      throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
        message: `The provider disagrees with its registry entry: ${configurationIssue}.`,
      });
    }
    return capabilities;
  };
  const sessionPlayer = (): string | undefined => backend.session()?.player;

  // Consent records.

  /** The session player's records, with that player's records still waiting; `undefined` without a session. */
  const readRecords = async (): Promise<NotificationConsentRecord[] | undefined> => {
    const session = backend.session();
    if (session === undefined) {
      return undefined;
    }
    const records = await backend.listConsent();
    return [
      ...records,
      ...waitingRecords
        .filter((pending) => pending.player === undefined || pending.player === session.player)
        .map((pending) => pending.record),
    ];
  };
  const addWaiting = (next: PendingRecord): void => {
    if (next.player === undefined && next.mode !== 'each') {
      // Before authentication only the latest per kind and scope is kept.
      for (let index = waitingRecords.length - 1; index >= 0; index -= 1) {
        const waiting = waitingRecords[index];
        if (
          waiting !== undefined
          && waiting.player === undefined
          && waiting.mode !== 'each'
          && waiting.record.kind === next.record.kind
          && waiting.record.topic === next.record.topic
        ) {
          waitingRecords.splice(index, 1);
        }
      }
    }
    waitingRecords.push(next);
  };
  /**
   * Inside the record queue: writes the session player's waiting records and
   * then `pending`, in order. What cannot be written waits for the next write.
   */
  const writeRecords = async (pending: readonly PendingRecord[]): Promise<void> => {
    for (const next of pending) {
      addWaiting(next);
    }
    const session = backend.session();
    if (session === undefined) {
      return;
    }
    const mine = waitingRecords.filter((waiting) =>
      waiting.player === undefined || waiting.player === session.player);
    if (mine.length === 0) {
      return;
    }
    for (const waiting of mine) {
      waitingRecords.splice(waitingRecords.indexOf(waiting), 1);
    }
    try {
      const records = [...(await backend.listConsent())];
      while (mine.length > 0) {
        if (backend.session()?.id !== session.id) {
          // The session changed during the write: the rest waits for its player.
          waitingRecords.push(...mine);
          return;
        }
        const next = mine[0];
        if (next !== undefined) {
          const latest = latestNotificationConsent(records, next.record.kind, next.record.topic);
          if (next.mode !== 'changed' || latest?.state !== next.record.state) {
            await backend.recordConsent(next.record);
            records.push(next.record);
          }
        }
        mine.shift();
      }
    } catch (error) {
      waitingRecords.push(...mine);
      throw error;
    }
  };
  const queueRecords = (pending: readonly PendingRecord[]): Promise<void> => {
    // A record the backend would refuse (a provider's malformed evidence) is
    // dropped, so it never blocks the records after it; its error surfaces.
    const valid = pending.filter((next) => {
      try {
        assertNotificationConsentRecord(next.record);
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    });
    return valid.length === 0 && waitingRecords.length === 0
      ? Promise.resolve()
      : enqueue('record', () => writeRecords(valid));
  };
  /**
   * A player action is recorded for the authenticated player, never for
   * whoever authenticates next.
   */
  const requirePlayer = (operation: string): string => {
    const player = sessionPlayer();
    if (player === undefined) {
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `${operation} records a player action, which needs an authenticated player.`,
      });
    }
    return player;
  };
  /** Refuses a server call when another player signed in after the call began. */
  const assertSamePlayer = (operation: string, player: string | undefined): void => {
    if (sessionPlayer() !== player) {
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `${operation} began for another player; ask again for the player signed in now.`,
      });
    }
  };
  /**
   * A server call needs the player who was signed in when it began, and that
   * player still signed in; before sign-in it is temporarily unavailable.
   */
  const requireSignedIn = (operation: string, player: string | undefined): void => {
    if (player === undefined) {
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `${operation} calls the backend, which needs an authenticated player.`,
      });
    }
    assertSamePlayer(operation, player);
  };
  /**
   * The records the decided states in `observations` call for, for `player`:
   * the one authenticated when the call began, or `undefined` before
   * authentication.
   */
  const permissionRecords = (
    capabilities: NotificationCapabilities,
    observations: readonly Observation[],
    evidence: NotificationPermissionResult['evidence'],
    player: string | undefined,
  ): PendingRecord[] => {
    const pending: PendingRecord[] = [];
    const proof = evidence === undefined ? {} : { evidence };
    for (const observation of observations) {
      const state = observation.state;
      if (!isRecordableNotificationPermissionState(state)) {
        continue;
      }
      const mode: RecordMode = capabilities.permission.allowance === 'per-send' && observation.accepted === true
        ? 'each'
        : 'changed';
      if (observation.topic === undefined) {
        // Device providers keep the permission on the endpoint, not in records.
        if (capabilities.permission.scope === 'app' && !isDeviceAddressing(capabilities)) {
          pending.push({
            mode,
            player,
            record: {
              kind: 'delivery-permission',
              state,
              source: 'client-report',
              at: clock.now(),
              ...proof,
            },
          });
        }
        continue;
      }
      const topic = topicOf(observation.topic);
      // Host policy, not the player, granted a topic that needs no agreement.
      if (capabilities.permission.scope === 'topic' && topic !== undefined && !notificationTopicNeedsNoAgreement(topic)) {
        pending.push({
          mode,
          player,
          record: {
            kind: 'host-agreement',
            topic: observation.topic,
            state,
            source: 'client-report',
            at: clock.now(),
            ...proof,
          },
        });
      }
    }
    return pending;
  };
  /**
   * The states a snapshot reports after the runtime's rules: a game-rendered
   * consent not opted in reads `denied` once a decision is recorded (or made
   * now), a topic that needs no agreement reads `granted`, and an `unknown`
   * host read takes the latest record.
   */
  const resolveStates = (
    capabilities: NotificationCapabilities,
    snapshot: NotificationPermissionSnapshot,
    topics: readonly string[],
    records: readonly NotificationConsentRecord[] | undefined,
    decidedNow = false,
  ): ResolvedStates => {
    const scope = capabilities.permission.scope;
    const kind = notificationPermissionConsentKind(scope);
    const decided = decidedNow
      || (records !== undefined && latestNotificationConsent(records, 'delivery-permission') !== undefined);
    const resolve = (
      host: NotificationPermissionState,
      topic: string | undefined,
    ): { readonly state: NotificationPermissionState; readonly source: 'host' | 'record' } => {
      const declared = topic === undefined ? undefined : topicOf(topic);
      if (scope === 'topic' && declared !== undefined && notificationTopicNeedsNoAgreement(declared)) {
        return { state: 'granted', source: 'host' };
      }
      const state = capabilities.permission.prompt === 'game' && host === 'prompt' && decided
        ? 'denied'
        : host;
      const recorded = state === 'unknown' && records !== undefined
        ? latestRecordState(records, kind, scope === 'app' ? undefined : topic)
        : undefined;
      return recorded === undefined
        ? { state, source: 'host' }
        : { state: recorded, source: 'record' };
    };
    const app = scope === 'app' && snapshot.app !== undefined
      ? resolve(snapshot.app, undefined)
      : undefined;
    const resolved = topics.map(
      (topic) => [topic, resolve(notificationPermissionStateOf(snapshot, topic), topic)] as const,
    );
    return {
      ...(app === undefined ? {} : { app: app.state, appSource: app.source }),
      topics: Object.fromEntries(resolved.map(([topic, entry]) => [topic, entry.state])),
      sources: Object.fromEntries(resolved.map(([topic, entry]) => [topic, entry.source])),
    };
  };
  /** The decided states the host itself reported, one per scope. */
  const hostObservations = (
    capabilities: NotificationCapabilities,
    states: ResolvedStates,
    topics: readonly string[],
  ): Observation[] => {
    if (capabilities.permission.scope === 'app') {
      return states.app === undefined || states.appSource !== 'host' ? [] : [{ state: states.app }];
    }
    return topics
      .filter((topic) => states.sources[topic] === 'host')
      .map((topic) => ({ topic, state: stateIn(states, topic) }));
  };

  // Registrations.

  /**
   * Inside the register queue: sends `registration` for the session unless
   * the backend acknowledged the same one for this player and session within
   * 7 days. One made before authentication is sent at authentication, and
   * nothing binds after `unregister()` until `register()` or the next
   * authentication, across restarts.
   */
  const sendRegistration = async (
    registration: NotificationEndpointRegistration,
    always: boolean,
  ): Promise<void> => {
    latestRegistration = registration;
    const session = backend.session();
    if (session === undefined || storage.unbound === true) {
      return;
    }
    const last = storage.registration;
    if (
      !always
      && last !== undefined
      && last.player === session.player
      && last.session === session.id
      && sameJson(last.registration, registration)
      && Date.parse(clock.now()) - Date.parse(last.at) < registrationRefreshMs
    ) {
      return;
    }
    await backend.registerEndpoint(registration);
    storage.registration = {
      registration,
      player: session.player,
      session: session.id,
      at: clock.now(),
    };
  };
  /**
   * Registers the provider's current address or platform identity; `rebind`
   * ends an `unregister()`. A `permission` the runtime decided (a
   * game-rendered consent reads `denied` once withdrawn) replaces the one a
   * device address carries.
   */
  const registerCurrent = (
    always: boolean,
    rebind = false,
    permission?: NotificationPermissionState,
  ): Promise<void> =>
    enqueue('register', async () => {
      if (rebind) {
        delete storage.unbound;
      }
      const capabilities = await provider.getCapabilities();
      const register = provider.register;
      if (!capabilities.remote.supported || capabilities.remote.addressing === 'none' || register === undefined) {
        return;
      }
      const registration = (await register.call(provider)) ?? latestRegistration;
      if (registration !== undefined) {
        const { address } = registration;
        await sendRegistration(
          permission === undefined || address.kind === 'platform-user' || address.permission === permission
            ? registration
            : { ...registration, address: { ...address, permission } },
          always,
        );
      }
    });
  /**
   * Re-sends the registration once the one the backend last acknowledged for
   * this player and session is older than 7 days, so the endpoint of a device
   * in use never goes stale. Runs at start and on reads.
   */
  const refreshRegistration = async (): Promise<void> => {
    const session = backend.session();
    const last = storage.registration;
    if (
      session === undefined
      || storage.unbound === true
      || last === undefined
      || last.player !== session.player
      || last.session !== session.id
      || Date.parse(clock.now()) - Date.parse(last.at) < registrationRefreshMs
      || !isDeviceAddressing(await provider.getCapabilities())
    ) {
      return;
    }
    await registerCurrent(false);
  };
  /** Re-registers when the device's decided permission differs from the latest registration's. */
  const syncRegistration = async (
    capabilities: NotificationCapabilities,
    state: NotificationPermissionState | undefined,
  ): Promise<void> => {
    if (
      !isDeviceAddressing(capabilities)
      || state === undefined
      || !isRecordableNotificationPermissionState(state)
    ) {
      return;
    }
    const address = (latestRegistration ?? storage.registration?.registration)?.address;
    if (address !== undefined && address.kind !== 'platform-user' && address.permission === state) {
      return;
    }
    await registerCurrent(false, false, state);
  };

  // Local reminders.

  const listLocalEntries = async (): Promise<readonly LocalEntry[]> =>
    provider.listLocal === undefined ? [...scheduledLocal.values()] : provider.listLocal();
  /** Inside the local queue: cancels the pending local reminders `refused` picks. */
  const cancelLocalNow = async (refused: (entry: LocalEntry) => boolean): Promise<void> => {
    const cancelLocal = provider.cancelLocal;
    if (cancelLocal === undefined) {
      return;
    }
    const keys = (await listLocalEntries()).filter(refused).map((entry) => entry.key);
    if (keys.length > 0) {
      await cancelLocal.call(provider, { keys });
      for (const key of keys) {
        scheduledLocal.delete(key);
      }
    }
  };
  /**
   * Cancels pending local reminders. In the local queue, so a reminder being
   * set when a withdrawal lands is scheduled before this sweep runs.
   */
  const cancelLocalWhere = (refused: (entry: LocalEntry) => boolean): Promise<void> =>
    enqueue('local', async () => {
      if ((await provider.getCapabilities()).local.supported) {
        await cancelLocalNow(refused);
      }
    });
  /** The device would still show local reminders after permission stops being granted. */
  const cancelRevokedLocal = async (
    capabilities: NotificationCapabilities,
    states: ResolvedStates,
    topics: readonly string[],
  ): Promise<void> => {
    if (!capabilities.local.supported) {
      return;
    }
    if (capabilities.permission.scope === 'app') {
      if (states.app !== undefined && revokesLocalReminders(states.app)) {
        await cancelLocalWhere(() => true);
      }
      return;
    }
    const revoked = topics.filter((topic) => revokesLocalReminders(stateIn(states, topic)));
    if (revoked.length > 0) {
      await cancelLocalWhere((entry) => revoked.includes(entry.topic));
    }
  };
  /**
   * Cancels the pending local reminders that no longer pass, in two sweeps.
   * The first, without the backend, takes every one whose topic no longer
   * takes the local route: an app update removed the topic from the catalog or
   * took away its `local` channel. The second takes the others whose
   * permission is known and not granted and, with the backend's records,
   * those whose topic preference refuses them, because a preference changed
   * on another device never reaches this one as an event. The second sweep
   * runs even when the first fails, and the first one's error is thrown at
   * the end (with the second one's, if both fail).
   */
  const reconcileLocal = (): Promise<void> =>
    enqueue('local', async () => {
      const capabilities = await provider.getCapabilities();
      if (!capabilities.local.supported || provider.cancelLocal === undefined) {
        return;
      }
      const localTopicOf = (entry: LocalEntry): NotificationTopicDeclaration | undefined => {
        const topic = topicOf(entry.topic);
        return topic !== undefined && routeNotificationReminder(topic, capabilities) === 'local'
          ? topic
          : undefined;
      };
      let offRoute: { readonly error: unknown } | undefined;
      try {
        await cancelLocalNow((entry) => localTopicOf(entry) === undefined);
      } catch (error) {
        offRoute = { error };
      }
      try {
        await cancelRefusedLocal(capabilities, localTopicOf);
      } catch (error) {
        if (offRoute === undefined) {
          throw error;
        }
        throw new AggregateError(
          [offRoute.error, error],
          'Neither sweep of the local reminders completed. First: ' + describeError(offRoute.error),
        );
      }
      if (offRoute !== undefined) {
        throw offRoute.error;
      }
    });
  /**
   * Inside the local queue: the second sweep. Reminders whose topic left the
   * local route belong to the first sweep and are skipped, so a reminder the
   * host cannot cancel is not tried twice.
   */
  const cancelRefusedLocal = async (
    capabilities: NotificationCapabilities,
    localTopicOf: (entry: LocalEntry) => NotificationTopicDeclaration | undefined,
  ): Promise<void> => {
    const pending = (await listLocalEntries()).filter((entry) => localTopicOf(entry) !== undefined);
    if (pending.length === 0) {
      return;
    }
    const records = await readRecords();
    const topics = [...new Set(pending.map((entry) => entry.topic))];
    const states = resolveStates(
      capabilities,
      await provider.getPermission({ topics }),
      topics,
      records,
    );
    await cancelLocalNow((entry) => {
      const topic = localTopicOf(entry);
      if (topic === undefined) {
        return false;
      }
      if (revokesLocalReminders(stateIn(states, entry.topic))) {
        return true;
      }
      return records !== undefined && preferenceRefuses(topic, records, clock.now());
    });
  };
  const localZone = (): string => {
    const zone = (latestRegistration ?? storage.registration?.registration)?.timeZone;
    return zone !== undefined && isValidNotificationTimeZone(zone) ? zone : input.timeZone;
  };
  /** Inside the local queue: the client gate steps, then the provider's schedule. */
  const scheduleLocalReminder = async (
    capabilities: NotificationCapabilities,
    topic: NotificationTopicDeclaration,
    request: SetNotificationReminderInput,
    player: string | undefined,
  ): Promise<ReminderResult> => {
    const scheduleLocal = provider.scheduleLocal;
    if (scheduleLocal === undefined) {
      return { route: 'local', status: 'unavailable' };
    }
    const records = await readRecords();
    const states = resolveStates(
      capabilities,
      await provider.getPermission({ topics: [topic.id] }),
      [topic.id],
      records,
    );
    const decision = evaluateLocalNotificationReminder({
      topic,
      permission: stateIn(states, topic.id),
      consent: records ?? [],
      fireAt: request.fireAt,
      timeZone: localZone(),
      // The topic's other pending reminders, which only its daily cap reads;
      // replacing one does not count it against itself.
      ...(topic.frequency === undefined
        ? {}
        : {
            pending: (await listLocalEntries()).flatMap((entry) =>
              entry.topic === topic.id && entry.key !== request.key && entry.fireAt !== undefined
                ? [{ fireAt: providerFireAt(entry.fireAt) }]
                : []),
          }),
    });
    if (decision.status !== 'schedule') {
      return { route: 'local', status: decision.status };
    }
    const locale = input.locale ?? input.defaultLocale;
    if (!hasLocalCopy(topic, locale, input.defaultLocale)) {
      return { route: 'local', status: 'unavailable' };
    }
    // Local copy is free-form content: the mapping's title and body, else the catalog copy.
    let content: NotificationDeliveryContent;
    try {
      content = resolveNotificationContent({
        topic,
        content: 'free-form',
        locale,
        defaultLocale: input.defaultLocale,
        ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
      });
    } catch (error) {
      throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    // One key across both routes: the server reminder with the key goes
    // first, for the player who began the call. After an account switch the
    // server reminder under the key is another player's, and it stays.
    if (capabilities.remote.supported && player !== undefined && sessionPlayer() === player) {
      await backend.cancelReminder({ key: request.key });
    }
    const scheduled = await scheduleLocal.call(provider, {
      key: request.key,
      topic: topic.id,
      fireAt: decision.fireAt,
      title: content.title ?? '',
      body: content.body ?? '',
      route: content.route,
    });
    if (scheduled.status === 'scheduled' || scheduled.status === 'replaced') {
      scheduledLocal.set(request.key, {
        key: request.key,
        topic: topic.id,
        fireAt: decision.fireAt,
      });
    }
    return {
      route: 'local',
      status: scheduled.status === 'unsupported' ? 'unavailable' : scheduled.status,
    };
  };
  /** Inside the local queue: removes a pending local reminder; whether one was pending. */
  const removeLocalKey = async (key: string): Promise<boolean> => {
    const cancelLocal = provider.cancelLocal;
    if (cancelLocal === undefined) {
      return false;
    }
    const pending = (await listLocalEntries()).some((entry) => entry.key === key);
    if (pending || provider.listLocal === undefined) {
      // Without `listLocal` the runtime cannot tell, so it cancels anyway.
      await cancelLocal.call(provider, { keys: [key] });
      scheduledLocal.delete(key);
    }
    return pending;
  };

  // Events and authentication.

  const onProviderEvent = (event: NotificationEvent): void => {
    // The runtime's own handling first, so a game listener cannot skip it.
    if (event.type === 'endpoint-changed') {
      const { registration } = event;
      track(enqueue('register', async () => {
        const { remote } = await provider.getCapabilities();
        const platformUser = registration.address.kind === 'platform-user';
        if (
          remote.supported
          && (remote.addressing === 'platform-user') === platformUser
          && remote.addressing !== 'none'
        ) {
          // A rotated address replaces the old one for this installation; a
          // platform user's changed locale or zone reaches the backend too.
          await sendRegistration(registration, false);
        }
      }));
    }
    if (event.type === 'permission-changed') {
      // The change belongs to the player authenticated now.
      const player = sessionPlayer();
      track((async () => {
        const capabilities = await provider.getCapabilities();
        const topics = Object.keys(event.snapshot.topics);
        const states = resolveStates(capabilities, event.snapshot, topics, await readRecords());
        await enqueue('record', () => writeRecords(permissionRecords(
          capabilities,
          hostObservations(capabilities, states, topics),
          undefined,
          player,
        )));
        await syncRegistration(capabilities, states.app);
        await cancelRevokedLocal(capabilities, states, topics);
      })());
    }
    emit(event);
  };
  const onAuthenticated = (): void => {
    // Records observed before authentication go to this session's player, the
    // registration goes again (a new session always sends it), and pending
    // local reminders meet the player's records.
    track(queueRecords([]));
    track(registerCurrent(false, true));
    track(reconcileLocal());
  };

  return {
    async start() {
      unsubscribeProvider ??= provider.subscribe(onProviderEvent);
      unsubscribeAuthentication ??= backend.onAuthenticated(onAuthenticated);
      const capabilities = await provider.getCapabilities();
      configurationIssue = input.registryEntry === undefined || !capabilities.remote.supported
        ? undefined
        : notificationRegistryMismatch(capabilities, input.registryEntry);
      // A backend that cannot answer does not fail the start; the next read reconciles.
      await settle(reconcileLocal());
      await settle(refreshRegistration());
    },
    stop() {
      unsubscribeProvider?.();
      unsubscribeProvider = undefined;
      unsubscribeAuthentication?.();
      unsubscribeAuthentication = undefined;
      listeners.clear();
      buffer = [];
      // A later start buffers events for its first subscriber again.
      gameSubscribed = false;
    },
    async runUntilIdle() {
      while (background.size > 0) {
        await Promise.all([...background]);
      }
      const first = failure;
      failure = undefined;
      if (first !== undefined) {
        throw first.count === 1
          ? first.error
          : new AggregateError(
            [first.error],
            `${first.count} background failures since the last runUntilIdle; the first: `
              + describeError(first.error),
          );
      }
    },
    async getPermission(input): Promise<NotificationRuntimePermissionSnapshot> {
      assertTopics(input.topics, false);
      // A topic listed twice is read once.
      const request = { topics: [...new Set(input.topics)] };
      const player = sessionPlayer();
      const capabilities = await capabilitiesOf();
      const snapshot = await provider.getPermission({ topics: request.topics });
      if (capabilities.availability === 'unsupported') {
        return {
          ...snapshot,
          sources: Object.fromEntries(request.topics.map((topic) => [topic, 'host' as const])),
        };
      }
      let records: NotificationConsentRecord[] | undefined;
      try {
        records = await readRecords();
      } catch (error) {
        // A read still answers when the backend cannot.
        fail(error);
      }
      const states = resolveStates(capabilities, snapshot, request.topics, records);
      await settle(queueRecords(permissionRecords(
        capabilities,
        hostObservations(capabilities, states, request.topics),
        undefined,
        player,
      )));
      await settle(syncRegistration(capabilities, states.app));
      await settle(cancelRevokedLocal(capabilities, states, request.topics));
      if (records !== undefined) {
        await settle(reconcileLocal());
      }
      await settle(refreshRegistration());
      return {
        ...(states.app === undefined ? {} : { app: states.app }),
        topics: states.topics,
        sources: states.sources,
        ...(snapshot.requiredAction === undefined ? {} : { requiredAction: snapshot.requiredAction }),
      };
    },
    async requestPermission(input): Promise<NotificationPermissionResult> {
      assertTopics(input.topics, true);
      // A topic listed twice is asked, and recorded, once.
      const request = { ...input, topics: [...new Set(input.topics)] };
      // The records belong to the player signed in when the prompt opened.
      const player = sessionPlayer();
      if (typeof request.gesture !== 'boolean') {
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
          message: 'requestPermission needs a boolean gesture.',
        });
      }
      const capabilities = await capabilitiesOf();
      const every = (outcome: NotificationPermissionOutcome): Record<string, NotificationPermissionOutcome> =>
        Object.fromEntries(request.topics.map((topic) => [topic, outcome]));
      if (capabilities.availability === 'unsupported') {
        // Unsupported is an answer: no prompt is reached.
        return {
          snapshot: await provider.getPermission({ topics: request.topics }),
          outcomes: every('unavailable'),
        };
      }
      if (capabilities.permission.userGesture && !request.gesture) {
        throw new NotificationError('NOTIFICATIONS_USER_GESTURE_REQUIRED', {
          message: 'This provider asks for notification permission only inside a player gesture.',
        });
      }
      const before = await provider.getPermission({ topics: request.topics });
      if (capabilities.availability === 'action-required') {
        // The game resolves the action (identity.requestUpgrade on Devvit) and asks again.
        return {
          snapshot: before,
          outcomes: every('action-required'),
          requiredAction: before.requiredAction ?? 'login',
        };
      }
      const scope = capabilities.permission.scope;
      const outcomes = new Map<string, NotificationPermissionOutcome>();
      const asked: string[] = [];
      for (const topic of request.topics) {
        const declared = topicOf(topic);
        if (declared?.mapping === undefined) {
          outcomes.set(topic, 'unavailable');
        } else if (scope === 'topic' && notificationTopicNeedsNoAgreement(declared)) {
          outcomes.set(topic, 'already-granted');
        } else if (notificationPermissionStateOf(before, topic) === 'blocked') {
          // Only a state the provider read from the host stops a request; a record never does.
          outcomes.set(topic, 'blocked');
        } else {
          asked.push(topic);
        }
      }
      const result = asked.length === 0
        ? undefined
        : await provider.requestPermission({ topics: asked });
      for (const topic of asked) {
        outcomes.set(
          topic,
          result !== undefined && Object.prototype.hasOwnProperty.call(result.outcomes, topic)
            ? (result.outcomes[topic] ?? 'unavailable')
            : 'unavailable',
        );
      }
      // The host has answered: its answer is returned whatever the backend does.
      let records: NotificationConsentRecord[] | undefined;
      try {
        records = await readRecords();
      } catch (error) {
        fail(error);
      }
      const after = mergeSnapshots(before, result?.snapshot, asked, outcomes, scope);
      const states = resolveStates(
        capabilities,
        after,
        request.topics,
        records,
        asked.some((topic) => outcomes.get(topic) === 'denied'),
      );
      const decidedTopics = asked.filter((topic) => isDecision(outcomes.get(topic)));
      const observations: Observation[] = scope === 'app'
        ? (states.app === undefined || states.appSource !== 'host' || decidedTopics.length === 0
          ? []
          : [{ state: states.app, accepted: asked.some((topic) => isAcceptance(outcomes.get(topic))) }])
        : decidedTopics
          .filter((topic) => states.sources[topic] === 'host')
          .map((topic) => ({
            topic,
            state: stateIn(states, topic),
            accepted: isAcceptance(outcomes.get(topic)),
          }));
      const pending = permissionRecords(capabilities, observations, result?.evidence, player);
      if (scope === 'topic') {
        for (const topic of asked) {
          // Accepting a requested topic's agreement is the player's request for it.
          if (isAcceptance(outcomes.get(topic)) && topicOf(topic)?.purpose === 'requested') {
            pending.push({
              mode: 'changed',
              player,
              record: { kind: 'topic-preference', topic, state: 'granted', source: 'player', at: clock.now() },
            });
          }
        }
      }
      await settle(queueRecords(pending));
      await settle(syncRegistration(capabilities, states.app));
      await settle(cancelRevokedLocal(capabilities, states, request.topics));
      return {
        snapshot: {
          ...(states.app === undefined ? {} : { app: states.app }),
          topics: states.topics,
          ...(result?.snapshot.requiredAction === undefined
            ? {}
            : { requiredAction: result.snapshot.requiredAction }),
        },
        outcomes: Object.fromEntries(request.topics.map((topic) => [topic, outcomes.get(topic) ?? 'unavailable'])),
        ...(result?.requiredAction === undefined ? {} : { requiredAction: result.requiredAction }),
        ...(result?.evidence === undefined ? {} : { evidence: result.evidence }),
      };
    },
    async revokePermission(input): Promise<NotificationPermissionResult> {
      assertTopics(input.topics, true);
      const request = { topics: [...new Set(input.topics)] };
      const player = sessionPlayer();
      const capabilities = await capabilitiesOf();
      const revoke = provider.revokePermission;
      if (capabilities.permission.prompt !== 'game' || revoke === undefined) {
        throw new NotificationError('NOTIFICATIONS_UNSUPPORTED', {
          message: 'Only a game-rendered consent is withdrawn in the game; others change in OS or host settings.',
        });
      }
      if (capabilities.availability === 'action-required') {
        // A logged-out player has no consent at the host to withdraw yet.
        const snapshot = await provider.getPermission({ topics: request.topics });
        return {
          snapshot,
          outcomes: Object.fromEntries(request.topics.map((topic) => [topic, 'action-required' as const])),
          requiredAction: snapshot.requiredAction ?? 'login',
        };
      }
      const result = await revoke.call(provider, { topics: request.topics });
      // Read again: a revocation is a decision, so not opted in reads `denied` from here on.
      const states = resolveStates(
        capabilities,
        await provider.getPermission({ topics: request.topics }),
        request.topics,
        undefined,
        true,
      );
      if (
        capabilities.permission.scope === 'app'
        && !isDeviceAddressing(capabilities)
        && states.app !== undefined
        && isRecordableNotificationPermissionState(states.app)
      ) {
        await settle(queueRecords([{
          mode: 'changed',
          player,
          record: { kind: 'delivery-permission', state: states.app, source: 'player', at: clock.now() },
        }]));
      }
      // A device endpoint stops at the host's answer too.
      await settle(syncRegistration(capabilities, states.app));
      await settle(cancelRevokedLocal(capabilities, states, request.topics));
      return {
        snapshot: { ...(states.app === undefined ? {} : { app: states.app }), topics: states.topics },
        outcomes: Object.fromEntries(request.topics.map((topic) => [
          topic,
          Object.prototype.hasOwnProperty.call(result.outcomes, topic)
            ? (result.outcomes[topic] ?? 'denied')
            : 'denied',
        ])),
      };
    },
    async register() {
      await capabilitiesOf();
      await registerCurrent(true, true);
    },
    async unregister() {
      // The player signing out, captured before any wait, and the unbind
      // queued at once, so an authentication that follows is never the one
      // unbound.
      const session = backend.session();
      const unbinding = enqueue('register', async () => {
        // Persisted: a restart before the next authentication binds nothing.
        storage.unbound = true;
        if (session === undefined || !isDeviceAddressing(await provider.getCapabilities())) {
          return;
        }
        await backend.unregisterEndpoint({ provider: provider.provider, player: session.player });
        if (storage.registration?.session === session.id) {
          delete storage.registration;
        }
      });
      // The device's pending local reminders belong to the player leaving.
      // They are cancelled whether or not the unbind reaches the backend (an
      // offline logout), and either failure is thrown once both have run.
      const outcomes = await Promise.allSettled([unbinding, cancelLocalWhere(() => true)]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason as unknown] : []);
      if (failures.length > 1) {
        throw new AggregateError(failures, 'unregister() could neither unbind nor cancel the local reminders.');
      }
      if (failures.length === 1) {
        throw failures[0];
      }
    },
    async setTopicPreference(request) {
      if (
        typeof request.topic !== 'string'
        || topicOf(request.topic) === undefined
        || typeof request.enabled !== 'boolean'
      ) {
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
          message: 'setTopicPreference needs a declared topic and a boolean.',
        });
      }
      if (!request.enabled && sessionPlayer() === undefined) {
        // The device stops showing the topic's reminders even before the
        // player signs in; the withdrawal itself needs the player.
        await cancelLocalWhere((entry) => entry.topic === request.topic);
      }
      const player = requirePlayer('setTopicPreference');
      await capabilitiesOf();
      // The withdrawal is recorded first, so the server stops sending and no
      // new local reminder passes the gate even if cancelling fails.
      await queueRecords([{
        mode: 'changed',
        player,
        record: {
          kind: 'topic-preference',
          topic: request.topic,
          state: request.enabled ? 'granted' : 'withdrawn',
          source: 'player',
          at: clock.now(),
        },
      }]);
      if (!request.enabled) {
        await cancelLocalWhere((entry) => entry.topic === request.topic);
      }
    },
    async setAdvertisingConsent(request) {
      const states = [request.advertising, request.night];
      if (
        states.every((state) => state === undefined)
        || states.some((state) => state !== undefined && state !== 'granted' && state !== 'withdrawn')
        || typeof request.textVersion !== 'string'
        || request.textVersion.trim() === ''
      ) {
        throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
          message: 'setAdvertisingConsent needs an advertising or night decision and the consent text version.',
        });
      }
      const player = requirePlayer('setAdvertisingConsent');
      await capabilitiesOf();
      // Each call is a consent decision the law asks to notify, so each one is appended.
      await queueRecords((['advertising', 'night'] as const).flatMap((kind) => {
        const state = request[kind];
        return state === undefined
          ? []
          : [{
              mode: 'always' as const,
              player,
              record: {
                kind,
                state,
                source: 'player' as const,
                at: clock.now(),
                textVersion: request.textVersion,
              },
            }];
      }));
      // Advertising never takes the local route, so there is nothing to cancel.
    },
    reminders: {
      async set(request) {
        const issue = reminderInputIssue(request);
        if (issue !== undefined) {
          throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
            message: `Invalid reminder: ${issue}.`,
          });
        }
        // A server reminder belongs to the player signed in when the call began.
        const player = sessionPlayer();
        const capabilities = await capabilitiesOf();
        const topic = topicOf(request.topic);
        if (topic === undefined) {
          return { route: 'none', status: 'unavailable' };
        }
        const route = routeNotificationReminder(topic, capabilities);
        if (route === 'none') {
          return { route, status: 'unavailable' };
        }
        if (route === 'remote' && capabilities.remote.content === 'host-template' && request.templateData !== undefined) {
          // Template context stays on the server, as in v1.
          throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
            message: 'A host-template provider takes no templateData in a reminder.',
          });
        }
        if (capabilities.availability === 'action-required') {
          return { route, status: 'action-required' };
        }
        if (route === 'local') {
          // In the local queue, so a withdrawal or revocation sweep that starts
          // while this reads consent runs after the schedule and cancels it.
          return enqueue('local', () => scheduleLocalReminder(capabilities, topic, request, player));
        }
        // A server reminder needs the signed-in player, checked before anything changes.
        requireSignedIn('reminders.set', player);
        // One key across both routes: the local reminder with the key goes first.
        if (capabilities.local.supported) {
          await enqueue('local', () => removeLocalKey(request.key));
        }
        assertSamePlayer('reminders.set', player);
        return {
          route,
          status: await backend.setReminder({
            key: request.key,
            topic: topic.id,
            fireAt: normalizeNotificationTimestamp(request.fireAt),
            ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
            ...(request.link === undefined ? {} : { link: request.link }),
          }),
        };
      },
      async cancel(request) {
        const issue = notificationKeyIssue(request.key);
        if (issue !== undefined) {
          throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
            message: `Invalid reminder key: ${issue}.`,
          });
        }
        const player = sessionPlayer();
        const capabilities = await capabilitiesOf();
        // One key across both routes: each route that has the key loses it.
        const local = capabilities.local.supported
          && (await enqueue('local', () => removeLocalKey(request.key)));
        let remote = false;
        if (capabilities.remote.supported) {
          if (capabilities.availability === 'action-required') {
            return { route: 'remote', status: 'action-required' };
          }
          requireSignedIn('reminders.cancel', player);
          remote = await backend.cancelReminder({ key: request.key });
        }
        // Both routes have the key only after a local reminder was set while
        // signed out; the local one is the latest set, so it answers.
        if (local) {
          return { route: 'local', status: 'cancelled' };
        }
        // Nothing is pending under the key any more.
        return { route: remote ? 'remote' : 'none', status: 'cancelled' };
      },
    },
    notices: {
      async list() {
        // The notices of the player signed in when the call began.
        const player = sessionPlayer();
        await capabilitiesOf();
        requireSignedIn('notices.list', player);
        const notices = await backend.listNotices();
        assertSamePlayer('notices.list', player);
        return notices;
      },
      async recordShown(request) {
        const player = sessionPlayer();
        // The backend gets only the name, with the record time in the canonical
        // form; a name that matches no listed notice records nothing.
        const notice = noticeIdentityOf(recordNoticeInputOf(request));
        await capabilitiesOf();
        requireSignedIn('notices.recordShown', player);
        await backend.recordNotice({ ...notice, channel: 'in-game' });
      },
    },
    async openSettings() {
      const capabilities = await capabilitiesOf();
      const openSettings = provider.openSettings;
      return capabilities.permission.settings && openSettings !== undefined
        ? openSettings.call(provider)
        : 'unavailable';
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!gameSubscribed) {
        gameSubscribed = true;
        const drained = buffer;
        buffer = [];
        // The first subscriber receives every buffered event once, even if it throws on one.
        for (const error of deliverEach([listener], drained)) {
          fail(error);
        }
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function assertTopics(topics: unknown, nonEmpty: boolean): void {
  if (
    !Array.isArray(topics)
    || (nonEmpty && topics.length === 0)
    || topics.some((topic) => typeof topic !== 'string' || topic.length === 0)
  ) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: nonEmpty ? 'Expected at least one topic id.' : 'Expected a list of topic ids.',
    });
  }
}

/**
 * The snapshot after a request: the host's answer for the asked topics over
 * the read before it, and the answer a prompt just gave for a topic the host
 * cannot read back.
 */
function mergeSnapshots(
  before: NotificationPermissionSnapshot,
  after: NotificationPermissionSnapshot | undefined,
  asked: readonly string[],
  outcomes: ReadonlyMap<string, NotificationPermissionOutcome>,
  scope: NotificationCapabilities['permission']['scope'],
): NotificationPermissionSnapshot {
  const topics = new Map<string, NotificationPermissionState>(Object.entries(before.topics));
  for (const [topic, state] of Object.entries(after?.topics ?? {})) {
    topics.set(topic, state);
  }
  let app = after?.app ?? before.app;
  for (const topic of asked) {
    const decided = outcomeState(outcomes.get(topic));
    if (decided === undefined) {
      continue;
    }
    if (scope === 'app') {
      app = app === undefined || app === 'unknown' ? decided : app;
    } else if ((topics.get(topic) ?? 'unknown') === 'unknown') {
      topics.set(topic, decided);
    }
  }
  if (scope === 'app' && app !== undefined) {
    // An app-scope topic reads the app state; an `unknown` entry for it does not outlive the answer.
    for (const topic of asked) {
      if (topics.get(topic) === 'unknown') {
        topics.set(topic, app);
      }
    }
  }
  return { ...(app === undefined ? {} : { app }), topics: Object.fromEntries(topics) };
}

/** The state a decided outcome leaves when the host cannot be read. */
function outcomeState(
  outcome: NotificationPermissionOutcome | undefined,
): NotificationRecordablePermissionState | undefined {
  switch (outcome) {
    case 'granted':
    case 'already-granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'blocked':
      return 'blocked';
    default:
      return undefined;
  }
}

function stateIn(states: ResolvedStates, topic: string): NotificationPermissionState {
  return Object.prototype.hasOwnProperty.call(states.topics, topic)
    ? (states.topics[topic] ?? 'unknown')
    : (states.app ?? 'unknown');
}

function isDeviceAddressing(capabilities: NotificationCapabilities): boolean {
  return capabilities.remote.supported && capabilities.remote.addressing === 'device';
}

/** A known permission other than `granted`: the device no longer shows local reminders. */
function revokesLocalReminders(state: NotificationPermissionState): boolean {
  return state === 'prompt'
    || state === 'prompt-with-rationale'
    || state === 'denied'
    || state === 'blocked';
}

function isAcceptance(outcome: NotificationPermissionOutcome | undefined): boolean {
  return outcome === 'granted' || outcome === 'already-granted';
}

/** An answer the player gave: never `dismissed`, `action-required`, or `unavailable`. */
function isDecision(outcome: NotificationPermissionOutcome | undefined): boolean {
  return outcomeState(outcome) !== undefined;
}

/** The latest permission state recorded for a kind and scope; `withdrawn` is not a permission state. */
function latestRecordState(
  records: readonly NotificationConsentRecord[],
  kind: NotificationConsentKind,
  topic: string | undefined,
): NotificationRecordablePermissionState | undefined {
  const state = latestNotificationConsent(records, kind, topic)?.state;
  return state === undefined || state === 'withdrawn' ? undefined : state;
}

/**
 * A pending reminder's `fireAt` as the provider listed it, which the daily cap
 * reads: one that does not parse strictly is the provider breaking the
 * contract, not the game's input.
 */
function providerFireAt(fireAt: string): string {
  if (!isNotificationTimestamp(fireAt)) {
    throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      message: `The provider listed a local reminder whose fireAt is not RFC 3339 with a date that exists: ${JSON.stringify(fireAt)}.`,
    });
  }
  return fireAt;
}

/** Whether the topic preference alone refuses a reminder of `topic` now. */
function preferenceRefuses(
  topic: NotificationTopicDeclaration,
  records: readonly NotificationConsentRecord[],
  at: string,
): boolean {
  const decision = evaluateLocalNotificationReminder({
    topic,
    permission: 'granted',
    consent: records,
    fireAt: at,
    timeZone: 'UTC',
  });
  return decision.status === 'request-missing' || decision.status === 'preference-off';
}

function hasLocalCopy(
  topic: NotificationTopicDeclaration,
  locale: string,
  defaultLocale: string,
): boolean {
  return (typeof topic.mapping?.['title'] === 'string' && typeof topic.mapping['body'] === 'string')
    || findNotificationCopy(topic, locale, defaultLocale) !== undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Runner.

export interface NotificationConformanceHarness {
  readonly provider: NotificationProvider;
  /**
   * Handles `host` steps and counts prompts and local operations. A vector
   * that scripts the host, or expects `prompts` or `local.operations` (or
   * `local.pending` from a provider without `listLocal`), fails without it.
   */
  readonly host?: NotificationConformanceHostActor;
  /**
   * The evidence schema this provider attaches to a host agreement. Vector
   * expectations naming the fixture schema `fixture.host-agreement.v1` match
   * it instead.
   */
  readonly hostAgreementEvidenceSchema?: string;
}

export interface NotificationConformanceContext {
  readonly vector: NotificationConformanceVector;
  readonly profile: NotificationConformanceProfile;
  readonly catalog: readonly NotificationTopicDeclaration[];
  readonly clock: NotificationConformanceClock;
  readonly player: string;
  /** The device zone, which the provider registers. */
  readonly timeZone: string;
}

export interface NotificationConformanceRunOptions {
  /** Supplies a provider over the caller's fake SDK; defaults to the fake host's fixture provider. */
  readonly createProvider?: (
    context: NotificationConformanceContext,
  ) => NotificationConformanceHarness | Promise<NotificationConformanceHarness>;
  readonly defaultLocale?: string;
}

export interface NotificationConformanceFailure {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export type NotificationConformanceVectorStatus = 'passed' | 'failed' | 'skipped';

export interface NotificationConformanceVectorResult {
  readonly vector: string;
  /** `skipped` vectors did not run; `passed` is false and `reason` says why. */
  readonly status: NotificationConformanceVectorStatus;
  readonly passed: boolean;
  readonly failures: readonly NotificationConformanceFailure[];
  readonly reason?: string;
}

export function createNotificationConformanceHarness(
  context: NotificationConformanceContext,
): NotificationConformanceHarness {
  const host = createNotificationConformanceHost({
    profile: context.profile,
    catalog: context.catalog,
    timeZone: context.timeZone,
    ...(context.vector.host === undefined ? {} : { host: context.vector.host }),
  });
  return { provider: host.provider, host };
}

/** Why `vector` does not apply to a provider with `capabilities`, or `undefined` when it runs. */
export function notificationConformanceSkipReason(
  vector: NotificationConformanceVector,
  capabilities: NotificationCapabilities,
): string | undefined {
  return notificationConformanceAppliesToReason(vector.appliesTo, capabilities);
}

/**
 * Runs one vector: reads the provider's capabilities and skips the vector when
 * they do not satisfy `appliesTo`, executes every step (a step's `returns` is
 * matched as a subset, its `throws` by `code`), lets the runtime settle after
 * each, then matches `expect`. Lists match exactly in length and order with
 * only the listed fields of each item asserted, a field set to `null` asserts
 * that it is absent, and timestamps compare as instants. Any unscripted
 * operation fails the vector at the step that needed it.
 *
 * The backend's registry entry is derived from the provider's own
 * capabilities and the profile's limits. A `setReminder` step that expects a
 * local `permission-required` also calls the provider's `scheduleLocal`
 * directly: it must answer `permission-required` without prompting or
 * scheduling. With `options.createProvider`, the fixture provider id and the
 * fixture agreement evidence schema in `returns` and `expect` match the
 * provider under test's own id and `hostAgreementEvidenceSchema`.
 */
export async function runNotificationConformanceVector(
  vector: NotificationConformanceVector,
  options: NotificationConformanceRunOptions = {},
): Promise<NotificationConformanceVectorResult> {
  const failed = (
    failures: readonly NotificationConformanceFailure[],
  ): NotificationConformanceVectorResult => ({
    vector: vector.vector,
    status: 'failed',
    passed: false,
    failures,
  });
  let clock: NotificationConformanceClock;
  try {
    clock = createNotificationConformanceClock(vector.context.now);
  } catch (error) {
    return failed([
      { path: 'context.now', expected: 'an RFC 3339 instant', actual: describeError(error) },
    ]);
  }
  const context: NotificationConformanceContext = {
    vector,
    profile: vector.profile,
    catalog: vector.catalog,
    clock,
    player: vector.context.player,
    timeZone: vector.context.timeZone,
  };
  let harness: NotificationConformanceHarness;
  let capabilities: NotificationCapabilities;
  try {
    harness = await (options.createProvider ?? createNotificationConformanceHarness)(context);
  } catch (error) {
    return failed([
      { path: 'harness', expected: 'createProvider resolves', actual: describeError(error) },
    ]);
  }
  try {
    capabilities = await harness.provider.getCapabilities();
  } catch (error) {
    return failed([
      {
        path: 'capabilities',
        expected: 'provider.getCapabilities() resolves',
        actual: describeError(error),
      },
    ]);
  }
  const reason = notificationConformanceSkipReason(vector, capabilities);
  if (reason !== undefined) {
    return { vector: vector.vector, status: 'skipped', passed: false, failures: [], reason };
  }
  const defaultLocale = options.defaultLocale ?? notificationConformanceDefaultLocale;
  const host = harness.host;
  const readServerPermission = host?.readServerPermission;
  const entry = notificationConformanceRegistryEntry({
    provider: harness.provider.provider,
    capabilities,
    ...(vector.profile.limits === undefined ? {} : { limits: vector.profile.limits }),
  });
  let backend: NotificationConformanceBackend;
  try {
    backend = createNotificationConformanceBackend({
      entry,
      catalog: vector.catalog,
      clock,
      ...(vector.deployment === undefined ? {} : { deployment: vector.deployment }),
      ...(vector.notices === undefined ? {} : { noticeCopy: vector.notices.copy }),
      defaultLocale,
      defaultPlayer: vector.context.player,
      ...(host === undefined || readServerPermission === undefined
        ? {}
        : { readServerPermission: (request) => readServerPermission.call(host, request) }),
    });
  } catch (error) {
    return failed([
      { path: 'backend', expected: 'the deployment is valid', actual: describeError(error) },
    ]);
  }
  const storage: NotificationConformanceRuntimeStorage = {};
  const createRuntime = (): NotificationConformanceRuntime =>
    createNotificationConformanceRuntime({
      provider: harness.provider,
      backend,
      catalog: vector.catalog,
      clock,
      timeZone: vector.deployment?.timeZone ?? notificationDefaultDeploymentTimeZone,
      defaultLocale,
      storage,
      ...(entry === undefined ? {} : { registryEntry: entry }),
    });
  const execution: Execution = {
    harness,
    backend,
    clock,
    runtime: createRuntime(),
    createRuntime,
    events: {},
    failures: [],
  };
  const adapted = adaptVector(vector, harness);
  for (const [index, step] of adapted.steps.entries()) {
    const path = `steps[${index}]`;
    try {
      await runStep(step, path, execution);
      await execution.runtime.runUntilIdle();
    } catch (error) {
      execution.failures.push({
        path,
        expected: `${step.actor}.${step.action} completes`,
        actual: describeError(error),
      });
      return failed(execution.failures);
    }
  }
  if (execution.failures.length > 0) {
    return failed(execution.failures);
  }
  try {
    await matchExpectations(adapted.expect, execution);
  } catch (error) {
    // A provider read that throws while expectations are evaluated is a failed
    // run, never a rejected promise.
    execution.failures.push({
      path: 'expect',
      expected: 'expectations evaluate',
      actual: describeError(error),
    });
  }
  return {
    vector: vector.vector,
    status: execution.failures.length === 0 ? 'passed' : 'failed',
    passed: execution.failures.length === 0,
    failures: execution.failures,
  };
}

export async function runNotificationConformanceVectors(
  vectors: readonly NotificationConformanceVector[],
  options: NotificationConformanceRunOptions = {},
): Promise<readonly NotificationConformanceVectorResult[]> {
  const results: NotificationConformanceVectorResult[] = [];
  for (const vector of vectors) {
    results.push(await runNotificationConformanceVector(vector, options));
  }
  return results;
}

interface Execution {
  readonly harness: NotificationConformanceHarness;
  readonly backend: NotificationConformanceBackend;
  readonly clock: NotificationConformanceClock;
  runtime: NotificationConformanceRuntime;
  readonly createRuntime: () => NotificationConformanceRuntime;
  readonly events: Record<string, NotificationEvent[]>;
  readonly failures: NotificationConformanceFailure[];
}

function hostOf(
  execution: Execution,
  step: NotificationConformanceStep,
): NotificationConformanceHostActor {
  if (execution.harness.host === undefined) {
    throw new NotificationConformanceScriptError(
      `The harness has no host actor for ${step.actor}.${step.action}.`,
    );
  }
  return execution.harness.host;
}

async function runStep(
  step: NotificationConformanceStep,
  path: string,
  execution: Execution,
): Promise<void> {
  switch (step.actor) {
    case 'runtime':
      if (step.action === 'restart') {
        execution.runtime.stop();
        execution.harness.host?.restart?.();
        execution.runtime = execution.createRuntime();
      }
      await execution.runtime.start();
      return;
    case 'clock':
      if (step.action === 'set') {
        execution.clock.set(step.at);
      } else {
        execution.clock.advance(step.seconds);
      }
      return;
    case 'host': {
      const host = hostOf(execution, step);
      switch (step.action) {
        case 'queuePrompt':
          host.queuePrompt(step.result);
          return;
        case 'setPermission':
          host.setPermission(step.state);
          return;
        case 'issueEndpoint':
          host.issueEndpoint(step.endpoint);
          return;
        case 'completeAction':
          host.completeAction();
          return;
        case 'tap':
          host.tap(step.input);
          return;
      }
      return;
    }
    case 'game':
      await runGameStep(step, path, execution);
      return;
    case 'backend':
      await runBackendStep(step, path, execution);
  }
}

type GameStep = Extract<NotificationConformanceStep, { readonly actor: 'game' }>;
type BackendStep = Extract<NotificationConformanceStep, { readonly actor: 'backend' }>;

async function runBackendStep(step: BackendStep, path: string, execution: Execution): Promise<void> {
  const { backend } = execution;
  switch (step.action) {
    case 'authenticate':
      backend.authenticate(step.player);
      return;
    case 'deliver':
      await expectAnswer(step, path, execution, () => backend.deliver(step.input));
      return;
    case 'queueProviderResult':
      backend.queueProviderResult(providerResultOf(step));
      return;
    case 'registerEndpoint':
      backend.registerInstallation(step.input);
      return;
    case 'revokeSession':
      backend.revokeSession();
      return;
    case 'runScheduler':
      await backend.runScheduler();
  }
}

function providerResultOf(
  step: Extract<BackendStep, { readonly action: 'queueProviderResult' }>,
): NotificationConformanceProviderResult {
  switch (step.result) {
    case 'rate-limited':
      return step.retryAfterSeconds === undefined
        ? { status: 'rate-limited' }
        : { status: 'rate-limited', retryAfterSeconds: step.retryAfterSeconds };
    case 'rejected':
      if (step.reason === undefined) {
        throw new NotificationConformanceScriptError(
          'A rejected provider answer needs its reason.',
        );
      }
      return { status: 'rejected', reason: step.reason };
    default:
      return { status: step.result };
  }
}

async function runGameStep(step: GameStep, path: string, execution: Execution): Promise<void> {
  const { runtime } = execution;
  switch (step.action) {
    case 'subscribe': {
      const events = execution.events[step.listener] ?? [];
      execution.events[step.listener] = events;
      runtime.subscribe((event) => {
        events.push(event);
      });
      return;
    }
    case 'getPermission':
      await expectAnswer(step, path, execution, () => runtime.getPermission(step.input));
      return;
    case 'requestPermission':
      await expectAnswer(step, path, execution, () => runtime.requestPermission(step.input));
      return;
    case 'revokePermission':
      await expectAnswer(step, path, execution, () => runtime.revokePermission(step.input));
      return;
    case 'register':
      await expectAnswer(step, path, execution, () => runtime.register());
      return;
    case 'unregister':
      await expectAnswer(step, path, execution, () => runtime.unregister());
      return;
    case 'setTopicPreference':
      await expectAnswer(step, path, execution, () => runtime.setTopicPreference(step.input));
      return;
    case 'setAdvertisingConsent':
      await expectAnswer(step, path, execution, () => runtime.setAdvertisingConsent(step.input));
      return;
    case 'setReminder': {
      const answered = await expectAnswer(step, path, execution, () =>
        runtime.reminders.set(step.input),
      );
      if (answered && step.returns?.status === 'permission-required' && step.returns.route !== 'remote') {
        await probeLocalPermission(step, path, execution);
      }
      return;
    }
    case 'cancelReminder':
      await expectAnswer(step, path, execution, () => runtime.reminders.cancel(step.input));
      return;
    case 'listNotices':
      await expectAnswer(step, path, execution, () => runtime.notices.list());
      return;
    case 'recordNotice':
      await expectAnswer(step, path, execution, () => runtime.notices.recordShown(step.input));
      return;
    case 'openSettings':
      await expectAnswer(step, path, execution, () => runtime.openSettings());
  }
}

/**
 * Runs a step's call and matches its `returns` or `throws`; an error the step
 * does not expect fails the vector. Whether the call answered.
 */
async function expectAnswer(
  step: { readonly returns?: unknown; readonly throws?: { readonly code: string } },
  path: string,
  execution: Execution,
  call: () => Promise<unknown>,
): Promise<boolean> {
  let value: unknown;
  try {
    value = await call();
  } catch (error) {
    if (step.throws === undefined) {
      throw error;
    }
    matchPartial(step.throws, { code: errorCodeOf(error) }, `${path}.throws`, execution.failures);
    return false;
  }
  if (step.throws !== undefined) {
    execution.failures.push({ path: `${path}.throws`, expected: step.throws, actual: 'returned' });
    return false;
  }
  if (step.returns !== undefined) {
    matchPartial(step.returns, value, `${path}.returns`, execution.failures);
  }
  return true;
}

/**
 * The provider rule behind `permission-required` (RFC "Conformance vectors"):
 * scheduling without permission answers `permission-required` and neither
 * prompts nor schedules. The runtime answers before it reaches the provider,
 * so the runner calls the provider itself.
 */
async function probeLocalPermission(
  step: Extract<GameStep, { readonly action: 'setReminder' }>,
  path: string,
  execution: Execution,
): Promise<void> {
  const { harness } = execution;
  if (harness.provider.scheduleLocal === undefined) {
    return;
  }
  // Prompts and operations are counted only where a host actor counts them.
  const { host } = harness;
  const counts = (): { readonly prompts?: number; readonly operations?: number } =>
    host === undefined ? {} : { prompts: host.prompts, operations: host.localOperations.length };
  const before = counts();
  const result = await harness.provider.scheduleLocal({
    key: step.input.key,
    topic: step.input.topic,
    fireAt: step.input.fireAt,
    title: 'probe',
    body: 'probe',
  });
  matchPartial(
    { status: 'permission-required', ...before },
    { status: result.status, ...counts() },
    `${path}.provider.scheduleLocal`,
    execution.failures,
  );
}

function errorCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code: unknown }).code
    : describeError(error);
}

/**
 * The vector with the fixture provider id replaced by the provider under
 * test's where a field names a provider (`provider` in every step's
 * `returns`, a send's input, and `expect`), and the fixture agreement
 * evidence schema by the provider's own where an evidence `schema` names it.
 * Any other field that holds the same text, such as an address or a topic,
 * stays as written.
 */
function adaptVector(
  vector: NotificationConformanceVector,
  harness: NotificationConformanceHarness,
): NotificationConformanceVector {
  const providerId = harness.provider.provider;
  const schema = harness.hostAgreementEvidenceSchema ?? notificationConformanceAgreementSchema;
  if (providerId === vector.profile.provider && schema === notificationConformanceAgreementSchema) {
    return vector;
  }
  const substitute = (value: unknown, key?: string): unknown => {
    if (key === 'provider' && value === vector.profile.provider) {
      return providerId;
    }
    if (key === 'schema' && value === notificationConformanceAgreementSchema) {
      return schema;
    }
    if (Array.isArray(value)) {
      return value.map((item) => substitute(item));
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([nestedKey, nested]) => [
          nestedKey,
          substitute(nested, nestedKey),
        ]),
      );
    }
    return value;
  };
  const steps = vector.steps.map((step) => {
    let adapted: NotificationConformanceStep = step;
    if ('returns' in adapted && adapted.returns !== undefined) {
      adapted = { ...adapted, returns: substitute(adapted.returns) } as NotificationConformanceStep;
    }
    if (adapted.actor === 'backend' && adapted.action === 'deliver' && adapted.input.provider !== undefined) {
      adapted = { ...adapted, input: { ...adapted.input, provider: providerId } };
    }
    return adapted;
  });
  return {
    ...vector,
    steps: steps as NotificationConformanceVector['steps'],
    expect: substitute(vector.expect) as NotificationConformanceExpectation,
  };
}

async function matchExpectations(
  expect: NotificationConformanceExpectation,
  execution: Execution,
): Promise<void> {
  const { backend, failures, harness } = execution;
  // Only a host actor counts prompts and local operations; without one these
  // expectations fail rather than read zero or nothing.
  const { host } = harness;
  const hostless = (path: string, expected: unknown): void => {
    failures.push({ path, expected, actual: 'the harness has no host actor to observe it' });
  };
  if (expect.prompts !== undefined) {
    if (host === undefined) {
      hostless('prompts', expect.prompts);
    } else {
      matchPartial(expect.prompts, host.prompts, 'prompts', failures);
    }
  }
  if (expect.consent !== undefined) {
    matchPartial(expect.consent, backend.consent, 'consent', failures);
  }
  if (expect.endpoints !== undefined) {
    matchPartial(expect.endpoints, backend.endpoints, 'endpoints', failures);
  }
  if (expect.deliveries !== undefined) {
    matchPartial(expect.deliveries, backend.deliveries, 'deliveries', failures);
  }
  if (expect.providerCalls !== undefined) {
    matchPartial(expect.providerCalls, backend.providerCalls, 'providerCalls', failures);
  }
  if (expect.local !== undefined) {
    if (expect.local.operations !== undefined) {
      if (host === undefined) {
        hostless('local.operations', expect.local.operations);
      } else {
        matchPartial(expect.local.operations, host.localOperations, 'local.operations', failures);
      }
    }
    if (expect.local.pending !== undefined) {
      if (harness.provider.listLocal !== undefined) {
        matchPartial(
          expect.local.pending,
          await harness.provider.listLocal(),
          'local.pending',
          failures,
        );
      } else if (host === undefined) {
        hostless('local.pending', expect.local.pending);
      } else {
        matchPartial(expect.local.pending, host.localPending, 'local.pending', failures);
      }
    }
  }
  if (expect.reminders !== undefined) {
    matchPartial(expect.reminders, backend.reminders, 'reminders', failures);
  }
  if (expect.events !== undefined) {
    for (const [listener, events] of Object.entries(expect.events)) {
      matchPartial(events, execution.events[listener] ?? [], `events.${listener}`, failures);
    }
  }
  if (expect.notices !== undefined) {
    matchPartial(expect.notices, backend.notices, 'notices', failures);
  }
}

/**
 * Partial match: an expected object asserts only its listed keys, `null`
 * asserts that the field is absent, an expected array asserts its length and
 * each element in order, two timestamps compare as instants, and other values
 * compare strictly. Failures name the deepest differing path.
 */
function matchPartial(
  expected: unknown,
  actual: unknown,
  path: string,
  failures: NotificationConformanceFailure[],
): void {
  if (expected === null) {
    if (actual !== undefined) {
      failures.push({ path, expected: 'absent', actual });
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      failures.push({ path, expected, actual });
      return;
    }
    if (expected.length !== actual.length) {
      failures.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
      return;
    }
    expected.forEach((item, index) => {
      matchPartial(item, actual[index], `${path}[${index}]`, failures);
    });
    return;
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      failures.push({ path, expected, actual });
      return;
    }
    const record = actual as Readonly<Record<string, unknown>>;
    for (const [key, value] of Object.entries(expected)) {
      matchPartial(
        value,
        Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined,
        `${path}.${key}`,
        failures,
      );
    }
    return;
  }
  // Two strict timestamps compare as instants; a spelling that does not parse
  // strictly, such as 31 September, is compared as text and never rolls over.
  if (
    typeof expected === 'string'
    && typeof actual === 'string'
    && isNotificationTimestamp(expected)
    && isNotificationTimestamp(actual)
  ) {
    if (normalizeNotificationTimestamp(expected) !== normalizeNotificationTimestamp(actual)) {
      failures.push({ path, expected, actual });
    }
    return;
  }
  if (expected !== actual) {
    failures.push({ path, expected, actual });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
