import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

import { createCapacitorPlatformGateway, type NativeBridge } from './index';

describe('adapter-capacitor', () => {
  it('sends typed requests through the native Capacitor bridge', async () => {
    const requests: BridgeRequest[] = [];
    const bridge: NativeBridge = {
      async request(input) {
        requests.push(input);

        return {
          id: input.id,
          ok: true,
          data: {
            status: 'completed',
            transactionId: 'native-transaction-1',
            entitlementIds: ['coins-100'],
          },
        } satisfies BridgeResponse;
      },
    };

    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge,
    });

    await expect(
      gateway.commerce.purchase({
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'purchase-1',
      }),
    ).resolves.toEqual({
      status: 'completed',
      transactionId: 'native-transaction-1',
      entitlementIds: ['coins-100'],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'commerce.purchase',
      payload: {
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'purchase-1',
      },
      meta: {
        target: 'android',
        appVersion: '1.2.3',
        buildId: 'build-android',
      },
    });
  });

  it('distinguishes a stored top-level JSON null from a missing native value', async () => {
    const bridge: NativeBridge = {
      async request(input) {
        if (input.method === 'storage.load') {
          const payload = input.payload as { readonly key?: string };
          return {
            id: input.id,
            ok: true,
            data:
              payload.key === 'nullable-save:v1'
                ? { found: true, value: null }
                : { found: false },
          } satisfies BridgeResponse;
        }

        return {
          id: input.id,
          ok: true,
          data: {},
        } satisfies BridgeResponse;
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge,
    });

    await expect(gateway.storage.load({ key: 'nullable-save:v1' })).resolves.toEqual({
      value: null,
    });
    await expect(gateway.storage.load({ key: 'missing:v1' })).resolves.toBeNull();
  });

  it('throws native bridge errors as JavaScript errors', async () => {
    const bridge: NativeBridge = {
      async request(input) {
        return {
          id: input.id,
          ok: false,
          error: {
            code: 'STORE_UNAVAILABLE',
            message: 'Store unavailable.',
            retryable: true,
          },
        };
      },
    };

    const gateway = createCapacitorPlatformGateway({
      target: 'ios',
      appVersion: '1.2.3',
      buildId: 'build-ios',
      bridge,
    });

    await expect(gateway.commerce.getProducts()).rejects.toThrow('Store unavailable.');
  });

  it('delegates shared launch, identity, share, and notification flows', async () => {
    const methods: string[] = [];
    const bridge: NativeBridge = {
      async request(input) {
        methods.push(input.method);

        const dataByMethod: Partial<Record<typeof input.method, unknown>> = {
          'identity.getSession': {
            identityLevel: 'platform-anonymous',
            playerId: 'android-local-player',
            trustLevel: 'local',
          },
          'presentation.getLaunchIntent': { entry: 'home' },
          'presentation.requestGameSurface': 'already-fullscreen',
          'share.share': { status: 'unavailable' },
          'share.readInboundShare': null,
          'notifications.getStatus': 'configuration-required',
          'notifications.requestSubscription': 'unavailable',
        };

        return {
          id: input.id,
          ok: true,
          data: dataByMethod[input.method],
        } satisfies BridgeResponse;
      },
    };
    const gateway = createCapacitorPlatformGateway({
      target: 'android',
      appVersion: '1.2.3',
      buildId: 'build-android',
      bridge,
    });

    await expect(gateway.identity.getSession?.()).resolves.toMatchObject({
      identityLevel: 'platform-anonymous',
      trustLevel: 'local',
    });
    await expect(gateway.presentation?.getLaunchIntent()).resolves.toEqual({ entry: 'home' });
    await expect(
      gateway.presentation?.requestGameSurface({ entry: 'daily' }),
    ).resolves.toBe('already-fullscreen');
    await expect(
      gateway.sharing?.share?.({
        kind: 'invite',
        title: 'Invite',
        text: 'Play with me',
        deepLink: 'mpgd://invite',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(gateway.sharing?.readInboundShare?.()).resolves.toBeNull();
    await expect(gateway.notifications?.getStatus('daily-ready')).resolves.toBe(
      'configuration-required',
    );
    await expect(
      gateway.notifications?.requestSubscription('daily-ready'),
    ).resolves.toBe('unavailable');
    expect(methods).toEqual([
      'identity.getSession',
      'presentation.getLaunchIntent',
      'presentation.requestGameSurface',
      'share.share',
      'share.readInboundShare',
      'notifications.getStatus',
      'notifications.requestSubscription',
    ]);
  });
});
