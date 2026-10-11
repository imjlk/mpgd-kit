import { describe, expect, it, vi } from 'vitest';

import {
  bridgeCommerceV2Methods,
  bridgeStorageLoadProtocol,
  createBridgeError,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { createBridgeRpcFetchHandler, createBridgeRpcRouter } from '@mpgd/bridge/orpc';

import {
  createDevvitCommerceCapabilities,
  createDevvitOrpcBridge,
  createDevvitPlatformGateway,
  createDevvitSandboxBridge,
  defaultDevvitRpcEndpoint,
  DevvitBridgeError,
  devvitOrderEvidenceSchema,
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
      remoteLeaderboard: false,
      cloudSave: true,
      socialShare: false,
    });
    const savedValue = {
      progress: { coins: 7 },
      inventory: ['seed'],
    };
    await gateway.storage.save({ key: 'save:v1', value: savedValue });
    savedValue.progress.coins = -1;
    savedValue.inventory.push('mutated-after-save');
    const firstLoad = await gateway.storage.load({ key: 'save:v1' });
    expect(firstLoad).toEqual({
      value: {
        progress: { coins: 7 },
        inventory: ['seed'],
      },
    });

    if (firstLoad === null) {
      throw new Error('Expected the Devvit sandbox save to be present.');
    }

    const firstLoadedValue = firstLoad.value as {
      progress: { coins: number };
      inventory: string[];
    };
    firstLoadedValue.progress.coins = -2;
    firstLoadedValue.inventory.push('mutated-after-load');
    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
      value: {
        progress: { coins: 7 },
        inventory: ['seed'],
      },
    });
    await gateway.storage.save({ key: 'nullable-save:v1', value: null });
    await expect(gateway.storage.load({ key: 'nullable-save:v1' })).resolves.toEqual({
      value: null,
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
            data: { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false },
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
              __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
              found: true,
              value: { coins: 1 },
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
              __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
              found: true,
              value: { coins: 1 },
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
              __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
              found: true,
              value: { coins: 1 },
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
            data: { __mpgdBridgeProtocol: bridgeStorageLoadProtocol, found: false },
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

  it('fails closed for commerce v2 methods until a Devvit v2 provider exists', async () => {
    const bridge = createDevvitSandboxBridge();

    for (const method of bridgeCommerceV2Methods) {
      const response = await bridge.request({
        id: `v2-${method}`,
        method,
        payload: { protocol: 'mpgd.commerce.v2' },
        meta: {
          target: 'reddit',
          appVersion: '1.2.3',
          buildId: 'build-reddit',
          sentAt: '2026-10-11T00:00:00.000Z',
        },
      });

      expect(response).toEqual({
        id: `v2-${method}`,
        ok: false,
        error: {
          code: 'COMMERCE_V2_UNAVAILABLE',
          message: expect.stringContaining(method),
          retryable: false,
        },
      });
    }
  });
});

describe('adapter-devvit commerce v2 gateway', () => {
  const products = [{
    info: {
      id: 'COINS_100',
      type: 'consumable' as const,
      title: '100 Coins',
      description: 'Adds 100 coins.',
      price: { formatted: '5 Gold', currencyCode: 'GOLD' },
    },
    sku: 'coins_100',
  }];
  const snapshot = {
    nativeIap: false,
    nativeAds: false,
    rewardedAds: false,
    interstitialAds: false,
    nativeLeaderboard: false,
    remoteLeaderboard: false,
    achievements: false,
    cloudSave: true,
    socialShare: false,
    haptics: false,
    localizedContent: true,
  };
  const listedPurchase = {
    store: 'devvit',
    transactionId: 'order-1',
    storeSku: 'coins_100',
    logicalId: 'COINS_100',
    quantity: 1,
    state: 'purchased',
    purchasedAt: '2026-10-12T00:00:00.000Z',
    token: 'order-1',
    evidence: {
      schema: devvitOrderEvidenceSchema,
      payload: { orderId: 'order-1', sku: 'coins_100', source: 'order-list', environment: 'sandbox' },
    },
    accountBinding: { kind: 'host-identity' },
  };

  function createServerBridge(input: { readonly served: boolean }): {
    readonly bridge: DevvitBridge;
    readonly requests: BridgeRequest[];
  } {
    const requests: BridgeRequest[] = [];
    return {
      requests,
      bridge: {
        async request(request) {
          requests.push(request);
          switch (request.method) {
            case 'runtime.getCapabilities':
              return { id: request.id, ok: true, data: snapshot };
            case 'commerce.v2.getCapabilities':
              return input.served
                ? {
                    id: request.id,
                    ok: true,
                    data: {
                      protocolVersion: '2.0.0-draft.1',
                      store: 'devvit',
                      capabilities: createDevvitCommerceCapabilities('available'),
                    },
                  }
                : createBridgeError(request.id, 'COMMERCE_V2_UNAVAILABLE', 'closed');
            case 'commerce.v2.getAvailablePurchases':
              return input.served
                ? { id: request.id, ok: true, data: { purchases: [listedPurchase] } }
                : createBridgeError(request.id, 'COMMERCE_V2_UNAVAILABLE', 'closed');
            default:
              return createBridgeError(request.id, 'UNSUPPORTED_METHOD', request.method);
          }
        },
      },
    };
  }

  it('offers no commerceV2 and the server snapshot as is without the commerce option', async () => {
    const { bridge } = createServerBridge({ served: true });
    const gateway = createDevvitPlatformGateway({ appVersion: '1.0.0', buildId: 'b', bridge });
    expect(gateway.commerceV2).toBeUndefined();
    await expect(gateway.getCapabilities()).resolves.toEqual(snapshot);
  });

  it('installs the webview provider with the capability block derived from it', async () => {
    const { bridge, requests } = createServerBridge({ served: true });
    const purchase = vi.fn(async () => ({ status: 'completed' as const, orderId: 'order-2' }));
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'b',
      bridge,
      commerce: { products, client: { purchase } },
    });
    expect(gateway.commerceV2?.store).toBe('devvit');
    await expect(gateway.getCapabilities()).resolves.toEqual({
      ...snapshot,
      nativeIap: true,
      subscriptionIap: false,
      commerce: createDevvitCommerceCapabilities('available'),
    });
    // The paid orders come from the server bridge, rebuilt under the provider's store id.
    await expect(gateway.commerceV2?.getAvailablePurchases()).resolves.toEqual([listedPurchase]);
    expect(requests.map((request) => request.method)).toEqual([
      'runtime.getCapabilities',
      'commerce.v2.getCapabilities',
      'commerce.v2.getAvailablePurchases',
    ]);
    // The checkout never crosses the bridge.
    await expect(gateway.commerceV2?.requestPurchase({
      logicalId: 'COINS_100',
      idempotencyKey: 'op-1',
      source: 'shop',
    })).resolves.toMatchObject({ outcome: 'purchased', purchase: { transactionId: 'order-2' } });
    expect(purchase).toHaveBeenCalledWith('coins_100');
    expect(requests.filter((request) => request.method === 'commerce.v2.requestPurchase')).toEqual([]);
  });

  it('reports configuration-required and a closed order list when the server bridge is closed', async () => {
    const { bridge } = createServerBridge({ served: false });
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'b',
      bridge,
      commerce: { products, client: { purchase: async () => ({ status: 'pending' as const }) } },
    });
    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: false,
      commerce: { availability: 'configuration-required' },
    });
    await expect(gateway.commerceV2?.getAvailablePurchases()).rejects.toMatchObject({
      code: 'CONFIGURATION_REQUIRED',
      storeCode: 'COMMERCE_V2_UNAVAILABLE',
    });
  });

  it('maps a transport failure of the order list to a retryable NETWORK error', async () => {
    const bridge = createDevvitOrpcBridge({
      fetch: async () => {
        throw new Error('offline');
      },
    });
    const gateway = createDevvitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'b',
      bridge,
      commerce: { products, client: { purchase: async () => ({ status: 'pending' as const }) } },
    });
    await expect(gateway.commerceV2?.getAvailablePurchases()).rejects.toMatchObject({
      code: 'NETWORK',
      retryable: true,
      storeCode: 'DEVVIT_BRIDGE_NETWORK_ERROR',
    });
    await expect(gateway.getCapabilities()).rejects.toThrow();
  });
});
