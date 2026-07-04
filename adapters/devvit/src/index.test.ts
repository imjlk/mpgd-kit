import { describe, expect, it, vi } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

import {
  createDevvitFetchBridge,
  createDevvitPlatformGateway,
  createDevvitSandboxBridge,
  defaultDevvitBridgeEndpoint,
  DevvitBridgeError,
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
    await expect(gateway.getCapabilities()).rejects.toMatchObject({
      code: 'UNSUPPORTED_METHOD',
      retryable: false,
    } satisfies Partial<DevvitBridgeError>);
  });

  it('returns structured fetch bridge errors for network, http, and parse failures', async () => {
    const networkBridge = createDevvitFetchBridge({
      async fetch() {
        throw new TypeError('connection refused');
      },
    });
    const httpBridge = createDevvitFetchBridge({
      async fetch() {
        return new Response('server error', {
          status: 500,
        });
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
    await expect(httpBridge.request(request)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'DEVVIT_BRIDGE_HTTP_ERROR',
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

  it('uses local fallback storage when the Devvit server reports a skipped save', async () => {
    const localItems = new Map<string, string>();
    const localStorageMock = {
      getItem(key: string) {
        return localItems.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        localItems.set(key, value);
      },
      removeItem(key: string) {
        localItems.delete(key);
      },
    } as Storage;
    const bridge: DevvitBridge = {
      async request(input) {
        if (input.method === 'storage.save') {
          return {
            id: input.id,
            ok: true,
            data: {
              saved: false,
            },
          };
        }

        if (input.method === 'storage.load') {
          return {
            id: input.id,
            ok: true,
            data: null,
          };
        }

        return {
          id: input.id,
          ok: true,
          data: {},
        };
      },
    };
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-reddit',
      bridge,
    });

    vi.stubGlobal('localStorage', localStorageMock);

    try {
      await gateway.storage.save({ key: 'save:v1', value: { coins: 7 } });

      await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
        value: {
          coins: 7,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prefers newer local fallback storage over stale server storage', async () => {
    const localItems = new Map<string, string>();
    const localStorageMock = {
      getItem(key: string) {
        return localItems.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        localItems.set(key, value);
      },
      removeItem(key: string) {
        localItems.delete(key);
      },
    } as Storage;
    const bridge: DevvitBridge = {
      async request(input) {
        if (input.method === 'storage.save') {
          return {
            id: input.id,
            ok: true,
            data: {
              saved: false,
            },
          };
        }

        if (input.method === 'storage.load') {
          return {
            id: input.id,
            ok: true,
            data: {
              coins: 1,
            },
          };
        }

        return {
          id: input.id,
          ok: true,
          data: {},
        };
      },
    };
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-reddit',
      bridge,
    });

    vi.stubGlobal('localStorage', localStorageMock);

    try {
      await gateway.storage.save({ key: 'save:v1', value: { coins: 7 } });

      await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
        value: {
          coins: 7,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats missing Devvit storage save status as an unconfirmed save', async () => {
    const bridge: DevvitBridge = {
      async request(input) {
        return {
          id: input.id,
          ok: true,
          data: {},
        };
      },
    };
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-reddit',
      bridge,
    });

    vi.stubGlobal('localStorage', undefined);

    try {
      await expect(gateway.storage.save({ key: 'save:v1', value: { coins: 7 } })).rejects.toThrow(
        'Devvit storage save was not persisted',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
