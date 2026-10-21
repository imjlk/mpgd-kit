import { describe, expect, it } from 'vitest';

import {
  bridgeCommerceV2Methods,
  bridgeNotificationsV2Methods,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import { createUnsupportedCommerceCapabilities } from '@mpgd/platform';
import { adProtocol, adProtocolVersion } from '@mpgd/platform/ads';

import { createAitHostBridge } from './host';
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
    await expect(gateway.promotions?.grantReward({
      campaignId: 'DAILY',
      idempotencyKey: 'old-host-grant',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' });
    await expect(gateway.promotions?.recoverReward?.({
      campaignId: 'DAILY',
      idempotencyKey: 'old-host-recover',
    })).resolves.toEqual({ status: 'pending' });
  });

  it('treats a pre-recovery host protocol rejection as pending without hiding other host failures', async () => {
    const host = createAitHostBridge();
    const probe = await host.request({
      id: 'unknown-method',
      method: 'promotions.notPublished' as unknown as BridgeRequest['method'],
      payload: { campaignId: 'DAILY', idempotencyKey: 'old-host' },
      meta: {
        target: 'ait',
        appVersion: '1.0.0',
        buildId: 'test',
        sentAt: '2026-07-19T00:00:00.000Z',
      },
    } as BridgeRequest);
    expect(probe.ok).toBe(false);
    if (probe.ok) {
      throw new Error('expected the generated method validator to reject an unknown method');
    }
    expect(probe.error.code).toBe('AIT_BRIDGE_REQUEST_FAILED');
    expect(probe.error.message).toContain('invalid type on $input.method');
    const preRecoveryMessage = probe.error.message
      .replace(' | "promotions.recoverReward"', '')
      .replace('"promotions.recoverReward" | ', '');
    expect(preRecoveryMessage).not.toContain('"promotions.recoverReward"');

    let nativeGrants = 0;
    const claim = { campaignId: 'DAILY', idempotencyKey: 'old-host' };
    const preRecovery: GamePlatformBridge = {
      async request(input) {
        if (input.method === 'promotions.grantReward') {
          nativeGrants += 1;
          return { id: input.id, ok: true, data: { status: 'granted', receiptKey: 'must-not-pay' } };
        }
        if (input.method === 'promotions.recoverReward') {
          return {
            id: input.id,
            ok: false,
            error: {
              code: 'AIT_BRIDGE_REQUEST_FAILED',
              message: preRecoveryMessage,
              retryable: probe.error.retryable,
            },
          };
        }
        return { id: input.id, ok: true, data: {} };
      },
    };
    const gateway = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: preRecovery,
    });
    await expect(Promise.all([
      gateway.promotions?.recoverReward?.(claim),
      gateway.promotions?.recoverReward?.(claim),
    ])).resolves.toEqual([{ status: 'pending' }, { status: 'pending' }]);
    expect(nativeGrants).toBe(0);

    const unrelated: GamePlatformBridge = {
      async request(input) {
        if (input.method === 'promotions.grantReward') {
          nativeGrants += 1;
        }
        return {
          id: input.id,
          ok: false,
          error: {
            code: 'AIT_BRIDGE_REQUEST_FAILED',
            message: 'AIT promotion campaignId must contain 1 to 128 characters.',
            retryable: true,
          },
        };
      },
    };
    await expect(createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: unrelated,
    }).promotions?.recoverReward?.(claim)).rejects.toMatchObject({
      code: 'AIT_BRIDGE_REQUEST_FAILED',
    });
    expect(nativeGrants).toBe(0);

    const listedByCurrentValidator: GamePlatformBridge = {
      async request(input) {
        return {
          id: input.id,
          ok: false,
          error: {
            code: probe.error.code,
            message: probe.error.message,
            retryable: probe.error.retryable,
          },
        };
      },
    };
    await expect(createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'test',
      bridge: listedByCurrentValidator,
    }).promotions?.recoverReward?.(claim)).rejects.toMatchObject({
      code: 'AIT_BRIDGE_REQUEST_FAILED',
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

  it('provides sandbox identity, storage, ad, and leaderboard behavior and sells nothing without the sandbox build id', async () => {
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
        deepLink: '/daily',
      }),
    ).resolves.toEqual({
      status: 'shared',
      completion: 'presented',
    });
    await expect(
      gateway.sharing?.share?.({
        kind: 'daily-result',
        title: 'Daily result',
        text: "I finished today's puzzle.",
        deepLink: '/.//evil.example/daily',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
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
    // The sandbox bridge sells only for the sandbox build id: here there is no
    // commerce provider and the snapshot carries the unsupported block, not
    // the removed boolean flags.
    expect(gateway.commerce).toBeUndefined();
    const capabilities = await gateway.getCapabilities();
    expect(capabilities).not.toHaveProperty('nativeIap');
    expect(capabilities).not.toHaveProperty('subscriptionIap');
    expect(capabilities.commerce).toEqual(createUnsupportedCommerceCapabilities());
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

  it('applies the host share-link rules in the sandbox', async () => {
    const intent = { kind: 'invite', title: 'Join', text: 'Join me' } as const;
    const named = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox',
      fallbackBridge: createAitSandboxBridge({ appName: ' ttokdoku ' }),
    });
    const derived = createAitPlatformGateway({
      appVersion: '1.0.0',
      buildId: 'ait-sandbox',
      fallbackBridge: createAitSandboxBridge(),
    });

    // With an app name, links must carry it, as on the host.
    await expect(named.sharing?.share?.({ ...intent, deepLink: 'intoss://ttokdoku/daily' }))
      .resolves.toEqual({ status: 'shared', completion: 'presented' });
    await expect(named.sharing?.share?.({ ...intent, deepLink: 'intoss://other/daily' }))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(named.sharing?.share?.({ ...intent, deepLink: '/daily' }))
      .resolves.toEqual({ status: 'shared', completion: 'presented' });

    // Without one, the sandbox uses the host's default app name.
    await expect(derived.sharing?.share?.({ ...intent, deepLink: 'intoss://mpgd-kit/daily' }))
      .resolves.toEqual({ status: 'shared', completion: 'presented' });
    await expect(derived.sharing?.share?.({ ...intent, deepLink: 'intoss://other/daily' }))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(derived.sharing?.share?.({ ...intent, deepLink: '/\\evil.example/daily' }))
      .resolves.toEqual({ status: 'unavailable' });

    expect(() => createAitSandboxBridge({ appName: 'not valid' })).toThrow('AIT appName');
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

  it('fails closed for commerce v2 methods and serves no removed commerce method without the sandbox build id', async () => {
    const bridge = createAitSandboxBridge({ storage: null });

    for (const method of ['commerce.getProducts', 'commerce.purchase', 'commerce.restore', 'commerce.getEntitlements']) {
      await expect(bridge.request({
        id: `removed-${method}`,
        method: method as BridgeRequest['method'],
        payload: {},
        meta: {
          target: 'ait',
          appVersion: '1.2.3',
          buildId: 'build-ait',
          sentAt: '2026-10-12T00:00:00.000Z',
        },
      })).resolves.toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_METHOD' } });
    }

    // The bridge itself sends the unsupported block and none of the removed flags.
    const answer = await bridge.request({
      id: 'sandbox-capabilities',
      method: 'runtime.getCapabilities',
      payload: {},
      meta: {
        target: 'ait',
        appVersion: '1.2.3',
        buildId: 'build-ait',
        sentAt: '2026-10-12T00:00:00.000Z',
      },
    });
    expect(answer.ok).toBe(true);
    const data = answer.ok ? answer.data : undefined;
    expect(data).not.toHaveProperty('nativeIap');
    expect(data).not.toHaveProperty('subscriptionIap');
    expect(data).toMatchObject({ commerce: createUnsupportedCommerceCapabilities() });

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

  it('fails closed for notifications v2 methods in every sandbox build', async () => {
    // The sandbox build gets the commerce v2 stub, but no build gets notifications v2.
    for (const buildId of ['ait-sandbox', 'build-ait']) {
      const bridge = createAitSandboxBridge({ storage: null, buildId });
      for (const method of bridgeNotificationsV2Methods) {
        for (const payload of [{ protocol: 'mpgd.notifications.v2' }, { topics: ['daily'] }, null]) {
          const response = await bridge.request({
            id: `v2-${method}`,
            method,
            payload,
            meta: {
              target: 'ait',
              appVersion: '1.2.3',
              buildId,
              sentAt: '2026-10-13T00:00:00.000Z',
            },
          });

          expect(response).toEqual({
            id: `v2-${method}`,
            ok: false,
            error: {
              code: 'NOTIFICATIONS_V2_UNAVAILABLE',
              message: expect.stringContaining(method),
              retryable: false,
            },
          });
        }
      }
      const gateway = createAitPlatformGateway({
        appVersion: '1.2.3',
        buildId,
        fallbackBridge: bridge,
      });
      expect(gateway.notificationsV2).toBeUndefined();
      // The v1 adapter keeps answering.
      await expect(gateway.notifications?.getStatus('daily-ready'))
        .resolves.toBe('configuration-required');
    }
  });

  it('answers commerce v2 with an evidence-only stub for the sandbox build only', async () => {
    const gateway = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'ait-sandbox',
      fallbackBridge: createAitSandboxBridge({ storage: null, buildId: 'ait-sandbox' }),
    });
    const provider = gateway.commerce;
    if (provider === undefined) {
      throw new Error('The sandbox gateway must expose commerce.');
    }
    expect(provider.store).toBe('apps-in-toss');
    const sandboxCapabilities = await gateway.getCapabilities();
    expect(sandboxCapabilities).toMatchObject({
      commerce: { availability: 'available', lifecycle: { finish: 'host' } },
    });
    expect(sandboxCapabilities).not.toHaveProperty('nativeIap');
    expect(sandboxCapabilities).not.toHaveProperty('subscriptionIap');
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
    // commerce provider and reports the unsupported block; the v2 methods
    // themselves stay fail-closed.
    const other = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      fallbackBridge: createAitSandboxBridge({ storage: null, buildId: 'build-ait' }),
    });
    expect(other.commerce).toBeUndefined();
    await expect(other.getCapabilities()).resolves.toMatchObject({
      commerce: createUnsupportedCommerceCapabilities(),
    });
    const unset = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'ait-sandbox',
      fallbackBridge: createAitSandboxBridge({ storage: null }),
    });
    expect(unset.commerce).toBeUndefined();
    // A sandbox bridge wired behind a gateway of another build stays closed
    // even though it exposes the channel.
    const mismatch = createAitPlatformGateway({
      appVersion: '1.2.3',
      buildId: 'build-ait',
      fallbackBridge: createAitSandboxBridge({ storage: null, buildId: 'ait-sandbox' }),
    });
    await expect(mismatch.getCapabilities()).resolves.toMatchObject({
      commerce: createUnsupportedCommerceCapabilities(),
    });
    await expect(mismatch.commerce?.requestPurchase({
      logicalId: 'COINS_100',
      idempotencyKey: 'sandbox-purchase-v2-mismatch',
      source: 'shop',
    })).rejects.toMatchObject({ storeCode: 'COMMERCE_V2_UNAVAILABLE' });
  });

  it('keeps commerce commands on the bridge whose events it subscribed to', async () => {
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
          data: input.method === 'runtime.getCapabilities'
            ? {
                haptics: name === 'second',
                commerce: {
                  ...createUnsupportedCommerceCapabilities(),
                  availability: name === 'first' ? 'available' : 'unsupported',
                  purchase: { ...createUnsupportedCommerceCapabilities().purchase, consumable: name === 'first' },
                },
              }
            : input.method === 'commerce.v2.restorePurchases'
            ? { restored: true }
            : { playerId: name },
        };
      },
    });
    try {
      globals.__GAME_PLATFORM_BRIDGE__ = hostBridge('first');
      const gateway = createAitPlatformGateway({ appVersion: '1.2.3', buildId: 'build-ait' });
      // The host bridge is reinstalled: ordinary requests follow the global
      // bridge, commerce stays with the bridge that owns its events.
      globals.__GAME_PLATFORM_BRIDGE__ = hostBridge('second');
      await expect(gateway.identity.getPlayer()).resolves.toEqual({ playerId: 'second' });
      await expect(gateway.commerce?.restorePurchases?.()).resolves.toBeUndefined();
      await expect(gateway.getCapabilities()).resolves.toMatchObject({
        haptics: true, commerce: { availability: 'available', purchase: { consumable: true } },
      });
      expect(served).toEqual([
        'second:identity.getPlayer', 'first:commerce.v2.restorePurchases',
        'second:runtime.getCapabilities', 'first:runtime.getCapabilities',
      ]);
    } finally {
      if (previous === undefined) {
        delete globals.__GAME_PLATFORM_BRIDGE__;
      } else {
        globals.__GAME_PLATFORM_BRIDGE__ = previous;
      }
    }
  });
});

it('passes optional host authority confirmation through without making it payout authority', async () => {
  const authorityConfirmation = { playerId: 'a', campaignId: 'DAILY', claimId: 'claim', receiptKey: 'receipt', confirmedAt: 10, state: { status: 'granted' } };
  const gateway = createAitPlatformGateway({ appVersion: '1.0.0', buildId: 'fixture', fallbackBridge: {
    request: async (input) => ({ id: input.id, ok: true, data: { status: 'granted', receiptKey: 'receipt', authorityConfirmation } }),
  } });
  expect(await gateway.promotions?.grantReward({ campaignId: 'DAILY', idempotencyKey: 'claim' })).toEqual({ status: 'granted', receiptKey: 'receipt', authorityConfirmation });
});
