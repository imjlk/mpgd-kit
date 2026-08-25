import { describe, expect, it } from 'vitest';

import { extractAitAdBridgeConfig } from './ad-config';

describe('extractAitAdBridgeConfig', () => {
  it('maps configured AIT placements and omits placements without an AIT group', () => {
    expect(extractAitAdBridgeConfig({
      version: '1',
      placements: [
        {
          id: 'HINT_REWARDED',
          type: 'rewarded',
          reward: { type: 'currency', currency: 'coin', amount: 1 },
          frequencyCap: { cooldownSeconds: 0 },
          platformPlacementIds: { ait: ' rewarded-group ' },
        },
        {
          id: 'RESULT_INTERSTITIAL',
          type: 'interstitial',
          frequencyCap: { cooldownSeconds: 60 },
          platformPlacementIds: { android: 'android-only' },
        },
        {
          id: 'GAMEPLAY_BANNER',
          type: 'banner',
          frequencyCap: { cooldownSeconds: 0 },
          platformPlacementIds: { ait: ' banner-group ' },
        },
      ],
    })).toEqual({
      adGroupIds: {
        HINT_REWARDED: 'rewarded-group',
        GAMEPLAY_BANNER: 'banner-group',
      },
      adPlacementTypes: {
        HINT_REWARDED: 'rewarded',
        GAMEPLAY_BANNER: 'banner',
      },
    });
  });

  it('rejects malformed placement entries with their source label', () => {
    expect(() => extractAitAdBridgeConfig({
      placements: [{ id: 'BROKEN', type: 'native' }],
    }, '/tmp/placements.json')).toThrow(
      'AIT ad placement entry at index 0 is invalid: /tmp/placements.json',
    );
  });

  it('rejects duplicate logical placement IDs before mapping AIT groups', () => {
    const placement = {
      id: 'HINT_REWARDED',
      type: 'rewarded',
      reward: { type: 'currency', currency: 'coin', amount: 1 },
      frequencyCap: { cooldownSeconds: 0 },
      platformPlacementIds: { ait: 'rewarded-group' },
    } as const;

    expect(() => extractAitAdBridgeConfig({
      version: '1',
      placements: [placement, placement],
    }, 'placements.json')).toThrow(
      'Duplicate AIT ad placement ID "HINT_REWARDED" at index 1: placements.json',
    );
  });
});
