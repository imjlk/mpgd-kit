import {
  CapacitorGameServices,
  type CapacitorGameServicesPlugin,
} from '@mpgd/capacitor-game-services';

/** The part of `@mpgd/capacitor-game-services` the settings opener calls. */
export type CapacitorNotificationSettingsPlugin = Pick<
  CapacitorGameServicesPlugin,
  'openNotificationSettings'
>;

/**
 * Opens this app's notification settings through
 * `@mpgd/capacitor-game-services` (Android 8+ app notification settings, iOS
 * 16+ notification settings, each app's settings page on older versions).
 * Pass it as the provider's `openSettings`, which then declares
 * `permission.settings: true` and waits for the player to come back. It
 * throws when the system could not open the screen, and the plugin rejects
 * it as unimplemented in a shell built with a plugin older than the method;
 * the provider reports either failure and answers `unavailable`.
 */
export async function openCapacitorNotificationSettings(
  plugin: CapacitorNotificationSettingsPlugin = CapacitorGameServices,
): Promise<void> {
  const result: unknown = await plugin.openNotificationSettings();
  if (typeof result !== 'object' || result === null
    || (result as { readonly opened?: unknown }).opened !== true) {
    throw new Error('The notification settings screen could not be opened.');
  }
}
