import type { CapacitorServiceProvider } from '@mpgd/adapter-capacitor';
import {
  createCapacitorNotificationServiceProvider,
  loadCapacitorNotificationSdks,
  openCapacitorNotificationSettings,
  readCapacitorAdvertisingPushRenderer,
} from '@mpgd/adapter-capacitor/notifications';

import { starterNotificationTopics } from './notifications';

/**
 * The Android and iOS notifications v2 provider over
 * `@capacitor-firebase/messaging` (remote, FCM for both platforms) and
 * `@capacitor/local-notifications` (local reminders, the permission read,
 * and the advertising opt-out action). `mpgd target init capacitor
 * --providers notifications` installs both into the native shell. A shell
 * without them still runs: the provider fails closed for the missing half,
 * and without both it is `unsupported`.
 *
 * It is created once, early, because the provider registers its native
 * listeners when it is created, which is how a cold-start open reaches it.
 * Never install `@capacitor/push-notifications` next to it: on iOS both
 * claim Capacitor's one push handler.
 */
export async function createStarterCapacitorNotifications(
  platform: 'android' | 'ios',
  configTarget: string,
): Promise<readonly CapacitorServiceProvider[]> {
  const topics = starterNotificationTopics(configTarget);
  if (topics.length === 0) {
    return [];
  }
  const sdks = await loadCapacitorNotificationSdks();
  const korean = (globalThis.navigator?.language ?? '').toLowerCase().startsWith('ko');
  return [
    createCapacitorNotificationServiceProvider({
      platform,
      topics,
      ...sdks,
      // Android channel names the player sees in system settings, in the
      // device language. The provider creates a channel only for the topics
      // mapped to Android; advertising has `mpgd-advertising`, a channel of
      // its own the player can turn off.
      channels: korean
        ? {
            'mpgd-service': { name: '알림' },
            'mpgd-requested': { name: '리마인더' },
            'mpgd-advertising': { name: '광고성 정보' },
          }
        : {
            'mpgd-service': { name: 'Notifications' },
            'mpgd-requested': { name: 'Reminders' },
            'mpgd-advertising': { name: 'Promotions' },
          },
      advertisingOptOutTitle: korean ? '수신거부' : 'Unsubscribe',
      openSettings: openCapacitorNotificationSettings,
      // Android: the shell renders advertising pushes with the opt-out
      // action when its messaging service is the kit's renderer, which
      // `mpgd target init capacitor --providers notifications` declares; the
      // backend sends advertising only to such an installation.
      advertisingRenderer: readCapacitorAdvertisingPushRenderer,
    }),
  ];
}
