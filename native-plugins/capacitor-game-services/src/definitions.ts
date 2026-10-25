import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

/** What `openNotificationSettings` answers once the settings screen was asked for. */
export interface OpenNotificationSettingsResult {
  /** False when the system could not open the screen. */
  readonly opened: boolean;
}

/** What `getAdvertisingPushRenderer` answers. */
export interface AdvertisingPushRendererResult {
  /**
   * True when the messaging service Firebase Messaging resolves for this app
   * is the kit's advertising renderer (`dev.mpgd.capacitor.AdvertisingMessagingService`,
   * or a shell service that declares the
   * `dev.mpgd.notifications.advertising_renderer` meta-data).
   */
  readonly installed: boolean;
}

export interface CapacitorGameServicesPlugin {
  request(input: BridgeRequest): Promise<BridgeResponse>;
  /**
   * Opens this app's notification settings: Android 8+
   * `Settings.ACTION_APP_NOTIFICATION_SETTINGS` (the app details screen
   * before it, and when the device cannot open that screen), iOS 16+
   * `UIApplication.openNotificationSettingsURLString` (the app's settings
   * page before it). It answers as soon as the screen
   * is launched, not when the player comes back. A shell built with an
   * older plugin rejects it as unimplemented.
   */
  openNotificationSettings(): Promise<OpenNotificationSettingsResult>;
  /**
   * Android only: whether this shell renders advertising pushes itself, with
   * the opt-out action (notifications v2 RFC, "Capacitor"). An Android FCM
   * notification message cannot carry actions, so the backend sends
   * advertising to an Android installation only when its registration says
   * the shell renders it. iOS, and a shell built with an older plugin,
   * reject it as unimplemented.
   */
  getAdvertisingPushRenderer(): Promise<AdvertisingPushRendererResult>;
}
