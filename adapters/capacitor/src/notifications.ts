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
