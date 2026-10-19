import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

/** What `openNotificationSettings` answers once the settings screen was asked for. */
export interface OpenNotificationSettingsResult {
  /** False when the system could not open the screen. */
  readonly opened: boolean;
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
}
