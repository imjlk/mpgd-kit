import { afterEach, describe, expect, it } from 'vitest';

import { createBrowserPlatformGateway } from './index';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('adapter-browser', () => {
  it('exposes browser capabilities and identity', async () => {
    const gateway = createBrowserPlatformGateway();

    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeAds: false,
      cloudSave: true,
      localizedContent: true,
    });
    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'browser-player',
      displayName: 'Browser Player',
    });
  });

  it('persists save data through localStorage when available', async () => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem(key: string) {
          return storage.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        },
      },
    });

    const gateway = createBrowserPlatformGateway();
    await gateway.storage.save({
      key: 'save:v1',
      value: {
        coins: 25,
      },
    });

    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
      coins: 25,
    });
  });
});
