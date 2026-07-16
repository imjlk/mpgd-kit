import { describe, expect, it, vi } from 'vitest';

import { createBridgeError, type BridgeRequest, type BridgeResponse } from '@mpgd/bridge';
import { createBridgeRpcFetchHandler, createBridgeRpcRouter } from '@mpgd/bridge/orpc';

import {
  createDevvitOrpcBridge,
  createDevvitPlatformGateway,
  createDevvitSandboxBridge,
  defaultDevvitRpcEndpoint,
  DevvitBridgeError,
  type DevvitBridge,
} from './index';

function createLocalStorageMock(): {
  readonly items: Map<string, string>;
  readonly storage: Storage;
} {
  const items = new Map<string, string>();

  return {
    items,
    storage: {
      getItem(key: string) {
        return items.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        items.set(key, value);
      },
      removeItem(key: string) {
        items.delete(key);
      },
      key(index: number) {
        return [...items.keys()][index] ?? null;
      },
      get length() {
        return items.size;
      },
    } as Storage,
  };
}

describe('adapter-devvit', () => {
  it('exposes only the oRPC network bridge transport', async () => {
    const devvitAdapter = await import('./index');

    expect(devvitAdapter).not.toHaveProperty('createDevvitFetchBridge');
    expect(devvitAdapter).not.toHaveProperty('defaultDevvitBridgeEndpoint');
  });

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

  it('uses the Devvit oRPC bridge endpoint by default', async () => {
    let fetchUrl = '';
    let fetchMethod = '';
    const handler = createBridgeRpcFetchHandler(
      createBridgeRpcRouter((input) => {
        return {
          id: input.id,
          ok: true,
          data: {
            playerId: 'orpc-player',
            displayName: 'oRPC Player',
          },
        } satisfies BridgeResponse;
      }),
    );

    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      fetchUrl = String(url);
      fetchMethod = init?.method ?? 'GET';

      return handler(new Request(`https://reddit.test${fetchUrl}`, init));
    });

    try {
      const gateway = createDevvitPlatformGateway({
        appVersion: '1.2.3',
        buildId: 'build-reddit',
      });

      await expect(gateway.identity.getPlayer()).resolves.toEqual({
        playerId: 'orpc-player',
        displayName: 'oRPC Player',
      });
      expect(fetchUrl.startsWith(defaultDevvitRpcEndpoint)).toBe(true);
      expect(fetchMethod).toBe('POST');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows overriding the Devvit oRPC endpoint separately', async () => {
    let fetchUrl = '';
    const rpcEndpoint = '/api/custom-rpc';
    const handler = createBridgeRpcFetchHandler(
      createBridgeRpcRouter((input) => {
        return {
          id: input.id,
          ok: true,
          data: {
            playerId: 'custom-orpc-player',
          },
        } satisfies BridgeResponse;
      }),
      {
        prefix: rpcEndpoint,
      },
    );

    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      fetchUrl = String(url);

      return handler(new Request(`https://reddit.test${fetchUrl}`, init));
    });

    try {
      const gateway = createDevvitPlatformGateway({
        appVersion: '1.2.3',
        buildId: 'build-reddit',
        rpcEndpoint,
      });

      await expect(gateway.identity.getPlayer()).resolves.toEqual({
        playerId: 'custom-orpc-player',
      });
      expect(fetchUrl.startsWith(rpcEndpoint)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows explicit Devvit oRPC clients to back the bridge interface', async () => {
    const bridge = createDevvitOrpcBridge({
      client: {
        request(input) {
          return Promise.resolve({
            id: input.id,
            ok: true,
            data: {
              playerId: 'explicit-orpc-player',
            },
          } satisfies BridgeResponse);
        },
      },
    });

    await expect(
      bridge.request({
        id: 'request-1',
        method: 'identity.getPlayer',
        payload: {},
        meta: {
          target: 'reddit',
          appVersion: '1.0.0',
          buildId: 'test',
          sentAt: '2026-07-04T00:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        playerId: 'explicit-orpc-player',
      },
    });
  });

  it('wraps thrown Devvit oRPC client errors as bridge responses', async () => {
    const bridge = createDevvitOrpcBridge({
      client: {
        request() {
          return Promise.reject(new TypeError('request failed'));
        },
      },
    });

    await expect(
      bridge.request({
        id: 'request-1',
        method: 'identity.getPlayer',
        payload: {},
        meta: {
          target: 'reddit',
          appVersion: '1.0.0',
          buildId: 'test',
          sentAt: '2026-07-04T00:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({
      id: 'request-1',
      ok: false,
      error: {
        code: 'DEVVIT_BRIDGE_NETWORK_ERROR',
        retryable: true,
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

  it('provides sandbox identity, storage, and unavailable platform services', async () => {
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-reddit',
      fallbackBridge: createDevvitSandboxBridge(),
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: 'reddit-sandbox-player',
      displayName: 'Reddit Sandbox Player',
    });
    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'authenticated',
      playerId: 'reddit-sandbox-player',
      trustLevel: 'server-verified',
    });
    await expect(gateway.presentation?.getLaunchIntent()).resolves.toEqual({ entry: 'home' });
    await expect(
      gateway.presentation?.requestGameSurface({ entry: 'daily' }),
    ).resolves.toBe('unavailable');
    await expect(
      gateway.sharing?.share?.({
        kind: 'invite',
        title: 'Invite',
        text: 'Play this post',
        deepLink: 'https://reddit.com/r/example/comments/post',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(gateway.sharing?.readInboundShare?.()).resolves.toBeNull();
    await expect(gateway.notifications?.getStatus('daily-ready')).resolves.toBe(
      'approval-required',
    );
    await expect(
      gateway.notifications?.requestSubscription('daily-ready'),
    ).resolves.toBe('unavailable');
    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeLeaderboard: false,
      cloudSave: true,
      socialShare: false,
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
      submitted: false,
    });
    await expect(gateway.leaderboard.open({ leaderboardId: 'default' })).rejects.toMatchObject({
      code: 'DEVVIT_LEADERBOARD_OPEN_UNAVAILABLE',
    });
  });

  it('rejects an unconfirmed Devvit save even when browser storage is available', async () => {
    const { storage: localStorageMock } = createLocalStorageMock();
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
      await expect(
        gateway.storage.save({ key: 'save:v1', value: { coins: 7 } }),
      ).rejects.toThrow('Devvit storage save was not persisted');
      await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the server value authoritative after an unconfirmed save', async () => {
    const { storage: localStorageMock } = createLocalStorageMock();
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
      await expect(
        gateway.storage.save({ key: 'save:v1', value: { coins: 7 } }),
      ).rejects.toThrow('Devvit storage save was not persisted');

      await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
        value: {
          coins: 1,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not synthesize player-scoped browser saves after server rejection', async () => {
    const { storage: localStorageMock } = createLocalStorageMock();
    let currentPlayerId = 'reddit-player-a';
    const bridge: DevvitBridge = {
      async request(input) {
        if (input.method === 'identity.getPlayer') {
          return {
            id: input.id,
            ok: true,
            data: {
              playerId: currentPlayerId,
            },
          };
        }

        if (input.method === 'storage.save') {
          return {
            id: input.id,
            ok: true,
            data: {
              saved: false,
              playerId: currentPlayerId,
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
      await expect(
        gateway.storage.save({ key: 'save:v1', value: { coins: 7 } }),
      ).rejects.toThrow('Devvit storage save was not persisted');

      currentPlayerId = 'reddit-player-b';
      await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
        value: {
          coins: 1,
        },
      });

      currentPlayerId = 'reddit-player-a';
      await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
        value: {
          coins: 1,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces Devvit load failures instead of reading browser fallback storage', async () => {
    const { storage: localStorageMock } = createLocalStorageMock();
    const bridge: DevvitBridge = {
      async request(input) {
        if (input.method === 'identity.getPlayer') {
          return {
            id: input.id,
            ok: true,
            data: {
              playerId: 'reddit-player-a',
            },
          };
        }

        if (input.method === 'storage.save') {
          return {
            id: input.id,
            ok: true,
            data: {
              saved: false,
              playerId: 'reddit-player-a',
            },
          };
        }

        if (input.method === 'storage.load') {
          return createBridgeError(
            input.id,
            'DEVVIT_BRIDGE_HTTP_ERROR',
            'Devvit storage load failed.',
            true,
          );
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
      await expect(
        gateway.storage.save({ key: 'save:v1', value: { coins: 7 } }),
      ).rejects.toThrow('Devvit storage save was not persisted');
      await expect(gateway.storage.load({ key: 'save:v1' })).rejects.toMatchObject({
        code: 'DEVVIT_BRIDGE_HTTP_ERROR',
        retryable: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not reuse cached identity to hide later Devvit storage failures', async () => {
    const { items: localItems, storage: localStorageMock } = createLocalStorageMock();
    let bridgeOffline = false;
    const bridge: DevvitBridge = {
      async request(input) {
        if (input.method === 'identity.getPlayer') {
          if (bridgeOffline) {
            return createBridgeError(
              input.id,
              'DEVVIT_BRIDGE_NETWORK_ERROR',
              'Devvit identity bridge failed.',
              true,
            );
          }

          return {
            id: input.id,
            ok: true,
            data: {
              playerId: 'reddit-player-a',
            },
          };
        }

        if (input.method === 'storage.save' || input.method === 'storage.load') {
          return createBridgeError(
            input.id,
            'DEVVIT_BRIDGE_NETWORK_ERROR',
            'Devvit storage bridge failed.',
            true,
          );
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
      await expect(gateway.identity.getPlayer()).resolves.toEqual({
        playerId: 'reddit-player-a',
      });

      bridgeOffline = true;
      await expect(
        gateway.storage.save({ key: 'save:v1', value: { coins: 7 } }),
      ).rejects.toMatchObject({
        code: 'DEVVIT_BRIDGE_NETWORK_ERROR',
        retryable: true,
      });
      expect(localItems.size).toBe(0);
      await expect(gateway.storage.load({ key: 'save:v1' })).rejects.toMatchObject({
        code: 'DEVVIT_BRIDGE_NETWORK_ERROR',
        retryable: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns a successful Devvit load value without consulting browser storage', async () => {
    const { storage: localStorageMock } = createLocalStorageMock();
    let bridgeOffline = false;
    const bridge: DevvitBridge = {
      async request(input) {
        if (input.method === 'identity.getPlayer') {
          if (bridgeOffline) {
            return createBridgeError(
              input.id,
              'DEVVIT_BRIDGE_NETWORK_ERROR',
              'Devvit identity bridge failed.',
              true,
            );
          }

          return {
            id: input.id,
            ok: true,
            data: {
              playerId: 'reddit-player-a',
            },
          };
        }

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
      await expect(gateway.identity.getPlayer()).resolves.toEqual({
        playerId: 'reddit-player-a',
      });
      await expect(
        gateway.storage.save({ key: 'save:v1', value: { coins: 7 } }),
      ).rejects.toThrow('Devvit storage save was not persisted');

      bridgeOffline = true;
      await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
        value: {
          coins: 1,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps an empty Devvit load empty after a rejected save', async () => {
    const { storage: localStorageMock } = createLocalStorageMock();
    let bridgeOffline = false;
    const bridge: DevvitBridge = {
      async request(input) {
        if (input.method === 'identity.getPlayer') {
          if (bridgeOffline) {
            return createBridgeError(
              input.id,
              'DEVVIT_BRIDGE_NETWORK_ERROR',
              'Devvit identity bridge failed.',
              true,
            );
          }

          return {
            id: input.id,
            ok: true,
            data: {
              playerId: 'reddit-player-a',
            },
          };
        }

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
      await expect(gateway.identity.getPlayer()).resolves.toEqual({
        playerId: 'reddit-player-a',
      });
      await expect(
        gateway.storage.save({ key: 'save:v1', value: { coins: 7 } }),
      ).rejects.toThrow('Devvit storage save was not persisted');

      bridgeOffline = true;
      await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toBeNull();
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
