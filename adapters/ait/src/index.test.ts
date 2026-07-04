import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

import { createAitPlatformGateway, createAitSandboxBridge, type GamePlatformBridge } from './index';

describe('adapter-ait', () => {
  it('sends platform requests through the installed AIT bridge', async () => {
    const requests: BridgeRequest[] = [];
    const bridge: GamePlatformBridge = {
      async request(input) {
        requests.push(input);

        return {
          id: input.id,
          ok: true,
          data: {
            playerId: 'ait-player',
            displayName: 'AIT Player',
          },
        } satisfies BridgeResponse;
      },
    };

    const gateway = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      bridge,
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'ait-player',
      displayName: 'AIT Player',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'identity.getPlayer',
      payload: {},
      meta: {
        target: 'ait',
        appVersion: '1.2.3',
        buildId: 'build-ait',
      },
    });
  });

  it('throws bridge errors as JavaScript errors', async () => {
    const bridge: GamePlatformBridge = {
      async request(input) {
        return {
          id: input.id,
          ok: false,
          error: {
            code: 'UNSUPPORTED_METHOD',
            message: 'Unsupported method.',
            retryable: false,
          },
        };
      },
    };

    const gateway = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      bridge,
    });

    await expect(gateway.getCapabilities()).rejects.toThrow('Unsupported method.');
  });

  it('uses fallback sandbox bridge only when no bridge is installed', async () => {
    const explicitBridge: GamePlatformBridge = {
      async request(input) {
        return {
          id: input.id,
          ok: true,
          data: {
            playerId: 'explicit-player',
          },
        };
      },
    };
    const gateway = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      bridge: explicitBridge,
      fallbackBridge: createAitSandboxBridge(),
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'explicit-player',
    });
  });

  it('provides sandbox identity, storage, purchase, ad, and leaderboard behavior', async () => {
    const gateway = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      fallbackBridge: createAitSandboxBridge(),
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'ait-sandbox-player',
      displayName: 'AIT Sandbox Player',
    });
    await gateway.storage.save({ key: 'save:v1', value: { coins: 7 } });
    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({ coins: 7 });
    await expect(
      gateway.commerce.purchase({
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'sandbox-purchase-1',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      entitlementIds: ['COINS_100'],
    });
    await expect(
      gateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'sandbox-reward-1',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      rewardGranted: true,
    });
    await expect(
      gateway.leaderboard.submitScore({
        leaderboardId: 'default',
        score: 100,
        runId: 'run-1',
        submittedAt: '2026-07-04T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      submitted: true,
    });
  });
});
