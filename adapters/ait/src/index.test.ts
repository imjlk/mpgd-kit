import { describe, expect, it } from 'vitest';

import { bridgeCommerceV2Methods, type BridgeRequest, type BridgeResponse } from '@mpgd/bridge';
import { adProtocol, adProtocolVersion } from '@mpgd/platform/ads';

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

  it('rejects advertising responses bound to another request or invocation', async () => {
    for (const mismatch of ['request', 'invocation', 'provider'] as const) {
      const bridge: GamePlatformBridge = {
        advertising: { id: 'apps-in-toss-ads', protocol: adProtocol, protocolVersion: adProtocolVersion, rewardSignal: 'delayed', subscribe: () => () => {} },
        async request(input) {
          return { id: mismatch === 'request' ? 'another-request' : input.id, ok: true, data: {
            providerId: mismatch === 'provider' ? 'another-provider' : 'apps-in-toss-ads',
            invocationId: mismatch === 'invocation' ? 'another-invocation' : 'original', format: 'rewarded', outcome: 'shown', presentation: 'closed', eligibility: 'unknown',
          } };
        },
      };
      const gateway = createAitPlatformGateway({ appVersion: 'test', buildId: 'test', bridge });
      await expect(gateway.ads.provider?.show({ placementId: 'CONTINUE', format: 'rewarded', invocationId: 'original', idempotencyKey: 'claim' })).rejects.toThrow(mismatch === 'request' ? 'another bridge request' : 'another invocation');
    }
  });

  it('preserves bridge error codes and retry hints', async () => {
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

    await expect(gateway.getCapabilities()).rejects.toMatchObject({
      name: 'PlatformOperationError',
      code: 'UNSUPPORTED_METHOD',
      message: 'Unsupported method.',
      retryable: false,
    });
  });

  it('classifies a missing bridge as a non-retryable configuration failure', async () => {
    const previousBridge = (globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge })
      .__GAME_PLATFORM_BRIDGE__;
    delete (globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge })
      .__GAME_PLATFORM_BRIDGE__;

    try {
      const gateway = createAitPlatformGateway({
        appVersion: '1.2.3',
        buildId: 'build-ait',
      });

      await expect(gateway.getCapabilities()).rejects.toMatchObject({
        name: 'PlatformOperationError',
        code: 'AIT_BRIDGE_NOT_INSTALLED',
        retryable: false,
      });
    } finally {
      if (previousBridge !== undefined) {
        (globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge })
          .__GAME_PLATFORM_BRIDGE__ = previousBridge;
      }
    }
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
    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'platform-anonymous',
      playerId: 'ait-sandbox-player',
      trustLevel: 'platform-asserted',
    });
    await expect(gateway.presentation?.getLaunchIntent()).resolves.toEqual({
      entry: 'home',
    });
    await expect(
      gateway.presentation?.requestGameSurface({ entry: 'daily' }),
    ).resolves.toBe('already-fullscreen');
    await expect(
      gateway.sharing?.share?.({
        kind: 'daily-result',
        title: 'Daily result',
        text: "I finished today's puzzle.",
        deepLink: 'intoss://game/daily',
      }),
    ).resolves.toEqual({
      status: 'shared',
    });
    await expect(gateway.sharing?.readInboundShare?.()).resolves.toBeNull();
    await expect(gateway.notifications?.getStatus('daily-ready')).resolves.toBe(
      'configuration-required',
    );
    await expect(
      gateway.notifications?.requestSubscription('daily-ready'),
    ).resolves.toBe('unavailable');
    await expect(
      gateway.promotions?.getAvailability({ campaignId: 'SEVEN_DAY_STREAK' }),
    ).resolves.toBe('configuration-required');
    await expect(
      gateway.promotions?.grantReward({
        campaignId: 'SEVEN_DAY_STREAK',
        idempotencyKey: 'sandbox-streak-1',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await gateway.storage.save({ key: 'save:v1', value: { coins: 7 } });
    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
      value: {
        coins: 7,
      },
    });
    await gateway.storage.save({ key: 'nullable-save:v1', value: null });
    await expect(gateway.storage.load({ key: 'nullable-save:v1' })).resolves.toEqual({
      value: null,
    });
    const mutableSave = {
      progress: { coins: 11 },
      inventory: ['shield'],
    };
    await gateway.storage.save({ key: 'isolated-save:v1', value: mutableSave });
    mutableSave.progress.coins = -1;
    mutableSave.inventory.push('mutated-after-save');
    const firstIsolatedLoad = await gateway.storage.load({ key: 'isolated-save:v1' });
    expect(firstIsolatedLoad).toEqual({
      value: {
        progress: { coins: 11 },
        inventory: ['shield'],
      },
    });
    if (firstIsolatedLoad !== null) {
      const loadedValue = firstIsolatedLoad.value as typeof mutableSave;
      loadedValue.progress.coins = -2;
      loadedValue.inventory.push('mutated-after-load');
    }
    await expect(gateway.storage.load({ key: 'isolated-save:v1' })).resolves.toEqual({
      value: {
        progress: { coins: 11 },
        inventory: ['shield'],
      },
    });
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

  it('persists sandbox storage across bridge recreation when browser storage is available', async () => {
    const values = new Map<string, string>();
    let storageUnavailable = false;
    const storage = {
      getItem: (key: string) => {
        if (storageUnavailable) {
          throw new Error('storage unavailable');
        }
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const first = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox-first',
      fallbackBridge: createAitSandboxBridge({ storage }),
    });

    await first.storage.save({ key: 'tutorial:v1', value: { completed: true } });

    const second = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox-second',
      fallbackBridge: createAitSandboxBridge({ storage }),
    });

    const restored = await second.storage.load({ key: 'tutorial:v1' });
    expect(restored).toEqual({
      value: { completed: true },
    });
    if (typeof restored?.value === 'object' && restored.value !== null) {
      (restored.value as { completed: boolean }).completed = false;
    }
    storageUnavailable = true;
    await expect(second.storage.load({ key: 'tutorial:v1' })).resolves.toEqual({
      value: { completed: true },
    });
    expect(values.has('mpgd:ait-sandbox:tutorial:v1')).toBe(true);
  });

  it('falls back to session memory after persistent storage rejects a save', async () => {
    let rejectWrites = false;
    let writes = 0;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (rejectWrites) {
          throw new Error('quota exceeded');
        }
        values.set(key, value);
      },
    };
    const gateway = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox-write-failure',
      fallbackBridge: createAitSandboxBridge({ storage }),
    });

    await gateway.storage.save({ key: 'tutorial:v1', value: { completed: false } });
    rejectWrites = true;
    await gateway.storage.save({ key: 'tutorial:v1', value: { completed: true } });
    await expect(gateway.storage.load({ key: 'tutorial:v1' })).resolves.toEqual({
      value: { completed: true },
    });
    await gateway.storage.save({ key: 'tutorial:v1', value: { completed: 'memory-only' } });
    expect(writes).toBe(2);
    await expect(gateway.storage.load({ key: 'tutorial:v1' })).resolves.toEqual({
      value: { completed: 'memory-only' },
    });
  });

  it('falls back to a missing value when persistent storage becomes unreadable', async () => {
    let reads = 0;
    const gateway = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox-read-failure',
      fallbackBridge: createAitSandboxBridge({
        storage: {
          getItem() {
            reads += 1;
            throw new Error('storage blocked');
          },
          setItem() {},
        },
      }),
    });

    await expect(gateway.storage.load({ key: 'tutorial:v1' })).resolves.toBeNull();
    await expect(gateway.storage.load({ key: 'tutorial:v1' })).resolves.toBeNull();
    expect(reads).toBe(1);
  });

  it('removes corrupt persistent values and lets the sandbox recover', async () => {
    const values = new Map([['mpgd:ait-sandbox:tutorial:v1', '{not-json']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const gateway = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox-corrupt-value',
      fallbackBridge: createAitSandboxBridge({ storage }),
    });

    await expect(gateway.storage.load({ key: 'tutorial:v1' })).resolves.toBeNull();
    expect(values.has('mpgd:ait-sandbox:tutorial:v1')).toBe(false);
    await gateway.storage.save({ key: 'tutorial:v1', value: { completed: true } });
    await expect(gateway.storage.load({ key: 'tutorial:v1' })).resolves.toEqual({
      value: { completed: true },
    });
  });

  it('disables persistent reads when a corrupt value cannot be removed', async () => {
    let reads = 0;
    const gateway = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox-corrupt-value-without-cleanup',
      fallbackBridge: createAitSandboxBridge({
        storage: {
          getItem() {
            reads += 1;
            return '{not-json';
          },
          setItem() {},
        },
      }),
    });

    await expect(gateway.storage.load({ key: 'tutorial:v1' })).resolves.toBeNull();
    await expect(gateway.storage.load({ key: 'tutorial:v1' })).resolves.toBeNull();
    expect(reads).toBe(1);
  });

  it('fails closed for commerce v2 methods until an Apps in Toss v2 provider exists', async () => {
    const bridge = createAitSandboxBridge({ storage: null });

    for (const method of bridgeCommerceV2Methods) {
      const response = await bridge.request({
        id: `v2-${method}`,
        method,
        payload: { protocol: 'mpgd.commerce.v2' },
        meta: {
          target: 'ait',
          appVersion: '1.2.3',
          buildId: 'build-ait',
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

  it('answers commerce v2 with an evidence-only stub for the sandbox build only', async () => {
    const gateway = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'ait-sandbox',
      fallbackBridge: createAitSandboxBridge({ storage: null, buildId: 'ait-sandbox' }),
    });
    const provider = gateway.commerceV2;
    if (provider === undefined) {
      throw new Error('The sandbox gateway must expose commerceV2.');
    }
    expect(provider.store).toBe('apps-in-toss');
    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: true,
      subscriptionIap: false,
      commerce: { availability: 'available', lifecycle: { finish: 'host' } },
    });
    await expect(provider.getCapabilities()).resolves.toMatchObject({
      lifecycle: { finish: 'host' },
      authority: { evidence: 'host-callback', accountBinding: 'host' },
      availability: 'available',
    });
    await expect(provider.fetchProducts({})).resolves.toMatchObject([
      { logicalId: 'COINS_100', storeSku: 'coins_100', kind: 'consumable' },
    ]);
    const result = await provider.requestPurchase({
      logicalId: 'COINS_100',
      idempotencyKey: 'sandbox-purchase-v2',
      source: 'shop',
    });
    expect(result).toMatchObject({
      outcome: 'purchased',
      purchase: {
        store: 'apps-in-toss',
        state: 'purchased',
        transactionId: 'ait-sandbox-sandbox-purchase-v2',
        evidence: { schema: 'apps-in-toss.iap.callback.v1' },
        accountBinding: { kind: 'host-identity' },
      },
    });
    // A retried attempt key answers the same order.
    await expect(provider.requestPurchase({
      logicalId: 'COINS_100',
      idempotencyKey: 'sandbox-purchase-v2',
      source: 'shop',
    })).resolves.toEqual(result);
    // The sandbox sells one product; another logical id is not for sale.
    await expect(provider.requestPurchase({
      logicalId: 'GEMS_500',
      idempotencyKey: 'sandbox-purchase-v2-other',
      source: 'shop',
    })).resolves.toEqual({
      outcome: 'failed',
      error: { code: 'ITEM_UNAVAILABLE', retryable: false, message: expect.any(String) },
    });
    await expect(provider.getAvailablePurchases({})).resolves.toEqual([]);
    await expect(provider.finishTransaction?.({
      transactionId: 'ait-sandbox-x',
      ledgerEntryId: 'le-1',
      isConsumable: true,
    })).resolves.toEqual({ finished: true });
    await expect(provider.restorePurchases?.()).resolves.toBeUndefined();
    expect(provider.subscribe(() => {})).toBeTypeOf('function');

    // Any other build gets no event channel, so its gateway offers no
    // commerceV2 at all; the v2 methods themselves stay fail-closed.
    const other = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      fallbackBridge: createAitSandboxBridge({ storage: null, buildId: 'build-ait' }),
    });
    expect(other.commerceV2).toBeUndefined();
    await expect(other.getCapabilities()).resolves.not.toHaveProperty('commerce');
    const unset = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'ait-sandbox',
      fallbackBridge: createAitSandboxBridge({ storage: null }),
    });
    expect(unset.commerceV2).toBeUndefined();
    // A sandbox bridge wired behind a gateway of another build stays closed
    // even though it exposes the channel.
    const mismatch = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      fallbackBridge: createAitSandboxBridge({ storage: null, buildId: 'ait-sandbox' }),
    });
    await expect(mismatch.getCapabilities()).resolves.not.toHaveProperty('commerce');
    await expect(mismatch.commerceV2?.requestPurchase({
      logicalId: 'COINS_100',
      idempotencyKey: 'sandbox-purchase-v2-mismatch',
      source: 'shop',
    })).rejects.toMatchObject({ storeCode: 'COMMERCE_V2_UNAVAILABLE' });
  });

  it('keeps commerce v2 commands on the bridge whose events it subscribed to', async () => {
    const globals = globalThis as { __GAME_PLATFORM_BRIDGE__?: GamePlatformBridge };
    const previous = globals.__GAME_PLATFORM_BRIDGE__;
    const served: string[] = [];
    const hostBridge = (name: string): GamePlatformBridge => ({
      commerceV2: { subscribe: () => () => {} },
      async request(input) {
        served.push(`${name}:${input.method}`);
        return {
          id: input.id,
          ok: true,
          data: input.method === 'commerce.v2.restorePurchases'
            ? { restored: true }
            : { playerId: name },
        };
      },
    });
    try {
      globals.__GAME_PLATFORM_BRIDGE__ = hostBridge('first');
      const gateway = createAitPlatformGateway({ appVersion: '1.2.3', buildId: 'build-ait' });
      // The host bridge is reinstalled: ordinary requests follow the global
      // bridge, commerce v2 stays with the bridge that owns its events.
      globals.__GAME_PLATFORM_BRIDGE__ = hostBridge('second');
      await expect(gateway.identity.getPlayer()).resolves.toEqual({ playerId: 'second' });
      await expect(gateway.commerceV2?.restorePurchases?.()).resolves.toBeUndefined();
      expect(served).toEqual(['second:identity.getPlayer', 'first:commerce.v2.restorePurchases']);
    } finally {
      if (previous === undefined) {
        delete globals.__GAME_PLATFORM_BRIDGE__;
      } else {
        globals.__GAME_PLATFORM_BRIDGE__ = previous;
      }
    }
  });
});
