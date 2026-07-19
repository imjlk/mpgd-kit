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
      ],
    })).toEqual({
      adGroupIds: { HINT_REWARDED: 'rewarded-group' },
      adPlacementTypes: { HINT_REWARDED: 'rewarded' },
    });
  });

  it('rejects malformed placement entries with their source label', () => {
    expect(() => extractAitAdBridgeConfig({
      placements: [{ id: 'BROKEN', type: 'banner' }],
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
