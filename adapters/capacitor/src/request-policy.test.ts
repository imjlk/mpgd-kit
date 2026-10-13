import { describe, expect, it } from 'vitest';

import {
  bridgeCommerceV2Methods,
  bridgeNotificationsV2Methods,
  type BridgeMethod,
} from '@mpgd/bridge';
import { PlatformOperationError } from '@mpgd/platform';

import { createCapacitorPlatformGateway } from './index.js';
import { assertNotificationsV2Served, externalActivityMethods } from './request-policy.js';

describe('Capacitor request policy', () => {
  it('pauses the game for the notifications v2 permission dialog and settings only', () => {
    // Like v1 `notifications.requestSubscription` and `commerce.v2.requestPurchase`.
    expect(externalActivityMethods.has('notifications.requestSubscription')).toBe(true);
    expect(externalActivityMethods.has('commerce.v2.requestPurchase')).toBe(true);
    const pausing = bridgeNotificationsV2Methods.filter((method) => externalActivityMethods.has(method));
    expect(pausing).toEqual(['notifications.v2.requestPermission', 'notifications.v2.openSettings']);
    // Reads, revocation, registration, and local scheduling show no UI.
    for (const method of [
      'notifications.v2.getCapabilities',
      'notifications.v2.getPermission',
      'notifications.v2.revokePermission',
      'notifications.v2.register',
      'notifications.v2.scheduleLocal',
      'notifications.v2.cancelLocal',
      'notifications.v2.listLocal',
    ] satisfies BridgeMethod[]) {
      expect(externalActivityMethods.has(method)).toBe(false);
    }
  });

  it('fails closed for a notifications v2 method no provider serves', () => {
    for (const method of bridgeNotificationsV2Methods) {
      let failure: unknown;
      try {
        assertNotificationsV2Served(method, false);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(PlatformOperationError);
      expect(failure).toMatchObject({
        code: 'NOTIFICATIONS_V2_UNAVAILABLE',
        retryable: false,
        message: expect.stringContaining(method),
      });
      // A provider that serves the method takes it.
      expect(() => assertNotificationsV2Served(method, true)).not.toThrow();
    }
    // Other methods keep their routes, served or not.
    for (const method of [
      ...bridgeCommerceV2Methods,
      'notifications.getStatus',
      'notifications.requestSubscription',
      'storage.load',
    ] satisfies BridgeMethod[]) {
      expect(() => assertNotificationsV2Served(method, false)).not.toThrow();
    }
  });

  it('exposes no notifications v2 provider and leaves the capability snapshot unchanged', async () => {
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1',
      buildId: 'notifications-v2',
      bridge: {
        async request(input) {
          if (input.method !== 'runtime.getCapabilities') {
            throw new Error(`Base bridge must not receive ${input.method}.`);
          }
          return {
            id: input.id,
            ok: true,
            data: {
              nativeIap: false, nativeAds: false, rewardedAds: false, interstitialAds: false,
              nativeLeaderboard: false, remoteLeaderboard: false, achievements: false,
              cloudSave: false, socialShare: false, haptics: false, localizedContent: true,
            },
          };
        },
      },
    });
    expect(gateway.notificationsV2).toBeUndefined();
    const capabilities = await gateway.getCapabilities();
    expect('notifications' in capabilities).toBe(false);
    expect(capabilities.providerAvailability?.pushNotifications).toBe('unsupported');
  });
});
