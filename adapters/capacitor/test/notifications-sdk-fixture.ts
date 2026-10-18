import type { PermissionState, PluginListenerHandle } from '@capacitor/core';

import type {
  LocalNotificationEntry,
  NotificationPermissionState,
} from '@mpgd/platform/notifications';
import type {
  NotificationConformanceHostActor,
  NotificationConformanceLocalOperation,
} from '@mpgd/platform/notifications-conformance';
import type {
  NotificationConformanceEndpointFixture,
  NotificationConformancePromptResult,
  NotificationConformanceTapInput,
} from '@mpgd/platform/notifications-vectors';

import type { CapacitorNotificationAppEvents } from '../src/notifications-provider.js';
import type {
  LocalNotificationSdk,
  LocalNotificationSdkActionType,
  LocalNotificationSdkSchema,
  NotificationSdkChannel,
  PushSdk,
} from '../src/notifications-sdk.js';

type Listener = (event: never) => void;

/**
 * A plugin's listener table with Capacitor's `retainUntilConsumed`: an event
 * emitted while no listener is registered waits for the first one.
 */
function createListenerTable() {
  const listeners = new Map<string, Set<Listener>>();
  const retained = new Map<string, unknown[]>();
  return {
    add(eventName: string, listener: Listener): Promise<PluginListenerHandle> {
      const set = listeners.get(eventName) ?? new Set<Listener>();
      listeners.set(eventName, set);
      set.add(listener);
      const waiting = retained.get(eventName) ?? [];
      retained.delete(eventName);
      for (const event of waiting) {
        listener(event as never);
      }
      return Promise.resolve({
        remove: async () => {
          set.delete(listener);
        },
      });
    },
    emit(eventName: string, event: unknown): void {
      const set = listeners.get(eventName);
      if (set === undefined || set.size === 0) {
        retained.set(eventName, [...(retained.get(eventName) ?? []), event]);
        return;
      }
      for (const listener of [...set]) {
        listener(event as never);
      }
    },
    count(eventName: string): number {
      return listeners.get(eventName)?.size ?? 0;
    },
    clear(): void {
      listeners.clear();
    },
  };
}

export interface FakeNotificationSdksInput {
  readonly platform: 'android' | 'ios';
  /** Android denials before the OS stops asking; 2 for a target SDK of 33 or later. */
  readonly androidPromptLimit?: 1 | 2;
  readonly push?: boolean;
  readonly local?: boolean;
  /** The clock a local open's `extra` time is read from. */
  readonly now?: () => string;
}

export interface FakeNotificationSdks extends NotificationConformanceHostActor {
  readonly push?: PushSdk;
  readonly local?: LocalNotificationSdk;
  readonly app: CapacitorNotificationAppEvents & {
    setActive(active: boolean): void;
    listenerCount(): number;
  };
  /** The OS permission as the plugins report it. */
  osState: PermissionState;
  readonly channels: readonly NotificationSdkChannel[];
  readonly actionTypes: readonly LocalNotificationSdkActionType[];
  readonly scheduled: readonly LocalNotificationSdkSchema[];
  readonly localPending: readonly LocalNotificationEntry[];
  /** A pending notification another part of the app scheduled. */
  addForeignPending(id: number): void;
  emitPush(eventName: 'tokenReceived' | 'notificationReceived' | 'notificationActionPerformed', event: unknown): void;
  emitLocal(eventName: 'localNotificationReceived' | 'localNotificationActionPerformed', event: unknown): void;
  /** Rejects the next call of `method` with `error`. */
  failNext(method: string, error: unknown): void;
  /** A process restart: native listeners go, OS state stays. */
  restart(): void;
}

/**
 * Fake `@capacitor-firebase/messaging` and `@capacitor/local-notifications`
 * over one OS permission, plus the conformance `host` actor that scripts
 * them: prompts answer from the queue (Android: `prompt-with-rationale` after
 * a denial under the limit, `denied` once it is used up; iOS: `denied` at the
 * first denial), `issueEndpoint` issues the FCM token and announces it, and
 * `tap` taps a push or a local notification. Scheduling while the OS
 * permission is not granted fails the run, because the real plugin would
 * prompt.
 */
export function createFakeNotificationSdks(input: FakeNotificationSdksInput): FakeNotificationSdks {
  const promptLimit = input.platform === 'ios' ? 1 : (input.androidPromptLimit ?? 2);
  const pushListeners = createListenerTable();
  const localListeners = createListenerTable();
  const appListeners = new Set<(state: { readonly isActive: boolean }) => void>();
  const promptQueue: NotificationConformancePromptResult[] = [];
  const failures = new Map<string, unknown>();
  const pending = new Map<number, LocalNotificationSdkSchema | { readonly id: number; readonly extra: Record<string, string> }>();
  const localOperations: NotificationConformanceLocalOperation[] = [];
  const scheduled: LocalNotificationSdkSchema[] = [];
  const channels: NotificationSdkChannel[] = [];
  const actionTypes: LocalNotificationSdkActionType[] = [];
  let denials = 0;
  let prompts = 0;
  let token: string | undefined;
  let tapCount = 0;

  const failure = async (method: string): Promise<void> => {
    if (failures.has(method)) {
      const error = failures.get(method);
      failures.delete(method);
      throw error;
    }
  };

  const prompt = async (): Promise<PermissionState> => {
    prompts += 1;
    const result = promptQueue.shift();
    if (result === undefined) {
      throw new Error('Unscripted OS prompt: queue a host.queuePrompt result first.');
    }
    switch (result) {
      case 'granted':
      case 'already-granted':
        sdks.osState = 'granted';
        break;
      case 'dismissed':
        break;
      case 'denied':
        denials += 1;
        sdks.osState = input.platform === 'android' && denials < promptLimit
          ? 'prompt-with-rationale'
          : 'denied';
        break;
      case 'host-terms-declined':
        throw new Error('An OS prompt has no host terms.');
    }
    return sdks.osState;
  };

  const push: PushSdk = {
    async checkPermissions() {
      await failure('push.checkPermissions');
      return { receive: sdks.osState };
    },
    async requestPermissions() {
      await failure('push.requestPermissions');
      return { receive: await prompt() };
    },
    async getToken() {
      await failure('push.getToken');
      if (token === undefined) {
        throw new Error('No FCM token yet.');
      }
      return { token };
    },
    async createChannel(channel) {
      channels.push(channel);
    },
    addListener: ((eventName: string, listener: Listener) =>
      pushListeners.add(eventName, listener)) as PushSdk['addListener'],
  };

  const local: LocalNotificationSdk = {
    async checkPermissions() {
      await failure('local.checkPermissions');
      return { display: sdks.osState };
    },
    async requestPermissions() {
      await failure('local.requestPermissions');
      return { display: await prompt() };
    },
    async schedule({ notifications }) {
      await failure('local.schedule');
      if (sdks.osState !== 'granted') {
        throw new Error('LocalNotifications.schedule would prompt for the permission.');
      }
      for (const notification of notifications) {
        localOperations.push({
          op: pending.has(notification.id) ? 'replace' : 'schedule',
          key: notification.extra['mpgdKey'] ?? '',
          topic: notification.extra['mpgdTopic'] ?? '',
          fireAt: notification.extra['mpgdFireAt'] ?? '',
          exact: notification.isExactNotification,
        });
        pending.set(notification.id, notification);
        scheduled.push(notification);
      }
      return { notifications: notifications.map(({ id }) => ({ id })) };
    },
    async cancel({ notifications }) {
      await failure('local.cancel');
      for (const { id } of notifications) {
        const entry = pending.get(id);
        if (entry !== undefined) {
          pending.delete(id);
          localOperations.push({
            op: 'cancel',
            key: entry.extra['mpgdKey'] ?? '',
            topic: entry.extra['mpgdTopic'] ?? '',
          });
        }
      }
    },
    async getPending() {
      await failure('local.getPending');
      return {
        notifications: [...pending.values()].map((entry) => ({ id: entry.id, extra: { ...entry.extra } })),
      };
    },
    async createChannel(channel) {
      channels.push(channel);
    },
    async registerActionTypes({ types }) {
      actionTypes.push(...types);
    },
    addListener: ((eventName: string, listener: Listener) =>
      localListeners.add(eventName, listener)) as LocalNotificationSdk['addListener'],
  };

  const app: FakeNotificationSdks['app'] = {
    addListener: ((eventName: string, listener: (state: { readonly isActive: boolean }) => void) => {
      if (eventName === 'appStateChange') {
        appListeners.add(listener);
      }
      return Promise.resolve({
        remove: async () => {
          appListeners.delete(listener);
        },
      });
    }) as CapacitorNotificationAppEvents['addListener'],
    setActive(active) {
      for (const listener of [...appListeners]) {
        listener({ isActive: active });
      }
    },
    listenerCount: () => appListeners.size,
  };

  const toOsState = (state: NotificationPermissionState): PermissionState => {
    switch (state) {
      case 'granted':
        return 'granted';
      case 'prompt':
        return 'prompt';
      case 'prompt-with-rationale':
        return 'prompt-with-rationale';
      case 'denied':
      case 'blocked':
        return 'denied';
      default:
        throw new Error(`The OS cannot be set to ${state}.`);
    }
  };

  const sortEntries = (entries: LocalNotificationEntry[]): LocalNotificationEntry[] =>
    entries.sort((left, right) =>
      Date.parse(left.fireAt) - Date.parse(right.fireAt) || left.key.localeCompare(right.key));

  const sdks: FakeNotificationSdks = {
    ...(input.push === false ? {} : { push }),
    ...(input.local === false ? {} : { local }),
    app,
    osState: 'prompt',
    get channels() {
      return channels;
    },
    get actionTypes() {
      return actionTypes;
    },
    get scheduled() {
      return scheduled;
    },
    get prompts() {
      return prompts;
    },
    get localOperations() {
      return localOperations;
    },
    get localPending() {
      return sortEntries([...pending.values()].flatMap((entry) => {
        const key = entry.extra['mpgdKey'];
        const topic = entry.extra['mpgdTopic'];
        const fireAt = entry.extra['mpgdFireAt'];
        return key === undefined || topic === undefined || fireAt === undefined
          ? []
          : [{ key, topic, fireAt }];
      }));
    },
    addForeignPending(id) {
      pending.set(id, { id, extra: {} });
    },
    emitPush(eventName, event) {
      pushListeners.emit(eventName, event);
    },
    emitLocal(eventName, event) {
      localListeners.emit(eventName, event);
    },
    failNext(method, error) {
      failures.set(method, error);
    },
    queuePrompt(result) {
      promptQueue.push(result);
    },
    setPermission(state) {
      // A change in system settings: no plugin reports it as an event.
      sdks.osState = toOsState(state);
    },
    issueEndpoint(endpoint: NotificationConformanceEndpointFixture) {
      if (endpoint.kind !== 'fcm-token') {
        throw new Error(`The FCM fake issues tokens, not ${endpoint.kind}.`);
      }
      token = endpoint.value;
      // Firebase announces every new token, the first one included.
      pushListeners.emit('tokenReceived', { token: endpoint.value });
    },
    completeAction() {
      throw new Error('The OS needs no player action before it can prompt.');
    },
    tap(tap: NotificationConformanceTapInput) {
      tapCount += 1;
      if (tap.channel === 'remote') {
        pushListeners.emit('notificationActionPerformed', {
          actionId: 'tap',
          notification: {
            id: `push-${tapCount}`,
            data: {
              ...tap.data,
              ...(tap.topic === undefined ? {} : { topic: tap.topic }),
              ...(tap.route === undefined ? {} : { route: tap.route }),
              'google.message_id': `0:${tapCount}`,
            },
          },
        });
        return;
      }
      localListeners.emit('localNotificationActionPerformed', {
        actionId: 'tap',
        notification: {
          id: 900_000 + tapCount,
          extra: {
            mpgdKey: `tap-${tapCount}`,
            ...(tap.topic === undefined ? {} : { mpgdTopic: tap.topic }),
            mpgdFireAt: input.now?.() ?? new Date().toISOString(),
            ...(tap.route === undefined ? {} : { mpgdRoute: tap.route }),
          },
        },
      });
    },
    restart() {
      pushListeners.clear();
      localListeners.clear();
      appListeners.clear();
    },
  };
  return sdks;
}
