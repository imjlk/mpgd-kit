import { describe, expect, it } from 'vitest';

import {
  runPlatformGatewayCapabilityConformance,
  type PlatformGatewayCapabilityConformanceFixture,
} from './capability-conformance';
import {
  createUnsupportedCapabilities,
  type PlatformCapabilities,
  type PlatformGateway,
} from './index';

describe('platform gateway capability conformance', () => {
  it('rejects an empty fixture set', async () => {
    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [] }),
    ).rejects.toThrow(
      'Platform gateway capability conformance requires at least one fixture.',
    );
  });

  it('accepts fresh snapshots and observes provider transitions', async () => {
    let capabilities = createUnsupportedCapabilities();
    const fixture = createFixture(() => ({ ...capabilities }), {
      update() {
        capabilities = {
          ...capabilities,
          cloudSave: true,
        };
      },
      expectedCapabilities: {
        ...createUnsupportedCapabilities(),
        cloudSave: true,
      },
    });

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
    ).resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it('rejects gateways that leak a shared capability object', async () => {
    const capabilities = createUnsupportedCapabilities();
    const fixture = createFixture(() => capabilities);

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
    ).rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
  });

  it('rejects duplicate fixture names', async () => {
    const fixture = createFixture(() => createUnsupportedCapabilities());

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture, fixture] }),
    ).rejects.toThrow('Duplicate platform capability conformance fixture: test-gateway.');
  });

  it('rejects empty fixture names', async () => {
    const fixture = {
      ...createFixture(() => createUnsupportedCapabilities()),
      name: ' ',
    };

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
    ).rejects.toThrow('Platform capability conformance fixture names must not be empty.');
  });
});

function createFixture(
  getCapabilities: () => Promise<PlatformCapabilities> | PlatformCapabilities,
  transition?: PlatformGatewayCapabilityConformanceFixture['transition'],
): PlatformGatewayCapabilityConformanceFixture {
  const gateway: PlatformGateway = {
    target: 'browser',
    async getCapabilities() {
      return getCapabilities();
    },
    identity: {
      async getPlayer() {
        return null;
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        return { status: 'cancelled', entitlementIds: [] };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded() {
        return { status: 'unavailable', rewardGranted: false };
      },
    },
    leaderboard: {
      async submitScore() {
        return { submitted: false };
      },
      async open() {},
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  };

  return {
    name: 'test-gateway',
    gateway,
    expectedTarget: 'browser',
    expectedCapabilities: createUnsupportedCapabilities(),
    ...(transition === undefined ? {} : { transition }),
  };
}
