import { describe, expect, it } from 'vitest';

import { getUserKeyForGame, IAP, loadFullScreenAd, Storage } from './local-mock.js';

describe('Apps in Toss local SDK mock', () => {
  it('provides a local identity and storage without advertising native capabilities', async () => {
    await Storage.setItem('mock-key', 'mock-value');

    await expect(getUserKeyForGame()).resolves.toEqual({
      type: 'HASH',
      hash: 'ait-local-player',
    });
    await expect(Storage.getItem('mock-key')).resolves.toBe('mock-value');
    expect(loadFullScreenAd.isSupported()).toBe(false);
    expect(IAP.createOneTimePurchaseOrder.isSupported()).toBe(false);
    expect(IAP.getProductItemList.isSupported()).toBe(false);
  });
});
