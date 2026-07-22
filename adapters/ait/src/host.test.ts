import { describe, expect, it, vi } from 'vitest';

import type { BridgeRequest } from '@mpgd/bridge';

import { createAitHostBridge, shareIntent, type AitHostDependencies } from './host';

describe('AIT production host bridge', () => {
  it('uses the native game identity and persistent string storage', async () => {
    const values = new Map<string, string>();
    const bridge = createAitHostBridge({
      dependencies: createDependencies({
        identityProvider: async () => ({ type: 'HASH', hash: ' player-1 ' }),
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'identity.getSession', {})).resolves.toEqual({
      identityLevel: 'platform-anonymous',
      playerId: 'player-1',
      trustLevel: 'platform-asserted',
    });
    await request(bridge, 'storage.save', { key: 'save:v1', value: { hints: 3 } });
    expect(values.get('save:v1')).toBe('{"hints":3}');
    await expect(request(bridge, 'storage.load', { key: 'save:v1' })).resolves.toEqual({
      __mpgdBridgeProtocol: 'mpgd.storage.load.v1',
      found: true,
      value: { hints: 3 },
    });

    const firstLoad = await request(bridge, 'storage.load', { key: 'save:v1' }) as {
      value: { hints: number };
    };
    firstLoad.value.hints = -1;
    await expect(request(bridge, 'storage.load', { key: 'save:v1' })).resolves.toMatchObject({
      value: { hints: 3 },
    });
  });

  it('fails closed when the native game identity is invalid', async () => {
    const bridge = createAitHostBridge({
      dependencies: createDependencies({ identityProvider: async () => ({ type: 'HASH' }) }),
    });

    await expect(request(bridge, 'identity.getPlayer', {})).rejects.toThrow(
      'AIT user identity is unavailable.',
    );
    await expect(request(bridge, 'identity.getSession', {})).resolves.toEqual({
      identityLevel: 'guest',
      trustLevel: 'local',
    });
  });

  it('treats corrupted native storage as a missing save', async () => {
    const bridge = createAitHostBridge({
      dependencies: createDependencies({
        storage: {
          getItem: async () => '{not-valid-json',
          removeItem: async () => {},
          setItem: async () => {},
        },
      }),
    });

    await expect(request(bridge, 'storage.load', { key: 'save:v1' })).resolves.toEqual({
      __mpgdBridgeProtocol: 'mpgd.storage.load.v1',
      found: false,
    });
  });

  it('fails closed for commerce and unconfigured ads', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });

    await expect(request(bridge, 'runtime.getCapabilities', {})).resolves.toMatchObject({
      nativeIap: false,
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
    });
    await expect(request(bridge, 'commerce.getProducts', {})).resolves.toEqual([]);
    await expect(request(bridge, 'commerce.purchase', { productId: 'HINT_PACK_5' })).resolves
      .toEqual({ status: 'failed', entitlementIds: [] });
    await expect(request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-1',
    })).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
  });

  it('requests configured notification agreement and reflects the session result', async () => {
    let callbacks: NotificationAgreementCallbacks | undefined;
    let cleanupCount = 0;
    const requestAgreement = Object.assign(
      (input: NotificationAgreementCallbacks) => {
        callbacks = input;
        return () => {
          cleanupCount += 1;
        };
      },
      { isSupported: () => true },
    );
    const bridge = createAitHostBridge({
      notificationTemplateCodes: { 'streak-at-risk': 'TTOKDOKU_STREAK_ALERT' },
      dependencies: createDependencies({ requestNotificationAgreement: requestAgreement }),
    });

    await expect(request(bridge, 'notifications.getStatus', {
      topic: 'daily-ready',
    })).resolves.toBe('configuration-required');
    await expect(request(bridge, 'notifications.getStatus', {
      topic: 'streak-at-risk',
    })).resolves.toBe('not-subscribed');

    const subscription = request(bridge, 'notifications.requestSubscription', {
      topic: 'streak-at-risk',
    });
    callbacks?.onEvent({ type: 'newAgreement' });
    await expect(subscription).resolves.toBe('subscribed');
    await expect(request(bridge, 'notifications.getStatus', {
      topic: 'streak-at-risk',
    })).resolves.toBe('subscribed');
    expect(cleanupCount).toBe(1);
  });

  it('deduplicates promotion grants with the server-issued claim id', async () => {
    const values = new Map<string, string>();
    const grantPromotion = vi.fn(async () => ({ key: 'promotion-receipt-1' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        grantPromotionReward: grantPromotion,
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.getAvailability', {
      campaignId: 'SEVEN_DAY_STREAK',
    })).resolves.toBe('available');
    await expect(request(bridge, 'promotions.getAvailability', {
      campaignId: 'UNCONFIGURED',
    })).resolves.toBe('configuration-required');

    const claim = {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-7d-1',
    };
    await expect(request(bridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'granted',
      receiptKey: 'promotion-receipt-1',
    });
    await expect(request(bridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'granted',
      receiptKey: 'promotion-receipt-1',
    });
    expect(grantPromotion).toHaveBeenCalledOnce();
    expect(grantPromotion).toHaveBeenCalledWith({
      params: { promotionCode: 'PROMOTION_7D', amount: 100 },
    });
  });

  it('keeps an ambiguous promotion attempt pending instead of double granting', async () => {
    const values = new Map<string, string>();
    let providerResponseLost = true;
    const grantPromotion = vi.fn(async () => {
      if (providerResponseLost) {
        throw new Error('native response lost');
      }
      return { key: 'promotion-receipt-recovered' };
    });
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      removeItem: async (key: string) => {
        values.delete(key);
      },
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const promotionRewards = {
      SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
    } as const;
    const bridge = createAitHostBridge({
      promotionRewards,
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({ grantPromotionReward: grantPromotion, storage }),
    });
    const claim = {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-ambiguous-1',
    };

    await expect(request(bridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'pending',
    });
    await expect(request(bridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'pending',
    });
    expect(grantPromotion).toHaveBeenCalledOnce();

    providerResponseLost = false;
    const resolvePendingPromotionGrant = vi.fn(async () => ({ status: 'retry' as const }));
    const recoveredBridge = createAitHostBridge({
      promotionRewards,
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      resolvePendingPromotionGrant,
      dependencies: createDependencies({ grantPromotionReward: grantPromotion, storage }),
    });
    await expect(request(recoveredBridge, 'promotions.grantReward', claim)).resolves.toEqual({
      status: 'granted',
      receiptKey: 'promotion-receipt-recovered',
    });
    expect(resolvePendingPromotionGrant).toHaveBeenCalledWith({
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-ambiguous-1',
      pendingSince: expect.any(String),
    });
    expect(grantPromotion).toHaveBeenCalledTimes(2);
  });

  it('returns failed for documented provider rejections and clears the pending marker', async () => {
    const values = new Map<string, string>();
    const providerResponses: unknown[] = [
      {
        errorCode: 'PROMOTION_NOT_ELIGIBLE',
        message: 'The promotion is not available for this user.',
      },
      'ERROR',
    ];
    const grantPromotionReward = vi.fn(async () => providerResponses.shift());
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        // Exercise provider-declared failure shapes that are intentionally wider
        // than the optimistic SDK return type.
        grantPromotionReward: grantPromotionReward as unknown as AitHostDependencies[
          'grantPromotionReward'
        ],
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-provider-rejected',
    })).resolves.toEqual({ status: 'failed' });
    expect(values.size).toBe(0);
    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-provider-rejected',
    })).resolves.toEqual({ status: 'failed' });
    expect(values.size).toBe(0);
    expect(grantPromotionReward).toHaveBeenCalledTimes(2);
  });

  it('keeps an undocumented promotion response pending for server reconciliation', async () => {
    const values = new Map<string, string>();
    const grantPromotionReward = vi.fn(async () => ({ unexpected: true }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        // Native bridges can return undocumented data even when the SDK type is
        // narrower, so keep this malformed-response test at the dependency edge.
        grantPromotionReward: grantPromotionReward as unknown as AitHostDependencies[
          'grantPromotionReward'
        ],
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-undocumented-response',
    })).resolves.toEqual({ status: 'pending' });
    expect(values.size).toBe(1);
  });

  it('keeps a rejected promotion pending when its marker cannot be cleared', async () => {
    const values = new Map<string, string>();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        promotionRewards: {
          SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
        },
        authorizePromotionGrant: async () => ({ status: 'authorized' }),
        dependencies: createDependencies({
          grantPromotionReward: vi.fn(async () => 'ERROR') as unknown as AitHostDependencies[
            'grantPromotionReward'
          ],
          storage: {
            getItem: async (key) => values.get(key) ?? null,
            removeItem: async () => {
              throw new Error('storage unavailable');
            },
            setItem: async (key, value) => {
              values.set(key, value);
            },
          },
        }),
      });

      await expect(request(bridge, 'promotions.grantReward', {
        campaignId: 'SEVEN_DAY_STREAK',
        idempotencyKey: 'server-claim-provider-rejected-storage-error',
      })).resolves.toEqual({ status: 'pending' });
      expect(values.size).toBe(1);
      expect(warning).toHaveBeenCalledWith(
        'AIT failed promotion marker could not be cleared; keeping the claim pending.',
        expect.stringContaining('server-claim-provider-rejected-storage-error'),
        expect.any(Error),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('disables an invalid promotion without blocking the remaining bridge', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        promotionRewards: {
          INVALID: { promotionCode: 'PROMOTION_INVALID', amount: 0 },
        },
        dependencies: createDependencies(),
      });

      await expect(request(bridge, 'promotions.getAvailability', {
        campaignId: 'INVALID',
      })).resolves.toBe('configuration-required');
      await expect(request(bridge, 'identity.getSession', {})).resolves.toMatchObject({
        playerId: 'test-player',
      });
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it('keeps configured promotions unavailable without initial server authorization', async () => {
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      dependencies: createDependencies({ grantPromotionReward }),
    });

    await expect(request(bridge, 'promotions.getAvailability', {
      campaignId: 'SEVEN_DAY_STREAK',
    })).resolves.toBe('configuration-required');
    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'invented-client-claim',
    })).resolves.toEqual({ status: 'unavailable' });
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('does not dispatch a provider grant when the game backend rejects the claim', async () => {
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const authorizePromotionGrant = vi.fn(async () => ({ status: 'rejected' as const }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant,
      dependencies: createDependencies({ grantPromotionReward }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'invented-client-claim',
    })).resolves.toEqual({ status: 'unavailable' });
    expect(authorizePromotionGrant).toHaveBeenCalledWith({
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'invented-client-claim',
    });
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('does not reopen a reconciled grant when receipt caching fails', async () => {
    const storageKey = 'mpgd:ait:promotion-grant:v1:server-claim-cache-failure';
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const resolvePendingPromotionGrant = vi.fn(async () => ({
      status: 'granted' as const,
      receiptKey: 'server-reconciled-receipt',
    }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      resolvePendingPromotionGrant,
      dependencies: createDependencies({
        grantPromotionReward,
        storage: {
          getItem: async (key) => key === storageKey
            ? JSON.stringify({ status: 'pending', pendingSince: '2026-07-22T00:00:00.000Z' })
            : null,
          removeItem: async () => {},
          setItem: async () => {
            throw new Error('storage unavailable');
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-cache-failure',
    })).resolves.toEqual({ status: 'granted', receiptKey: 'server-reconciled-receipt' });
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('returns a native receipt even when its terminal cache write fails', async () => {
    let writeCount = 0;
    const grantPromotionReward = vi.fn(async () => ({ key: 'native-receipt' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        grantPromotionReward,
        storage: {
          getItem: async () => null,
          removeItem: async () => {},
          setItem: async () => {
            writeCount += 1;
            if (writeCount === 2) {
              throw new Error('terminal cache unavailable');
            }
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-native-cache-failure',
    })).resolves.toEqual({ status: 'granted', receiptKey: 'native-receipt' });
    expect(grantPromotionReward).toHaveBeenCalledOnce();
  });

  it('fails closed when a persisted promotion marker is corrupt', async () => {
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      authorizePromotionGrant: async () => ({ status: 'authorized' }),
      dependencies: createDependencies({
        grantPromotionReward,
        storage: {
          getItem: async () => '{not-json',
          removeItem: async () => {},
          setItem: async () => {},
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'server-claim-corrupt-marker',
    })).resolves.toEqual({ status: 'pending' });
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('fails closed for legacy pending state and an invalid reconciled receipt', async () => {
    const values = new Map<string, string>([
      [
        'mpgd:ait:promotion-grant:v1:legacy-claim',
        JSON.stringify({ status: 'pending' }),
      ],
    ]);
    const resolvePendingPromotionGrant = vi.fn(async () => ({
      status: 'granted' as const,
      receiptKey: '   ',
    }));
    const grantPromotionReward = vi.fn(async () => ({ key: 'must-not-run' }));
    const bridge = createAitHostBridge({
      promotionRewards: {
        SEVEN_DAY_STREAK: { promotionCode: 'PROMOTION_7D', amount: 100 },
      },
      resolvePendingPromotionGrant,
      dependencies: createDependencies({
        grantPromotionReward,
        storage: {
          getItem: async (key) => values.get(key) ?? null,
          removeItem: async (key) => {
            values.delete(key);
          },
          setItem: async (key, value) => {
            values.set(key, value);
          },
        },
      }),
    });

    await expect(request(bridge, 'promotions.grantReward', {
      campaignId: 'SEVEN_DAY_STREAK',
      idempotencyKey: 'legacy-claim',
    })).resolves.toEqual({ status: 'pending' });
    expect(resolvePendingPromotionGrant).not.toHaveBeenCalled();
    expect(grantPromotionReward).not.toHaveBeenCalled();
  });

  it('returns a protocol error for a malformed runtime bridge call', async () => {
    const bridge = createAitHostBridge({ dependencies: createDependencies() });
    const response: unknown = await Reflect.apply(bridge.request, bridge, [null]);
    const legacyResponse: unknown = await Reflect.apply(bridge.request, bridge, [{
      id: 'legacy-request',
      method: 'runtime.getCapabilities',
      payload: {},
    }]);

    expect(response).toMatchObject({
      id: 'ait-invalid-request',
      ok: false,
      error: {
        code: 'AIT_BRIDGE_REQUEST_FAILED',
        retryable: true,
      },
    });
    expect(legacyResponse).toMatchObject({
      id: 'legacy-request',
      ok: false,
      error: { code: 'AIT_BRIDGE_REQUEST_FAILED' },
    });
  });

  it('treats a configured preload as a no-op when Ads 2.0 is unsupported', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        dependencies: createDependencies(),
      });

      await expect(request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      })).resolves.toEqual({});
      await expect(request(bridge, 'ads.preload', {
        placementId: 'UNKNOWN_PLACEMENT',
      })).rejects.toThrow('AIT ad placement is unavailable: UNKNOWN_PLACEMENT');
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        'AIT full-screen ads are not supported; configured preload is a no-op.',
        'SUDOKU_HINT_REWARDED',
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('treats missing Ads 2.0 support constants as unsupported without blocking startup', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diagnostic = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const missingSupportConstant = Object.assign(
      () => () => {},
      {
        isSupported: () => {
          throw new Error('native support constant is unavailable');
        },
      },
    );

    try {
      const bridge = createAitHostBridge({
        adGroupIds: {
          SUDOKU_HINT_REWARDED: 'ait-ad-group-1',
          SUDOKU_BREAK_INTERSTITIAL: 'ait-ad-group-2',
        },
        adPlacementTypes: {
          SUDOKU_HINT_REWARDED: 'rewarded',
          SUDOKU_BREAK_INTERSTITIAL: 'interstitial',
        },
        dependencies: createDependencies({
          loadFullScreenAd: missingSupportConstant,
          showFullScreenAd: missingSupportConstant,
        }),
      });

      await expect(request(bridge, 'runtime.getCapabilities', {})).resolves.toMatchObject({
        nativeAds: false,
        rewardedAds: false,
        interstitialAds: false,
      });
      await expect(request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      })).resolves.toEqual({});
      await expect(request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-1',
      })).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
      await expect(request(bridge, 'ads.showInterstitial', {
        placementId: 'SUDOKU_BREAK_INTERSTITIAL',
      })).resolves.toEqual({ status: 'unavailable' });
      expect(warning).toHaveBeenCalledOnce();
      expect(diagnostic).toHaveBeenCalledWith(
        'AIT capability support check failed; disabling the feature.',
        expect.objectContaining({ message: 'native support constant is unavailable' }),
      );
    } finally {
      diagnostic.mockRestore();
      warning.mockRestore();
    }
  });

  it('grants a configured rewarded ad only after userEarnedReward and dismissal', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    let markShowRegistered = (): void => {};
    const showRegistered = new Promise<void>((resolve) => {
      markShowRegistered = resolve;
    });
    const dependencies = createDependencies({
      loadFullScreenAd: Object.assign(
        (callbacks: LoadAdCallbacks) => {
          loadCallbacks = callbacks;
          return () => {};
        },
        { isSupported: () => true },
      ),
      showFullScreenAd: Object.assign(
        (callbacks: ShowAdCallbacks) => {
          showCallbacks = callbacks;
          markShowRegistered();
          return () => {};
        },
        { isSupported: () => true },
      ),
    });
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies,
    });

    const preload = request(bridge, 'ads.preload', { placementId: 'SUDOKU_HINT_REWARDED' });
    loadCallbacks?.onEvent({ type: 'loaded' });
    await expect(preload).resolves.toEqual({});

    const reward = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-correlation-1',
    });
    await showRegistered;
    showCallbacks?.onEvent({
      type: 'userEarnedReward',
      data: { unitType: 'hint', unitAmount: 1 },
    });
    showCallbacks?.onEvent({ type: 'dismissed' });

    await expect(reward).resolves.toEqual({
      status: 'completed',
      rewardGranted: true,
      ledgerEntryId: 'reward-correlation-1',
      evidence: {
        schema: 'apps-in-toss.rewarded-ad.callback.v1',
        payload: {
          event: 'user-earned-reward',
          correlationId: 'reward-correlation-1',
          placementId: 'ait-ad-group-1',
        },
      },
    });
  });

  it('preserves an earned reward during a long displayed ad', async () => {
    vi.useFakeTimers();
    try {
      let loadCallbacks: LoadAdCallbacks | undefined;
      let showCallbacks: ShowAdCallbacks | undefined;
      let markShowRegistered = (): void => {};
      const showRegistered = new Promise<void>((resolve) => {
        markShowRegistered = resolve;
      });
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        adTimeoutMs: 50,
        adDisplayStartTimeoutMs: 100,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            (callbacks: ShowAdCallbacks) => {
              showCallbacks = callbacks;
              markShowRegistered();
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const preload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      loadCallbacks?.onEvent({ type: 'loaded' });
      await preload;

      const reward = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-long-display',
      });
      await showRegistered;
      showCallbacks?.onEvent({ type: 'show' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      showCallbacks?.onEvent({
        type: 'userEarnedReward',
        data: { unitType: 'hint', unitAmount: 1 },
      });
      showCallbacks?.onEvent({ type: 'dismissed' });

      await expect(reward).resolves.toMatchObject({
        status: 'completed',
        rewardGranted: true,
        ledgerEntryId: 'reward-long-display',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a long displayed interstitial after native dismissal', async () => {
    vi.useFakeTimers();
    try {
      let loadCallbacks: LoadAdCallbacks | undefined;
      let showCallbacks: ShowAdCallbacks | undefined;
      let markShowRegistered = (): void => {};
      const showRegistered = new Promise<void>((resolve) => {
        markShowRegistered = resolve;
      });
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_BREAK_INTERSTITIAL: 'ait-ad-group-interstitial' },
        adPlacementTypes: { SUDOKU_BREAK_INTERSTITIAL: 'interstitial' },
        adTimeoutMs: 50,
        adDisplayStartTimeoutMs: 100,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            (callbacks: ShowAdCallbacks) => {
              showCallbacks = callbacks;
              markShowRegistered();
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const preload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_BREAK_INTERSTITIAL',
      });
      loadCallbacks?.onEvent({ type: 'loaded' });
      await preload;

      const interstitial = request(bridge, 'ads.showInterstitial', {
        placementId: 'SUDOKU_BREAK_INTERSTITIAL',
      });
      await showRegistered;
      showCallbacks?.onEvent({ type: 'show' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      showCallbacks?.onEvent({ type: 'dismissed' });

      await expect(interstitial).resolves.toEqual({ status: 'shown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a rewarded ad when the native terminal callback is omitted', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let loadCallbacks: LoadAdCallbacks | undefined;
      let showCallbacks: ShowAdCallbacks | undefined;
      let markShowRegistered = (): void => {};
      const showRegistered = new Promise<void>((resolve) => {
        markShowRegistered = resolve;
      });
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        adTimeoutMs: 50,
        adMaximumDisplayMs: 100,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            (callbacks: ShowAdCallbacks) => {
              showCallbacks = callbacks;
              markShowRegistered();
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const preload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      loadCallbacks?.onEvent({ type: 'loaded' });
      await preload;

      const reward = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-missing-dismissal',
      });
      await showRegistered;
      showCallbacks?.onEvent({ type: 'show' });
      showCallbacks?.onEvent({
        type: 'userEarnedReward',
        data: { unitType: 'hint', unitAmount: 1 },
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(reward).resolves.toMatchObject({
        status: 'completed',
        rewardGranted: true,
        ledgerEntryId: 'reward-missing-dismissal',
      });
      expect(warning).toHaveBeenCalledWith(
        'AIT full-screen ad omitted its terminal callback; recovering the game lifecycle.',
        'ait-ad-group-1',
      );
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the requested-to-display wait inside the total show timeout', async () => {
    vi.useFakeTimers();
    try {
      let loadCallbacks: LoadAdCallbacks | undefined;
      let showCallbacks: ShowAdCallbacks | undefined;
      let markShowRegistered = (): void => {};
      const showRegistered = new Promise<void>((resolve) => {
        markShowRegistered = resolve;
      });
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        adTimeoutMs: 50,
        adDisplayStartTimeoutMs: 100,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            (callbacks: ShowAdCallbacks) => {
              showCallbacks = callbacks;
              markShowRegistered();
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const preload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      loadCallbacks?.onEvent({ type: 'loaded' });
      await preload;

      const reward = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-total-timeout',
      });
      await showRegistered;
      await vi.advanceTimersByTimeAsync(40);
      showCallbacks?.onEvent({ type: 'requested' });
      await vi.advanceTimersByTimeAsync(10);

      await expect(reward).resolves.toEqual({ status: 'failed', rewardGranted: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a shared explicit preload failure as non-fatal and logs it once', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const firstPreload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      const secondPreload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      loadCallbacks?.onError(new Error('native load failed'));

      await expect(firstPreload).resolves.toEqual({});
      await expect(secondPreload).resolves.toEqual({});
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('serializes native loads for different full-screen ad groups', async () => {
    const loads: Array<{
      readonly adGroupId: string;
      readonly callbacks: LoadAdCallbacks;
    }> = [];
    const bridge = createAitHostBridge({
      adGroupIds: {
        SUDOKU_HINT_REWARDED: 'ait-ad-group-rewarded',
        SUDOKU_BREAK_INTERSTITIAL: 'ait-ad-group-interstitial',
      },
      adPlacementTypes: {
        SUDOKU_HINT_REWARDED: 'rewarded',
        SUDOKU_BREAK_INTERSTITIAL: 'interstitial',
      },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loads.push({ adGroupId: callbacks.options?.adGroupId ?? 'missing-ad-group', callbacks });
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const rewardedPreload = request(bridge, 'ads.preload', {
      placementId: 'SUDOKU_HINT_REWARDED',
    });
    const interstitialPreload = request(bridge, 'ads.preload', {
      placementId: 'SUDOKU_BREAK_INTERSTITIAL',
    });

    expect(loads.map(({ adGroupId }) => adGroupId)).toEqual(['ait-ad-group-rewarded']);
    loads[0]?.callbacks.onEvent({ type: 'loaded' });
    await rewardedPreload;
    await vi.waitFor(() => {
      expect(loads.map(({ adGroupId }) => adGroupId)).toEqual([
        'ait-ad-group-rewarded',
        'ait-ad-group-interstitial',
      ]);
    });
    loads[1]?.callbacks.onEvent({ type: 'loaded' });

    await expect(interstitialPreload).resolves.toEqual({});
  });

  it('does not let a hung native load extend the next group timeout', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const nativeLoadGroups: string[] = [];
      const bridge = createAitHostBridge({
        adGroupIds: {
          SUDOKU_HINT_REWARDED: 'ait-ad-group-rewarded',
          SUDOKU_BREAK_INTERSTITIAL: 'ait-ad-group-interstitial',
        },
        adPlacementTypes: {
          SUDOKU_HINT_REWARDED: 'rewarded',
          SUDOKU_BREAK_INTERSTITIAL: 'interstitial',
        },
        adTimeoutMs: 50,
        adLoadQueueTimeoutMs: 20,
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              nativeLoadGroups.push(callbacks.options?.adGroupId ?? 'missing-ad-group');
              return () => {};
            },
            { isSupported: () => true },
          ),
        }),
      });

      const rewardedPreload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_HINT_REWARDED',
      });
      const interstitialPreload = request(bridge, 'ads.preload', {
        placementId: 'SUDOKU_BREAK_INTERSTITIAL',
      });
      await vi.advanceTimersByTimeAsync(20);

      await expect(interstitialPreload).resolves.toEqual({});
      expect(nativeLoadGroups).toEqual(['ait-ad-group-rewarded']);
      expect(warning).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30);
      await expect(rewardedPreload).resolves.toEqual({});
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('loads a configured rewarded ad before a direct show request', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    let markShowRegistered = (): void => {};
    const showRegistered = new Promise<void>((resolve) => {
      markShowRegistered = resolve;
    });
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loadCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
        showFullScreenAd: Object.assign(
          (callbacks: ShowAdCallbacks) => {
            showCallbacks = callbacks;
            markShowRegistered();
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const reward = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-direct-show',
    });

    expect(loadCallbacks).toBeDefined();
    expect(showCallbacks).toBeUndefined();
    loadCallbacks?.onEvent({ type: 'loaded' });
    await showRegistered;
    showCallbacks?.onEvent({
      type: 'userEarnedReward',
      data: { unitType: 'hint', unitAmount: 1 },
    });
    showCallbacks?.onEvent({ type: 'dismissed' });

    await expect(reward).resolves.toMatchObject({
      status: 'completed',
      rewardGranted: true,
      ledgerEntryId: 'reward-direct-show',
    });
  });

  it('logs one diagnostic when concurrent shows share a failed ad load', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridge = createAitHostBridge({
        adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
        adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
        dependencies: createDependencies({
          loadFullScreenAd: Object.assign(
            (callbacks: LoadAdCallbacks) => {
              loadCallbacks = callbacks;
              return () => {};
            },
            { isSupported: () => true },
          ),
          showFullScreenAd: Object.assign(
            () => () => {},
            { isSupported: () => true },
          ),
        }),
      });

      const firstShow = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-load-failure-1',
      });
      const secondShow = request(bridge, 'ads.showRewarded', {
        placementId: 'SUDOKU_HINT_REWARDED',
        idempotencyKey: 'reward-load-failure-2',
      });
      loadCallbacks?.onError(new Error('native load failed'));

      await expect(firstShow).resolves.toEqual({
        status: 'unavailable',
        rewardGranted: false,
      });
      await expect(secondShow).resolves.toEqual({
        status: 'unavailable',
        rewardGranted: false,
      });
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('does not grant a reward when the ad is dismissed without the reward event', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    let markShowRegistered = (): void => {};
    const showRegistered = new Promise<void>((resolve) => {
      markShowRegistered = resolve;
    });
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loadCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
        showFullScreenAd: Object.assign(
          (callbacks: ShowAdCallbacks) => {
            showCallbacks = callbacks;
            markShowRegistered();
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const preload = request(bridge, 'ads.preload', { placementId: 'SUDOKU_HINT_REWARDED' });
    loadCallbacks?.onEvent({ type: 'loaded' });
    await preload;
    const reward = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-correlation-2',
    });
    await showRegistered;
    showCallbacks?.onEvent({ type: 'dismissed' });

    await expect(reward).resolves.toEqual({ status: 'skipped', rewardGranted: false });
  });

  it('consumes a preloaded ad before awaiting the native show result', async () => {
    let loadCallbacks: LoadAdCallbacks | undefined;
    let showCallbacks: ShowAdCallbacks | undefined;
    let showCount = 0;
    const bridge = createAitHostBridge({
      adGroupIds: { SUDOKU_HINT_REWARDED: 'ait-ad-group-1' },
      adPlacementTypes: { SUDOKU_HINT_REWARDED: 'rewarded' },
      dependencies: createDependencies({
        loadFullScreenAd: Object.assign(
          (callbacks: LoadAdCallbacks) => {
            loadCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
        showFullScreenAd: Object.assign(
          (callbacks: ShowAdCallbacks) => {
            showCount += 1;
            showCallbacks = callbacks;
            return () => {};
          },
          { isSupported: () => true },
        ),
      }),
    });

    const preload = request(bridge, 'ads.preload', { placementId: 'SUDOKU_HINT_REWARDED' });
    loadCallbacks?.onEvent({ type: 'loaded' });
    await preload;

    const firstShow = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-concurrent-1',
    });
    const secondShow = request(bridge, 'ads.showRewarded', {
      placementId: 'SUDOKU_HINT_REWARDED',
      idempotencyKey: 'reward-concurrent-2',
    });

    await expect(secondShow).resolves.toEqual({
      status: 'unavailable',
      rewardGranted: false,
    });
    showCallbacks?.onEvent({
      type: 'userEarnedReward',
      data: { unitType: 'hint', unitAmount: 1 },
    });
    showCallbacks?.onEvent({ type: 'dismissed' });
    await expect(firstShow).resolves.toMatchObject({
      status: 'completed',
      rewardGranted: true,
    });
    expect(showCount).toBe(1);
  });

  it('treats a missing Game Center environment constant as unsupported', async () => {
    const diagnostic = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const submitScore = vi.fn(async () => ({ statusCode: 'SUCCESS' as const }));
    const openLeaderboard = vi.fn(async () => {});

    try {
      const bridge = createAitHostBridge({
        dependencies: createDependencies({
          isMinVersionSupported: () => {
            throw new Error('getOperationalEnvironment is not a constant handler');
          },
          submitGameCenterLeaderBoardScore: submitScore,
          openGameCenterLeaderboard: openLeaderboard,
        }),
      });

      await expect(request(bridge, 'runtime.getCapabilities', {})).resolves.toMatchObject({
        nativeLeaderboard: false,
      });
      await expect(request(bridge, 'leaderboard.submitScore', { score: 42 })).resolves.toEqual({
        submitted: false,
      });
      await expect(request(bridge, 'leaderboard.open', {})).resolves.toEqual({});
      expect(submitScore).not.toHaveBeenCalled();
      expect(openLeaderboard).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith(
        'AIT capability support check failed; disabling the feature.',
        expect.objectContaining({
          message: 'getOperationalEnvironment is not a constant handler',
        }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('delegates supported Game Center score submission and opening', async () => {
    const submittedScores: string[] = [];
    let openCount = 0;
    const bridge = createAitHostBridge({
      dependencies: createDependencies({
        submitGameCenterLeaderBoardScore: async ({ score }) => {
          submittedScores.push(score);
          return { statusCode: 'SUCCESS' };
        },
        openGameCenterLeaderboard: async () => {
          openCount += 1;
        },
      }),
    });

    await expect(request(bridge, 'leaderboard.submitScore', { score: 42 })).resolves.toEqual({
      submitted: true,
    });
    await expect(request(bridge, 'leaderboard.open', {})).resolves.toEqual({});
    expect(submittedScores).toEqual(['42']);
    expect(openCount).toBe(1);
  });
});

describe('AIT sharing', () => {
  it('converts an HTTPS game path to the app-owned intoss deep link', async () => {
    const paths: string[] = [];
    const messages: string[] = [];
    const result = await shareIntent(
      {
        text: "Try today's challenge.",
        deepLink: 'https://game.example/daily?challengeToken=signed-token#result',
        previewImageUrl: 'https://game.example/daily.png',
      },
      {
        appName: 'ttokdoku',
        getTossShareLink: async (path) => {
          paths.push(path);
          return 'https://toss.im/_ul/daily';
        },
        share: async ({ message }) => {
          messages.push(message);
        },
      },
    );

    expect(result).toEqual({ status: 'shared', completion: 'presented' });
    expect(paths).toEqual([
      'intoss://ttokdoku/daily?challengeToken=signed-token#result',
    ]);
    expect(messages).toEqual(["Try today's challenge.\nhttps://toss.im/_ul/daily"]);
  });

  it('rejects unsafe links and preserves native share cancellation', async () => {
    const dependencies = {
      appName: 'ttokdoku',
      getTossShareLink: async () => 'https://toss.im/_ul/daily',
      share: async () => {},
    };

    await expect(shareIntent({ text: 'Unsafe', deepLink: 'javascript:alert(1)' }, dependencies))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(shareIntent(
      { text: 'Cancelled', deepLink: '/daily' },
      {
        ...dependencies,
        share: async () => {
          throw { name: 'AbortError' };
        },
      },
    )).resolves.toEqual({ status: 'cancelled' });
  });
});

type LoadAdCallbacks = Parameters<AitHostDependencies['loadFullScreenAd']>[0];
type ShowAdCallbacks = Parameters<AitHostDependencies['showFullScreenAd']>[0];
type NotificationAgreementCallbacks = Parameters<
  AitHostDependencies['requestNotificationAgreement']
>[0];

function createDependencies(
  overrides: Partial<AitHostDependencies> = {},
): AitHostDependencies {
  const unsupportedAd = Object.assign(() => () => {}, { isSupported: () => false });

  return {
    identityProvider: async () => ({ type: 'HASH', hash: 'test-player' }),
    storage: {
      getItem: async () => null,
      removeItem: async () => {},
      setItem: async () => {},
    },
    getTossShareLink: async () => 'https://toss.im/test',
    share: async () => {},
    grantPromotionReward: async () => ({ key: 'test-promotion-receipt' }),
    requestNotificationAgreement: Object.assign(() => () => {}, {
      isSupported: () => false,
    }),
    isMinVersionSupported: () => true,
    loadFullScreenAd: unsupportedAd,
    showFullScreenAd: unsupportedAd,
    openGameCenterLeaderboard: async () => {},
    submitGameCenterLeaderBoardScore: async () => ({ statusCode: 'SUCCESS' }),
    ...overrides,
  } as AitHostDependencies;
}

async function request(
  bridge: ReturnType<typeof createAitHostBridge>,
  method: BridgeRequest['method'],
  payload: unknown,
): Promise<unknown> {
  const response = await bridge.request({
    id: `${method}:test`,
    method,
    payload,
    meta: {
      target: 'ait',
      appVersion: '1.0.0',
      buildId: 'test',
      sentAt: '2026-07-19T00:00:00.000Z',
    },
  } satisfies BridgeRequest);

  if (!response.ok) {
    throw new Error(response.error.message);
  }

  return response.data;
}
