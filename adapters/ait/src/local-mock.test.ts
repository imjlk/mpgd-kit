import { describe, expect, it } from 'vitest';

import {
  getUserKeyForGame,
  IAP,
  loadFullScreenAd,
  SafeArea,
  Storage,
  TossAds,
  User,
} from './local-mock.js';

describe('Apps in Toss local SDK mock', () => {
  it('provides a local identity and storage without advertising native capabilities', async () => {
    await Storage.setItem('mock-key', 'mock-value');

    await expect(getUserKeyForGame()).resolves.toEqual({
      type: 'HASH',
      hash: 'ait-local-player',
    });
    await expect(User.getAnonymousKey()).resolves.toEqual({
      type: 'HASH',
      hash: 'ait-local-player',
    });
    await expect(Storage.getItem('mock-key')).resolves.toBe('mock-value');
    expect(loadFullScreenAd.isSupported()).toBe(false);
    expect(TossAds.initialize.isSupported()).toBe(false);
    expect(TossAds.attachBanner.isSupported()).toBe(false);
    expect(IAP.createOneTimePurchaseOrder.isSupported()).toBe(false);
    expect(IAP.getProductItemList.isSupported()).toBe(false);
    expect(() => SafeArea.get()).toThrow('SafeArea is unavailable');
    expect(() => SafeArea.subscribe({ onEvent: () => {} })()).not.toThrow();
  });
});
