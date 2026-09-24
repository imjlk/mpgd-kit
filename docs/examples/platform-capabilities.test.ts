import { describe, expect, it } from 'vitest';

import { createUnsupportedCapabilities, type PlatformGateway } from '@mpgd/platform';

import {
  readCloudSaveTransition,
  readRewardedAdAvailability,
  verifyCapabilityFixture,
} from './platform-capabilities';

describe('published platform capability examples', () => {
  it('checks rewarded-ad availability on each decision', async () => {
    let rewardedAds = false;
    const gateway = {
      async getCapabilities() {
        return { ...createUnsupportedCapabilities(), rewardedAds };
      },
    } satisfies Pick<PlatformGateway, 'getCapabilities'>;

    await expect(readRewardedAdAvailability(gateway)).resolves.toEqual({ status: 'unavailable' });
    rewardedAds = true;
    await expect(readRewardedAdAvailability(gateway)).resolves.toEqual({ status: 'available' });
  });

  it('keeps a rejected capability read distinct from false', async () => {
    const failure = new Error('bridge unavailable');
    const gateway = {
      async getCapabilities(): Promise<never> {
        throw failure;
      },
    } satisfies Pick<PlatformGateway, 'getCapabilities'>;

    await expect(readRewardedAdAvailability(gateway)).resolves.toEqual({
      status: 'unknown',
      error: failure,
    });
  });

  it('reads a changed provider after an update', async () => {
    let cloudSave = false;
    const gateway = {
      async getCapabilities() {
        return { ...createUnsupportedCapabilities(), cloudSave };
      },
    } satisfies Pick<PlatformGateway, 'getCapabilities'>;

    await expect(readCloudSaveTransition(gateway, () => {
      cloudSave = true;
    })).resolves.toEqual([false, true]);
  });

  it('runs a named gateway fixture and returns the report', async () => {
    const gateway = {
      target: 'browser' as const,
      async getCapabilities() {
        return createUnsupportedCapabilities();
      },
    } as PlatformGateway;

    await expect(verifyCapabilityFixture({
      name: 'browser-example',
      gateway,
      expectedTarget: 'browser',
      expectedCapabilities: createUnsupportedCapabilities(),
    })).resolves.toEqual({ passedFixtures: ['browser-example'] });
  });
});
