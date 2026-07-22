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
});
