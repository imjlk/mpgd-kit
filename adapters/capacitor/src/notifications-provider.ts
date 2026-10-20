import { App, type AppPlugin } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  assertLocalNotificationRequest,
  isRootRelativeNotificationRoute,
  normalizeNotificationTimestamp,
  notificationAdvertisingOptOutActionId,
  NotificationError,
  type LocalNotificationEntry,
  type LocalNotificationRequest,
  type LocalScheduleResult,
  type NotificationCapabilities,
  type NotificationEndpointRegistration,
  type NotificationEvent,
  type NotificationPermissionOutcome,
  type NotificationPermissionResult,
  type NotificationPermissionSnapshot,
  type NotificationPermissionState,
  type NotificationProvider,
  type NotificationProviderId,
  type NotificationPurpose,
  type NotificationSettingsResult,
  type NotificationTopicDeclaration,
  type NotificationTopicsInput,
} from '@mpgd/platform/notifications';

import type {
  LocalNotificationSdk,
  LocalNotificationSdkEntry,
  LocalNotificationSdkSchema,
  NotificationSdkChannel,
  NotificationSdkPermissionState,
  PushSdk,
  PushSdkNotification,
} from './notifications-sdk.js';

// The Capacitor notifications v2 provider (notifications RFC "Provider
// profiles", Capacitor): app-scope OS permission, FCM device endpoints, local
// reminders through `@capacitor/local-notifications`, and opens from the
// notification payload. It never sends and never grants: a remote push comes
// only from the backend, and an open is routing data.

/** The reference provider id the backend's FCM registry entry uses. */
export const capacitorNotificationProviderId = 'fcm';

/**
 * The notification category (iOS) and action type that carries the
 * advertising opt-out action. An FCM send for an advertising topic names it
 * (`apns.payload.aps.category`) so iOS shows the action.
 */
export const capacitorAdvertisingActionTypeId = 'mpgd-advertising';

/**
 * Keys of the push data the provider reads. A send carries the topic and the
 * topic's root-relative route in them; every other string entry reaches the
 * game as the open's untrusted `data`.
 */
export const capacitorNotificationDataKeys = Object.freeze({
  topic: 'topic',
  route: 'route',
} as const);

/** iOS keeps at most 64 pending local notifications per app. */
export const capacitorIosMaxPendingLocalNotifications = 64;

/** How long `openSettings` waits for the app to leave for the settings screen. */
export const capacitorSettingsLeaveTimeoutMs = 5_000;
/** How long `openSettings` waits for the player to come back from settings. */
export const capacitorSettingsReturnTimeoutMs = 120_000;

export type CapacitorNotificationAppEvents = Pick<AppPlugin, 'addListener'>;

export interface CapacitorNotificationChannelSettings {
  readonly name: string;
  readonly description?: string;
  /** Android importance, 1 (min) to 5 (max); 3 when absent. */
  readonly importance?: 1 | 2 | 3 | 4 | 5;
}

export interface CreateCapacitorNotificationProviderInput {
  readonly platform: 'android' | 'ios';
  /**
   * The topics resolved for this target, as the runtime reads them
   * (`resolveNotificationTopicsForTarget(catalog, 'android')` from
   * `@mpgd/catalog`). A topic outside them answers `unavailable` to a request.
   */
  readonly topics: readonly NotificationTopicDeclaration[];
  /** Remote delivery; absent means the provider declares none. */
  readonly push?: PushSdk;
  /** Local reminders and the permission read; absent means no local reminders. */
  readonly local?: LocalNotificationSdk;
  /** Defaults to `capacitorNotificationProviderId` ('fcm'). */
  readonly provider?: NotificationProviderId;
  /**
   * Denials Android accepts before only settings can change the answer: 2 for
   * a target SDK of 33 or later (Capacitor 8 projects target 36), 1 for an
   * app that targets 32 or lower. iOS always declares 1.
   */
  readonly androidPromptLimit?: 1 | 2;
  /**
   * Names of the Android channels, by channel id. A topic uses its mapping's
   * `channelId`, or the default channel of its purpose
   * (`capacitorNotificationChannelId`).
   */
  readonly channels?: Readonly<Record<string, CapacitorNotificationChannelSettings>>;
  /** The title of the advertising opt-out action; '수신거부' when absent. */
  readonly advertisingOptOutTitle?: string;
  /**
   * Opens the OS notification settings for this app. Neither plugin can, so
   * the shell supplies it (for example a small native method). Without it
   * `permission.settings` is false and `openSettings` answers 'unavailable'.
   */
  readonly openSettings?: () => Promise<void>;
  /** App state events; defaults to `App` from `@capacitor/app`. */
  readonly app?: CapacitorNotificationAppEvents | null;
  /** The device's IANA zone for registrations; defaults to `Intl`. */
  readonly timeZone?: () => string | undefined;
  /** The device locale for registrations; defaults to `navigator.language`. */
  readonly locale?: () => string | undefined;
  /**
   * Clock for deciding whether a stored Android reminder has already fired.
   * Defaults to `Date.now`. Tests and conformance pass the scenario clock.
   */
  readonly now?: () => number;
  readonly settingsLeaveTimeoutMs?: number;
  readonly settingsReturnTimeoutMs?: number;
  /** Reports a native listener or setup failure; defaults to `console.warn`. */
  readonly onError?: (error: unknown) => void;
}

/** The provider, with the topics it was created for (the v1 surface reads them). */
export interface CapacitorNotificationProvider extends NotificationProvider {
  readonly topics: readonly NotificationTopicDeclaration[];
}

const defaultChannels: Readonly<Record<NotificationPurpose, CapacitorNotificationChannelSettings>> = {
  service: { name: 'Notifications' },
  requested: { name: 'Reminders' },
  advertising: { name: 'Promotions' },
};

const extraKeys = Object.freeze({
  key: 'mpgdKey',
  topic: 'mpgdTopic',
  fireAt: 'mpgdFireAt',
  route: 'mpgdRoute',
} as const);

/** Push data keys that are not the game's: the provider's own and the transport's. */
const reservedDataKey = /^(?:topic|route|from|collapse_key|aps|fcm_options)$|^(?:google|gcm)\./u;
const eventBufferLimit = 64;
const maxNativeId = 0x7f_ff_ff_ff;

/**
 * The Android channel a topic posts to: its mapping's `channelId`, or the
 * default channel of its purpose (`mpgd-service`, `mpgd-requested`,
 * `mpgd-advertising`), so advertising stays in a channel of its own that the
 * player can turn off in system settings.
 */
export function capacitorNotificationChannelId(
  topic: Pick<NotificationTopicDeclaration, 'purpose' | 'mapping'>,
): string {
  const mapped = topic.mapping?.['channelId'];
  return typeof mapped === 'string' && mapped !== '' ? mapped : `mpgd-${topic.purpose}`;
}

/**
 * The native id of a local reminder key: a stable positive 32-bit integer
 * (FNV-1a), as Android requires. The provider probes the next id when another
 * pending reminder already holds it, and finds reminders by the key it stores
 * in `extra`, so a collision never replaces another reminder.
 */
export function capacitorLocalNotificationId(key: string): number {
  let hash = 0x81_1c_9d_c5;
  for (const unit of new TextEncoder().encode(key)) {
    hash ^= unit;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return (hash % maxNativeId) + 1;
}

/**
 * Creates the Capacitor notifications provider over the two plugin SDKs.
 *
 * - **Listeners first.** It registers every native listener synchronously,
 *   before any `await`, and keeps them for the process lifetime: Capacitor
 *   retains a plugin's events only until its first native listener, so a
 *   cold-start open reaches this provider, which keeps it for its first
 *   subscriber.
 * - **Permission.** It reads `LocalNotifications.checkPermissions`, which
 *   reflects the system setting on every Android version, and maps the OS
 *   `denied` to `blocked`: on iOS after the one denial, on Android after the
 *   second. Only `requestPermission` shows the OS dialog; `scheduleLocal`
 *   answers `permission-required` instead.
 * - **Local reminders.** Inexact (`isExactNotification: false`), on the
 *   topic's channel, at most 64 pending on iOS, keeping the nearest, one
 *   operation at a time. A `fireAt` already past posts at once, as both
 *   plugins do.
 * - **Fails closed.** Without either SDK the provider is `unsupported`;
 *   without `push` it declares no remote delivery, without `local` no local
 *   reminders.
 */
export function createCapacitorNotificationProvider(
  input: CreateCapacitorNotificationProviderInput,
): CapacitorNotificationProvider {
  const { push, local, platform } = input;
  const providerId = input.provider ?? capacitorNotificationProviderId;
  const topics = [...input.topics];
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));
  /**
   * The topic this target maps. A topic the catalog declares without a
   * mapping for this target, as `resolveNotificationTopicsForTarget` keeps
   * it, is not available here: it reads `unsupported`, a request answers
   * `unavailable`, it schedules nothing, gets no channel, and an open naming
   * it carries no topic, as the reference runtime treats it.
   */
  const mappedTopic = (id: string | undefined): NotificationTopicDeclaration | undefined => {
    const declared = id === undefined ? undefined : topicById.get(id);
    return declared?.mapping === undefined ? undefined : declared;
  };
  const mappedTopics = topics.filter((topic) => topic.mapping !== undefined);
  const channels = collectChannels(mappedTopics, input.channels ?? {});
  const unsupported = push === undefined && local === undefined;
  // RFC "Advertising rules": an advertising push carries the opt-out action,
  // which this provider registers through the local plugin (the iOS
  // category, and the action type a shell renders on Android). Without it,
  // remote advertising would go out without the action, so the provider is
  // `configuration-required`, as a registry mismatch makes a provider.
  const optOutMissing = push !== undefined && local === undefined
    && mappedTopics.some((topic) => topic.purpose === 'advertising');
  const configurationIssue = optOutMissing
    ? 'Capacitor notifications: the catalog maps an advertising topic, whose opt-out action '
      + 'needs @capacitor/local-notifications; install both plugins.'
    : undefined;
  const assertConfigured = (): void => {
    if (configurationIssue !== undefined) {
      throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
        message: configurationIssue,
      });
    }
  };
  const promptLimit = platform === 'ios' ? 1 : (input.androidPromptLimit ?? 2);
  const app = input.app === undefined ? App : input.app;
  const reportError = (error: unknown): void => {
    try {
      if (input.onError === undefined) {
        console.warn('Capacitor notifications provider failed.', error);
      } else {
        input.onError(error);
      }
    } catch {
      // Reporting must not break the native listener that failed.
    }
  };

  // Events.
  const listeners = new Set<(event: NotificationEvent) => void>();
  const buffer: NotificationEvent[] = [];
  let subscribed = false;
  // Events wait whenever no listener is attached, not only before the first:
  // the gateway's bridge detaches when its last listener leaves, so a game
  // that subscribes per scene would otherwise lose an open between scenes.
  function deliver(
    event: NotificationEvent,
    targets: readonly ((event: NotificationEvent) => void)[],
  ): void {
    for (const target of targets) {
      try {
        target(event);
      } catch (error) {
        reportError(error);
      }
    }
  }
  let draining = false;
  const dispatch = (event: NotificationEvent): void => {
    if (listeners.size === 0 || draining) {
      // A receipt is worth nothing once the scene that showed it is gone; the
      // opens, endpoint and permission changes are kept.
      if (subscribed && !draining && event.type === 'received') {
        return;
      }
      buffer.push(event);
      if (buffer.length > eventBufferLimit) {
        // Keep the opens: a cold-start open must not be lost to later events.
        const evicted = buffer.findIndex((buffered) => buffered.type !== 'opened');
        buffer.splice(evicted === -1 ? 0 : evicted, 1);
      }
      return;
    }
    deliver(event, [...listeners]);
  };

  // Permission. It is read from the local plugin, which reflects the system
  // setting on every Android version, and asked through the push plugin,
  // which also registers with APNs on iOS.
  let checkPermission: (() => Promise<NotificationSdkPermissionState>) | undefined;
  if (local !== undefined) {
    checkPermission = async () => {
      const display = (await local.checkPermissions()).display;
      // Android 13+ `checkPermissions` reads POST_NOTIFICATIONS and can
      // answer granted after the player turns notifications off in settings.
      // `areNotificationsEnabled` is that switch. On older Android the
      // permission read already uses it, so a false answer agrees.
      if (platform === 'android' && display === 'granted' && local.areEnabled !== undefined) {
        const enabled = await local.areEnabled();
        if (enabled.value === false) {
          return 'denied';
        }
      }
      return display;
    };
  } else if (push !== undefined) {
    // Without the local plugin, Android 12 and lower read granted whatever
    // the system setting is: the push plugin cannot tell.
    checkPermission = async () => (await push.checkPermissions()).receive;
  }
  let askPermission: (() => Promise<NotificationSdkPermissionState>) | undefined;
  if (push !== undefined) {
    askPermission = async () => (await push.requestPermissions()).receive;
  } else if (local !== undefined) {
    askPermission = async () => (await local.requestPermissions()).display;
  }
  let tokenFailureReported = false;
  let lastObserved: NotificationPermissionState | undefined;
  /**
   * The OS dialog in flight, whose answer settles `lastObserved`; a request
   * made while it is up shares it, so a double tap never asks twice.
   */
  let requesting: Promise<PermissionDialogAnswer> | undefined;
  /** The answer of the last dialog that settled. */
  let lastAnswer: PermissionDialogAnswer | undefined;
  /** Whether a dialog that started after `generation` was taken has answered since. */
  const answeredSince = (generation: number): boolean =>
    lastAnswer !== undefined && lastAnswer.request > generation;
  /** Counts requests, so a read that overlapped one cannot settle `lastObserved` after it. */
  let requests = 0;
  const readAppState = async (): Promise<NotificationPermissionState> => {
    if (checkPermission === undefined) {
      return 'unsupported';
    }
    const generation = requests;
    const duringDialog = requesting !== undefined;
    const state = await callSdk(checkPermission);
    const mapped = toPermissionState(state);
    // Only the request's own answer settles a request, so a read that began
    // before or during the dialog cannot overwrite that answer, even when it
    // finishes after the request did.
    if (!duringDialog && requesting === undefined && !answeredSince(generation)) {
      lastObserved = mapped;
    }
    return mapped;
  };
  const snapshotOf = (
    requested: readonly string[],
    state: NotificationPermissionState,
  ): NotificationPermissionSnapshot => ({
    app: state,
    topics: Object.fromEntries(
      requested.map((topic) => [topic, mappedTopic(topic) === undefined ? 'unsupported' : state]),
    ),
  });

  // Settings round trips and permission changes made outside the game.
  const appStateWaiters = new Set<(active: boolean) => void>();
  // One check at a time, each against the state the one before it read, so
  // two quick returns announce one change once.
  let resumeCheck: Promise<void> = Promise.resolve();
  const onAppState = (active: boolean): void => {
    for (const waiter of [...appStateWaiters]) {
      waiter(active);
    }
    if (!active || unsupported) {
      return;
    }
    // A push-only provider has no local reminder to retry the setup from.
    ensureChannels().catch(reportSetupFailure);
    ensureActionTypes().catch(reportSetupFailure);
    resumeCheck = resumeCheck.then(async () => {
      const before = lastObserved;
      const generation = requests;
      // A request's own dialog also takes the app out of the foreground (the
      // iOS alert, the Android permission activity); the request reports that
      // answer itself.
      if (before === undefined || requesting !== undefined) {
        return;
      }
      const state = await readAppState();
      // A request that began, or even ended, during the read reports its own
      // answer.
      if (state !== before && requesting === undefined && !answeredSince(generation)) {
        // Changed in system settings: no plugin reports it as an event.
        dispatch({
          type: 'permission-changed',
          // Every declared topic; `snapshotOf` reads the unmapped ones `unsupported`.
          snapshot: snapshotOf(topics.map((topic) => topic.id), state),
        });
      }
    }).catch(reportError);
  };

  const registrationWith = (
    value: string,
    permission: NotificationPermissionState,
  ): NotificationEndpointRegistration => {
    const timeZone = (input.timeZone ?? defaultTimeZone)();
    const locale = (input.locale ?? defaultLocale)();
    return {
      provider: providerId,
      // FCM tokens only: `fcm-installation` addresses are reserved, because
      // FCM HTTP v1 cannot send to a Firebase installation id and the
      // game-services sender refuses them.
      address: { kind: 'fcm-token', value, permission },
      ...(locale === undefined || locale === '' ? {} : { locale }),
      ...(timeZone === undefined || timeZone === '' ? {} : { timeZone }),
    };
  };
  const registrationOf = async (value: string): Promise<NotificationEndpointRegistration> =>
    registrationWith(value, await readAppState());

  /** The declared topic a push names; the payload is untrusted. */
  const declaredTopicOf = (data: Record<string, unknown>): NotificationTopicDeclaration | undefined => {
    return mappedTopic(stringOf(data[capacitorNotificationDataKeys.topic]));
  };
  const openedFromPush = (actionId: string, notification: PushSdkNotification | undefined): void => {
    if (actionId === 'dismiss') {
      // Firebase Messaging emits notificationActionPerformed for a swipe
      // dismiss (`UNNotificationDismissActionIdentifier`) and retains it
      // until a listener consumes it. That is not an open.
      return;
    }
    const data = isRecord(notification?.data) ? notification.data : {};
    const declared = declaredTopicOf(data);
    const topicId = declared?.id;
    // The opt-out action opens the topic's declared opt-out screen, never a
    // route from the payload.
    let route: string | undefined;
    if (actionId !== notificationAdvertisingOptOutActionId) {
      route = safeRoute(data[capacitorNotificationDataKeys.route]);
    } else if (declared?.purpose === 'advertising') {
      route = declared.optOutRoute;
    }
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && !reservedDataKey.test(key)) {
        extra[key] = value;
      }
    }
    dispatch({
      type: 'opened',
      channel: 'remote',
      source: subscribed ? 'warm' : 'cold',
      ...(topicId === undefined ? {} : { topic: topicId }),
      ...(route === undefined ? {} : { route }),
      ...(Object.keys(extra).length === 0 ? {} : { data: extra }),
    });
  };

  const openedFromLocal = (
    actionId: string,
    notification: LocalNotificationSdkEntry | undefined,
  ): void => {
    const entry = readLocalEntry(notification);
    if (entry === undefined || actionId === 'dismiss') {
      // Not one of this provider's reminders, or not an open.
      return;
    }
    const topic = mappedTopic(entry.topic)?.id;
    dispatch({
      type: 'opened',
      channel: 'local',
      source: subscribed ? 'warm' : 'cold',
      ...(topic === undefined ? {} : { topic }),
      ...(entry.route === undefined ? {} : { route: entry.route }),
    });
  };

  // Native listeners: synchronously, before any await, and never removed,
  // because the provider lives as long as the process.
  const listen = (register: () => Promise<PluginListenerHandle>): void => {
    try {
      register().catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };
  if (push !== undefined) {
    listen(() => push.addListener('tokenReceived', (event) => {
      // A configuration-required provider announces no address, as it
      // registers none: the backend must not reach this device yet.
      if (configurationIssue !== undefined || typeof event.token !== 'string'
        || event.token === '') {
        return;
      }
      const { token } = event;
      tokenFailureReported = false;
      // A rotation must reach the runtime before this listener returns: the
      // conformance harness registers the address from that synchronous
      // event. The permission on it is the last read. A change made in
      // system settings has no event, so a fresh read follows and replaces
      // the announcement when the permission differs. Channels are awaited
      // on that read; `register()` does not return a token until they exist.
      const announced = lastObserved !== undefined && requesting === undefined
        ? lastObserved
        : undefined;
      const announcedNow = announced !== undefined && androidChannelsReady;
      if (announcedNow && announced !== undefined) {
        dispatch({
          type: 'endpoint-changed',
          registration: registrationWith(token, announced),
        });
      }
      void (requesting ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          await ensureChannels();
          return registrationOf(token);
        })
        .then((registration) => {
          const permission = registration.address.kind === 'fcm-token'
            ? registration.address.permission
            : undefined;
          if (announcedNow && permission === announced) {
            return;
          }
          dispatch({ type: 'endpoint-changed', registration });
        }, reportError);
    }));
    listen(() => push.addListener('notificationReceived', (event) => {
      const data = isRecord(event?.notification?.data) ? event.notification.data : {};
      const topic = declaredTopicOf(data)?.id;
      dispatch({ type: 'received', channel: 'remote', ...(topic === undefined ? {} : { topic }) });
    }));
    listen(() =>
      push.addListener('notificationActionPerformed', (event) => {
        openedFromPush(actionIdOf(event), event?.notification);
      }),
    );
  }
  if (local !== undefined) {
    listen(() =>
      local.addListener('localNotificationReceived', (notification) => {
        const entry = readLocalEntry(notification);
        if (entry !== undefined) {
          const topic = mappedTopic(entry.topic)?.id;
          dispatch({
            type: 'received',
            channel: 'local',
            ...(topic === undefined ? {} : { topic }),
          });
        }
      }),
    );
    listen(() =>
      local.addListener('localNotificationActionPerformed', (event) => {
        openedFromLocal(actionIdOf(event), event?.notification);
      }),
    );
  }
  if (app !== null && !unsupported) {
    listen(() => app.addListener('appStateChange', (state) => onAppState(state.isActive)));
  }

  // Native setup: the Android channels and the opt-out action type. A remote
  // push needs its channel before it arrives, so both start now. Each is kept
  // only once it succeeded. A failure is tried again on the next local
  // reminder, which needs the channels and fails until they exist, and on
  // each return to the foreground; it is reported once until a try succeeds.
  let setupFailureReported = false;
  const reportSetupFailure = (error: unknown): void => {
    if (!setupFailureReported) {
      setupFailureReported = true;
      reportError(error);
    }
  };
  let channelsReady: Promise<void> | undefined;
  /** Android pushes name a channel; do not announce an address before it exists. */
  let androidChannelsReady = platform !== 'android';
  const ensureChannels = (): Promise<void> => {
    channelsReady ??= (async () => {
      if (platform !== 'android') {
        return;
      }
      const createChannel = local === undefined
        ? push?.createChannel?.bind(push)
        : local.createChannel.bind(local);
      if (createChannel === undefined) {
        return;
      }
      for (const channel of channels) {
        await createChannel(channel);
      }
      androidChannelsReady = true;
      setupFailureReported = false;
    })().catch((error: unknown) => {
      channelsReady = undefined;
      androidChannelsReady = platform === 'android' ? false : androidChannelsReady;
      throw error;
    });
    return channelsReady;
  };
  let actionTypesReady: Promise<void> | undefined;
  // The call sets every iOS category at once, so a catalog without
  // advertising leaves the shell's categories alone.
  const needsOptOut = mappedTopics.some((topic) => topic.purpose === 'advertising');
  const ensureActionTypes = (): Promise<void> => {
    if (!needsOptOut) {
      return Promise.resolve();
    }
    actionTypesReady ??= Promise.resolve()
      .then(async () => {
        if (local === undefined) {
          return;
        }
        await local.registerActionTypes({
          types: [{
            id: capacitorAdvertisingActionTypeId,
            actions: [{
              id: notificationAdvertisingOptOutActionId,
              title: input.advertisingOptOutTitle ?? '수신거부',
              foreground: true,
            }],
          }],
        });
        setupFailureReported = false;
      })
      .catch((error: unknown) => {
        actionTypesReady = undefined;
        throw error;
      });
    return actionTypesReady;
  };
  if (!unsupported) {
    ensureChannels().catch(reportSetupFailure);
    ensureActionTypes().catch(reportSetupFailure);
  }

  // Local reminder operations run one at a time: each reads the pending list
  // and decides from it, so two at once could both take the last free slot.
  let localQueue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = localQueue.then(operation, operation);
    localQueue = run.catch(() => undefined);
    return run;
  };

  const availabilityOf = (): NotificationCapabilities['availability'] => {
    if (unsupported) {
      return 'unsupported';
    }
    return configurationIssue === undefined ? 'available' : 'configuration-required';
  };
  const capabilities = (): NotificationCapabilities => ({
    availability: availabilityOf(),
    permission: {
      scope: 'app',
      prompt: 'os',
      readable: true,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: false,
      ...(unsupported ? {} : { promptLimit }),
      settings: !unsupported && input.openSettings !== undefined,
    },
    remote: push === undefined
      ? { supported: false, purposes: [], addressing: 'none', content: 'free-form' }
      : {
          supported: true,
          // An Android FCM notification message cannot carry the opt-out
          // action, so advertising is not a remote purpose until the shell
          // renders it (RFC "Provider profiles", Capacitor).
          purposes: platform === 'android'
            ? ['service', 'requested']
            : ['service', 'requested', 'advertising'],
          addressing: 'device',
          content: 'free-form',
        },
    local: local === undefined
      ? { supported: false }
      : {
          supported: true,
          ...(platform === 'ios' ? { maxPending: capacitorIosMaxPendingLocalNotifications } : {}),
        },
    open: unsupported ? 'none' : 'payload',
  });

  const readPending = async (sdk: LocalNotificationSdk): Promise<{
    readonly all: readonly LocalNotificationSdkEntry[];
    readonly ours: readonly PendingReminder[];
  }> => {
    const result = await callSdk(() => sdk.getPending());
    const all = Array.isArray(result?.notifications) ? result.notifications : [];
    const ours: PendingReminder[] = [];
    for (const notification of all) {
      const entry = readLocalEntry(notification);
      if (entry !== undefined) {
        ours.push({
          ...entry,
          id: notification.id,
          ...(typeof notification.title === 'string' ? { title: notification.title } : {}),
          ...(typeof notification.body === 'string' ? { body: notification.body } : {}),
        });
      }
    }
    return { all, ours: sortEntries(ours) };
  };

  /** How many times to re-read pending after a schedule the plugin resolved early. */
  const scheduleConfirmAttempts = 4;
  /** Pause after the immediate re-reads, so a `center.add` still in flight can land. */
  const scheduleConfirmDelayMs = 25;
  /**
   * iOS `LocalNotifications.schedule` resolves before `center.add` completes.
   * The first getPending can miss the row; the next one sees a delayed add.
   */
  const confirmScheduled = async (sdk: LocalNotificationSdk, id: number): Promise<boolean> => {
    for (let attempt = 0; attempt < scheduleConfirmAttempts; attempt += 1) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, scheduleConfirmDelayMs));
      }
      const pending = await callSdk(() => sdk.getPending());
      const notifications = Array.isArray(pending?.notifications) ? pending.notifications : [];
      if (notifications.some((entry) => entry.id === id)) {
        return true;
      }
    }
    return false;
  };

  /**
   * Schedules a validated, declared, non-advertising reminder once permission
   * and channels are in place; runs inside `serialized`.
   */
  const scheduleChecked = async (
    sdk: LocalNotificationSdk,
    checked: LocalNotificationRequest,
    declared: NotificationTopicDeclaration,
  ): Promise<LocalScheduleResult> => {
    // Never let the plugin prompt: its schedule asks by itself.
    if (await readAppState() !== 'granted') {
      return { status: 'permission-required' };
    }
    await callSdk(ensureChannels);
    ensureActionTypes().catch(reportSetupFailure);
    const fireAt = normalizeNotificationTimestamp(checked.fireAt);
    const pending = await readPending(sdk);
    const existing = pending.ours.find((entry) => entry.key === checked.key);
    const maxPending = platform === 'ios' ? capacitorIosMaxPendingLocalNotifications : undefined;
    let evicted: PendingReminder | undefined;
    if (existing === undefined && maxPending !== undefined
      && pending.all.length >= maxPending) {
      // Keep the nearest: the farthest of this provider's reminders
      // gives way, or the new one is refused.
      const farthest = pending.ours.at(-1);
      if (farthest === undefined || Date.parse(fireAt) >= Date.parse(farthest.fireAt)) {
        return { status: 'capacity-exceeded' };
      }
      await callSdk(() => sdk.cancel({ notifications: [{ id: farthest.id }] }));
      evicted = farthest;
    }
    const id = existing?.id ?? freeId(checked.key, pending.all);
    const route = checked.route ?? declared.route;
    try {
      await callSdk(() =>
        sdk.schedule({
          notifications: [schemaOf({ ...checked, id, fireAt, route })],
        }),
      );
      // iOS `schedule` resolves before `center.add` finishes, and a full
      // center silently drops one. A future reminder must be pending before
      // this answers `scheduled`; an already-due one posts at once and does
      // not have to stay pending.
      const nowMs = (input.now ?? Date.now)();
      if (Date.parse(fireAt) > nowMs && !(await confirmScheduled(sdk, id))) {
        throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
          message: `Capacitor notifications: the reminder ${checked.key} was not pending after schedule.`,
        });
      }
    } catch (error) {
      // The new reminder failed after the farthest gave way: put that one back.
      if (evicted !== undefined) {
        await restore(sdk, evicted);
      }
      throw error;
    }
    return { status: existing === undefined ? 'scheduled' : 'replaced' };
  };

  /** One local notification as this provider writes it, for a new or a restored reminder. */
  const schemaOf = (input: {
    readonly id: number;
    readonly title: string;
    readonly body: string;
    readonly key: string;
    readonly topic: string;
    readonly fireAt: string;
    readonly route?: string | undefined;
  }): LocalNotificationSdkSchema => {
    const declared = mappedTopic(input.topic);
    return {
      id: input.id,
      title: input.title,
      body: input.body,
      // Inexact, but allowed to fire in Doze: without it Android posts the
      // reminder only when the device next wakes for another reason.
      schedule: { at: new Date(input.fireAt), allowWhileIdle: true },
      extra: {
        [extraKeys.key]: input.key,
        [extraKeys.topic]: input.topic,
        [extraKeys.fireAt]: input.fireAt,
        ...(input.route === undefined ? {} : { [extraKeys.route]: input.route }),
      },
      ...(platform === 'android' && declared !== undefined
        ? { channelId: capacitorNotificationChannelId(declared) }
        : {}),
      isExactNotification: false,
    };
  };

  /** Puts an evicted reminder back as `getPending` reported it; reports when it cannot. */
  const restore = async (sdk: LocalNotificationSdk, entry: PendingReminder): Promise<void> => {
    const { title, body } = entry;
    if (title === undefined || body === undefined) {
      reportError(
        new Error(`Capacitor notifications: could not restore the reminder ${entry.key}.`),
      );
      return;
    }
    try {
      await callSdk(() =>
        sdk.schedule({
          notifications: [schemaOf({ ...entry, title, body })],
        }),
      );
    } catch (error) {
      reportError(error);
    }
  };

  const provider: CapacitorNotificationProvider = {
    provider: providerId,
    topics,
    async getCapabilities() {
      return capabilities();
    },
    async getPermission(request) {
      const requested = topicsOf(request);
      assertConfigured();
      return snapshotOf(requested, await readAppState());
    },
    async requestPermission(request) {
      const requested = topicsOf(request);
      assertConfigured();
      const outcomes: Record<string, NotificationPermissionOutcome> = {};
      if (askPermission === undefined) {
        for (const topic of requested) {
          outcomes[topic] = 'unavailable';
        }
        return { snapshot: snapshotOf(requested, 'unsupported'), outcomes };
      }
      const askable = requested.filter((topic) => mappedTopic(topic) !== undefined);
      for (const topic of requested) {
        outcomes[topic] = 'unavailable';
      }
      if (askable.length === 0) {
        return { snapshot: snapshotOf(requested, await readAppState()), outcomes };
      }
      let answer = requesting;
      if (answer === undefined) {
        const generation = requests;
        const before = await readAppState();
        // Another request may have opened the dialog during that read, or
        // opened and closed it: then this call shares that answer instead
        // of asking again from a state read before it.
        answer = requesting
          // Only a dialog that started after the read began, and answered.
          ?? (lastAnswer !== undefined && answeredSince(generation)
            ? Promise.resolve(lastAnswer)
            : undefined);
        if (answer === undefined && before === 'blocked') {
          // Only settings can change it; the dialog would not show.
          for (const topic of askable) {
            outcomes[topic] = 'blocked';
          }
          return { snapshot: snapshotOf(requested, before), outcomes };
        }
        if (answer === undefined) {
          // The push plugin also registers with APNs on iOS. Its answer is
          // not read: on Android 12 and lower it is granted whatever the
          // setting is, so the read after it decides (through the local
          // plugin when present).
          requests += 1;
          const request = requests;
          // Started in a microtask, so `requesting` is set before the dialog
          // opens and every read from then on sees it.
          const asked = Promise.resolve().then(async () => {
            await callSdk(askPermission);
            const after = await readAppState();
            lastObserved = after;
            lastAnswer = { request, before, after };
            return lastAnswer;
          });
          requesting = asked;
          const clear = (): void => {
            if (requesting === asked) {
              requesting = undefined;
            }
          };
          asked.then(clear, clear);
          answer = asked;
        }
      }
      const { before, after } = await answer;
      let outcome: NotificationPermissionOutcome;
      if (after === 'granted') {
        outcome = before === 'granted' ? 'already-granted' : 'granted';
      } else if (after === before) {
        // A dialog closed without an answer leaves the state as it was.
        outcome = 'dismissed';
      } else {
        outcome = 'denied';
      }
      for (const topic of askable) {
        outcomes[topic] = outcome;
      }
      return {
        snapshot: snapshotOf(requested, after),
        outcomes,
      } satisfies NotificationPermissionResult;
    },
    ...(push === undefined
      ? {}
      : {
          async register(): Promise<NotificationEndpointRegistration | null> {
            assertConfigured();
            // Do not hand the backend a token until the Android channels
            // exist. A failed create is retryable and returns no token.
            await callSdk(ensureChannels);
            let value: string;
            try {
              value = (await push.getToken()).token;
            } catch (error) {
              if (error instanceof NotificationError || isConfigurationFailure(error)) {
                throw toNotificationError(error);
              }
              // No address yet (iOS before APNs registration, offline):
              // `tokenReceived` announces it as `endpoint-changed`. Reported
              // once until a token arrives, because a Firebase set up wrongly
              // fails the same way.
              if (!tokenFailureReported) {
                tokenFailureReported = true;
                reportError(error);
              }
              return null;
            }
            if (typeof value !== 'string' || value === '') {
              return null;
            }
            tokenFailureReported = false;
            return registrationOf(value);
          },
        }),
    ...(local === undefined
      ? {}
      : {
          async scheduleLocal(request: LocalNotificationRequest): Promise<LocalScheduleResult> {
            let checked: LocalNotificationRequest;
            try {
              checked = assertLocalNotificationRequest(request);
            } catch (error) {
              throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
                message: error instanceof Error ? error.message : 'Invalid local reminder.',
                cause: error,
              });
            }
            const declared = mappedTopic(checked.topic);
            if (declared === undefined || declared.purpose === 'advertising') {
              // Outside the resolved catalog it has no channel, as a request
              // for it answers `unavailable`; and a device-scheduled
              // advertisement could not be withdrawn, labelled, or held for
              // the night window (RFC "Topic catalog").
              return { status: 'unsupported' };
            }
            // The whole operation holds the queue, so concurrent calls apply
            // in the order they were made.
            return serialized(() => scheduleChecked(local, checked, declared));
          },
          cancelLocal(request: { readonly keys: readonly string[] }): Promise<void> {
            if (!Array.isArray(request?.keys)) {
              return Promise.reject(new NotificationError('NOTIFICATIONS_INVALID_INPUT'));
            }
            const keys = new Set(request.keys);
            return serialized(async () => {
              const ids = (await readPending(local)).ours
                .filter((entry) => keys.has(entry.key))
                .map((entry) => ({ id: entry.id }));
              if (ids.length > 0) {
                await callSdk(() => local.cancel({ notifications: ids }));
              }
            });
          },
          listLocal(): Promise<readonly LocalNotificationEntry[]> {
            return serialized(async () => {
              const now = (input.now ?? Date.now)();
              return (await readPending(local)).ours
                // Android `getPending` lists stored rows, including one-shots
                // that already fired. Those are not pending. iOS drops them
                // from the center, and a past `fireAt` there can still be
                // waiting for the device to wake, so it stays.
                .filter((entry) => platform !== 'android' || Date.parse(entry.fireAt) > now)
                .map(({ key, topic, fireAt }) => ({ key, topic, fireAt }));
            });
          },
        }),
    async openSettings(): Promise<NotificationSettingsResult> {
      const open = input.openSettings;
      if (unsupported || open === undefined) {
        return 'unavailable';
      }
      // Resolve once the player is back, so the game stays paused while the
      // settings screen is up: on Android the native call returns as soon as
      // the screen launches, before the app reports the background.
      let finish: () => void = () => undefined;
      /** Whether the wait ended by a timer rather than the player's return. */
      let timedOut = false;
      const returned = new Promise<void>((resolve) => {
        let left = false;
        const done = (): void => {
          appStateWaiters.delete(waiter);
          clearTimeout(leaveTimer);
          clearTimeout(returnTimer);
          resolve();
        };
        const expire = (): void => {
          timedOut = true;
          done();
        };
        const waiter = (active: boolean): void => {
          if (!active) {
            left = true;
          } else if (left) {
            done();
          }
        };
        appStateWaiters.add(waiter);
        // A screen that never took the app to the background does not hold the game.
        const leaveTimer = setTimeout(() => {
          if (!left) {
            expire();
          }
        }, input.settingsLeaveTimeoutMs ?? capacitorSettingsLeaveTimeoutMs);
        const returnTimer = setTimeout(expire, input.settingsReturnTimeoutMs
          ?? capacitorSettingsReturnTimeoutMs);
        finish = done;
      });
      // The opener is raced with the wait: one that never settles must not
      // hold the game past the timers, and settling after they ended changes
      // nothing (a late rejection is only reported).
      const opening = Promise.resolve()
        .then(() => open())
        .then(
          () => 'opened' as const,
          (error: unknown) => {
            reportError(error);
            return 'failed' as const;
          },
        );
      const outcome = await Promise.race([
        opening,
        returned.then(() => 'waited' as const),
      ]);
      if (outcome === 'failed') {
        finish();
        return 'unavailable';
      }
      if (outcome === 'waited') {
        // The wait ended before the opener settled: answered as a missed
        // return is. A timer ending it is a stall, reported once; the player
        // coming back first is a normal round trip (some iOS openers settle
        // only after the settings screen closes).
        if (timedOut) {
          reportError(new Error(
            'Capacitor notifications: openSettings had not settled when the settings wait timed out.',
          ));
        }
        return 'opened';
      }
      await returned;
      return 'opened';
    },
    subscribe(subscriber) {
      // One entry per call, so the same function subscribed twice is two
      // subscriptions, and only the handle this call returns removes this one.
      const listener = (event: NotificationEvent): void => subscriber(event);
      const first = listeners.size === 0;
      listeners.add(listener);
      // `source` reads `cold` only for opens before the first subscriber ever.
      subscribed = true;
      if (first && !draining) {
        // Every buffered event reaches the next subscriber exactly once, in
        // order: an event dispatched while the buffer drains queues behind it
        // and then reaches every listener attached by then, as a live one does.
        draining = true;
        // The backlog is taken whole, so an eviction while it drains touches
        // only events dispatched meanwhile. This subscription cannot leave
        // during the drain: it runs inside this `subscribe` call, before the
        // call returns the only handle that removes it.
        const backlog = buffer.splice(0);
        try {
          for (const event of backlog) {
            deliver(event, [listener]);
          }
          for (let event = buffer.shift(); event !== undefined; event = buffer.shift()) {
            deliver(event, [...listeners]);
          }
        } finally {
          draining = false;
        }
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return provider;
}

function collectChannels(
  topics: readonly NotificationTopicDeclaration[],
  settings: Readonly<Record<string, CapacitorNotificationChannelSettings>>,
): NotificationSdkChannel[] {
  const purposes = new Map<string, NotificationPurpose>();
  for (const topic of topics) {
    const id = capacitorNotificationChannelId(topic);
    const seen = purposes.get(id);
    if (seen !== undefined && (seen === 'advertising') !== (topic.purpose === 'advertising')) {
      // RFC "Provider profiles", Capacitor: advertising has channels of its
      // own, so a player can turn it off without losing service messages.
      throw new Error(
        `Capacitor notifications: channel ${id} mixes advertising and other topics (${topic.id}).`,
      );
    }
    purposes.set(id, seen ?? topic.purpose);
  }
  return [...purposes].map(([id, purpose]) => {
    const channel = Object.prototype.hasOwnProperty.call(settings, id) ? settings[id] : undefined;
    const fallback = defaultChannels[purpose];
    return {
      id,
      name: channel?.name ?? fallback.name,
      ...(channel?.description === undefined ? {} : { description: channel.description }),
      importance: channel?.importance ?? 3,
    };
  });
}

function topicsOf(request: NotificationTopicsInput): readonly string[] {
  if (!Array.isArray(request?.topics)
    || !request.topics.every((topic) => typeof topic === 'string')) {
    throw new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
      message: 'Notification topics must be a list of topic ids.',
    });
  }
  return [...new Set(request.topics)];
}

function toPermissionState(
  state: NotificationSdkPermissionState | undefined,
): NotificationPermissionState {
  switch (state) {
    case 'granted':
      return 'granted';
    case 'prompt':
    case 'provisional':
    case 'ephemeral':
      // Provisional and ephemeral can still be upgraded by a prompt. The
      // installed plugins collapse both to `granted`; a shell that reports
      // the raw status is not treated as already granted.
      return 'prompt';
    case 'prompt-with-rationale':
      return 'prompt-with-rationale';
    case 'denied':
      // iOS after its one denial, Android after the second: only settings
      // can change it.
      return 'blocked';
    default:
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `The notification plugin reported an unknown permission state: ${String(state)}.`,
      });
  }
}

/** One OS dialog's answer, and the `requests` count that started it. */
interface PermissionDialogAnswer {
  readonly request: number;
  readonly before: NotificationPermissionState;
  readonly after: NotificationPermissionState;
}

/** One of this provider's pending reminders, as `getPending` reported it. */
interface PendingReminder extends LocalEntryExtra {
  readonly id: number;
  readonly title?: string;
  readonly body?: string;
}

interface LocalEntryExtra extends LocalNotificationEntry {
  readonly route?: string;
}

/** This provider's key, topic, and time from a local notification's `extra`, or `undefined` for another one. */
function readLocalEntry(notification: LocalNotificationSdkEntry | undefined): LocalEntryExtra | undefined {
  const extra = notification?.extra;
  if (!isRecord(extra) || typeof notification?.id !== 'number') {
    return undefined;
  }
  const key = stringOf(extra[extraKeys.key]);
  const topic = stringOf(extra[extraKeys.topic]);
  const fireAt = stringOf(extra[extraKeys.fireAt]);
  if (key === undefined || topic === undefined || fireAt === undefined
    || Number.isNaN(Date.parse(fireAt))) {
    return undefined;
  }
  const route = safeRoute(extra[extraKeys.route]);
  return { key, topic, fireAt, ...(route === undefined ? {} : { route }) };
}

/**
 * A route the game may open, by the rule its router applies
 * (`isRootRelativeNotificationRoute`): at most 2,048 characters and already
 * in the form `normalizeRootRelativeRoute` from `@mpgd/platform/routes`
 * returns, which also refuses any path a client could read as another host
 * (`hasNetworkPathPrefix`).
 */
function safeRoute(value: unknown): string | undefined {
  return typeof value === 'string' && isRootRelativeNotificationRoute(value) ? value : undefined;
}

/** The action a native event names; `tap` when it names none. */
function actionIdOf(event: { readonly actionId?: unknown } | undefined): string {
  return typeof event?.actionId === 'string' ? event.actionId : 'tap';
}

function freeId(key: string, pending: readonly LocalNotificationSdkEntry[]): number {
  const taken = new Set(pending.map((entry) => entry.id));
  let id = capacitorLocalNotificationId(key);
  while (taken.has(id)) {
    id = id === maxNativeId ? 1 : id + 1;
  }
  return id;
}

function sortEntries<TEntry extends LocalNotificationEntry>(entries: readonly TEntry[]): TEntry[] {
  return [...entries].sort((left, right) => {
    const byTime = Date.parse(left.fireAt) - Date.parse(right.fireAt);
    if (byTime !== 0) {
      return byTime;
    }
    // Code unit order, the same on every device locale.
    if (left.key === right.key) {
      return 0;
    }
    return left.key < right.key ? -1 : 1;
  });
}

async function callSdk<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toNotificationError(error);
  }
}

function toNotificationError(error: unknown): NotificationError {
  if (error instanceof NotificationError) {
    return error;
  }
  const code = isRecord(error) ? stringOf(error['code']) : undefined;
  if (isConfigurationFailure(error)) {
    return new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
      ...(code === undefined ? {} : { hostCode: code }),
      cause: error,
    });
  }
  return new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { cause: error });
}

/** Capacitor's answer for a plugin the native shell does not implement. */
function isConfigurationFailure(error: unknown): boolean {
  const code = isRecord(error) ? error['code'] : undefined;
  return code === 'UNIMPLEMENTED' || code === 'UNAVAILABLE';
}

function defaultTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function defaultLocale(): string | undefined {
  const language: unknown = (globalThis as { readonly navigator?: { readonly language?: unknown } })
    .navigator?.language;
  return typeof language === 'string' ? language : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
