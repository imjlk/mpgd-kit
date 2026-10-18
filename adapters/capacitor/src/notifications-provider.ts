import { App, type AppPlugin } from '@capacitor/app';
import type { PermissionState, PluginListenerHandle } from '@capacitor/core';
import {
  assertLocalNotificationRequest,
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
import { normalizeRootRelativeRoute } from '@mpgd/platform/routes';

import type {
  LocalNotificationSdk,
  LocalNotificationSdkEntry,
  NotificationSdkChannel,
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
export const capacitorSettingsReturnTimeoutMs = 600_000;

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
  /** The address the backend sends to; `fcm-installation` needs `push.getInstallationId`. */
  readonly address?: 'fcm-token' | 'fcm-installation';
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
const reservedDataKey = /^(?:topic|route|from|collapse_key|aps|google\.|gcm\.|fcm_options)/u;
const maxRouteLength = 2048;
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
 *   cold-start open reaches this provider, which buffers it for its first
 *   subscriber.
 * - **Permission.** It reads `LocalNotifications.checkPermissions`, which
 *   reflects the system setting on every Android version, and maps the OS
 *   `denied` to `blocked`: on iOS after the one denial, on Android after the
 *   second. Only `requestPermission` shows the OS dialog; `scheduleLocal`
 *   answers `permission-required` instead.
 * - **Local reminders.** Inexact (`isExactNotification: false`), on the
 *   topic's channel, at most 64 pending on iOS, keeping the nearest.
 * - **Fails closed.** Without either SDK the provider is `unsupported`;
 *   without `push` it declares no remote delivery, without `local` no local
 *   reminders.
 */
export function createCapacitorNotificationProvider(
  input: CreateCapacitorNotificationProviderInput,
): CapacitorNotificationProvider {
  const { push, local, platform } = input;
  const providerId = input.provider ?? capacitorNotificationProviderId;
  const addressKind = input.address ?? 'fcm-token';
  if (addressKind === 'fcm-installation' && push !== undefined
    && push.getInstallationId === undefined) {
    throw new Error(
      'Capacitor notifications: address fcm-installation needs a PushSdk with getInstallationId.',
    );
  }
  const topics = [...input.topics];
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));
  const channels = collectChannels(topics, input.channels ?? {});
  const unsupported = push === undefined && local === undefined;
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
  let buffer: NotificationEvent[] = [];
  let subscribed = false;
  const dispatch = (event: NotificationEvent): void => {
    if (!subscribed) {
      buffer.push(event);
      if (buffer.length > eventBufferLimit) {
        // Keep the opens: a cold-start open must not be lost to later events.
        const evicted = buffer.findIndex((buffered) => buffered.type !== 'opened');
        buffer.splice(evicted === -1 ? 0 : evicted, 1);
      }
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        reportError(error);
      }
    }
  };

  // Permission. It is read from the local plugin, which reflects the system
  // setting on every Android version, and asked through the push plugin,
  // which also registers with APNs on iOS.
  const checkPermission = local !== undefined
    ? async () => (await local.checkPermissions()).display
    : push === undefined
      ? undefined
      : async () => (await push.checkPermissions()).receive;
  const askPermission = push !== undefined
    ? async () => (await push.requestPermissions()).receive
    : local === undefined
      ? undefined
      : async () => (await local.requestPermissions()).display;
  const getInstallationId = push?.getInstallationId?.bind(push);
  let lastObserved: NotificationPermissionState | undefined;
  const readAppState = async (): Promise<NotificationPermissionState> => {
    if (checkPermission === undefined) {
      return 'unsupported';
    }
    const state = await callSdk(checkPermission);
    const mapped = toPermissionState(state);
    lastObserved = mapped;
    return mapped;
  };
  const snapshotOf = (
    requested: readonly string[],
    state: NotificationPermissionState,
  ): NotificationPermissionSnapshot => ({
    app: state,
    topics: Object.fromEntries(requested.map((topic) => [topic, state])),
  });

  // Settings round trips and permission changes made outside the game.
  const appStateWaiters = new Set<(active: boolean) => void>();
  const onAppState = (active: boolean): void => {
    for (const waiter of [...appStateWaiters]) {
      waiter(active);
    }
    if (active && lastObserved !== undefined && !unsupported) {
      const before = lastObserved;
      void readAppState().then((state) => {
        if (state !== before) {
          // Changed in system settings: no plugin reports it as an event.
          dispatch({
            type: 'permission-changed',
            snapshot: snapshotOf(topics.map((topic) => topic.id), state),
          });
        }
      }, reportError);
    }
  };

  const registrationWith = (
    value: string,
    permission: NotificationPermissionState,
  ): NotificationEndpointRegistration => {
    const timeZone = (input.timeZone ?? defaultTimeZone)();
    const locale = (input.locale ?? defaultLocale)();
    return {
      provider: providerId,
      address: { kind: addressKind, value, permission },
      ...(locale === undefined || locale === '' ? {} : { locale }),
      ...(timeZone === undefined || timeZone === '' ? {} : { timeZone }),
    };
  };
  const registrationOf = async (value: string): Promise<NotificationEndpointRegistration> =>
    registrationWith(value, await readAppState());

  const openedFromPush = (actionId: string, notification: PushSdkNotification): void => {
    const data = isRecord(notification.data) ? notification.data : {};
    const topicId = stringOf(data[capacitorNotificationDataKeys.topic]);
    const declared = topicId === undefined ? undefined : topicById.get(topicId);
    // The opt-out action opens the topic's declared opt-out screen, never a
    // route from the payload.
    const route = actionId === notificationAdvertisingOptOutActionId
      ? declared?.purpose === 'advertising'
        ? declared.optOutRoute
        : undefined
      : safeRoute(data[capacitorNotificationDataKeys.route]);
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

  const openedFromLocal = (actionId: string, notification: LocalNotificationSdkEntry): void => {
    const entry = readLocalEntry(notification);
    if (entry === undefined || actionId === 'dismiss') {
      // Not one of this provider's reminders, or not an open.
      return;
    }
    dispatch({
      type: 'opened',
      channel: 'local',
      source: subscribed ? 'warm' : 'cold',
      topic: entry.topic,
      ...(entry.route === undefined ? {} : { route: entry.route }),
    });
  };

  // Native listeners: synchronously, before any await, for the process lifetime.
  const handles: Promise<PluginListenerHandle>[] = [];
  const listen = (register: () => Promise<PluginListenerHandle>): void => {
    try {
      const handle = register();
      handle.catch(reportError);
      handles.push(handle);
    } catch (error) {
      reportError(error);
    }
  };
  if (push !== undefined) {
    listen(() => push.addListener('tokenReceived', (event) => {
      if (addressKind !== 'fcm-token' || typeof event.token !== 'string' || event.token === '') {
        return;
      }
      // A rotated token goes out at once, with the permission this provider
      // last read: a permission changes only in system settings, and the
      // return from there reads it again. Before any read it reads first.
      if (lastObserved !== undefined) {
        dispatch({
          type: 'endpoint-changed',
          registration: registrationWith(event.token, lastObserved),
        });
        return;
      }
      void registrationOf(event.token).then(
        (registration) => dispatch({ type: 'endpoint-changed', registration }),
        reportError,
      );
    }));
    listen(() => push.addListener('notificationReceived', (event) => {
      const data = isRecord(event.notification.data) ? event.notification.data : {};
      const topic = stringOf(data[capacitorNotificationDataKeys.topic]);
      dispatch({ type: 'received', channel: 'remote', ...(topic === undefined ? {} : { topic }) });
    }));
    listen(() =>
      push.addListener('notificationActionPerformed', (event) => {
        openedFromPush(event.actionId, event.notification);
      }),
    );
  }
  if (local !== undefined) {
    listen(() =>
      local.addListener('localNotificationReceived', (notification) => {
        const entry = readLocalEntry(notification);
        if (entry !== undefined) {
          dispatch({ type: 'received', channel: 'local', topic: entry.topic });
        }
      }),
    );
    listen(() =>
      local.addListener('localNotificationActionPerformed', (event) => {
        openedFromLocal(event.actionId, event.notification);
      }),
    );
  }
  if (app !== null && !unsupported) {
    listen(() => app.addListener('appStateChange', (state) => onAppState(state.isActive)));
  }

  // One-time native setup: Android channels and the opt-out action type. A
  // remote push needs its channel before it arrives, so this starts now.
  const setup: Promise<void> = unsupported
    ? Promise.resolve()
    : Promise.resolve().then(async () => {
        const createChannel = local?.createChannel.bind(local) ?? push?.createChannel?.bind(push);
        if (platform === 'android' && createChannel !== undefined) {
          for (const channel of channels) {
            await createChannel(channel);
          }
        }
        await local?.registerActionTypes({
          types: [{
            id: capacitorAdvertisingActionTypeId,
            actions: [{
              id: notificationAdvertisingOptOutActionId,
              title: input.advertisingOptOutTitle ?? '수신거부',
              foreground: true,
            }],
          }],
        });
      }).catch((error: unknown) => {
        reportError(error);
      });

  const capabilities = (): NotificationCapabilities => ({
    availability: unsupported ? 'unsupported' : 'available',
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
          purposes: ['service', 'requested', 'advertising'],
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
    readonly ours: readonly (LocalNotificationEntry & { readonly id: number })[];
  }> => {
    const result = await callSdk(() => sdk.getPending());
    const all = Array.isArray(result?.notifications) ? result.notifications : [];
    const ours: (LocalNotificationEntry & { readonly id: number })[] = [];
    for (const notification of all) {
      const entry = readLocalEntry(notification);
      if (entry !== undefined) {
        ours.push({
          id: notification.id,
          key: entry.key,
          topic: entry.topic,
          fireAt: entry.fireAt,
        });
      }
    }
    return { all, ours: sortEntries(ours) };
  };

  const provider: CapacitorNotificationProvider = {
    provider: providerId,
    topics,
    async getCapabilities() {
      return capabilities();
    },
    async getPermission(request) {
      const requested = topicsOf(request);
      return snapshotOf(requested, await readAppState());
    },
    async requestPermission(request) {
      const requested = topicsOf(request);
      const outcomes: Record<string, NotificationPermissionOutcome> = {};
      if (askPermission === undefined) {
        for (const topic of requested) {
          outcomes[topic] = 'unavailable';
        }
        return { snapshot: snapshotOf(requested, 'unsupported'), outcomes };
      }
      const askable = requested.filter((topic) => topicById.get(topic)?.mapping !== undefined);
      for (const topic of requested) {
        outcomes[topic] = 'unavailable';
      }
      const before = await readAppState();
      if (askable.length === 0) {
        return { snapshot: snapshotOf(requested, before), outcomes };
      }
      if (before === 'blocked') {
        // Only settings can change it; the dialog would not show.
        for (const topic of askable) {
          outcomes[topic] = 'blocked';
        }
        return { snapshot: snapshotOf(requested, before), outcomes };
      }
      // The push plugin also registers with APNs on iOS; on Android 12 and
      // lower it answers granted without reading the setting, so the fresh
      // read below decides.
      const answered = await callSdk(askPermission);
      const after = local === undefined ? toPermissionState(answered) : await readAppState();
      lastObserved = after;
      const outcome: NotificationPermissionOutcome = after === 'granted'
        ? before === 'granted' ? 'already-granted' : 'granted'
        // A dialog closed without an answer leaves the state as it was.
        : after === before ? 'dismissed' : 'denied';
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
            let value: string;
            try {
              value = addressKind === 'fcm-installation' && getInstallationId !== undefined
                ? (await getInstallationId()).installationId
                : (await push.getToken()).token;
            } catch (error) {
              if (isConfigurationFailure(error)) {
                throw toNotificationError(error);
              }
              // No address yet (iOS before APNs registration, offline):
              // `tokenReceived` announces it as `endpoint-changed`.
              return null;
            }
            return typeof value === 'string' && value !== '' ? registrationOf(value) : null;
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
            const declared = topicById.get(checked.topic);
            if (declared?.purpose === 'advertising') {
              // A device-scheduled advertisement could not be withdrawn,
              // labelled, or held for the night window (RFC "Topic catalog").
              return { status: 'unsupported' };
            }
            await setup;
            // Never let the plugin prompt: its schedule asks by itself.
            if (await readAppState() !== 'granted') {
              return { status: 'permission-required' };
            }
            const fireAt = normalizeNotificationTimestamp(checked.fireAt);
            const pending = await readPending(local);
            const existing = pending.ours.find((entry) => entry.key === checked.key);
            const maxPending = platform === 'ios'
              ? capacitorIosMaxPendingLocalNotifications
              : undefined;
            if (existing === undefined && maxPending !== undefined
              && pending.all.length >= maxPending) {
              // Keep the nearest: the farthest of this provider's reminders
              // gives way, or the new one is refused.
              const farthest = pending.ours.at(-1);
              if (farthest === undefined || Date.parse(fireAt) >= Date.parse(farthest.fireAt)) {
                return { status: 'capacity-exceeded' };
              }
              await callSdk(() => local.cancel({ notifications: [{ id: farthest.id }] }));
            }
            const id = existing?.id ?? freeId(checked.key, pending.all);
            const route = checked.route ?? declared?.route;
            await callSdk(() => local.schedule({
              notifications: [{
                id,
                title: checked.title,
                body: checked.body,
                schedule: { at: new Date(fireAt) },
                extra: {
                  [extraKeys.key]: checked.key,
                  [extraKeys.topic]: checked.topic,
                  [extraKeys.fireAt]: fireAt,
                  ...(route === undefined ? {} : { [extraKeys.route]: route }),
                },
                ...(platform === 'android'
                  ? {
                      channelId: capacitorNotificationChannelId(
                        declared ?? { purpose: 'requested' },
                      ),
                    }
                  : {}),
                isExactNotification: false,
              }],
            }));
            return { status: existing === undefined ? 'scheduled' : 'replaced' };
          },
          async cancelLocal(request: { readonly keys: readonly string[] }): Promise<void> {
            if (!Array.isArray(request?.keys)) {
              throw new NotificationError('NOTIFICATIONS_INVALID_INPUT');
            }
            const keys = new Set(request.keys);
            const ids = (await readPending(local)).ours
              .filter((entry) => keys.has(entry.key))
              .map((entry) => ({ id: entry.id }));
            if (ids.length > 0) {
              await callSdk(() => local.cancel({ notifications: ids }));
            }
          },
          async listLocal(): Promise<readonly LocalNotificationEntry[]> {
            return (await readPending(local)).ours.map(({ key, topic, fireAt }) => ({ key, topic, fireAt }));
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
      const returned = new Promise<void>((resolve) => {
        let left = false;
        const done = (): void => {
          appStateWaiters.delete(waiter);
          clearTimeout(leaveTimer);
          clearTimeout(returnTimer);
          resolve();
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
            done();
          }
        }, input.settingsLeaveTimeoutMs ?? capacitorSettingsLeaveTimeoutMs);
        const returnTimer = setTimeout(done, input.settingsReturnTimeoutMs
          ?? capacitorSettingsReturnTimeoutMs);
        finish = done;
      });
      try {
        await open();
      } catch (error) {
        reportError(error);
        finish();
        return 'unavailable';
      }
      await returned;
      return 'opened';
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!subscribed) {
        subscribed = true;
        const drained = buffer;
        buffer = [];
        // Every buffered event reaches the first subscriber exactly once.
        for (const event of drained) {
          try {
            listener(event);
          } catch (error) {
            reportError(error);
          }
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

function toPermissionState(state: PermissionState | undefined): NotificationPermissionState {
  switch (state) {
    case 'granted':
      return 'granted';
    case 'prompt':
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
 * A route the game may open: root-relative and already in the form
 * `normalizeRootRelativeRoute` returns, which also refuses any path a client
 * could read as another host (`hasNetworkPathPrefix`).
 */
function safeRoute(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= maxRouteLength
    && normalizeRootRelativeRoute(value) === value
    ? value
    : undefined;
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
  return [...entries].sort((left, right) =>
    Date.parse(left.fireAt) - Date.parse(right.fireAt) || left.key.localeCompare(right.key));
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
