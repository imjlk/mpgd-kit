import type { StorageAdapter } from './index.js';
import {
  assertNotificationConsentRecord,
  evaluateLocalNotificationReminder,
  findNotificationCopy,
  isNotificationTimestamp,
  isRecordableNotificationPermissionState,
  isValidNotificationTimeZone,
  latestNotificationConsent,
  normalizeNotificationTimestamp,
  notificationDefaultDeploymentTimeZone,
  NotificationError,
  notificationKeyIssue,
  notificationPermissionConsentKind,
  notificationPermissionStateOf,
  notificationRegistryMismatch,
  notificationTopicNeedsNoAgreement,
  resolveNotificationContent,
  routeNotificationReminder,
  type CancelNotificationReminderInput,
  type NotificationBackendReminderSetStatus,
  type NotificationCapabilities,
  type NotificationConsentKind,
  type NotificationConsentRecord,
  type NotificationDeliveryContent,
  type NotificationDeliveryProviderEntry,
  type NotificationEndpointRegistration,
  type NotificationEvent,
  type NotificationNotice,
  type NotificationNoticeIdentity,
  type NotificationPermissionOutcome,
  type NotificationPermissionResult,
  type NotificationPermissionSnapshot,
  type NotificationPermissionState,
  type NotificationProvider,
  type NotificationRecordablePermissionState,
  type NotificationRuntime,
  type NotificationRuntimePermissionSnapshot,
  type NotificationTopicDeclaration,
  type ReminderResult,
  type SetNotificationReminderInput,
} from './notifications.js';
import {
  bufferEvent,
  comparableRegistryEntry,
  deliverEach,
  describeError,
  errorMessageOf,
  noticeIdentityOf,
  recordNoticeInputOf,
  reminderInputIssue,
} from './notifications-runtime-support.js';

/**
 * The notifications runtime (RFC "Runtime"): a target's
 * `NotificationProvider` composed with the game backend that keeps consent
 * records, endpoint registrations, server reminders, and notices for the
 * authenticated player. Games call the runtime, never the provider directly.
 *
 * The backend is a port (`NotificationRuntimeBackend`): the game-services
 * client in `@mpgd/game-services/notifications/client` implements it over the
 * game-services Worker's session routes, and the conformance runner's fake
 * backend implements it in memory. What survives a restart goes through
 * another port (`NotificationRuntimeStorage`). Pure code: no Phaser, DOM,
 * network, or SDK imports.
 */

const secondMs = 1000;
const dayMs = 24 * 60 * 60 * secondMs;
/** A registration identical to the last acknowledged one is skipped for this long. */
const registrationRefreshMs = 7 * dayMs;
/**
 * After a registration fails, reads retry it no sooner than this, doubling
 * with each failure in a row up to `registrationRetryMaxMs`. Start, a
 * sign-in, `register()`, and a changed address or permission send at once.
 */
const registrationRetryBaseMs = 30 * secondMs;
/** The longest a read waits to retry a failed registration. */
const registrationRetryMaxMs = 60 * 60 * secondMs;

/** The authenticated session a backend serves; the backend binds the installation to it. */
export interface NotificationRuntimeSession {
  /** Stable for the session's life: refreshing the session keeps it. */
  readonly id: string;
  readonly player: string;
}

/**
 * What setting a server reminder answers: stored, the gate step 3 to 5
 * refusal, `capacity-exceeded` past a backend's cap on a player's pending
 * reminders, or `unavailable` when no provider the player can be reached on
 * maps the topic (`NotificationBackendReminderSetStatus`).
 */
export type NotificationRuntimeReminderSetStatus = NotificationBackendReminderSetStatus;

/**
 * The backend surface the runtime calls for the authenticated session. Every
 * call acts for the session `session()` names when it is made; the backend
 * learns the session from its own authentication, never from a request field.
 * A call without a session, or for a session the backend no longer accepts,
 * throws `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
 */
export interface NotificationRuntimeBackend {
  /** The authenticated session; `undefined` before authentication and after the session ends. */
  session(): NotificationRuntimeSession | undefined;
  /**
   * Calls `listener` whenever a session starts, including a restored one and
   * an account switch; returns the unsubscribe. Refreshing the same session
   * (the same `id`) is not a start.
   */
  onAuthenticated(listener: (session: NotificationRuntimeSession) => void): () => void;
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
   * stays bound. Unlike the other calls, it may answer without a request when
   * `player` is no longer signed in: that session's end unbinds what it
   * registered (the game-services client does).
   */
  unregisterEndpoint(input: { readonly provider: string; readonly player: string }): Promise<void>;
  /** Checks gate steps 3 to 5, then stores or replaces the session player's reminder with this key. */
  setReminder(input: SetNotificationReminderInput): Promise<NotificationRuntimeReminderSetStatus>;
  /** Whether a pending reminder with this key, or a waiting send of one, existed. */
  cancelReminder(input: CancelNotificationReminderInput): Promise<boolean>;
  /** The session player's listed notices; none unless the deployment applies the Korean rules. */
  listNotices(): Promise<readonly NotificationNotice[]>;
  /**
   * Records a notice the game showed the session's player, named by its
   * identity fields, while that notice is listed; recording one that is not
   * listed changes nothing.
   */
  recordNotice(input: NotificationNoticeIdentity & { readonly channel: 'in-game' }): Promise<void>;
}

/** The last registration the backend acknowledged, with the player and session it was sent for. */
export interface NotificationRuntimePersistedRegistration {
  readonly registration: NotificationEndpointRegistration;
  readonly player: string;
  readonly session: string;
  readonly at: string;
}

/** What the runtime keeps across restarts (RFC "Runtime", "Restarts"). */
export interface NotificationRuntimeState {
  /** The last registration the backend acknowledged. */
  readonly registration?: NotificationRuntimePersistedRegistration;
  /**
   * Set by `unregister()`; `register()` or the next authentication clears it,
   * including one the runtime did not observe (see `unboundSession`).
   */
  readonly unbound?: boolean;
  /**
   * With `unbound`: the session signed in when `unregister()` ran. Another
   * session found at start or on a read, or any session when none was signed
   * in then, is a sign-in the runtime did not observe, so it binds again.
   */
  readonly unboundSession?: { readonly player: string; readonly session: string };
}

/**
 * Where the runtime keeps its state across restarts. `load` runs once, when
 * the runtime is created, and again after a load that failed; a failed load
 * is reported by the call that needed the state. `save` runs after each
 * change, with the whole state. Either may answer synchronously. A value
 * `load` answers that is not a runtime state reads as an empty one, and a
 * malformed entry in one (the registration, or the session `unregister()`
 * left) is left out while the others are kept. One
 * runtime owns a storage: a game with two runtimes gives each its own key.
 * The state holds the last registration as sent, push address included (an
 * FCM token): an address, not a credential, kept like other game data.
 */
export interface NotificationRuntimeStorage {
  load(): unknown;
  save(state: NotificationRuntimeState): void | Promise<void>;
}

/** The clock the runtime dates its records and registrations by (RFC 3339 instants). */
export interface NotificationRuntimeClock {
  now(): string;
}

export interface CreateNotificationRuntimeInput {
  readonly provider: NotificationProvider;
  readonly backend: NotificationRuntimeBackend;
  /** The provider's topics, each with this target's mapping (`resolveNotificationTopicsForTarget`). */
  readonly catalog: readonly NotificationTopicDeclaration[];
  /** The catalog's default locale. */
  readonly defaultLocale: string;
  /** The device locale for local reminder copy; defaults to `defaultLocale`. */
  readonly locale?: string;
  /**
   * The deployment's zone, for local quiet hours while the device has
   * registered none; defaults to `notificationDefaultDeploymentTimeZone`.
   */
  readonly timeZone?: string;
  /** Defaults to the system clock. */
  readonly clock?: NotificationRuntimeClock;
  /**
   * Survives restarts. Without it the state lives in memory, so a restart
   * re-sends the registration and forgets an `unregister()`; pass
   * `createNotificationRuntimeStorage({ storage: gateway.storage })` or
   * another durable port.
   */
  readonly storage?: NotificationRuntimeStorage;
  /**
   * The backend's registry entry for this provider. When the provider's
   * capabilities disagree with it at start, every call throws
   * `NOTIFICATIONS_CONFIGURATION_REQUIRED`, and nothing is registered, read,
   * or recorded in the background either. `unregister()` is the exception:
   * it still unbinds, since removing a device from a player is always safe. While a `loadRegistryEntry` is in
   * flight, registrations (including `register()`, which then resolves
   * before it is sent) and records that grant something wait without
   * holding any queue, and go out when the load settles without a mismatch;
   * withdrawals and refusals go out at once. An entry whose compared fields
   * (`provider`, `addressing`, `content`, `purposes`, `permission`) are
   * malformed is reported through `onError` at each start and left out, as
   * if none was given.
   */
  readonly registryEntry?: NotificationDeliveryProviderEntry;
  /**
   * Loads the registry entry when `start()` runs without `registryEntry`,
   * for example from the game-services Worker's `GET /providers`. The load
   * runs on its own: neither `start()` nor `runUntilIdle()` waits for it.
   * Until it answers, reads, prompts, and local reminders run without the
   * comparison, while registrations and granting records wait for it (see
   * `registryEntry`). A load that fails is
   * reported through `onError` and the next `runUntilIdle()`, and the runtime
   * goes on without the entry, so a backend it cannot reach does not turn notifications off;
   * the next `start()` loads it again. An answered entry that cannot be
   * compared (see `registryEntry`) is such a failure. An entry once loaded
   * is kept for the runtime's life.
   */
  readonly loadRegistryEntry?: () => Promise<NotificationDeliveryProviderEntry | undefined>;
  /**
   * Called with each failure of background work (records, registrations,
   * local reminders, game listeners) as it happens; `runUntilIdle` still
   * rethrows them. It runs synchronously: an error it throws, or a promise
   * it returns, is ignored.
   */
  readonly onError?: (error: unknown) => void;
}

export interface NotificationRuntimeController extends NotificationRuntime {
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

/** The storage key `createNotificationRuntimeStorage` uses by default. */
export const defaultNotificationRuntimeStorageKey = 'mpgd:notifications-runtime';

/**
 * A `NotificationRuntimeStorage` over the platform storage adapter
 * (`gateway.storage`), one JSON value under `key`. The host owns its
 * durability; a failed load or save surfaces from the runtime call that
 * needed it as `NOTIFICATIONS_TEMPORARILY_UNAVAILABLE`.
 */
export function createNotificationRuntimeStorage(input: {
  readonly storage: Pick<StorageAdapter, 'load' | 'save'>;
  readonly key?: string;
}): NotificationRuntimeStorage {
  const key = input.key ?? defaultNotificationRuntimeStorageKey;
  if (typeof key !== 'string' || key.length === 0) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'The notifications runtime storage key must be a non-empty string.',
    });
  }
  return {
    async load() {
      return (await input.storage.load({ key }))?.value;
    },
    async save(state) {
      await input.storage.save({ key, value: state });
    },
  };
}

/** A `NotificationRuntimeStorage` that lives in memory: nothing survives a restart. */
export function createMemoryNotificationRuntimeStorage(): NotificationRuntimeStorage {
  let stored: NotificationRuntimeState = {};
  return {
    load: () => stored,
    save(state) {
      stored = state;
    },
  };
}

/**
 * A stored value as a runtime state; anything else reads as an empty state.
 * Each entry is read on its own: a malformed one (or one whose getter or
 * `Proxy` trap throws) is left out, and the others are kept. Never throws.
 */
export function notificationRuntimeStateOf(value: unknown): NotificationRuntimeState {
  if (!isRecordValue(value)) {
    return {};
  }
  const registration = persistedRegistrationOf(fieldOf(value, 'registration'));
  // The session unregister() left means nothing without the unbound state.
  const unbound = fieldOf(value, 'unbound') === true;
  const unboundSession = unbound ? unboundSessionOf(fieldOf(value, 'unboundSession')) : undefined;
  return {
    ...(registration === undefined ? {} : { registration }),
    ...(unbound ? { unbound: true } : {}),
    ...(unboundSession === undefined ? {} : { unboundSession }),
  };
}

function unboundSessionOf(value: unknown): NotificationRuntimeState['unboundSession'] {
  if (!isRecordValue(value)) {
    return undefined;
  }
  const player = fieldOf(value, 'player');
  const session = fieldOf(value, 'session');
  return typeof player === 'string' && player.length > 0 && typeof session === 'string' && session.length > 0
    ? { player, session }
    : undefined;
}

function persistedRegistrationOf(value: unknown): NotificationRuntimePersistedRegistration | undefined {
  // A plain copy: the state keeps no getter or Proxy of the stored value.
  let record: unknown;
  try {
    record = JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecordValue(record)) {
    return undefined;
  }
  const registration = record['registration'];
  const text = (field: unknown): field is string => typeof field === 'string' && field.length > 0;
  if (
    !text(record['player'])
    || !text(record['session'])
    || !text(record['at'])
    || !isNotificationTimestamp(record['at'])
    || typeof registration !== 'object'
    || registration === null
    || Array.isArray(registration)
    || !text((registration as Readonly<Record<string, unknown>>)['provider'])
  ) {
    return undefined;
  }
  const address = (registration as Readonly<Record<string, unknown>>)['address'];
  if (
    typeof address !== 'object'
    || address === null
    || Array.isArray(address)
    || !text((address as Readonly<Record<string, unknown>>)['kind'])
  ) {
    return undefined;
  }
  return {
    registration: registration as NotificationEndpointRegistration,
    player: record['player'],
    session: record['session'],
    at: record['at'],
  };
}

const systemClock: NotificationRuntimeClock = { now: () => new Date().toISOString() };

/** Whether `value` is an object that is not a list; `false` when even that check throws (a revoked `Proxy`). */
function isRecordValue(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** `value[key]`, or `undefined` when reading it throws (a getter, a `Proxy` trap). */
function fieldOf(value: Readonly<Record<string, unknown>>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

/** Whether `value` is a thenable; `false` when reading its `then` throws (a getter, a `Proxy` trap). */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    return typeof (value as { readonly then?: unknown }).then === 'function';
  } catch {
    return false;
  }
}

/** A mutable copy of the runtime state, which the runtime saves after each change. */
interface MutableRuntimeState {
  registration?: NotificationRuntimePersistedRegistration;
  unbound?: boolean;
  unboundSession?: { readonly player: string; readonly session: string };
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
 * Creates the notifications runtime (RFC "Runtime"): the provider composed
 * with the backend for the authenticated session. The conformance runner's
 * reference runtime is this one, so every vector exercises it.
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
 *   than 7 days, belongs to another session, or was never acknowledged (a
 *   first registration that failed); after a failed registration, a read
 *   retries only once 30 seconds have passed, doubling with each failure in
 *   a row up to an hour. An identical one for the same player and session is skipped
 *   for 7 days, except on `register()`. `unregister()` unbinds the
 *   installation from the player signed in when it was called and cancels the
 *   pending local reminders, even when the unbind fails, and nothing binds it
 *   again, across restarts, until `register()` or the next authentication. A
 *   session found at start or on a read other than the one `unregister()`
 *   left (any session, when none was signed in then) is such an
 *   authentication even when the runtime did not observe it. While bound, a
 *   registration acknowledged for another session is sent again for this
 *   one, and so is, at start, one for a session with nothing acknowledged.
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
export function createNotificationRuntime(
  input: CreateNotificationRuntimeInput,
): NotificationRuntimeController {
  const { provider, backend } = input;
  const clock = input.clock ?? systemClock;
  const deploymentZone = input.timeZone ?? notificationDefaultDeploymentTimeZone;
  const storage = input.storage ?? createMemoryNotificationRuntimeStorage();
  /** The persisted state once loaded; mutated in place, then saved whole. */
  let kept: MutableRuntimeState | undefined;
  let loading: Promise<MutableRuntimeState> | undefined;
  /**
   * The persisted state: synchronously when the storage answered
   * synchronously (or has already answered), else once its load settles. A
   * failed load is tried again on the next call.
   */
  const loadState = (): MutableRuntimeState | Promise<MutableRuntimeState> => {
    if (kept !== undefined) {
      return kept;
    }
    if (loading !== undefined) {
      return loading;
    }
    const failed = (error: unknown): NotificationError =>
      new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `The notifications runtime could not read its stored state: ${describeError(error)}`,
        cause: error,
      });
    let loaded: unknown;
    try {
      loaded = storage.load();
    } catch (error) {
      throw failed(error);
    }
    if (!isPromiseLike(loaded)) {
      kept = { ...notificationRuntimeStateOf(loaded) };
      return kept;
    }
    const pending = Promise.resolve(loaded).then(
      (value) => {
        kept ??= { ...notificationRuntimeStateOf(value) };
        return kept;
      },
      (error: unknown) => {
        loading = undefined;
        throw failed(error);
      },
    );
    loading = pending;
    return pending;
  };
  /** Saves the whole state; answers synchronously when the storage does. */
  const saveState = (current: MutableRuntimeState): void | Promise<void> => {
    const failed = (error: unknown): NotificationError =>
      new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `The notifications runtime could not save its state: ${describeError(error)}`,
        cause: error,
      });
    const snapshot: NotificationRuntimeState = {
      ...(current.registration === undefined ? {} : { registration: current.registration }),
      ...(current.unbound === true ? { unbound: true } : {}),
      ...(current.unbound === true && current.unboundSession !== undefined
        ? { unboundSession: current.unboundSession }
        : {}),
    };
    let saved: void | Promise<void>;
    try {
      saved = storage.save(snapshot);
    } catch (error) {
      throw failed(error);
    }
    return isPromiseLike(saved)
      ? Promise.resolve(saved).then(
          () => undefined,
          (error: unknown) => {
            throw failed(error);
          },
        )
      : undefined;
  };
  try {
    // Start reading now; a failure is thrown by the first call that needs the state.
    const first = loadState();
    if (isPromiseLike(first)) {
      first.then(undefined, () => undefined);
    }
  } catch {
    // The next call that needs the state reads it again.
  }
  const listeners = new Set<(event: NotificationEvent) => void>();
  let buffer: NotificationEvent[] = [];
  let gameSubscribed = false;
  let unsubscribeProvider: (() => void) | undefined;
  let unsubscribeAuthentication: (() => void) | undefined;
  let configurationIssue: string | undefined;
  /** The entry `loadRegistryEntry` answered, kept across starts. */
  let loadedRegistryEntry: NotificationDeliveryProviderEntry | undefined;
  /** The load in flight, so overlapping starts share one. */
  let registryEntryLoad: Promise<void> | undefined;
  /** A `register()` held by a load in flight; the load's flush sends it unconditionally. */
  let forceRegistration = false;
  /** The device permission of the latest registration a load in flight held. */
  let heldPermission: NotificationPermissionState | undefined;
  /** The provider's capabilities as the latest `start()` read them. */
  let startCapabilities: NotificationCapabilities | undefined;
  /** The provider's latest registration, from `register()` or `endpoint-changed`. */
  let latestRegistration: NotificationEndpointRegistration | undefined;
  /**
   * After registrations that failed in a row: how many, and the time (epoch
   * ms) before which a read does not retry. Cleared by one the backend acknowledges.
   */
  let registrationRetry:
    | { readonly failures: number; readonly notBefore: number; readonly session: string | undefined }
    | undefined;
  /** The clock in epoch ms; `NaN` when it cannot be read, which holds nothing back. */
  const nowMs = (): number => {
    try {
      return Date.parse(clock.now());
    } catch {
      return Number.NaN;
    }
  };
  /** The session a backoff belongs to: another session's failures hold nothing back. */
  const retrySessionKey = (): string | undefined => {
    try {
      const session = backend.session();
      return session === undefined ? undefined : JSON.stringify([session.player, session.id]);
    } catch {
      return undefined;
    }
  };
  const background = new Set<Promise<void>>();
  /** The first background failure since the last `runUntilIdle`, and how many there were. */
  let failure: { readonly error: unknown; count: number } | undefined;
  const fail = (error: unknown): void => {
    try {
      const observed: unknown = input.onError?.(error);
      if (isPromiseLike(observed)) {
        observed.then(undefined, () => undefined);
      }
    } catch {
      // The observer's own failure is not the runtime's.
    }
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
    // Nothing is read from a backend whose registry entry the provider disagrees with.
    if (session === undefined || configurationIssue !== undefined) {
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
    // Records wait while the provider disagrees with its registry entry.
    if (session === undefined || configurationIssue !== undefined) {
      return;
    }
    let mine = waitingRecords.filter((waiting) =>
      waiting.player === undefined || waiting.player === session.player);
    if (registryEntryLoad !== undefined) {
      // While the entry loads, only withdrawals and refusals go out, so the
      // server stops sending at once; a record that grants waits for the
      // check (the load writes it once the entry matches), and so does every
      // record after it, keeping their order.
      const firstGrant = mine.findIndex((waiting) => waiting.record.state === 'granted');
      mine = firstGrant === -1 ? mine : mine.slice(0, firstGrant);
    }
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
          // The session changed during the write: the rest waits for its
          // player, ahead of any record held back behind it.
          waitingRecords.unshift(...mine);
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
      // Back at the front, so a record held back while the entry loads stays after it.
      waitingRecords.unshift(...mine);
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
    if (session === undefined) {
      return;
    }
    // Nothing goes out before the registry check: while an entry loads the
    // registration waits (the load sends it once the entry matches, as
    // forcefully as it was asked for), and a provider the entry disagrees
    // with never sends its address.
    if (registryEntryLoad !== undefined) {
      forceRegistration ||= always;
      // The permission the runtime decided for the device, which the flush keeps.
      heldPermission = registration.address.kind === 'platform-user' ? undefined : registration.address.permission;
      return;
    }
    if (configurationIssue !== undefined) {
      return;
    }
    const persisted = kept ?? await loadState();
    if (persisted.unbound === true) {
      return;
    }
    const last = persisted.registration;
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
    const acknowledged: NotificationRuntimePersistedRegistration = {
      registration,
      player: session.player,
      session: session.id,
      at: clock.now(),
    };
    // Kept only once saved: after a failed save the next identical one is sent again.
    const saved = saveState({ ...persisted, registration: acknowledged });
    if (saved !== undefined) {
      await saved;
    }
    persisted.registration = acknowledged;
    registrationRetry = undefined;
  };
  /**
   * Holds reads back from retrying a registration that failed: 30 s, doubling
   * per failure in a row for the same session, at most an hour.
   */
  const noteRegistrationFailure = (): void => {
    const session = retrySessionKey();
    const previous = registrationRetry !== undefined && registrationRetry.session === session
      ? registrationRetry.failures
      : 0;
    const failures = previous + 1;
    // A clock that cannot be read holds nothing back (`NaN` is never later).
    registrationRetry = {
      failures,
      notBefore: nowMs() + Math.min(registrationRetryBaseMs * 2 ** Math.min(failures - 1, 16), registrationRetryMaxMs),
      session,
    };
  };
  /** `work`, noting a failure for the read backoff before it is rethrown. */
  const withRegistrationBackoff = (work: () => Promise<void>) => async (): Promise<void> => {
    try {
      await work();
    } catch (error) {
      noteRegistrationFailure();
      throw error;
    }
  };
  /**
   * Registers the provider's current address or platform identity; `rebind`
   * ends an `unregister()`. A `permission` the runtime decided (a
   * game-rendered consent reads `denied` once withdrawn) replaces the one a
   * device address carries.
   */
  const registerCurrent = (
    always: boolean,
    rebind: boolean | 'if-unobserved-sign-in' = false,
    permission?: NotificationPermissionState,
  ): Promise<void> =>
    enqueue('register', withRegistrationBackoff(async () => {
      if (rebind !== false) {
        const persisted = kept ?? await loadState();
        if (persisted.unbound === true) {
          if (rebind === 'if-unobserved-sign-in' && !unobservedSignIn(persisted)) {
            // An unregister() queued since the check left this very session.
            return;
          }
          const { unboundSession, registration } = persisted;
          delete persisted.unbound;
          delete persisted.unboundSession;
          // The backend dropped the endpoint at the unbind: the registration
          // kept from before it is no longer acknowledged, so it is sent again.
          delete persisted.registration;
          try {
            const saved = saveState(persisted);
            if (saved !== undefined) {
              await saved;
            }
          } catch (error) {
            // Memory goes back to what storage still holds.
            persisted.unbound = true;
            if (unboundSession !== undefined) {
              persisted.unboundSession = unboundSession;
            }
            if (registration !== undefined) {
              persisted.registration = registration;
            }
            throw error;
          }
        }
      }
      const capabilities = await provider.getCapabilities();
      const register = provider.register;
      if (!capabilities.remote.supported || capabilities.remote.addressing === 'none') {
        return;
      }
      // A provider without `register()` reports its address only through
      // `endpoint-changed`: the latest one it reported is its registration.
      const registration = (register === undefined ? undefined : await register.call(provider))
        ?? latestRegistration;
      if (registration !== undefined) {
        const { address } = registration;
        await sendRegistration(
          permission === undefined || address.kind === 'platform-user' || address.permission === permission
            ? registration
            : { ...registration, address: { ...address, permission } },
          always,
        );
      }
    }));
  /**
   * Whether the session signed in now, while unbound, is a sign-in after
   * `unregister()`: any session when none was signed in at the unbind, else
   * one other than the session it left.
   */
  const unobservedSignIn = (persisted: MutableRuntimeState): boolean => {
    const session = backend.session();
    const left = persisted.unboundSession;
    return session !== undefined
      && (left === undefined || left.player !== session.player || left.session !== session.id);
  };
  /**
   * Catches the registration up with the session signed in now. At start and
   * on reads:
   * - while unbound, a session other than the one `unregister()` left is a
   *   sign-in the runtime did not observe (before `start()`, or while
   *   stopped), so the installation binds again;
   * - a registration acknowledged for another player or session is sent for
   *   this one, for the same reason;
   * - a device registration acknowledged more than 7 days ago is sent again,
   *   so the endpoint of a device in use never goes stale.
   * With nothing acknowledged yet, the registration is sent at start for a
   * session that was already signed in, and on reads once the provider has
   * an address whose registration failed.
   *
   * After a registration failed, a read retries it only once the backoff
   * since the failure has passed (`registrationRetryBaseMs`, doubling per
   * failure in a row, at most `registrationRetryMaxMs`), so a game that reads
   * often does not send a registration on every read to a backend that keeps
   * refusing it. Start does not wait, and the backoff belongs to the session
   * it was noted for: a read for another session does not wait for it.
   */
  const refreshRegistration = async (atStart: boolean): Promise<void> => {
    const session = backend.session();
    if (session === undefined) {
      return;
    }
    if (
      !atStart
      && registrationRetry !== undefined
      && registrationRetry.session === retrySessionKey()
      && nowMs() < registrationRetry.notBefore
    ) {
      return;
    }
    const persisted = kept ?? await loadState();
    if (persisted.unbound === true) {
      if (unobservedSignIn(persisted)) {
        await registerCurrent(false, 'if-unobserved-sign-in');
      }
      return;
    }
    const last = persisted.registration;
    if (last === undefined) {
      // Nothing acknowledged yet: at start for a session already signed in,
      // and on reads once the provider has an address whose registration
      // failed (a Worker that answered 429 or could not be reached).
      if (atStart || latestRegistration !== undefined) {
        // The retry keeps the device permission the runtime decided last.
        const address = latestRegistration?.address;
        await registerCurrent(
          false,
          false,
          address === undefined || address.kind === 'platform-user' ? undefined : address.permission,
        );
      }
      return;
    }
    const otherSession = last.player !== session.player || last.session !== session.id;
    if (
      !otherSession
      && (Date.parse(clock.now()) - Date.parse(last.at) < registrationRefreshMs
        || !isDeviceAddressing(await provider.getCapabilities()))
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
    const address = (latestRegistration ?? (kept ?? await loadState()).registration?.registration)?.address;
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
  /** The zone the device registered, else the deployment's. */
  const localZone = (registered: NotificationEndpointRegistration | undefined): string => {
    const zone = registered?.timeZone;
    return zone !== undefined && isValidNotificationTimeZone(zone) ? zone : deploymentZone;
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
    let registered = latestRegistration;
    if (registered === undefined) {
      try {
        registered = (kept ?? await loadState()).registration?.registration;
      } catch (error) {
        // Without the stored registration the deployment's zone applies, as before any registration.
        fail(error);
      }
    }
    const decision = evaluateLocalNotificationReminder({
      topic,
      permission: stateIn(states, topic.id),
      consent: records ?? [],
      fireAt: request.fireAt,
      timeZone: localZone(registered),
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
        message: errorMessageOf(error),
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

  /** Sends what waited for a registry check that passed (or could not run), while started. */
  const flushAfterCheck = (): void => {
    const force = forceRegistration;
    const permission = heldPermission;
    forceRegistration = false;
    heldPermission = undefined;
    if (configurationIssue !== undefined || unsubscribeProvider === undefined) {
      return;
    }
    track(queueRecords([]));
    track(registerCurrent(force, false, permission));
  };

  // Events and authentication.

  const onProviderEvent = (event: NotificationEvent): void => {
    // The runtime's own handling first, so a game listener cannot skip it.
    if (event.type === 'endpoint-changed') {
      const { registration } = event;
      track(enqueue('register', withRegistrationBackoff(async () => {
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
      })));
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
      startCapabilities = await provider.getCapabilities();
      /** Compares with the capabilities of the latest start, whichever start began the load. */
      const compare = (entry: NotificationDeliveryProviderEntry | undefined): void => {
        const capabilities = startCapabilities;
        configurationIssue = entry === undefined || capabilities === undefined || !capabilities.remote.supported
          ? undefined
          : notificationRegistryMismatch(capabilities, entry);
      };
      // A given entry that cannot be compared is reported and left out, as if
      // none was given: the runtime loads one when it can, else runs unchecked.
      let given: NotificationDeliveryProviderEntry | undefined;
      if (input.registryEntry !== undefined) {
        const comparable = comparableRegistryEntry(input.registryEntry);
        if ('entry' in comparable) {
          given = comparable.entry;
        } else {
          fail(new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
            message: `The registry entry the runtime was given cannot be compared: ${comparable.issue}. `
              + 'The runtime runs without it.',
          }));
        }
      }
      const known = given ?? loadedRegistryEntry;
      compare(known);
      const load = input.loadRegistryEntry;
      // Only a provider with remote delivery is compared, so only it loads an entry.
      if (
        known === undefined
        && load !== undefined
        && registryEntryLoad === undefined
        && startCapabilities.remote.supported
      ) {
        // Neither awaited nor tracked, so a backend that is slow or never
        // answers holds up neither the start nor `runUntilIdle`; a failure is
        // still reported through `onError` and the next `runUntilIdle`.
        const loading = Promise.resolve().then(load).then((loaded) => {
          // An entry that cannot be compared is a failed load: reported, not
          // kept, and loaded again at the next start.
          const comparable = loaded === undefined ? undefined : comparableRegistryEntry(loaded);
          if (comparable !== undefined && 'issue' in comparable) {
            throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
              message: `loadRegistryEntry answered an entry that cannot be compared: ${comparable.issue}.`,
            });
          }
          loadedRegistryEntry = comparable?.entry;
          compare(comparable?.entry);
        });
        registryEntryLoad = loading;
        loading.then(
          () => {
            registryEntryLoad = undefined;
            // What waited for the check goes out now, unless the check failed
            // or the runtime stopped meanwhile.
            flushAfterCheck();
          },
          (error: unknown) => {
            registryEntryLoad = undefined;
            fail(error);
            // Without the entry the runtime goes on unchecked, so what waited goes out.
            flushAfterCheck();
          },
        );
      }
      if (configurationIssue !== undefined) {
        // Fail closed: nothing reaches the backend for a provider its registry
        // entry disagrees with; every call throws NOTIFICATIONS_CONFIGURATION_REQUIRED.
        return;
      }
      // Records that waited for a check that now passes.
      await settle(queueRecords([]));
      // A backend that cannot answer does not fail the start; the next read reconciles.
      await settle(reconcileLocal());
      await settle(refreshRegistration(true));
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
      await settle(refreshRegistration(false));
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
        // The unbind is tried even when the stored state cannot be read; the
        // unbound state is then kept in memory and saved over it.
        // A load that never settles still holds the unbind up; the storage
        // port is expected to answer or fail.
        let loadFailure: { readonly error: unknown } | undefined;
        let persisted: MutableRuntimeState;
        try {
          persisted = kept ?? await loadState();
        } catch (error) {
          loadFailure = { error };
          // A load another call started meanwhile may have set the state; the
          // unbound state goes on whichever object is kept, and is written
          // over the stored one either way.
          kept ??= {};
          persisted = kept;
        }
        persisted.unbound = true;
        if (session !== undefined) {
          persisted.unboundSession = { player: session.player, session: session.id };
        }
        const saveFailures: unknown[] = [];
        /** Saves the state; a failure is collected, and a synchronous save answers synchronously. */
        const save = (): void | Promise<void> => {
          let saved: void | Promise<void>;
          try {
            saved = saveState(persisted);
          } catch (error) {
            saveFailures.push(error);
            return undefined;
          }
          return saved?.then(undefined, (error: unknown) => {
            saveFailures.push(error);
          });
        };
        // Saved before the unbind, so a restart during it binds nothing.
        const before = save();
        if (before !== undefined) {
          await before;
        }
        let unbindFailure: { readonly error: unknown } | undefined;
        try {
          if (session !== undefined && isDeviceAddressing(await provider.getCapabilities())) {
            await backend.unregisterEndpoint({ provider: provider.provider, player: session.player });
            if (persisted.registration?.session === session.id) {
              delete persisted.registration;
              const after = save();
              if (after !== undefined) {
                await after;
              }
            }
          }
        } catch (error) {
          unbindFailure = { error };
        }
        // Only the unbind's own error is thrown, so a caller can tell a
        // logout that did not reach the backend; the storage's failures reach
        // onError and runUntilIdle.
        for (const error of [...(loadFailure === undefined ? [] : [loadFailure.error]), ...saveFailures]) {
          fail(error);
        }
        if (unbindFailure !== undefined) {
          throw unbindFailure.error;
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
      try {
        await capabilitiesOf();
        // Never recorded for a player who is no longer signed in.
        assertSamePlayer('setTopicPreference', player);
      } catch (error) {
        // A withdrawal still stops this device's reminders of the topic,
        // which touches no backend, before the call throws.
        if (!request.enabled) {
          try {
            await cancelLocalWhere((entry) => entry.topic === request.topic);
          } catch (cancelError) {
            // Reported, so the call still throws its own error.
            fail(cancelError);
          }
        }
        throw error;
      }
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
      // Never recorded for a player who is no longer signed in.
      assertSamePlayer('setAdvertisingConsent', player);
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
          // Signed out, the local reminder is removed above and the call never
          // claims a cancel: a server reminder under the key may be pending
          // for the player who signed out. A provider waiting for a player
          // action answers `action-required`; any other throws
          // NOTIFICATIONS_TEMPORARILY_UNAVAILABLE below (RFC "Backend calls").
          // Retried after sign-in, it removes the server reminder too.
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
