import { Capacitor, type PermissionState, type PluginListenerHandle } from '@capacitor/core';

// The two plugin surfaces the Capacitor notifications provider uses
// (notifications RFC "Provider profiles", Capacitor). The provider speaks
// only these interfaces, as the commerce provider speaks `StoreSdk`, so tests
// drive it with fakes and the plugins stay optional peers that only
// `loadCapacitorNotificationSdks` imports, dynamically. The shapes follow
// `@capacitor-firebase/messaging` 8.x and `@capacitor/local-notifications`
// 8.x, narrowed to what the provider calls.

/** A notification as `@capacitor-firebase/messaging` reports it. */
export interface PushSdkNotification {
  readonly id?: string;
  readonly title?: string;
  readonly body?: string;
  /** The FCM data payload (Android) or the APNs `userInfo` (iOS). Untrusted. */
  readonly data?: unknown;
}

export interface PushSdkActionEvent {
  /** `tap` for the notification itself, otherwise the action's id. */
  readonly actionId: string;
  readonly notification: PushSdkNotification;
}

/** An Android notification channel, as both plugins create it. */
export interface NotificationSdkChannel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Android importance, 1 (min) to 5 (max). */
  readonly importance?: 1 | 2 | 3 | 4 | 5;
}

/**
 * Remote notifications through Firebase Cloud Messaging
 * (`@capacitor-firebase/messaging`). iOS registers through Firebase Messaging
 * too, and FCM relays to APNs. Do not install `@capacitor/push-notifications`
 * next to it: on iOS both claim Capacitor's one push handler.
 */
export interface PushSdk {
  /** On Android 12 and lower the plugin answers `granted` whatever the system setting is. */
  checkPermissions(): Promise<{ readonly receive: PermissionState }>;
  /** Shows the OS dialog when the OS still allows it; on iOS it also registers with APNs. */
  requestPermissions(): Promise<{ readonly receive: PermissionState }>;
  /** Rejects while Firebase cannot issue a token yet (iOS before APNs registration, offline). */
  getToken(): Promise<{ readonly token: string }>;
  /** A Firebase installation id, for a project that registers installations instead of tokens. */
  getInstallationId?(): Promise<{ readonly installationId: string }>;
  createChannel?(channel: NotificationSdkChannel): Promise<void>;
  addListener(
    eventName: 'tokenReceived',
    listener: (event: { readonly token: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'notificationReceived',
    listener: (event: { readonly notification: PushSdkNotification }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'notificationActionPerformed',
    listener: (event: PushSdkActionEvent) => void,
  ): Promise<PluginListenerHandle>;
}

/** A scheduled local notification as the provider writes it. */
export interface LocalNotificationSdkSchema {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  /** `allowWhileIdle` lets an inexact alarm fire in Doze (`setAndAllowWhileIdle`). */
  readonly schedule: { readonly at: Date; readonly allowWhileIdle: true };
  /** Round-trips through `getPending` and the listeners; the provider stores its key there. */
  readonly extra: Readonly<Record<string, string>>;
  /** Android only. */
  readonly channelId?: string;
  /**
   * Always `false`: the plugin defaults to exact alarms, which on Android 12+
   * opens the "Alarms & reminders" screen when the app lacks
   * `SCHEDULE_EXACT_ALARM`, and Android 14 denies that permission by default.
   */
  readonly isExactNotification: false;
}

/** A local notification as `getPending` and the listeners report it. */
export interface LocalNotificationSdkEntry {
  readonly id: number;
  /** `getPending` reports these; the provider restores an evicted reminder from them. */
  readonly title?: string;
  readonly body?: string;
  readonly extra?: unknown;
}

export interface LocalNotificationSdkActionType {
  readonly id: string;
  readonly actions: {
    readonly id: string;
    readonly title: string;
    /** Opens the app, so the game can route the action. */
    readonly foreground?: boolean;
  }[];
}

/**
 * Device-scheduled notifications (`@capacitor/local-notifications`). Its
 * `schedule` asks for the notification permission by itself on Android 13+,
 * so the provider calls it only once a fresh `checkPermissions` answered
 * `granted` (RFC "Consent model": never prompt as a side effect).
 */
export interface LocalNotificationSdk {
  /** Reflects the system setting on every Android version, unlike the push plugin. */
  checkPermissions(): Promise<{ readonly display: PermissionState }>;
  requestPermissions(): Promise<{ readonly display: PermissionState }>;
  // Parameter lists are mutable, as the plugin declares them.
  schedule(options: { readonly notifications: LocalNotificationSdkSchema[] }): Promise<unknown>;
  cancel(options: { readonly notifications: { readonly id: number }[] }): Promise<void>;
  getPending(): Promise<{ readonly notifications: readonly LocalNotificationSdkEntry[] }>;
  createChannel(channel: NotificationSdkChannel): Promise<void>;
  /**
   * On iOS this sets the app's notification categories, which remote
   * notifications use too, so it also carries the advertising opt-out
   * category for FCM sends.
   */
  registerActionTypes(options: { readonly types: LocalNotificationSdkActionType[] }): Promise<void>;
  addListener(
    eventName: 'localNotificationReceived',
    listener: (notification: LocalNotificationSdkEntry) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'localNotificationActionPerformed',
    listener: (event: {
      readonly actionId: string;
      readonly notification: LocalNotificationSdkEntry;
    }) => void,
  ): Promise<PluginListenerHandle>;
}

export interface CapacitorNotificationSdks {
  /** Absent when `@capacitor-firebase/messaging` is not installed in the native shell. */
  readonly push?: PushSdk;
  /** Absent when `@capacitor/local-notifications` is not installed in the native shell. */
  readonly local?: LocalNotificationSdk;
}

/** What `loadCapacitorNotificationSdks` asks of the Capacitor runtime. */
export interface CapacitorNotificationSdkRuntime {
  isNativePlatform(): boolean;
  isPluginAvailable(name: string): boolean;
}

export interface LoadCapacitorNotificationSdksInput {
  /** Defaults to `Capacitor` from `@capacitor/core`. */
  readonly runtime?: CapacitorNotificationSdkRuntime;
  /** Defaults to `import('@capacitor-firebase/messaging')`. */
  readonly importPush?: () => Promise<{ readonly FirebaseMessaging: unknown }>;
  /** Defaults to `import('@capacitor/local-notifications')`. */
  readonly importLocal?: () => Promise<{ readonly LocalNotifications: unknown }>;
}

/** The names the two plugins register with Capacitor. */
export const capacitorNotificationPluginNames = Object.freeze({
  push: 'FirebaseMessaging',
  local: 'LocalNotifications',
} as const);

/**
 * Loads the two optional plugins. Each half is absent, so the provider fails
 * closed for it, when the app does not run natively (a browser preview would
 * reach the plugins' web fallbacks), when the shell has no native
 * implementation of the plugin, or when the package cannot be imported. A
 * game that bundles `@mpgd/adapter-capacitor/notifications` installs both
 * peers, so the bundler resolves both imports; the native shell decides which
 * plugin is present.
 */
export async function loadCapacitorNotificationSdks(
  input: LoadCapacitorNotificationSdksInput = {},
): Promise<CapacitorNotificationSdks> {
  const runtime = input.runtime ?? Capacitor;
  if (!runtime.isNativePlatform()) {
    return {};
  }
  const [push, local] = await Promise.all([
    runtime.isPluginAvailable(capacitorNotificationPluginNames.push)
      ? importPlugin(
          input.importPush ?? (() => import('@capacitor-firebase/messaging')),
          'FirebaseMessaging',
        )
      : undefined,
    runtime.isPluginAvailable(capacitorNotificationPluginNames.local)
      ? importPlugin(
          input.importLocal ?? (() => import('@capacitor/local-notifications')),
          'LocalNotifications',
        )
      : undefined,
  ]);
  return {
    ...(push === undefined ? {} : { push: push.plugin as PushSdk }),
    ...(local === undefined ? {} : { local: local.plugin as LocalNotificationSdk }),
  };
}

/**
 * Imports one plugin, boxed: a Capacitor plugin is a proxy that answers every
 * property, `then` included, so resolving a promise with it would call a
 * native `then` that does not exist. Only the box crosses an `await`.
 */
async function importPlugin<TName extends string>(
  load: () => Promise<Readonly<Record<TName, unknown>>>,
  name: TName,
): Promise<{ readonly plugin: object } | undefined> {
  try {
    const plugin: unknown = (await load())[name];
    return typeof plugin === 'object' && plugin !== null ? { plugin } : undefined;
  } catch {
    return undefined;
  }
}
