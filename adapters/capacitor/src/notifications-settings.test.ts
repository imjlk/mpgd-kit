import { describe, expect, it, vi } from 'vitest';

import { createFakeNotificationSdks } from '../test/notifications-sdk-fixture.js';
import { createCapacitorNotificationProvider } from './notifications-provider.js';
import { openCapacitorNotificationSettings } from './notifications-settings.js';

describe('openCapacitorNotificationSettings', () => {
  it('resolves when the plugin opened the screen', async () => {
    const openNotificationSettings = vi.fn(async () => ({ opened: true }));
    await expect(openCapacitorNotificationSettings({ openNotificationSettings })).resolves.toBeUndefined();
    expect(openNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it('throws when the screen did not open or the answer is malformed', async () => {
    for (const answer of [{ opened: false }, {}, null, 'yes']) {
      await expect(openCapacitorNotificationSettings({
        openNotificationSettings: async () => answer as never,
      })).rejects.toThrow('could not be opened');
    }
  });

  it('passes on the rejection of a shell whose plugin lacks the method', async () => {
    await expect(openCapacitorNotificationSettings({
      openNotificationSettings: async () => {
        throw new Error('"CapacitorGameServices.openNotificationSettings()" is not implemented on android');
      },
    })).rejects.toThrow('not implemented');
  });

  it('declares settings and answers unavailable through the provider when the opener fails', async () => {
    const onError = vi.fn();
    const sdks = createFakeNotificationSdks({ platform: 'android' });
    const provider = createCapacitorNotificationProvider({
      platform: 'android',
      topics: [],
      ...(sdks.push === undefined ? {} : { push: sdks.push }),
      ...(sdks.local === undefined ? {} : { local: sdks.local }),
      app: sdks.app,
      onError,
      openSettings: () => openCapacitorNotificationSettings({
        openNotificationSettings: async () => ({ opened: false }),
      }),
    });
    expect((await provider.getCapabilities()).permission.settings).toBe(true);
    await expect(provider.openSettings?.()).resolves.toBe('unavailable');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'The notification settings screen could not be opened.',
    }));
  });
});
