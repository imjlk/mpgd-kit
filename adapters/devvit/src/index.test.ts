import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

import {
  createDevvitFetchBridge,
  createDevvitPlatformGateway,
  createDevvitSandboxBridge,
  defaultDevvitBridgeEndpoint,
  type DevvitBridge,
} from './index';

describe('adapter-devvit', () => {
  it('sends platform requests through the installed Devvit bridge', async () => {
    const requests: BridgeRequest[] = [];
    const bridge: DevvitBridge = {
      async request(input) {
        requests.push(input);

        return {
          id: input.id,
          ok: true,
          data: {
            playerId: 'reddit-player',
            displayName: 'Reddit Player',
          },
        } satisfies BridgeResponse;
      },
    };

    const gateway = createDevvitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-reddit',
      bridge,
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'reddit-player',
      displayName: 'Reddit Player',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'identity.getPlayer',
      payload: {},
      meta: {
        target: 'reddit',
        appVersion: '1.2.3',
        buildId: 'build-reddit',
      },
    });
  });

  it('uses the Devvit fetch bridge endpoint by default', async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const bridge = createDevvitFetchBridge({
      async fetch(url, init) {
        requests.push({
          url: String(url),
          init: init ?? {},
        });

        return new Response(
          JSON.stringify({
            id: JSON.parse(String(init?.body)).id,
            ok: true,
            data: {
              playerId: 'fetch-player',
            },
          } satisfies BridgeResponse),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      },
    });
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-reddit',
      bridge,
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'fetch-player',
    });
    expect(requests[0]).toMatchObject({
      url: defaultDevvitBridgeEndpoint,
      init: {
        method: 'POST',
      },
    });
  });

  it('throws bridge errors as JavaScript errors', async () => {
    const bridge: DevvitBridge = {
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

    const gateway = createDevvitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-reddit',
      bridge,
    });

    await expect(gateway.getCapabilities()).rejects.toThrow('Unsupported method.');
  });

  it('returns structured fetch bridge errors for network and parse failures', async () => {
    const networkBridge = createDevvitFetchBridge({
      async fetch() {
        throw new TypeError('connection refused');
      },
    });
    const parseBridge = createDevvitFetchBridge({
      async fetch() {
        return new Response('not json', {
          status: 200,
        });
      },
    });
    const request = {
      id: 'request-1',
      method: 'identity.getPlayer',
      payload: {},
      meta: {
        target: 'reddit',
        appVersion: '1.0.0',
        buildId: 'test',
        sentAt: '2026-07-04T00:00:00.000Z',
      },
    } as const;

    await expect(networkBridge.request(request)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'DEVVIT_BRIDGE_NETWORK_ERROR',
        retryable: true,
      },
    });
    await expect(parseBridge.request(request)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'DEVVIT_BRIDGE_PARSE_ERROR',
        retryable: false,
      },
    });
  });

  it('provides sandbox identity, storage, unavailable ads, and leaderboard behavior', async () => {
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-reddit',
      fallbackBridge: createDevvitSandboxBridge(),
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'reddit-sandbox-player',
      displayName: 'Reddit Sandbox Player',
    });
    await gateway.storage.save({ key: 'save:v1', value: { coins: 7 } });
    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
      value: {
        coins: 7,
      },
    });
    await expect(
      gateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'sandbox-reward-1',
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      rewardGranted: false,
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
