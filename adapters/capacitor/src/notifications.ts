import { createNotificationServiceProvider } from './notifications-bridge.js';
import {
  createCapacitorNotificationProvider,
  type CreateCapacitorNotificationProviderInput,
} from './notifications-provider.js';
import type { CapacitorNotificationServiceProvider } from './providers.js';

// `@mpgd/adapter-capacitor/notifications`: the notifications v2 provider for
// Android and iOS (notifications RFC "Provider profiles", Capacitor). Only
// this subpath loads the notifications validators and, dynamically, the
// optional `@capacitor-firebase/messaging` and `@capacitor/local-notifications`
// peers; the base adapter entry loads neither.

export {
  capacitorNotificationPluginNames,
  loadCapacitorNotificationSdks,
  type CapacitorNotificationSdkRuntime,
  type CapacitorNotificationSdks,
  type LoadCapacitorNotificationSdksInput,
  type LocalNotificationSdk,
  type LocalNotificationSdkActionType,
  type LocalNotificationSdkEntry,
  type LocalNotificationSdkSchema,
  type NotificationSdkChannel,
  type NotificationSdkPermissionState,
  type PushSdk,
  type PushSdkActionEvent,
  type PushSdkNotification,
} from './notifications-sdk.js';
export {
  capacitorAdvertisingActionTypeId,
  capacitorIosMaxPendingLocalNotifications,
  capacitorLocalNotificationId,
  capacitorNotificationChannelId,
  capacitorNotificationDataKeys,
  capacitorNotificationProviderId,
  capacitorSettingsLeaveTimeoutMs,
  capacitorSettingsReturnTimeoutMs,
  createCapacitorNotificationProvider,
  type CapacitorNotificationAppEvents,
  type CapacitorNotificationChannelSettings,
  type CapacitorNotificationProvider,
  type CreateCapacitorNotificationProviderInput,
} from './notifications-provider.js';
export {
  createBridgeNotificationProvider,
  createNotificationProviderBridge,
  createNotificationServiceProvider,
  createNotificationSubscriptionAdapter,
  type CreateBridgeNotificationProviderInput,
  type CreateNotificationProviderBridgeInput,
  type CreateNotificationServiceProviderInput,
  type NotificationProviderBridge,
} from './notifications-bridge.js';
export {
  openCapacitorNotificationSettings,
  type CapacitorNotificationSettingsPlugin,
} from './notifications-settings.js';
export {
  readCapacitorAdvertisingPushRenderer,
  type CapacitorAdvertisingPushRendererPlugin,
} from './notifications-renderer.js';
export type {
  CapacitorNotificationServiceProvider,
  CapacitorNotificationsV2Service,
} from './providers.js';

export interface CreateCapacitorNotificationServiceProviderInput
  extends CreateCapacitorNotificationProviderInput {
  /** The registry id; 'capacitor-notifications' when absent. */
  readonly id?: string;
}

/**
 * The provider and its registry entry in one call, with the same topics, for
 * `createCapacitorPlatformGateway({ providers: [...] })`:
 *
 * ```ts
 * const sdks = await loadCapacitorNotificationSdks();
 * const notifications = createCapacitorNotificationServiceProvider({
 *   platform: 'android',
 *   topics: resolveNotificationTopicsForTarget(catalog, 'android'),
 *   ...sdks,
 * });
 * ```
 *
 * Create it once, early in startup: the provider registers its native
 * listeners when it is created, which is when a cold-start open reaches it.
 */
export function createCapacitorNotificationServiceProvider(
  input: CreateCapacitorNotificationServiceProviderInput,
): CapacitorNotificationServiceProvider {
  const { id, ...providerInput } = input;
  const notifications = createCapacitorNotificationProvider(providerInput);
  return createNotificationServiceProvider({
    id: id ?? 'capacitor-notifications',
    notifications,
    topics: notifications.topics,
  });
}
